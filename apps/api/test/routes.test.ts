import net from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AeoAuditError, type AuditReport, type SitemapAuditReport } from '@ainyc/aeo-audit'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/service/config.js'
import { RequestContainment } from '../src/service/containment.js'
import { UsageStore } from '../src/service/quota.js'

const rawKey = `aak_${'01'.repeat(32)}`
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'aeo-audit-routes-'))
  dirs.push(dataDir)
  const config = loadConfig({
    NODE_ENV: 'test',
    FLEET_AUDIT_BRIDGE_URL: 'http://127.0.0.1:4600',
    FLEET_AUDIT_SVC_SECRET: 's'.repeat(32),
    AEO_AUDIT_DATA_DIR: dataDir,
  })
  const usage = new UsageStore(join(dataDir, 'usage.db'), { requests: 20, audit: 10, sitemap: 5 }, () => new Date('2026-07-15T12:00:00.000Z'))
  const bridge = {
    validateHash: vi.fn(async () => ({
      status: 'active' as const,
      keyId: 'key-1',
      agencyId: 'agency-1',
      name: 'Production',
      keyPrefix: 'aak_0101',
      createdAt: '2026-07-15T10:00:00.000Z',
      lastUsedAt: null,
    })),
  }
  const containment = new RequestContainment({ capacity: 8, queueSize: 32, queueWaitMs: 1_000, perKeyConcurrency: 2 })
  return { config, usage, bridge, containment }
}

function report(): AuditReport {
  return {
    schemaVersion: '3.2',
    url: 'https://example.com/',
    finalUrl: 'https://example.com/',
    auditedAt: '2026-07-15T12:00:00.000Z',
    overallScore: 80,
    summary: 'ok',
    factors: [],
    criticalDefects: [],
    metadata: {
      fetchTimeMs: 1,
      pageTitle: 'Example',
      wordCount: 1,
      auxiliary: { llmsTxt: 'missing', llmsFullTxt: 'missing', robotsTxt: 'missing', sitemapXml: 'missing' },
      redirectChain: [],
    },
    compareMeta: { engineVersion: '4.3.0', factorIds: [] },
  }
}

function sitemapReport(): SitemapAuditReport {
  return {
    schemaVersion: '3.2',
    sitemapUrl: 'https://example.com/sitemap.xml',
    auditedAt: '2026-07-15T12:00:00.000Z',
    pagesDiscovered: 1,
    pagesAudited: 1,
    pagesSkipped: 0,
    pagesFiltered: 0,
    pagesTruncated: 0,
    effectiveLimit: 25,
    aggregateScore: 80,
    pages: [],
    criticalDefects: [],
    crossCuttingIssues: [],
    prioritizedFixes: [],
    compareMeta: { engineVersion: '4.3.0', factorIds: [] },
    budget: { exhausted: false, discoveryComplete: true },
  }
}

describe('audit API routes', () => {
  it('serves health and runs an authenticated audit with durable agency usage headers', async () => {
    const deps = setup()
    const engine = {
      audit: vi.fn(async (_url, options) => {
        options?.onOutboundAttempt?.()
        return report()
      }),
      sitemap: vi.fn(async () => sitemapReport()),
    }
    const app = buildApp({ ...deps, engine, logger: false })

    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' })
    const response = await app.inject({
      method: 'POST',
      url: '/v1/audit',
      headers: { Authorization: `Bearer ${rawKey}` },
      payload: { url: 'https://example.com' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(report())
    expect(response.headers['x-ratelimit-limit']).toBe('10')
    expect(response.headers['x-ratelimit-remaining']).toBe('9')
    expect(deps.usage.getUsage('agency-1')).toMatchObject({ requests: { used: 1 }, audit: { used: 1 } })

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { Authorization: `Bearer ${rawKey}` } })
    expect(me.statusCode).toBe(200)
    expect(me.json()).toEqual({
      key: {
        id: 'key-1',
        name: 'Production',
        prefix: 'aak_0101',
        createdAt: '2026-07-15T10:00:00.000Z',
        lastUsedAt: null,
      },
      agency: { id: 'agency-1' },
      usage: {
        date: '2026-07-15',
        resetsAt: '2026-07-16T00:00:00.000Z',
        requests: { used: 1, limit: 20, remaining: 19 },
        audit: { used: 1, limit: 10, remaining: 9 },
        sitemapAudit: { used: 0, limit: 5, remaining: 5 },
      },
    })
    await app.close()
    deps.usage.close()
  })

  it('defaults and clamps sitemap limits without forwarding unknown options', async () => {
    const deps = setup()
    const engine = {
      audit: vi.fn(async () => report()),
      sitemap: vi.fn(async (_url: string, _options: unknown) => sitemapReport()),
    }
    const app = buildApp({ ...deps, engine, logger: false })

    const first = await app.inject({
      method: 'POST', url: '/v1/sitemap-audit', headers: { Authorization: `Bearer ${rawKey}` }, payload: { url: 'https://example.com' },
    })
    const second = await app.inject({
      method: 'POST', url: '/v1/sitemap-audit', headers: { Authorization: `Bearer ${rawKey}` }, payload: { url: 'https://example.com', limit: 50 },
    })
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(engine.sitemap.mock.calls[0][1]).toMatchObject({ limit: 25 })
    expect(engine.sitemap.mock.calls[1][1]).toMatchObject({ limit: 25 })

    const rejected = await app.inject({
      method: 'POST', url: '/v1/sitemap-audit', headers: { Authorization: `Bearer ${rawKey}` }, payload: { url: 'https://example.com', allowPrivateHost: true },
    })
    expect(rejected.statusCode).toBe(400)
    expect(engine.sitemap).toHaveBeenCalledTimes(2)
    await app.close()
    deps.usage.close()
  })

  it('refunds only endpoint quota when no outbound attempt began', async () => {
    const deps = setup()
    const app = buildApp({
      ...deps,
      engine: {
        audit: vi.fn(async () => { throw new AeoAuditError('BLOCKED_IP', 'blocked') }),
        sitemap: vi.fn(async () => sitemapReport()),
      },
      logger: false,
    })
    const response = await app.inject({
      method: 'POST', url: '/v1/audit', headers: { Authorization: `Bearer ${rawKey}` }, payload: { url: 'http://127.0.0.1' },
    })
    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ code: 'TARGET_BLOCKED' })
    expect(response.headers['x-ratelimit-remaining']).toBe('10')
    expect(deps.usage.getUsage('agency-1')).toMatchObject({ requests: { used: 1 }, audit: { used: 0 } })
    await app.close()
    deps.usage.close()
  })

  it('does not refund an endpoint unit after the engine observes an outbound attempt', async () => {
    const deps = setup()
    const app = buildApp({
      ...deps,
      engine: {
        audit: vi.fn(async (_url, options) => {
          options?.onOutboundAttempt?.()
          throw new AeoAuditError('BLOCKED_IP', 'connect-time rebind')
        }),
        sitemap: vi.fn(async () => sitemapReport()),
      },
      logger: false,
    })
    const response = await app.inject({
      method: 'POST', url: '/v1/audit', headers: { Authorization: `Bearer ${rawKey}` }, payload: { url: 'https://example.com' },
    })
    expect(response.statusCode).toBe(422)
    expect(response.headers['x-ratelimit-remaining']).toBe('9')
    expect(deps.usage.getUsage('agency-1')).toMatchObject({ requests: { used: 1 }, audit: { used: 1 } })
    await app.close()
    deps.usage.close()
  })

  it('rejects duplicate raw Authorization header lines before bridge validation', async () => {
    const deps = setup()
    const app = buildApp({
      ...deps,
      engine: { audit: vi.fn(async () => report()), sitemap: vi.fn(async () => sitemapReport()) },
      logger: false,
    })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('listener address unavailable')
    const rawResponse = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: address.port })
      let data = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk) => { data += chunk })
      socket.on('end', () => resolve(data))
      socket.on('error', reject)
      socket.write(`GET /v1/me HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${rawKey}\r\nAuthorization: Bearer ${rawKey}\r\nConnection: close\r\n\r\n`)
    })
    expect(rawResponse).toContain('401 Unauthorized')
    expect(deps.bridge.validateHash).not.toHaveBeenCalled()
    await app.close()
    deps.usage.close()
  })
})

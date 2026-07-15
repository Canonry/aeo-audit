import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/service/config.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function validEnv(): NodeJS.ProcessEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'aeo-audit-api-config-'))
  dirs.push(dataDir)
  return {
    NODE_ENV: 'test',
    FLEET_AUDIT_BRIDGE_URL: 'http://127.0.0.1:4600',
    FLEET_AUDIT_SVC_SECRET: 's'.repeat(32),
    AEO_AUDIT_DATA_DIR: dataDir,
  }
}

describe('service config', () => {
  it('requires the bridge secret and honors PORT before API_PORT', () => {
    const cfg = loadConfig({ ...validEnv(), PORT: '5123', API_PORT: '5124' })
    expect(cfg.port).toBe(5123)
    expect(cfg.bindHost).toBe('0.0.0.0')
    expect(cfg.sitemapDailyLimit).toBe(10)
    expect(cfg.auditDailyLimit).toBe(100)

    expect(() => loadConfig({ ...validEnv(), FLEET_AUDIT_SVC_SECRET: 'short' })).toThrow()
  })

  it('supports an explicit loopback bind for host-networked agent-node Docker', () => {
    expect(loadConfig({ ...validEnv(), AEO_AUDIT_BIND: '127.0.0.1' }).bindHost).toBe('127.0.0.1')
    expect(() => loadConfig({ ...validEnv(), AEO_AUDIT_BIND: '192.0.2.1' })).toThrow()
  })

  it('rejects fractional and impossible containment settings', () => {
    expect(() => loadConfig({ ...validEnv(), AUDIT_QUEUE_SIZE: '1.5' })).toThrow()
    expect(() => loadConfig({ ...validEnv(), AUDIT_SITEMAP_WEIGHT: '9' })).toThrow()
  })

  it('rejects plain HTTP bridges outside an explicit loopback runtime', () => {
    expect(() => loadConfig({
      ...validEnv(),
      NODE_ENV: 'production',
      FLEET_AUDIT_BRIDGE_URL: 'http://platform.example.com',
    })).toThrow(/HTTPS/)
  })
})

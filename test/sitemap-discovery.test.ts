import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { discoverSitemapUrl, parseRobotsSitemap } from '../src/sitemap.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseRobotsSitemap', () => {
  it('extracts a Sitemap: directive (case-insensitive)', () => {
    const robots = `User-agent: *\nAllow: /\nSitemap: https://example.com/custom-sitemap.xml\n`
    expect(parseRobotsSitemap(robots, 'https://example.com')).toBe('https://example.com/custom-sitemap.xml')
  })

  it('handles uppercase, mixed-case, and extra whitespace', () => {
    const robots = `SITEMAP:    https://example.com/a.xml\nsitemap:https://example.com/b.xml`
    expect(parseRobotsSitemap(robots, 'https://example.com')).toBe('https://example.com/a.xml')
  })

  it('resolves relative paths against the supplied origin', () => {
    const robots = `Sitemap: /sitemap-2026.xml`
    expect(parseRobotsSitemap(robots, 'https://example.com')).toBe('https://example.com/sitemap-2026.xml')
  })

  it('returns null when no Sitemap directive is present', () => {
    const robots = `User-agent: *\nDisallow: /private`
    expect(parseRobotsSitemap(robots, 'https://example.com')).toBeNull()
  })

  it('skips comment lines starting with #', () => {
    const robots = `# Sitemap: https://example.com/commented-out.xml\nSitemap: https://example.com/real.xml`
    expect(parseRobotsSitemap(robots, 'https://example.com')).toBe('https://example.com/real.xml')
  })

  it('rejects cross-origin Sitemap directives (SSRF guard)', () => {
    const robots = `Sitemap: http://169.254.169.254/latest/meta-data/`
    expect(parseRobotsSitemap(robots, 'https://example.com')).toBeNull()
  })

  it('rejects a same-host directive on a different port', () => {
    const robots = `Sitemap: https://example.com:8443/sitemap.xml`
    expect(parseRobotsSitemap(robots, 'https://example.com')).toBeNull()
  })

  it('rejects an http directive when the origin is https (no protocol downgrade)', () => {
    const robots = `Sitemap: http://example.com/sitemap.xml`
    expect(parseRobotsSitemap(robots, 'https://example.com')).toBeNull()
  })

  it('falls through cross-origin entries and returns a later same-origin directive', () => {
    const robots = `Sitemap: http://attacker.example/sitemap.xml\nSitemap: https://example.com/real.xml`
    expect(parseRobotsSitemap(robots, 'https://example.com')).toBe('https://example.com/real.xml')
  })
})

describe('discoverSitemapUrl', () => {
  let server: Server
  let origin: string
  let handler: (path: string) => { status: number; body: string; contentType?: string }
  // The test server is on 127.0.0.1 (a private/loopback IP). Discovery now SSRF-
  // validates every fetch, so the loopback host must be opted in via allowPrivateHost
  // exactly as `--allow-local` does in production.
  const ALLOW_LOOPBACK = '127.0.0.1'

  beforeAll(async () => {
    server = createServer((req, res) => {
      const result = handler(req.url || '/')
      res.writeHead(result.status, { 'content-type': result.contentType || 'application/xml' })
      res.end(result.body)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    origin = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  })

  it('returns /sitemap.xml when it exists', async () => {
    handler = (path) => {
      if (path === '/sitemap.xml') return { status: 200, body: '<urlset></urlset>' }
      return { status: 404, body: '' }
    }
    expect(await discoverSitemapUrl(origin, ALLOW_LOOPBACK)).toBe(`${origin}/sitemap.xml`)
  })

  it('falls back to /sitemap-index.xml when /sitemap.xml is 404 (issue #32)', async () => {
    handler = (path) => {
      if (path === '/sitemap.xml') return { status: 404, body: '' }
      if (path === '/sitemap-index.xml') return { status: 200, body: '<sitemapindex></sitemapindex>' }
      return { status: 404, body: '' }
    }
    expect(await discoverSitemapUrl(origin, ALLOW_LOOPBACK)).toBe(`${origin}/sitemap-index.xml`)
  })

  it('falls back to robots.txt Sitemap directive when both default paths 404', async () => {
    handler = (path) => {
      if (path === '/robots.txt') {
        return {
          status: 200,
          body: `User-agent: *\nSitemap: ${origin}/custom/path/sitemap.xml\n`,
          contentType: 'text/plain',
        }
      }
      return { status: 404, body: '' }
    }
    expect(await discoverSitemapUrl(origin, ALLOW_LOOPBACK)).toBe(`${origin}/custom/path/sitemap.xml`)
  })

  it('returns null when no sitemap is found anywhere', async () => {
    handler = () => ({ status: 404, body: '' })
    expect(await discoverSitemapUrl(origin, ALLOW_LOOPBACK)).toBeNull()
  })

  it('ignores non-XML 200 responses (e.g. HTML 200 from a SPA catch-all route)', async () => {
    handler = (path) => {
      if (path === '/sitemap.xml') return { status: 200, body: '<!doctype html><html>...</html>', contentType: 'text/html' }
      if (path === '/sitemap-index.xml') return { status: 200, body: '<sitemapindex></sitemapindex>' }
      return { status: 404, body: '' }
    }
    expect(await discoverSitemapUrl(origin, ALLOW_LOOPBACK)).toBe(`${origin}/sitemap-index.xml`)
  })

  it('propagates the caller abort reason during sitemap discovery', async () => {
    const controller = new AbortController()
    const reason = new Error('caller cancelled sitemap discovery')

    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) {
          reject(new Error('expected fetch signal'))
          return
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    ))

    const promise = discoverSitemapUrl('http://1.1.1.1', { signal: controller.signal })
    await new Promise((resolve) => setImmediate(resolve))
    controller.abort(reason)

    await expect(promise).rejects.toBe(reason)
  })
})

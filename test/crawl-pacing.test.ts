import { afterEach, describe, expect, test, vi } from 'vitest'

import { runSiteCrawl } from '../src/index.js'

const html = (body: string) => new Response(`<!doctype html><html><body>${body}</body></html>`, {
  status: 200,
  headers: { 'content-type': 'text/html' },
})

afterEach(() => vi.unstubAllGlobals())

describe('full-crawl request pacing', () => {
  test('applies Crawl-delay before the first request after robots.txt', async () => {
    const starts: Array<{ path: string; at: number }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/robots.txt') return new Response('User-agent: *\nCrawl-delay: 0.03\n')
      if (url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt' || url.pathname === '/map.xml') {
        return new Response('', { status: 404 })
      }
      return html('<p>root</p>')
    }))

    await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      sitemapUrl: 'https://example.test/map.xml',
      onOutboundAttempt: (attempt) => {
        const path = new URL(attempt.url).pathname
        if (path === '/robots.txt' || path === '/llms.txt') starts.push({ path, at: Date.now() })
      },
    })

    const robots = starts.find((entry) => entry.path === '/robots.txt')!
    const llms = starts.find((entry) => entry.path === '/llms.txt')!
    expect(llms.at - robots.at).toBeGreaterThanOrEqual(20)
  })

  test('spaces concurrent page starts by the explicit request delay', async () => {
    const starts: Array<{ path: string; at: number }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/robots.txt' || url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt' || url.pathname === '/map.xml') {
        return new Response('', { status: 404 })
      }
      if (url.pathname === '/') return html('<a href="/a">a</a><a href="/b">b</a>')
      return html('<p>child</p>')
    }))

    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      sitemapUrl: 'https://example.test/map.xml',
      concurrency: 2,
      requestDelayMs: 20,
      onOutboundAttempt: (attempt) => {
        const path = new URL(attempt.url).pathname
        if (path === '/a' || path === '/b') starts.push({ path, at: Date.now() })
      },
    })

    expect(report.summary.pacing).toMatchObject({ requestedDelayMs: 20, effectiveDelayMs: 20 })
    expect(starts).toHaveLength(2)
    expect(Math.abs(starts[1]!.at - starts[0]!.at)).toBeGreaterThanOrEqual(15)
  })

  test('honors Crawl-delay but ignores it when robots behavior is disabled', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/robots.txt') return new Response('User-agent: *\nCrawl-delay: 60\n')
      if (url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt' || url.pathname === '/map.xml') {
        return new Response('', { status: 404 })
      }
      return html('<p>root</p>')
    })
    vi.stubGlobal('fetch', fetchMock)

    const bounded = await Promise.race([
      runSiteCrawl('https://example.test/', {
        allowPrivateHost: 'example.test', sitemapUrl: 'https://example.test/map.xml', maxDurationMs: 30,
      }),
      new Promise<'stalled'>((resolve) => setTimeout(() => resolve('stalled'), 250)),
    ])
    expect(bounded).not.toBe('stalled')
    if (bounded === 'stalled') throw new Error('crawl delay ignored the crawl deadline')
    expect(bounded.summary).toMatchObject({
      complete: false,
      terminationReason: 'max-duration',
      pacing: { robotsCrawlDelayMs: 60_000, effectiveDelayMs: 60_000 },
    })

    const ignored = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      sitemapUrl: 'https://example.test/map.xml',
      respectRobots: false,
      maxDurationMs: 100,
    })
    expect(ignored.summary.complete).toBe(true)
    expect(ignored.summary.pacing).toMatchObject({ robotsCrawlDelayMs: 60_000, effectiveDelayMs: 0 })
  })

  test('paces each followed redirect hop', async () => {
    const starts: Array<{ path: string; at: number }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/robots.txt' || url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt' || url.pathname === '/map.xml') {
        return new Response('', { status: 404 })
      }
      if (url.pathname === '/') return html('<a href="/go">go</a>')
      if (url.pathname === '/go') return new Response('', { status: 302, headers: { location: '/target' } })
      return html('<p>target</p>')
    }))

    await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      sitemapUrl: 'https://example.test/map.xml',
      requestDelayMs: 20,
      onOutboundAttempt: (attempt) => {
        const path = new URL(attempt.url).pathname
        if (path === '/go' || path === '/target') starts.push({ path, at: Date.now() })
      },
    })

    expect(starts.map((start) => start.path)).toEqual(['/go', '/target'])
    expect(starts[1]!.at - starts[0]!.at).toBeGreaterThanOrEqual(15)
  })
})

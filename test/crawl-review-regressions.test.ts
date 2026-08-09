import { afterEach, describe, expect, test, vi } from 'vitest'

import { normalizeCrawlUrl, runSiteCrawl } from '../src/index.js'

const html = (body: string) => new Response(`<!doctype html><html><body>${body}</body></html>`, {
  status: 200,
  headers: { 'content-type': 'text/html' },
})

afterEach(() => vi.unstubAllGlobals())

describe('full-crawl review regressions', () => {
  test('preserves semantic ref, source, and campaign query parameters', () => {
    expect(normalizeCrawlUrl('https://example.test/page?ref=chapter-2&source=knowledge-base&campaign=fall&utm_source=mail&gclid=click'))
      .toBe('https://example.test/page?campaign=fall&ref=chapter-2&source=knowledge-base')
  })

  test('reports an off-host root redirect as an explicit partial crawl without following it', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      requested.push(url.toString())
      if (url.pathname === '/robots.txt' || url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt' || url.pathname === '/map.xml') {
        return new Response('', { status: 404 })
      }
      return new Response('', { status: 301, headers: { location: 'https://www.example.test/' } })
    }))

    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      sitemapUrl: 'https://example.test/map.xml',
    })

    expect(requested).not.toContain('https://www.example.test/')
    expect(report.summary).toMatchObject({
      complete: false,
      terminationReason: 'root-host-redirect',
      finalRootUrl: 'https://www.example.test/',
      warnings: [expect.objectContaining({ code: 'root-host-redirect' })],
    })
  })

  test('surfaces an ignored off-host robots redirect without requesting its target', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      requested.push(url.toString())
      if (url.pathname === '/robots.txt') {
        return new Response('', { status: 302, headers: { location: 'https://policy.example.test/robots.txt' } })
      }
      if (url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt' || url.pathname === '/map.xml') {
        return new Response('', { status: 404 })
      }
      return html('<p>root</p>')
    }))

    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      sitemapUrl: 'https://example.test/map.xml',
    })

    expect(requested).not.toContain('https://policy.example.test/robots.txt')
    expect(report.summary.warnings).toContainEqual(expect.objectContaining({
      code: 'robots-host-redirect',
      to: 'https://policy.example.test/robots.txt',
    }))
  })

  test('matches robots rules against the normalized URL that is actually fetched', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      requested.push(url.toString())
      if (url.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /private?a=1&sessionid=x\n')
      if (url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt' || url.pathname === '/map.xml') {
        return new Response('', { status: 404 })
      }
      return html('<a href="/private?sessionid=x&a=1&utm_source=mail">private</a>')
    }))

    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      sitemapUrl: 'https://example.test/map.xml',
    })
    if (report.mode !== 'full') throw new Error('expected full report')

    expect(report.pages.find((page) => page.requestedUrl === 'https://example.test/private?a=1&sessionid=x')?.state)
      .toBe('robots-blocked')
    expect(requested).not.toContain('https://example.test/private?a=1&sessionid=x')
  })

  test('cancels unread HTTP error bodies', async () => {
    const cancel = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/robots.txt' || url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt' || url.pathname === '/map.xml') {
        return new Response('', { status: 404 })
      }
      if (url.pathname === '/') return html('<a href="/gone">gone</a>')
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('not found'))
        },
        cancel,
      }), { status: 404, headers: { 'content-type': 'text/html' } })
    }))

    await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      sitemapUrl: 'https://example.test/map.xml',
    })

    expect(cancel).toHaveBeenCalledOnce()
  })

  test('uses one sitemap parser for numeric entity references in child and page locations', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      requested.push(url.toString())
      if (url.pathname === '/robots.txt' || url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt') {
        return new Response('', { status: 404 })
      }
      if (url.pathname === '/map.xml') {
        return new Response('<sitemapindex><sitemap><loc>https://example.test/child.xml?kind=index&#38;page=2</loc></sitemap></sitemapindex>')
      }
      if (url.pathname === '/child.xml' && url.search === '?kind=index&page=2') {
        return new Response('<urlset><url><loc>https://example.test/target?ref=chapter&#38;page=2</loc></url></urlset>')
      }
      return html('<p>page</p>')
    }))

    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      sitemapUrl: 'https://example.test/map.xml',
    })
    if (report.mode !== 'full') throw new Error('expected full report')

    expect(requested).toContain('https://example.test/child.xml?kind=index&page=2')
    expect(report.pages.some((page) => page.requestedUrl === 'https://example.test/target?page=2&ref=chapter')).toBe(true)
  })

  test('preserves explicit text/html fragment handling in the crawl path', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/robots.txt' || url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt' || url.pathname === '/map.xml') {
        return new Response('', { status: 404 })
      }
      if (url.pathname === '/') return html('<a href="/payload">payload</a>')
      return new Response('<p>fragment</p>', { headers: { 'content-type': 'text/html' } })
    }))

    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      sitemapUrl: 'https://example.test/map.xml',
    })
    if (report.mode !== 'full') throw new Error('expected full report')

    expect(report.pages.find((page) => page.requestedUrl.endsWith('/payload'))?.state).toBe('html')
  })
})

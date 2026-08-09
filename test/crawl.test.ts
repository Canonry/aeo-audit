import { afterEach, describe, expect, test, vi } from 'vitest'

import { normalizeCrawlUrl, runSiteCrawl } from '../src/index.js'

const html = (body: string, contentType = 'text/html') => new Response(`<!doctype html><html><body>${body}</body></html>`, {
  status: 200,
  headers: { 'content-type': contentType },
})

afterEach(() => vi.unstubAllGlobals())

describe('runSiteCrawl', () => {
  test('normalizes URLs without changing meaningful path or query variants', () => {
    expect(normalizeCrawlUrl('HTTPS://Example.TEST:443/Foo/?b=2&utm_source=x&a=1#part'))
      .toBe('https://example.test/Foo/?a=1&b=2')
    expect(() => normalizeCrawlUrl('mailto:owner@example.test', 'https://example.test/')).toThrow('Unsupported crawl URL protocol')
  })

  test('walks a bounded host-scoped BFS once across cycles and tracking aliases', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      requested.push(url.toString())
      if (url.pathname === '/robots.txt') return new Response('', { status: 404 })
      if (url.pathname === '/sitemap.xml' || url.pathname === '/sitemap-index.xml') return new Response('', { status: 404 })
      if (url.pathname === '/') return html('<a href="/a?utm_source=mail">A</a><a href="/a">again</a><a href="https://outside.test/x">outside</a>')
      if (url.pathname === '/a') return html('<a href="/">home</a><a href="/b?variant=1">B</a>')
      if (url.pathname === '/b') return html('<p>done</p>')
      return new Response('missing', { status: 404 })
    }))

    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      maxPages: 10,
    })

    expect(report.mode).toBe('full')
    if (report.mode !== 'full') throw new Error('expected full report')
    expect(report.pages.filter((page) => page.state === 'html').map((page) => page.finalUrl).sort())
      .toEqual(['https://example.test/', 'https://example.test/a', 'https://example.test/b?variant=1'])
    expect(requested).not.toContain('https://outside.test/x')
    expect(report.edges.some((edge) => edge.classification === 'external')).toBe(true)
  })

  test('uses robots sitemap directives recursively and records robots-blocked URLs', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /private\nSitemap: https://example.test/index.xml\n')
      if (url.pathname === '/sitemap.xml' || url.pathname === '/sitemap-index.xml') return new Response('', { status: 404 })
      if (url.pathname === '/index.xml') return new Response('<sitemapindex><sitemap><loc>https://example.test/urls.xml</loc></sitemap></sitemapindex>', { headers: { 'content-type': 'application/xml' } })
      if (url.pathname === '/urls.xml') return new Response('<urlset><url><loc>https://example.test/private</loc></url><url><loc>https://example.test/public</loc></url></urlset>', { headers: { 'content-type': 'application/xml' } })
      if (url.pathname === '/') return html('<p>root</p>')
      if (url.pathname === '/public') return html('<p>public</p>')
      return new Response('missing', { status: 404 })
    }))

    const report = await runSiteCrawl('https://example.test/', { allowPrivateHost: 'example.test' })
    if (report.mode !== 'full') throw new Error('expected full report')
    expect(report.pages.find((page) => page.requestedUrl.endsWith('/private'))?.state).toBe('robots-blocked')
    expect(report.pages.some((page) => page.finalUrl?.endsWith('/public') && page.state === 'html')).toBe(true)
  })

  test('honors an end-anchored robots rule without blocking descendant paths', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /private$\n')
      if (url.pathname === '/map.xml') {
        return new Response('<urlset><url><loc>https://example.test/private</loc></url><url><loc>https://example.test/private/child</loc></url></urlset>')
      }
      return html('<p>page</p>')
    }))

    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test', sitemapUrl: 'https://example.test/map.xml',
    })
    if (report.mode !== 'full') throw new Error('expected full report')
    expect(report.pages.find((page) => page.requestedUrl.endsWith('/private'))?.state).toBe('robots-blocked')
    expect(report.pages.find((page) => page.requestedUrl.endsWith('/private/child'))?.state).toBe('html')
  })

  test('does not probe external links by default and derives internal broken-link findings only when enabled', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      requested.push(url.toString())
      if (url.pathname === '/robots.txt') return new Response('', { status: 404 })
      if (url.pathname === '/sitemap.xml' || url.pathname === '/sitemap-index.xml') return new Response('', { status: 404 })
      if (url.pathname === '/') return html('<a href="/gone">gone</a><a href="https://outside.test/never">outside</a>')
      if (url.pathname === '/gone') return new Response('gone', { status: 404, headers: { 'content-type': 'text/html' } })
      return new Response('missing', { status: 404 })
    }))

    const disabled = await runSiteCrawl('https://example.test/', { allowPrivateHost: 'example.test' })
    expect(disabled.deadLinks.state).toBe('disabled')
    expect(requested).not.toContain('https://outside.test/never')
    const enabled = await runSiteCrawl('https://example.test/', { allowPrivateHost: 'example.test', checkDeadLinks: true })
    expect(enabled.deadLinks.state).toBe('complete')
    expect(enabled.deadLinks.findings).toHaveLength(1)
  })

  test('resolves an observed redirect before classifying an internal dead link', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/robots.txt' || url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt' || url.pathname === '/map.xml') {
        return new Response('', { status: 404 })
      }
      if (url.pathname === '/') return html('<a href="/go">go</a>')
      if (url.pathname === '/go') return new Response('', { status: 302, headers: { location: '/gone' } })
      return new Response('gone', { status: 404, headers: { 'content-type': 'text/html' } })
    }))

    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test', sitemapUrl: 'https://example.test/map.xml', checkDeadLinks: true,
    })
    expect(report.deadLinks).toMatchObject({
      state: 'complete',
      findings: [{ from: 'https://example.test/', to: 'https://example.test/go', statusCode: 404, reason: 'http-error' }],
    })
  })

  test('emits checkpoint-safe batches and returns a graph-free summary mode', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/robots.txt') return new Response('', { status: 404 })
      if (url.pathname === '/sitemap.xml' || url.pathname === '/sitemap-index.xml') return new Response('', { status: 404 })
      return html(url.pathname === '/' ? '<a href="/a" rel="nofollow">a</a>' : '<p>a</p>')
    }))
    const events: Array<{ sequence: number; batchId: string; checksum: string; type: string }> = []
    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      mode: 'summary',
      onEvent: async (event) => { events.push(event) },
    })

    expect(report.mode).toBe('summary')
    expect(report).not.toHaveProperty('pages')
    expect(events.map((event) => event.sequence)).toEqual([...events.keys()].map((index) => index + 1))
    expect(events.every((event) => event.batchId && event.checksum)).toBe(true)
  })

  test('re-emits a page checkpoint when later links extend its provenance', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/robots.txt' || url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt' || url.pathname === '/map.xml') {
        return new Response('', { status: 404 })
      }
      if (url.pathname === '/') return html('<a href="/target">target</a><a href="/chain">chain</a>')
      if (url.pathname === '/chain') return html('<a href="/deep">deep</a>')
      if (url.pathname === '/deep') return html('<a href="/target">target again</a>')
      return html('<p>target</p>')
    }))
    const targetEvents: Array<{ batchId: string; discoveredFrom: string[] }> = []
    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      sitemapUrl: 'https://example.test/map.xml',
      mode: 'summary',
      onEvent: (event) => {
        if (event.type !== 'pages') return
        for (const page of event.rows) {
          if (page.requestedUrl.endsWith('/target')) {
            targetEvents.push({ batchId: event.batchId, discoveredFrom: page.provenance.discoveredFrom })
          }
        }
      },
    })

    expect(report.mode).toBe('summary')
    expect(targetEvents).toHaveLength(2)
    expect(targetEvents[1]!.discoveredFrom).toEqual([
      'https://example.test/',
      'https://example.test/deep',
    ])
    expect(targetEvents[0]!.batchId).not.toBe(targetEvents[1]!.batchId)
  })

  test('records redirects, non-HTML responses, and HTTP failures without aborting the BFS', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/robots.txt') return new Response('', { status: 404 })
      if (url.pathname === '/sitemap.xml' || url.pathname === '/sitemap-index.xml') return new Response('', { status: 404 })
      if (url.pathname === '/') return html('<a href="/go">go</a><a href="/json">json</a><a href="/gone">gone</a>')
      if (url.pathname === '/go') return new Response('', { status: 302, headers: { location: '/target' } })
      if (url.pathname === '/target') return html('<p>target</p>')
      if (url.pathname === '/json') return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
      if (url.pathname === '/gone') return new Response('gone', { status: 404, headers: { 'content-type': 'text/html' } })
      return new Response('missing', { status: 404 })
    }))
    const report = await runSiteCrawl('https://example.test/', { allowPrivateHost: 'example.test' })
    if (report.mode !== 'full') throw new Error('expected full report')
    expect(report.pages.map((page) => page.state)).toEqual(expect.arrayContaining(['redirect', 'html', 'non-html', 'fetch-error']))
    expect(report.edges.some((edge) => edge.type === 'redirect' && edge.from.endsWith('/go') && edge.to.endsWith('/target'))).toBe(true)
  })

  test('analyzes a separately scheduled redirect target once and gives it terminal page identity', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/robots.txt' || url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt' || url.pathname === '/map.xml') {
        return new Response('', { status: 404 })
      }
      if (url.pathname === '/') return html('<a href="/alias">alias</a><a href="/target">target</a>')
      if (url.pathname === '/alias') return new Response('', { status: 302, headers: { location: '/target' } })
      if (url.pathname === '/target') return html('<a href="/leaf">leaf</a>')
      return html('<p>leaf</p>')
    }))

    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test', sitemapUrl: 'https://example.test/map.xml', concurrency: 2,
    })
    if (report.mode !== 'full') throw new Error('expected full report')
    const edge = report.edges.find((candidate) => candidate.from.endsWith('/target') && candidate.to.endsWith('/leaf'))!
    const terminal = report.pages.find((page) => page.requestedUrl.endsWith('/target') && page.state === 'html')!
    const alias = report.pages.find((page) => page.requestedUrl.endsWith('/alias'))!
    expect(edge.totalOccurrences).toBe(1)
    expect(terminal.audit?.url).toBe('https://example.test/target')
    expect(terminal.metrics.outbound).toEqual({ totalOccurrences: 1, uniqueEdges: 1 })
    expect(alias.metrics.outbound).toEqual({ totalOccurrences: 0, uniqueEdges: 0 })
  })

  test('keeps an internal redirect terminal within the page cap', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      requested.push(url.pathname)
      if (url.pathname === '/robots.txt' || url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt' || url.pathname === '/map.xml') {
        return new Response('', { status: 404 })
      }
      if (url.pathname === '/') return new Response('', { status: 302, headers: { location: '/target' } })
      return html('<a href="/must-not-be-parsed">leaf</a>')
    }))

    const pageEvents: string[][] = []
    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      sitemapUrl: 'https://example.test/map.xml',
      maxPages: 1,
      onEvent: (event) => {
        if (event.type === 'pages') pageEvents.push(event.rows.map((page) => page.requestedUrl))
      },
    })
    if (report.mode !== 'full') throw new Error('expected full report')

    expect(report.pages).toHaveLength(1)
    expect(report.pages[0]).toMatchObject({
      requestedUrl: 'https://example.test/',
      finalUrl: 'https://example.test/target',
      state: 'redirect',
    })
    expect(report.summary).toMatchObject({
      finalRootUrl: 'https://example.test/target',
      pagesObserved: 1,
      complete: false,
      terminationReason: 'max-pages',
    })
    expect(report.edges).toEqual([
      expect.objectContaining({ type: 'redirect', from: 'https://example.test/', to: 'https://example.test/target' }),
    ])
    expect(requested.filter((path) => path === '/target')).toHaveLength(1)
    expect(pageEvents.flat()).toEqual(['https://example.test/'])
  })

  test('admits the same redirect terminal at a page cap regardless of concurrent response order', async () => {
    const run = async (delays: Record<string, number>) => {
      vi.stubGlobal('fetch', vi.fn(async (input: string) => {
        const url = new URL(input)
        if (url.pathname === '/robots.txt' || url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt' || url.pathname === '/map.xml') {
          return new Response('', { status: 404 })
        }
        if (url.pathname === '/') return html('<a href="/a">a</a><a href="/b">b</a>')
        if (url.pathname === '/a') return new Response('', { status: 302, headers: { location: '/z' } })
        if (url.pathname === '/b') return new Response('', { status: 302, headers: { location: '/c' } })
        await new Promise((resolve) => setTimeout(resolve, delays[url.pathname] ?? 0))
        return html('<p>terminal</p>')
      }))
      const report = await runSiteCrawl('https://example.test/', {
        allowPrivateHost: 'example.test', sitemapUrl: 'https://example.test/map.xml', concurrency: 2, maxPages: 4,
      })
      if (report.mode !== 'full') throw new Error('expected full report')
      return report.pages.map((page) => page.requestedUrl).sort()
    }

    const cFirst = await run({ '/c': 1, '/z': 30 })
    const zFirst = await run({ '/c': 30, '/z': 1 })

    expect(cFirst).toEqual(zFirst)
    expect(cFirst).toContain('https://example.test/c')
  })

  test('computes deterministic link scores and excludes nofollow paths from anchor depth', async () => {
    const handler = vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/robots.txt') return new Response('', { status: 404 })
      if (url.pathname === '/map.xml') return new Response('<urlset><url><loc>https://example.test/orphan</loc></url></urlset>')
      if (url.pathname === '/') return html('<a href="/follow">follow</a><a href="/nofollow" rel="nofollow">nofollow</a>')
      return html('<p>leaf</p>')
    })
    vi.stubGlobal('fetch', handler)
    const options = { allowPrivateHost: 'example.test', sitemapUrl: 'https://example.test/map.xml' }
    const first = await runSiteCrawl('https://example.test/', options)
    const second = await runSiteCrawl('https://example.test/', options)
    if (first.mode !== 'full' || second.mode !== 'full') throw new Error('expected full reports')
    const byPath = (report: typeof first, path: string) => report.pages.find((page) => new URL(page.finalUrl ?? page.requestedUrl).pathname === path)!
    expect(byPath(first, '/follow').metrics.shortestFollowableAnchorDepth).toBe(1)
    expect(byPath(first, '/nofollow').metrics.shortestFollowableAnchorDepth).toBeNull()
    expect(byPath(first, '/orphan').metrics.shortestFollowableAnchorDepth).toBeNull()
    expect(first.pages.map((page) => [page.key, page.metrics.linkScoreRaw])).toEqual(second.pages.map((page) => [page.key, page.metrics.linkScoreRaw]))
  })

  test('indexes followable adjacency instead of rescanning the full graph for every BFS node', async () => {
    const nodes = Array.from({ length: 20 }, (_, index) => `/node-${index}`)
    const links = nodes.map((path) => `<a href="${path}">${path}</a>`).join('')
    const expectedEdgeCount = nodes.length + nodes.length ** 2
    let fullGraphFilters = 0
    const originalFilter = Array.prototype.filter
    const filterSpy = vi.spyOn(Array.prototype, 'filter').mockImplementation(function <T>(
      this: T[],
      predicate: (value: T, index: number, array: T[]) => unknown,
      thisArg?: unknown,
    ): T[] {
      if (this.length === expectedEdgeCount) fullGraphFilters += 1
      return originalFilter.call(this, predicate, thisArg)
    })
    try {
      vi.stubGlobal('fetch', vi.fn(async (input: string) => {
        const url = new URL(input)
        if (url.pathname === '/robots.txt' || url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt' || url.pathname === '/map.xml') {
          return new Response('', { status: 404 })
        }
        return html(url.pathname === '/' ? links : links)
      }))
      const report = await runSiteCrawl('https://example.test/', {
        allowPrivateHost: 'example.test', sitemapUrl: 'https://example.test/map.xml', concurrency: nodes.length, maxPages: nodes.length + 1,
      })
      if (report.mode !== 'full') throw new Error('expected full report')
      expect(report.pages).toHaveLength(nodes.length + 1)
      expect(fullGraphFilters).toBeLessThanOrEqual(2)
    } finally {
      filterSpy.mockRestore()
    }
  })

  test('applies page-level nofollow and keeps per-page link counts internal-only', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/robots.txt' || url.pathname === '/map.xml') return new Response('', { status: 404 })
      if (url.pathname === '/') {
        return html('<meta name="robots" content="nofollow"><a href="/a">internal</a><a href="https://outside.test/x">external</a>')
      }
      return html('<p>leaf</p>')
    }))

    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test', sitemapUrl: 'https://example.test/map.xml',
    })
    if (report.mode !== 'full') throw new Error('expected full report')
    const internal = report.edges.find((edge) => edge.type === 'anchor' && edge.to.endsWith('/a'))!
    const root = report.pages.find((page) => page.finalUrl === 'https://example.test/')!
    const child = report.pages.find((page) => page.finalUrl?.endsWith('/a'))!
    expect(internal).toMatchObject({ followableOccurrences: 0, nofollowOccurrences: 1 })
    expect(root.metrics.outbound).toEqual({ totalOccurrences: 1, uniqueEdges: 1 })
    expect(child.metrics.shortestFollowableAnchorDepth).toBeNull()
  })

  test('returns an explicit truncation reason when a frontier cannot be exhausted', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/robots.txt' || url.pathname === '/map.xml') return new Response('', { status: 404 })
      return html(url.pathname === '/' ? '<a href="/a">a</a><a href="/b">b</a>' : '<p>leaf</p>')
    }))
    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      sitemapUrl: 'https://example.test/map.xml',
      maxPages: 1,
    })
    expect(report.summary.complete).toBe(false)
    expect(report.summary.terminationReason).toBe('max-pages')
  })

  test('counts depth-truncated observations against the page cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/robots.txt' || url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt' || url.pathname === '/map.xml') {
        return new Response('', { status: 404 })
      }
      return html('<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a>')
    }))

    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test', sitemapUrl: 'https://example.test/map.xml', maxDepth: 0, maxPages: 2,
    })
    if (report.mode !== 'full') throw new Error('expected full report')

    expect(report.pages).toHaveLength(2)
    expect(report.summary.pagesObserved).toBe(2)
    expect(report.pages.filter((page) => page.state === 'discovered')).toHaveLength(1)
  })

  test('returns a partial crawl when a response exceeds maxPageBytes', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/robots.txt' || url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt' || url.pathname === '/map.xml') {
        return new Response('', { status: 404 })
      }
      return html('<html><body>response larger than the configured page cap</body></html>')
    }))

    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test', sitemapUrl: 'https://example.test/map.xml', maxPageBytes: 10,
    })
    expect(report.summary).toMatchObject({ complete: false, terminationReason: 'max-page-bytes' })
  })

  test('finishes already admitted pages when later discoveries hit the page cap', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      requested.push(url.pathname)
      if (url.pathname === '/robots.txt' || url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt' || url.pathname === '/map.xml') {
        return new Response('', { status: 404 })
      }
      return html(url.pathname === '/' ? '<a href="/a">a</a><a href="/b">b</a>' : '<p>leaf</p>')
    }))
    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test', sitemapUrl: 'https://example.test/map.xml', maxPages: 2,
    })
    if (report.mode !== 'full') throw new Error('expected full report')
    expect(report.pages.filter((page) => page.state === 'html')).toHaveLength(2)
    expect(requested).toContain('/a')
    expect(report.summary).toMatchObject({ complete: false, terminationReason: 'max-pages' })
  })

  test('preserves AbortSignal reasons and propagates checkpoint failures', async () => {
    const reason = new Error('caller stopped crawl')
    const controller = new AbortController()
    controller.abort(reason)
    await expect(runSiteCrawl('https://example.test/', { signal: controller.signal })).rejects.toBe(reason)

    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml' || url.pathname === '/sitemap-index.xml') return new Response('', { status: 404 })
      return html('<p>root</p>')
    }))
    await expect(runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      onEvent: () => { throw new Error('checkpoint unavailable') },
    })).rejects.toThrow('checkpoint unavailable')
  })

  test('applies crawl duration and caller cancellation while a response body is stalled', async () => {
    const stalledResponse = (): Response => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('<html>'))
      },
    }), { status: 200, headers: { 'content-type': 'text/html' } })
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/robots.txt' || url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt' || url.pathname === '/map.xml') {
        return new Response('', { status: 404 })
      }
      return stalledResponse()
    }))

    const durationResult = await Promise.race([
      runSiteCrawl('https://example.test/', {
        allowPrivateHost: 'example.test', sitemapUrl: 'https://example.test/map.xml', maxDurationMs: 20,
      }),
      new Promise<'stalled'>((resolve) => setTimeout(() => resolve('stalled'), 250)),
    ])
    expect(durationResult).not.toBe('stalled')
    if (durationResult === 'stalled') throw new Error('crawl duration was not enforced')
    expect(durationResult.summary).toMatchObject({ complete: false, terminationReason: 'max-duration' })

    const controller = new AbortController()
    const reason = new Error('cancel stalled body')
    const crawl = runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test', sitemapUrl: 'https://example.test/map.xml', signal: controller.signal,
    })
    setTimeout(() => controller.abort(reason), 10)
    const abortResult = await Promise.race([
      crawl.then(() => null, (error: unknown) => error),
      new Promise<'stalled'>((resolve) => setTimeout(() => resolve('stalled'), 250)),
    ])
    expect(abortResult).toBe(reason)
  })

  test('validates factors before fetching and forwards includeLighthouse', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.hostname === 'www.googleapis.com') {
        return new Response(JSON.stringify({
          lighthouseResult: {
            categories: {
              performance: { title: 'Performance', score: 1 },
              accessibility: { title: 'Accessibility', score: 1 },
              'best-practices': { title: 'Best Practices', score: 1 },
            },
            audits: {},
          },
        }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.pathname === '/robots.txt' || url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt' || url.pathname === '/map.xml') {
        return new Response('', { status: 404 })
      }
      return html('<p>root</p>')
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test', sitemapUrl: 'https://example.test/map.xml', factors: ['not-a-factor'],
    })).rejects.toMatchObject({ code: 'BAD_INPUT' })
    expect(fetchMock).not.toHaveBeenCalled()

    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test', sitemapUrl: 'https://example.test/map.xml', includeLighthouse: true,
    })
    if (report.mode !== 'full') throw new Error('expected full report')
    expect(report.pages.find((page) => page.provenance.root)?.audit?.factors.some((factor) => factor.id === 'lighthouse')).toBe(true)
  })

  test('does not follow an out-of-scope redirect hop, including a private target', async () => {
    const attempts: string[] = []
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      requested.push(url.toString())
      if (url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml' || url.pathname === '/sitemap-index.xml') return new Response('', { status: 404 })
      return new Response('', { status: 302, headers: { location: 'http://127.0.0.1/secret' } })
    }))
    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      onOutboundAttempt: (attempt) => { attempts.push(attempt.url) },
    })
    expect(requested).not.toContain('http://127.0.0.1/secret')
    expect(attempts).not.toContain('http://127.0.0.1/secret')
    if (report.mode !== 'full') throw new Error('expected full report')
    expect(report.pages.find((page) => page.provenance.root)?.state).toBe('redirect')
  })

  test('reserves the root before sitemap locations and reuses one global auxiliary snapshot', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      requested.push(url.pathname)
      if (url.pathname === '/robots.txt') return new Response('Sitemap: https://example.test/map.xml')
      if (url.pathname === '/llms.txt') return new Response('# llms')
      if (url.pathname === '/llms-full.txt') return new Response('# full')
      if (url.pathname === '/map.xml') return new Response('<urlset><url><loc>https://example.test/sitemap-page</loc></url></urlset>')
      if (url.pathname === '/') return html('<a href="/linked">linked</a>')
      return html('<p>child</p>')
    }))
    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      sitemapUrl: 'https://example.test/map.xml',
      maxPages: 1,
    })
    if (report.mode !== 'full') throw new Error('expected full report')
    const root = report.pages.find((page) => page.provenance.root)
    expect(root?.state).toBe('html')
    expect(root?.audit?.metadata.auxiliary).toMatchObject({ llmsTxt: 'ok', llmsFullTxt: 'ok', robotsTxt: 'ok', sitemapXml: 'ok' })
    expect(requested.filter((path) => path === '/llms.txt')).toHaveLength(1)
    expect(requested.filter((path) => path === '/llms-full.txt')).toHaveLength(1)
  })

  test('admits sitemap seeds before link-only discoveries when the page budget is capped', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/robots.txt' || url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt') return new Response('', { status: 404 })
      if (url.pathname === '/map.xml') return new Response('<urlset><url><loc>https://example.test/orphan</loc></url></urlset>')
      if (url.pathname === '/') return html('<a href="/linked">linked</a>')
      return html('<p>child</p>')
    }))

    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test', sitemapUrl: 'https://example.test/map.xml', maxPages: 2,
    })
    if (report.mode !== 'full') throw new Error('expected full report')
    const urls = report.pages.map((page) => page.requestedUrl)
    expect(urls).toContain('https://example.test/')
    expect(urls).toContain('https://example.test/orphan')
    expect(urls).not.toContain('https://example.test/linked')
  })

  test('counts unique sitemap URLs against the sitemap URL budget', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/robots.txt' || url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt') return new Response('', { status: 404 })
      if (url.pathname === '/map.xml') {
        return new Response('<urlset><url><loc>https://example.test/a</loc></url><url><loc>https://example.test/a</loc></url><url><loc>https://example.test/b</loc></url></urlset>')
      }
      return html('<p>page</p>')
    }))

    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test', sitemapUrl: 'https://example.test/map.xml', maxSitemapUrls: 2,
    })
    if (report.mode !== 'full') throw new Error('expected full report')
    expect(report.pages.map((page) => page.requestedUrl)).toEqual(expect.arrayContaining([
      'https://example.test/a',
      'https://example.test/b',
    ]))
  })

  test('reserves the only fetch slot for the explicit root instead of optional discovery files', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      requested.push(url.pathname)
      return html('<p>root</p>')
    }))
    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      maxFetches: 1,
    })
    if (report.mode !== 'full') throw new Error('expected full report')
    expect(requested).toEqual(['/'])
    expect(report.pages.find((page) => page.provenance.root)?.state).toBe('html')
  })

  test('marks a terminal redirect as non-indexable/unknown and batches repeated anchor occurrences', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/robots.txt' || url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt' || url.pathname === '/map.xml') return new Response('', { status: 404 })
      if (url.pathname === '/') return html(`${Array.from({ length: 100 }, () => '<a href="/a">A</a>').join('')}<a href="/go">go</a>`)
      if (url.pathname === '/go') return new Response('', { status: 302, headers: { location: 'https://outside.test/' } })
      return html('<p>a</p>')
    }))
    const edgeEvents: Array<{ rows: Array<{ to: string; totalOccurrences: number }> }> = []
    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      sitemapUrl: 'https://example.test/map.xml',
      onEvent: (event) => { if (event.type === 'edges') edgeEvents.push(event) },
    })
    if (report.mode !== 'full') throw new Error('expected full report')
    const redirect = report.pages.find((page) => page.requestedUrl.endsWith('/go'))!
    expect(redirect.indexability).toMatchObject({ state: 'unknown', reasons: ['redirect-terminal'] })
    const repeated = report.edges.find((edge) => edge.type === 'anchor' && edge.to.endsWith('/a'))!
    expect(repeated.totalOccurrences).toBe(100)
    expect(edgeEvents.filter((event) => event.rows.some((row) => row.to.endsWith('/a')))).toHaveLength(1)
  })

  test('keeps checkpoint identities and checksums identical in full and summary modes', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/robots.txt' || url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt' || url.pathname === '/map.xml') return new Response('', { status: 404 })
      return html(url.pathname === '/' ? '<a href="/a">a</a>' : '<p>a</p>')
    }))
    const run = async (mode: 'full' | 'summary') => {
      const batches: Array<[string, string, string]> = []
      await runSiteCrawl('https://example.test/', {
        allowPrivateHost: 'example.test',
        sitemapUrl: 'https://example.test/map.xml',
        mode,
        onEvent: (event) => { batches.push([event.type, event.batchId, event.checksum]) },
      })
      return batches
    }
    expect(await run('full')).toEqual(await run('summary'))
  })

  test('honors the requested bounded crawl concurrency', async () => {
    let active = 0
    let maximum = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/robots.txt' || url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt' || url.pathname === '/map.xml') return new Response('', { status: 404 })
      if (url.pathname === '/') return html('<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a>')
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active -= 1
      return html('<p>child</p>')
    }))
    await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      sitemapUrl: 'https://example.test/map.xml',
      concurrency: 2,
    })
    expect(maximum).toBe(2)
  })

  test('keeps concurrent checkpoint batches deterministic across response order changes', async () => {
    const run = async (delays: Record<string, number>) => {
      vi.stubGlobal('fetch', vi.fn(async (input: string) => {
        const url = new URL(input)
        if (url.pathname === '/robots.txt' || url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt' || url.pathname === '/map.xml') {
          return new Response('', { status: 404 })
        }
        if (url.pathname === '/') return html('<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a>')
        await new Promise((resolve) => setTimeout(resolve, delays[url.pathname] ?? 0))
        return html(`<link rel="canonical" href="${url.pathname}"><p>${url.pathname}</p>`)
      }))
      const batches: Array<[string, string, string]> = []
      await runSiteCrawl('https://example.test/', {
        allowPrivateHost: 'example.test',
        sitemapUrl: 'https://example.test/map.xml',
        concurrency: 3,
        onEvent: (event) => { batches.push([event.type, event.batchId, event.checksum]) },
      })
      return batches
    }

    const first = await run({ '/a': 30, '/b': 20, '/c': 10 })
    const second = await run({ '/a': 10, '/b': 20, '/c': 30 })
    expect(first).toEqual(second)
  })

  test('admits the same capped frontier regardless of concurrent response order', async () => {
    const run = async (delays: Record<string, number>) => {
      vi.stubGlobal('fetch', vi.fn(async (input: string) => {
        const url = new URL(input)
        if (url.pathname === '/robots.txt' || url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt' || url.pathname === '/map.xml') {
          return new Response('', { status: 404 })
        }
        if (url.pathname === '/') return html('<a href="/a">a</a><a href="/b">b</a>')
        await new Promise((resolve) => setTimeout(resolve, delays[url.pathname] ?? 0))
        if (url.pathname === '/a') return html('<a href="/z">z</a>')
        if (url.pathname === '/b') return html('<a href="/c">c</a>')
        return html('<p>leaf</p>')
      }))
      const report = await runSiteCrawl('https://example.test/', {
        allowPrivateHost: 'example.test', sitemapUrl: 'https://example.test/map.xml', concurrency: 2, maxPages: 4,
      })
      if (report.mode !== 'full') throw new Error('expected full report')
      return report.pages.map((page) => page.requestedUrl).sort()
    }
    expect(await run({ '/a': 30, '/b': 5 })).toEqual(await run({ '/a': 5, '/b': 30 }))
    expect(await run({ '/a': 30, '/b': 5 })).toContain('https://example.test/c')
    expect(await run({ '/a': 30, '/b': 5 })).not.toContain('https://example.test/z')
  })

  test('classifies canonical-to-other HTML separately from an indexable self-canonical page', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/robots.txt' || url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt' || url.pathname === '/map.xml') {
        return new Response('', { status: 404 })
      }
      if (url.pathname === '/') return html('<link rel="canonical" href="/preferred"><a href="/preferred">preferred</a>')
      return html('<link rel="canonical" href="/preferred"><p>preferred</p>')
    }))
    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      sitemapUrl: 'https://example.test/map.xml',
    })
    if (report.mode !== 'full') throw new Error('expected full report')
    expect(report.pages.find((page) => page.finalUrl === 'https://example.test/')?.indexability)
      .toMatchObject({ state: 'unknown', reasons: ['canonical-to-other'] })
    expect(report.pages.find((page) => page.finalUrl === 'https://example.test/preferred')?.indexability)
      .toMatchObject({ state: 'indexable', reasons: [] })
  })

  test('enforces the unique-edge budget and reports an explicit partial crawl', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/robots.txt' || url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt' || url.pathname === '/map.xml') {
        return new Response('', { status: 404 })
      }
      return html(url.pathname === '/' ? '<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a>' : '<p>leaf</p>')
    }))
    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      sitemapUrl: 'https://example.test/map.xml',
      maxEdges: 2,
    })
    if (report.mode !== 'full') throw new Error('expected full report')
    expect(report.edges).toHaveLength(2)
    expect(report.summary).toMatchObject({ complete: false, terminationReason: 'max-edges' })
  })
})

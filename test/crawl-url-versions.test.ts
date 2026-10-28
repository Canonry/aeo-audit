import { afterEach, describe, expect, test, vi } from 'vitest'

import { runSiteCrawl } from '../src/index.js'
import type { SiteCrawlOptions } from '../src/index.js'

const html = (body: string, head = '', status = 200) => new Response(
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`,
  { status, headers: { 'content-type': 'text/html' } },
)

const canonical = (href: string) => `<link rel="canonical" href="${href}">`

/** A URL version: a page whose head declares `path` canonical. */
const copyOf = (path: string) => html('<p>copy</p>', canonical(path))

const MISSING_AUXILIARY = new Set(['/robots.txt', '/llms.txt', '/llms-full.txt', '/map.xml'])

afterEach(() => vi.unstubAllGlobals())

/**
 * Serve a fixture site and crawl it. `route` answers every page request;
 * returning null serves an empty page. Returns the report and every page URL
 * the crawler requested, in request order.
 */
async function crawl(route: (url: URL) => Response | null | Promise<Response | null>, options: SiteCrawlOptions = {}) {
  const requested: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input)
    if (MISSING_AUXILIARY.has(url.pathname)) return new Response('', { status: 404 })
    requested.push(url.toString())
    return (await route(url)) ?? html('<p>page</p>')
  }))
  const report = await runSiteCrawl('https://example.test/', {
    allowPrivateHost: 'example.test',
    sitemapUrl: 'https://example.test/map.xml',
    concurrency: 1,
    ...options,
  })
  if (report.mode !== 'full') throw new Error('expected full report')
  return { report, requested }
}

/** Six unit pages, each linking a `?forcecache=1` copy that declares the clean unit URL canonical. */
const unitSite = (url: URL): Response | null => {
  if (url.pathname === '/') {
    return html([1, 2, 3, 4, 5, 6].map((unit) => `<a href="/units/${unit}/">unit ${unit}</a>`).join(''))
  }
  if (url.searchParams.has('forcecache')) return copyOf(url.pathname)
  if (url.pathname.startsWith('/units/')) return html(`<a href="${url.pathname}?forcecache=1">refresh</a>`)
  return null
}

const forcecacheRequests = (requested: string[]) => requested.filter((url) => new URL(url).searchParams.has('forcecache'))

describe('runSiteCrawl skipUrlVersionsAfter', () => {
  test('is off by default: every URL version is fetched', async () => {
    const { report, requested } = await crawl(unitSite)

    expect(forcecacheRequests(requested)).toHaveLength(6)
    expect(report.summary.urlVersions).toEqual({ skipAfter: 0, skipped: 0, patterns: [] })
  })

  test('stops fetching a pattern once enough of its URLs prove to be versions of another page', async () => {
    const { report, requested } = await crawl(unitSite, { skipUrlVersionsAfter: 2 })

    expect(forcecacheRequests(requested)).toEqual([
      'https://example.test/units/1/?forcecache=1',
      'https://example.test/units/2/?forcecache=1',
    ])
    // Skipped URLs are discovered but never observed: no page rows.
    expect(report.pages.map((page) => page.requestedUrl).filter((url) => url.includes('forcecache')).sort()).toEqual([
      'https://example.test/units/1/?forcecache=1',
      'https://example.test/units/2/?forcecache=1',
    ])
    expect(report.summary.urlVersions).toEqual({
      skipAfter: 2,
      skipped: 4,
      patterns: [{
        section: '/units',
        parameters: ['forcecache'],
        copies: 2,
        skipped: 4,
        exampleUrl: 'https://example.test/units/1/?forcecache=1',
      }],
    })
    // A URL version is not a page: skipped ones stay out of the discovered count.
    expect(report.summary).toMatchObject({ complete: true, terminationReason: null, pagesDiscovered: 9, pagesObserved: 9 })
  })

  test('keeps fetching a pattern once one of its pages proves to be a page of its own', async () => {
    const { report, requested } = await crawl((url) => {
      if (url.pathname === '/') {
        return html([2, 3, 4, 5].map((page) => `<a href="/blog/?page=${page}">page ${page}</a>`).join(''))
      }
      // Page 3 declares itself canonical: `?page=` makes real pages here.
      if (url.searchParams.get('page') === '3') return html('<p>older posts</p>', canonical('/blog/?page=3'))
      if (url.searchParams.has('page')) return copyOf('/blog/')
      return null
    }, { skipUrlVersionsAfter: 2 })

    expect(requested.filter((url) => new URL(url).searchParams.has('page'))).toHaveLength(4)
    expect(report.summary.urlVersions).toEqual({ skipAfter: 2, skipped: 0, patterns: [] })
  })

  test('learns each site section separately', async () => {
    const { report, requested } = await crawl((url) => {
      if (url.pathname === '/') {
        return html([
          '<a href="/units/1/?view=map">1</a>',
          '<a href="/units/2/?view=map">2</a>',
          '<a href="/units/3/?view=map">3</a>',
          '<a href="/zz/?view=map">zz</a>',
        ].join(''))
      }
      if (url.searchParams.has('view')) return copyOf(url.pathname)
      return null
    }, { skipUrlVersionsAfter: 2 })

    const viewRequests = requested.filter((url) => new URL(url).searchParams.has('view'))
    expect(viewRequests).toEqual([
      'https://example.test/units/1/?view=map',
      'https://example.test/units/2/?view=map',
      'https://example.test/zz/?view=map',
    ])
    expect(report.summary.urlVersions?.patterns).toEqual([
      { section: '/units', parameters: ['view'], copies: 2, skipped: 1, exampleUrl: 'https://example.test/units/1/?view=map' },
    ])
  })

  test('learns only from a canonical the canonical audit accepts', async () => {
    const { report, requested } = await crawl((url) => {
      if (url.pathname === '/') {
        return html([1, 2, 3].map((unit) => `<a href="/units/${unit}/?forcecache=1">${unit}</a>`).join(''))
      }
      // Search engines ignore a canonical tag in the body, and so does the audit.
      if (url.searchParams.has('forcecache')) return html(`${canonical(url.pathname)}<p>copy</p>`)
      return null
    }, { skipUrlVersionsAfter: 1 })

    expect(forcecacheRequests(requested)).toHaveLength(3)
    expect(report.summary.urlVersions).toEqual({ skipAfter: 1, skipped: 0, patterns: [] })
    const first = report.pages.find((page) => page.requestedUrl === 'https://example.test/units/1/?forcecache=1')
    const findingCodes = first?.audit?.factors.flatMap((factor) => factor.findings.map((finding) => finding.code))
    expect(findingCodes).toContain('entity-consistency.canonical.missing')
  })

  test('never skips a sitemap entry', async () => {
    const { report, requested } = await crawl((url) => {
      if (url.pathname === '/sitemap-units.xml') {
        return new Response([
          '<urlset>',
          ...[1, 2, 3].map((unit) => `<url><loc>https://example.test/units/${unit}/?forcecache=1</loc></url>`),
          '</urlset>',
        ].join(''), { headers: { 'content-type': 'application/xml' } })
      }
      if (url.pathname === '/') return html('<a href="/units/4/?forcecache=1">linked only</a>')
      if (url.searchParams.has('forcecache')) return copyOf(url.pathname)
      return null
    }, { skipUrlVersionsAfter: 1, sitemapUrl: 'https://example.test/sitemap-units.xml' })

    expect(forcecacheRequests(requested)).toEqual([
      'https://example.test/units/1/?forcecache=1',
      'https://example.test/units/2/?forcecache=1',
      'https://example.test/units/3/?forcecache=1',
    ])
    expect(report.summary.urlVersions).toMatchObject({
      skipped: 1,
      patterns: [{ section: '/units', parameters: ['forcecache'], copies: 3, skipped: 1 }],
    })
  })

  test('gives the page slots of skipped URLs back to pages', async () => {
    const route = (url: URL): Response | null => {
      if (url.pathname === '/') {
        return html('<a href="/a/?v=1">1</a><a href="/a/?v=2">2</a><a href="/a/?v=3">3</a><a href="/b/">b</a>')
      }
      if (url.searchParams.has('v')) return copyOf('/a/')
      if (url.pathname === '/b/') return html('<a href="/c/">c</a><a href="/d/">d</a>')
      return null
    }

    const fetchesAll = await crawl(route, { maxPages: 5 })
    expect(fetchesAll.report.summary).toMatchObject({ complete: false, terminationReason: 'max-pages' })
    expect(fetchesAll.requested).not.toContain('https://example.test/d/')

    const { report, requested } = await crawl(route, { maxPages: 5, skipUrlVersionsAfter: 1 })
    expect(requested).toEqual(expect.arrayContaining(['https://example.test/c/', 'https://example.test/d/']))
    expect(requested).not.toContain('https://example.test/a/?v=2')
    expect(report.summary).toMatchObject({ complete: true, terminationReason: null })
    expect(report.summary.urlVersions).toMatchObject({ skipped: 2 })
  })

  test('frees the slots of newly learned copies before admitting the links of the batch that taught them', async () => {
    const { report } = await crawl((url) => {
      if (url.pathname === '/') return html('<a href="/a/?v=1">1</a><a href="/a/?v=2">2</a><a href="/a/?v=3">3</a>')
      // The page that teaches the pattern is also the only page that links /c/.
      if (url.searchParams.get('v') === '1') return html('<a href="/c/">c</a>', canonical('/a/'))
      if (url.searchParams.has('v')) return copyOf('/a/')
      return null
    }, { maxPages: 4, skipUrlVersionsAfter: 1 })

    expect(report.pages.map((page) => page.requestedUrl).sort()).toEqual([
      'https://example.test/',
      'https://example.test/a/?v=1',
      'https://example.test/c/',
    ])
    expect(report.summary).toMatchObject({ complete: true, terminationReason: null })
  })

  test('fetches what a pattern skipped once a redirect target proves the pattern wrong', async () => {
    const { report, requested } = await crawl((url) => {
      if (url.pathname === '/') {
        return html([1, 2, 3].map((unit) => `<a href="/units/${unit}/?forcecache=1">${unit}</a>`).join('') + '<a href="/zgo">go</a>')
      }
      if (url.pathname === '/zgo') return new Response('', { status: 302, headers: { location: '/units/9/?forcecache=1' } })
      // Unit 9 declares its own query URL canonical: not a copy.
      if (url.pathname === '/units/9/') return html('<p>own page</p>', canonical('/units/9/?forcecache=1'))
      if (url.searchParams.has('forcecache')) return copyOf(url.pathname)
      return null
    }, { skipUrlVersionsAfter: 1 })

    // Units 2 and 3 were skipped once unit 1 taught the pattern, then fetched
    // after the redirect target showed the pattern also makes real pages.
    expect(forcecacheRequests(requested)).toEqual([
      'https://example.test/units/1/?forcecache=1',
      'https://example.test/units/9/?forcecache=1',
      'https://example.test/units/2/?forcecache=1',
      'https://example.test/units/3/?forcecache=1',
    ])
    expect(report.pages.filter((page) => page.state === 'html' && page.requestedUrl.includes('forcecache'))
      .map((page) => page.requestedUrl).sort()).toEqual([
      'https://example.test/units/1/?forcecache=1',
      'https://example.test/units/2/?forcecache=1',
      'https://example.test/units/3/?forcecache=1',
      'https://example.test/units/9/?forcecache=1',
    ])
    expect(report.summary.urlVersions).toEqual({ skipAfter: 1, skipped: 0, patterns: [] })
    expect(report.summary.complete).toBe(true)
    // The re-fetched pages keep the links that found them while they were skipped.
    expect(report.pages.find((page) => page.requestedUrl === 'https://example.test/units/2/?forcecache=1')?.provenance)
      .toEqual({ discoveredFrom: ['https://example.test/'], sitemapSources: [], root: false })
  })

  test('still fetches a queued redirect target that answered with an error', async () => {
    const { report } = await crawl((url) => {
      if (url.pathname === '/') {
        return html('<a href="/a-go">go</a><a href="/units/1/?forcecache=1">1</a><a href="/units/9/?forcecache=1">9</a>')
      }
      if (url.pathname === '/a-go') return new Response('', { status: 302, headers: { location: '/units/9/?forcecache=1' } })
      if (url.pathname === '/units/9/') return html('<p>gone</p>', '', 404)
      if (url.searchParams.has('forcecache')) return copyOf(url.pathname)
      return null
    }, { skipUrlVersionsAfter: 1, checkDeadLinks: true })

    expect(report.pages.find((page) => page.requestedUrl === 'https://example.test/units/9/?forcecache=1'))
      .toMatchObject({ state: 'fetch-error', statusCode: 404 })
    expect(report.deadLinks.findings.map((finding) => [finding.to, finding.statusCode])).toEqual(expect.arrayContaining([
      ['https://example.test/a-go', 404],
      ['https://example.test/units/9/?forcecache=1', 404],
    ]))
  })

  test('still fetches a queued redirect target that proves the pattern wrong', async () => {
    const { report, requested } = await crawl((url) => {
      if (url.pathname === '/') {
        return html([
          '<a href="/a-go">go</a>',
          '<a href="/units/1/?forcecache=1">1</a>',
          '<a href="/units/2/?forcecache=1">2</a>',
          '<a href="/units/9/?forcecache=1">9</a>',
        ].join(''))
      }
      if (url.pathname === '/a-go') return new Response('', { status: 302, headers: { location: '/units/9/?forcecache=1' } })
      if (url.pathname === '/units/9/') return html('<p>own page</p>', canonical('/units/9/?forcecache=1'))
      if (url.searchParams.has('forcecache')) return copyOf(url.pathname)
      return null
    }, { skipUrlVersionsAfter: 1 })

    expect(forcecacheRequests(requested)).toEqual(expect.arrayContaining(['https://example.test/units/2/?forcecache=1']))
    expect(report.summary.urlVersions).toEqual({ skipAfter: 1, skipped: 0, patterns: [] })
  })

  test('gives a skipped URL that a redirect reaches its page row and the links that found it', async () => {
    const { report } = await crawl((url) => {
      if (url.pathname === '/') {
        return html('<a href="/hub/">hub</a><a href="/units/1/?forcecache=1">1</a><a href="/units/2/?forcecache=1">2</a>')
      }
      // Fetched before unit 2 is skipped; its link to /zgo waits one layer deeper.
      if (url.pathname === '/hub/') return html('<a href="/zgo">go</a>')
      if (url.pathname === '/zgo') return new Response('', { status: 302, headers: { location: '/units/2/?forcecache=1' } })
      if (url.searchParams.has('forcecache')) return copyOf(url.pathname)
      return null
    }, { skipUrlVersionsAfter: 1 })

    const reached = report.pages.find((page) => page.requestedUrl === 'https://example.test/units/2/?forcecache=1')
    expect(reached).toMatchObject({ state: 'html' })
    // The root's link is known only from the skipped record; the hub's comes with the redirect.
    expect(reached?.provenance.discoveredFrom).toEqual(['https://example.test/', 'https://example.test/hub/'])
    expect(report.summary.urlVersions).toMatchObject({ skipped: 0, patterns: [] })
    expect(report.summary.pagesDiscovered).toBe(report.summary.pagesObserved)
  })

  test('does not count a URL the query-variant cap turned away as discovered once it is skipped', async () => {
    const { report } = await crawl((url) => {
      if (url.pathname === '/') return html('<a href="/p/?v=1">1</a><a href="/p/?v=2">2</a>')
      if (url.searchParams.get('v') === '1') return html('<a href="/p/?v=2">2</a>', canonical('/p/'))
      return null
    }, { maxQueryVariants: 1, skipUrlVersionsAfter: 1 })

    expect(report.summary.urlVersions).toMatchObject({ skipped: 1 })
    expect(report.summary).toMatchObject({ pagesDiscovered: 2, pagesObserved: 2 })
  })

  test('skips the same URLs whatever order concurrent responses arrive in', async () => {
    const run = async (delays: Record<string, number>) => {
      const batches: Array<[string, string, string]> = []
      const { requested } = await crawl(async (url) => {
        await new Promise((resolve) => setTimeout(resolve, delays[`${url.pathname}${url.search}`] ?? 0))
        return unitSite(url)
      }, {
        concurrency: 3,
        skipUrlVersionsAfter: 2,
        onEvent: (event) => { batches.push([event.type, event.batchId, event.checksum]) },
      })
      return { batches, fetched: forcecacheRequests(requested).sort() }
    }

    const first = await run({ '/units/1/?forcecache=1': 30, '/units/2/?forcecache=1': 20, '/units/3/?forcecache=1': 10 })
    const second = await run({ '/units/1/?forcecache=1': 10, '/units/2/?forcecache=1': 20, '/units/3/?forcecache=1': 30 })
    expect(first).toEqual(second)
    expect(first.fetched).toHaveLength(3)
  })

  test('orders skipped patterns the same way whatever order responses arrive in', async () => {
    const run = async (delays: Record<string, number>) => {
      const batches: Array<[string, string, string]> = []
      const { report } = await crawl(async (url) => {
        if (url.pathname === '/') {
          return html([1, 2].flatMap((n) => [
            `<a href="/x/${n}/?mode=a&amp;view=b">a</a>`,
            `<a href="/x/${n}/?modeview=c">b</a>`,
          ]).join(''))
        }
        await new Promise((resolve) => setTimeout(resolve, delays[`${url.pathname}${url.search}`] ?? 0))
        if (url.search) return copyOf(url.pathname)
        return null
      }, {
        concurrency: 2,
        skipUrlVersionsAfter: 1,
        onEvent: (event) => { batches.push([event.type, event.batchId, event.checksum]) },
      })
      return { batches, patterns: report.summary.urlVersions?.patterns.map((pattern) => pattern.parameters) }
    }

    const first = await run({ '/x/1/?mode=a&view=b': 30, '/x/1/?modeview=c': 1 })
    const second = await run({ '/x/1/?mode=a&view=b': 1, '/x/1/?modeview=c': 30 })
    expect(first.patterns).toEqual([['mode', 'view'], ['modeview']])
    expect(first).toEqual(second)
  })

  test('treats an unset, negative or non-finite value as off and floors fractions', async () => {
    for (const value of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { report } = await crawl(unitSite, { skipUrlVersionsAfter: value })
      expect(report.summary.urlVersions?.skipAfter).toBe(0)
    }
    const { report } = await crawl(unitSite, { skipUrlVersionsAfter: 2.9 })
    expect(report.summary.urlVersions?.skipAfter).toBe(2)
  })
})

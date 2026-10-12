import { afterEach, describe, expect, it, vi } from 'vitest'
import { runSiteCrawl } from '../src/index.js'
import type { CrawlEvent, CrawlPageObservation } from '../src/types.js'

const origin = 'https://example.test'
const title = 'Clothing made for everyday adventures'
const description = 'Thoughtful clothing made for everyday adventures, with useful details about each collection, its materials, and the people who make it.'
const factors = ['entity-consistency', 'technical-seo']

function html(body: string, head = '', pageTitle = title): Response {
  return new Response(`<!doctype html><html><head><title>${pageTitle}</title><meta name="description" content="${description}">${head}</head><body><h1>Collection</h1>${body}</body></html>`, {
    headers: { 'content-type': 'text/html' },
  })
}

function fakeSite(respond: (url: URL) => Response): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input)
    if (url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml' || url.pathname === '/sitemap-index.xml') {
      return new Response('', { status: 404 })
    }
    return respond(url)
  }))
}

afterEach(() => vi.unstubAllGlobals())

describe('cross-page metadata in a full site crawl', () => {
  it.each(['full', 'summary'] as const)('retains groups and final page updates in %s mode without changing scores', async (mode) => {
    fakeSite((url) => html(url.pathname === '/' ? '<a href="/a">Collection</a>' : '<p>Details</p>'))
    const events: CrawlEvent[] = []
    const report = await runSiteCrawl(origin, {
      allowPrivateHost: 'example.test', factors, mode,
      onEvent: (event) => { events.push(event) },
    })
    expect(report.summary.complete).toBe(true)
    expect(report.summary.siteIssues).toEqual([
      {
        code: 'site.duplicate-meta-description',
        message: `2 pages share the same meta description word for word: "${description.slice(0, 120)}"`,
        affectedUrls: [`${origin}/`, `${origin}/a`],
      },
      {
        code: 'site.duplicate-title',
        message: `2 pages share the same title word for word: "${title}"`,
        affectedUrls: [`${origin}/`, `${origin}/a`],
      },
    ])
    const finalPages = new Map<string, CrawlPageObservation>()
    const initialPages = new Map<string, CrawlPageObservation>()
    for (const event of events) {
      if (event.type !== 'pages') continue
      for (const page of event.rows) {
        if (!initialPages.has(page.key)) initialPages.set(page.key, page)
        finalPages.set(page.key, page)
      }
    }
    expect(finalPages.size).toBe(2)
    for (const [key, page] of finalPages) {
      const initial = initialPages.get(key)!
      expect(initial.audit?.factors.flatMap((factor) => factor.findings).some((finding) => finding.code.startsWith('site.duplicate-'))).toBe(false)
      expect(page.audit?.overallScore).toBe(initial.audit?.overallScore)
      expect(page.audit?.factors.map((factor) => factor.score)).toEqual(initial.audit?.factors.map((factor) => factor.score))
      expect(page.audit?.factors.find((factor) => factor.id === 'entity-consistency')?.findings.filter((finding) => finding.code === 'site.duplicate-title')).toHaveLength(1)
      expect(page.audit?.factors.find((factor) => factor.id === 'technical-seo')?.findings.filter((finding) => finding.code === 'site.duplicate-meta-description')).toHaveLength(1)
      expect(page.audit?.factors.find((factor) => factor.id === 'technical-seo')?.recommendations).toContain('Review the shared meta-description template and canonical intent before assigning page-specific descriptions.')
    }
    expect(events.at(-1)?.type).toBe('summary')
    if (report.mode === 'full') expect(report.pages).toEqual([...finalPages.values()])
    else expect(report).not.toHaveProperty('pages')
    const summaryEvent = events.at(-1)
    if (summaryEvent?.type !== 'summary') throw new Error('Missing terminal summary')
    expect(summaryEvent.summary.siteIssues).toEqual(report.summary.siteIssues)
  })

  it.each(['full', 'summary'] as const)('preserves final graph depths when replaying duplicate updates in %s mode', async (mode) => {
    const paths = ['/', '/one', '/two', '/orphan']
    fakeSite((url) => {
      if (url.pathname === '/crawl-sitemap.xml') {
        return new Response(`<urlset>${paths.map((path) => `<url><loc>${origin}${path}</loc></url>`).join('')}</urlset>`, {
          headers: { 'content-type': 'application/xml' },
        })
      }
      const body = url.pathname === '/' ? '<a href="/one">One</a>'
        : url.pathname === '/one' ? '<a href="/two">Two</a>' : ''
      return html(body)
    })
    const events: CrawlEvent[] = []
    const report = await runSiteCrawl(origin, {
      allowPrivateHost: 'example.test', factors, mode,
      sitemapUrl: `${origin}/crawl-sitemap.xml`,
      onEvent: (event) => { events.push(event) },
    })
    expect(report.summary.complete).toBe(true)
    const finalPages = new Map<string, CrawlPageObservation>()
    const persistedDepths = new Map<string, number | null>()
    for (const event of events) {
      // Replay the persistence contract: page upserts carry discovery depth;
      // the terminal metrics replace it with shortest followable anchor depth.
      if (event.type === 'pages') {
        for (const page of event.rows) {
          finalPages.set(page.key, page)
          persistedDepths.set(page.key, page.depth)
        }
      } else if (event.type === 'metrics') {
        for (const row of event.rows) persistedDepths.set(row.key, row.metrics.shortestFollowableAnchorDepth)
      }
    }
    const expectedDepths = new Map<string, number | null>([
      [`${origin}/`, 0], [`${origin}/one`, 1], [`${origin}/two`, 2], [`${origin}/orphan`, null],
    ])
    expect(finalPages.size).toBe(expectedDepths.size)
    for (const page of finalPages.values()) {
      expect(page.depth).toBe(0)
      expect(persistedDepths.get(page.key), page.requestedUrl).toBe(expectedDepths.get(page.requestedUrl))
      expect(page.metrics.shortestFollowableAnchorDepth).toBe(expectedDepths.get(page.requestedUrl))
      expect(page.audit?.factors.flatMap((factor) => factor.findings)
        .filter((finding) => finding.code.startsWith('site.duplicate-'))).toHaveLength(2)
    }
  })

  it('excludes noindex, canonical aliases, redirects, failed responses and non-HTML pages', async () => {
    fakeSite((url) => {
      if (url.pathname === '/') return html(['/a', '/noindex', '/alias', '/redirect', '/failed', '/text'].map((path) => `<a href="${path}">Page</a>`).join(''))
      if (url.pathname === '/noindex') return html('', '<meta name="robots" content="noindex">')
      if (url.pathname === '/alias') return html('', `<link rel="canonical" href="${origin}/a">`)
      if (url.pathname === '/redirect') return new Response('', { status: 301, headers: { location: `${origin}/a` } })
      if (url.pathname === '/failed') return new Response('Not found', { status: 404 })
      if (url.pathname === '/text') return new Response(title, { headers: { 'content-type': 'text/plain' } })
      return html('')
    })
    const report = await runSiteCrawl(origin, { allowPrivateHost: 'example.test', factors })
    expect(report.summary.siteIssues?.map((issue) => issue.affectedUrls)).toEqual([
      [`${origin}/`, `${origin}/a`], [`${origin}/`, `${origin}/a`],
    ])
    if (report.mode !== 'full') throw new Error('Expected full crawl')
    expect(report.pages.filter((page) => page.indexability.state !== 'indexable').length).toBe(5)
    for (const page of report.pages.filter((page) => page.indexability.state !== 'indexable')) {
      expect(page.audit?.factors.flatMap((factor) => factor.findings).filter((finding) => finding.code.startsWith('site.duplicate-')) ?? []).toEqual([])
    }
  })

  it('reports observed duplicates on a partial crawl without including unseen URLs', async () => {
    fakeSite((url) => html(url.pathname === '/' ? '<a href="/a">A</a><a href="/b">B</a>' : ''))
    const report = await runSiteCrawl(origin, { allowPrivateHost: 'example.test', factors, maxPages: 2 })
    expect(report.summary.complete).toBe(false)
    expect(report.summary.terminationReason).toBe('max-pages')
    expect(report.summary.siteIssues?.map((issue) => issue.affectedUrls)).toEqual([
      [`${origin}/`, `${origin}/a`], [`${origin}/`, `${origin}/a`],
    ])
  })

  it('keeps summary findings when the associated factor was not requested', async () => {
    fakeSite((url) => html(url.pathname === '/' ? '<a href="/a">A</a>' : ''))
    const report = await runSiteCrawl(origin, { allowPrivateHost: 'example.test', factors: ['named-entities'] })
    expect(report.summary.siteIssues).toHaveLength(2)
    if (report.mode !== 'full') throw new Error('Expected full crawl')
    expect(report.pages.every((page) => page.audit?.factors.length === 1)).toBe(true)
    expect(report.pages.every((page) => page.audit?.factors[0].id === 'named-entities')).toBe(true)
  })

  it('does not count redirect aliases as additional pages sharing the terminal metadata', async () => {
    fakeSite((url) => {
      if (url.pathname === '/') return html('<a href="/one">One</a><a href="/two">Two</a>', '', 'Unique homepage')
      if (url.pathname === '/one' || url.pathname === '/two') return new Response('', { status: 301, headers: { location: `${origin}/terminal` } })
      return html('')
    })
    const report = await runSiteCrawl(origin, { allowPrivateHost: 'example.test', factors })
    expect(report.summary.siteIssues?.filter((issue) => issue.code === 'site.duplicate-title')).toEqual([])
    expect(report.summary.siteIssues?.find((issue) => issue.code === 'site.duplicate-meta-description')?.affectedUrls).toEqual([`${origin}/`, `${origin}/terminal`])
  })
})

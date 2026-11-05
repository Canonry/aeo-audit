import { afterEach, test, vi } from 'vitest'

import { runSiteCrawl } from '../src/index.js'
import type { SiteCrawlOptions } from '../src/index.js'

const html = (body: string) => new Response(`<!doctype html><html><head></head><body>${body}</body></html>`, {
  status: 200,
  headers: { 'content-type': 'text/html' },
})
const canonical = (href: string) => `<link rel="canonical" href="${href}">`
const MISSING = new Set(['/robots.txt', '/llms.txt', '/llms-full.txt', '/map.xml'])
afterEach(() => vi.unstubAllGlobals())

async function crawl(route: (url: URL) => Response | null | Promise<Response | null>, options: SiteCrawlOptions = {}) {
  const requested: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input)
    if (MISSING.has(url.pathname)) return new Response('', { status: 404 })
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

test('H1 lazy eviction: discoveries admitted right after settle are rejected by slots about to be freed', async () => {
  const { report, requested } = await crawl((url) => {
    if (url.pathname === '/') return html('<a href="/a/?v=1">1</a><a href="/a/?v=2">2</a><a href="/a/?v=3">3</a><a href="/b/">b</a>')
    if (url.searchParams.get('v') === '1') return html(`${canonical('/a/')}<a href="/c/">c</a>`)
    if (url.searchParams.has('v')) return html(`${canonical('/a/')}<p>copy</p>`)
    return null
  }, { maxPages: 5, skipUrlVersionsAfter: 1 })
  console.log('H1 requested', JSON.stringify(requested))
  console.log('H1 summary', JSON.stringify({ complete: report.summary.complete, reason: report.summary.terminationReason, uv: report.summary.urlVersions, disc: report.summary.pagesDiscovered, obs: report.summary.pagesObserved }))
})

test('H2 NUL-joined parameter sort tie makes pattern order timing dependent', async () => {
  const run = async (delays: Record<string, number>) => {
    const checksums: string[] = []
    const { report } = await crawl(async (url) => {
      await new Promise((resolve) => setTimeout(resolve, delays[`${url.pathname}${url.search}`] ?? 0))
      if (url.pathname === '/') return html('<a href="/x/1?mode=a&view=b">1</a><a href="/x/2?modeview=c">2</a>')
      if (url.pathname === '/x/1') return html(`${canonical('/x/1')}<a href="/x/3?mode=a&view=b">3</a>`)
      if (url.pathname === '/x/2') return html(`${canonical('/x/2')}<a href="/x/4?modeview=c">4</a>`)
      if (url.search) return html(`${canonical(url.pathname)}<p>copy</p>`)
      return null
    }, {
      concurrency: 2,
      skipUrlVersionsAfter: 1,
      onEvent: (event) => { if (event.type === 'summary') checksums.push(event.checksum) },
    })
    return { order: report.summary.urlVersions?.patterns.map((p) => p.parameters.join('+')), checksums }
  }
  const first = await run({ '/x/1?mode=a&view=b': 40, '/x/2?modeview=c': 5 })
  const second = await run({ '/x/1?mode=a&view=b': 5, '/x/2?modeview=c': 40 })
  console.log('H2 first', JSON.stringify(first))
  console.log('H2 second', JSON.stringify(second))
})

test('H3 query-variant-capped URL ends up both discovered and skipped', async () => {
  const { report } = await crawl((url) => {
    if (url.pathname === '/') return html('<a href="/a/?v=1">1</a><a href="/a/?v=2">2</a>')
    if (url.searchParams.get('v') === '1') return html(`${canonical('/a/')}<a href="/a/?v=2">2 again</a>`)
    if (url.searchParams.has('v')) return html(`${canonical('/a/')}<p>copy</p>`)
    return null
  }, { maxQueryVariants: 1, skipUrlVersionsAfter: 1 })
  console.log('H3 summary', JSON.stringify({ complete: report.summary.complete, reason: report.summary.terminationReason, uv: report.summary.urlVersions, disc: report.summary.pagesDiscovered, obs: report.summary.pagesObserved, pages: report.pages.map((p) => p.requestedUrl) }))
})

test('H4 redirect target merged into a queued item, then evicted: fetched but no row, counted as skipped', async () => {
  const { report, requested } = await crawl((url) => {
    if (url.pathname === '/') return html('<a href="/units/1/?f=1">1</a><a href="/units/7/?f=1">7</a><a href="/a-go">go</a><a href="/units/8/?f=1">8</a>')
    if (url.pathname === '/a-go') return new Response('', { status: 302, headers: { location: '/units/7/?f=1' } })
    if (url.pathname === '/units/7/') return html(`${canonical('/units/7/?f=1')}<p>own page, not a copy</p>`)
    if (url.searchParams.has('f')) return html(`${canonical(url.pathname)}<p>copy</p>`)
    return null
  }, { skipUrlVersionsAfter: 1, concurrency: 2 })
  console.log('H4 requested', JSON.stringify(requested))
  console.log('H4 summary', JSON.stringify({ uv: report.summary.urlVersions, pages: report.pages.map((p) => [p.requestedUrl, p.state, p.finalUrl]) }))
})

test('H5 locale prefix conflates sections: copies under /en/news make real /en/blog pagination skipped', async () => {
  const { report, requested } = await crawl((url) => {
    if (url.pathname === '/') return html('<a href="/en/news/?page=2">news 2</a><a href="/en/hub/">hub</a>')
    if (url.pathname === '/en/hub/') return html('<a href="/en/blog/?page=2">blog 2</a><a href="/en/blog/?page=3">blog 3</a>')
    if (url.pathname === '/en/news/') return html(`${canonical('/en/news/')}<p>news copy</p>`)
    if (url.pathname === '/en/blog/') return html(`${canonical(`/en/blog/${url.search}`)}<a href="/en/blog/post-${url.searchParams.get('page')}">post</a>`)
    return null
  }, { skipUrlVersionsAfter: 1 })
  console.log('H5 requested', JSON.stringify(requested))
  console.log('H5 uv', JSON.stringify(report.summary.urlVersions))
})

test('H6 pages rejected at the cap before learning are never reconsidered after eviction frees slots', async () => {
  const { report, requested } = await crawl((url) => {
    if (url.pathname === '/') return html('<a href="/a/?v=1">1</a><a href="/a/?v=2">2</a><a href="/a/?v=3">3</a><a href="/b/">b</a>')
    if (url.searchParams.has('v')) return html(`${canonical('/a/')}<p>copy</p>`)
    return null
  }, { maxPages: 4, skipUrlVersionsAfter: 1 })
  console.log('H6 requested', JSON.stringify(requested))
  console.log('H6 summary', JSON.stringify({ complete: report.summary.complete, reason: report.summary.terminationReason, uv: report.summary.urlVersions?.skipped, disc: report.summary.pagesDiscovered }))
})

import { afterEach, describe, test, vi } from 'vitest'

import { runSiteCrawl } from '../src/index.js'
import type { SiteCrawlOptions } from '../src/index.js'

const html = (body: string) => new Response(`<!doctype html><html><head></head><body>${body}</body></html>`, {
  status: 200,
  headers: { 'content-type': 'text/html' },
})
const canonical = (href: string) => `<link rel="canonical" href="${href}">`
const MISSING_AUXILIARY = new Set(['/robots.txt', '/llms.txt', '/llms-full.txt', '/map.xml'])
afterEach(() => vi.unstubAllGlobals())

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

describe('angle C scratch', () => {
  test('H1: redirect target queued before the pattern is learned is fetched but never observed', async () => {
    const site = (alias: string) => (url: URL): Response | null => {
      if (url.pathname === '/') {
        return html(`<a href="${alias}">go</a><a href="/a/?x=1">1</a><a href="/a/?x=2">2</a>`)
      }
      if (url.pathname === alias) return new Response('', { status: 302, headers: { location: '/a/?x=2' } })
      // x=2 is a page of its own (self canonical): a counterexample.
      if (url.searchParams.get('x') === '2') return html(`${canonical('/a/?x=2')}<p>own page</p>`)
      if (url.searchParams.has('x')) return html(`${canonical('/a/')}<p>copy</p>`)
      return null
    }
    const early = await crawl(site('/0alias'), { skipUrlVersionsAfter: 1 })
    const late = await crawl(site('/zalias'), { skipUrlVersionsAfter: 1 })
    const summarize = (r: typeof early) => ({
      requested: r.requested,
      rows: r.report.pages.map((p) => `${p.state} ${p.requestedUrl} -> ${p.finalUrl}`).sort(),
      urlVersions: r.report.summary.urlVersions,
      complete: r.report.summary.complete,
      pagesDiscovered: r.report.summary.pagesDiscovered,
      pagesObserved: r.report.summary.pagesObserved,
    })
    console.log('EARLY', JSON.stringify(summarize(early), null, 2))
    console.log('LATE', JSON.stringify(summarize(late), null, 2))
  })

  test('H2: URL rejected by max-query-variants is counted both as discovered and as skipped', async () => {
    const { report, requested } = await crawl((url) => {
      if (url.pathname === '/') {
        return html('<a href="/p/?v=1">1</a><a href="/p/?v=2">2</a><a href="/p/?v=3">3</a>')
      }
      // The copy links to the rejected variant again.
      if (url.searchParams.get('v') === '1') return html(`${canonical('/p/')}<a href="/p/?v=3">3</a>`)
      if (url.searchParams.has('v')) return html(`${canonical('/p/')}<p>copy</p>`)
      return null
    }, { skipUrlVersionsAfter: 1, maxQueryVariants: 2 })
    console.log('H2', JSON.stringify({
      requested,
      rows: report.pages.map((p) => `${p.state} ${p.requestedUrl}`).sort(),
      pagesDiscovered: report.summary.pagesDiscovered,
      pagesObserved: report.summary.pagesObserved,
      urlVersions: report.summary.urlVersions,
      complete: report.summary.complete,
      terminationReason: report.summary.terminationReason,
    }, null, 2))
  })

  test('H3: queued URL versions keep their page slots after the pattern is learned and trip max-pages', async () => {
    const route = (url: URL): Response | null => {
      if (url.pathname === '/') {
        return html('<a href="/a/?v=1">1</a><a href="/a/?v=2">2</a><a href="/a/?v=3">3</a><a href="/b/">b</a>')
      }
      // Every copy carries the site nav, which links /c/ and /d/.
      if (url.searchParams.has('v')) return html(`${canonical('/a/')}<a href="/c/">c</a><a href="/d/">d</a>`)
      return null
    }
    const { report, requested } = await crawl(route, { maxPages: 6, skipUrlVersionsAfter: 1 })
    console.log('H3', JSON.stringify({
      requested,
      pagesObserved: report.summary.pagesObserved,
      pagesDiscovered: report.summary.pagesDiscovered,
      complete: report.summary.complete,
      terminationReason: report.summary.terminationReason,
      urlVersions: report.summary.urlVersions,
    }, null, 2))
  })
})

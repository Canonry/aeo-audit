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

describe('angle C scratch 2', () => {
  test('H1b: a 404 delivered through a redirect is lost when its target was queued, then skipped', async () => {
    const site = (alias: string) => (url: URL): Response | null => {
      if (url.pathname === '/') {
        return html(`<a href="${alias}">go</a><a href="/a/?x=1">1</a><a href="/a/?x=2">2</a>`)
      }
      if (url.pathname === alias) return new Response('', { status: 302, headers: { location: '/a/?x=2' } })
      if (url.searchParams.get('x') === '2') return new Response('gone', { status: 404, headers: { 'content-type': 'text/html' } })
      if (url.searchParams.has('x')) return html(`${canonical('/a/')}<p>copy</p>`)
      return null
    }
    for (const alias of ['/0alias', '/zalias']) {
      const { report, requested } = await crawl(site(alias), { skipUrlVersionsAfter: 1, checkDeadLinks: true })
      console.log(alias, JSON.stringify({
        requested,
        rows: report.pages.map((p) => `${p.state} ${p.statusCode} ${p.requestedUrl} -> ${p.finalUrl}`).sort(),
        deadLinks: report.deadLinks,
        urlVersions: report.summary.urlVersions,
        complete: report.summary.complete,
      }, null, 2))
    }
  })

  test('H1c: same site with skipping off reports the dead link', async () => {
    const { report } = await crawl((url) => {
      if (url.pathname === '/') return html('<a href="/0alias">go</a><a href="/a/?x=1">1</a><a href="/a/?x=2">2</a>')
      if (url.pathname === '/0alias') return new Response('', { status: 302, headers: { location: '/a/?x=2' } })
      if (url.searchParams.get('x') === '2') return new Response('gone', { status: 404, headers: { 'content-type': 'text/html' } })
      if (url.searchParams.has('x')) return html(`${canonical('/a/')}<p>copy</p>`)
      return null
    }, { checkDeadLinks: true })
    console.log('OFF', JSON.stringify(report.deadLinks.findings.map((f) => `${f.from} -> ${f.to} ${f.statusCode}`)))
  })
})

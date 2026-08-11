import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, test } from 'vitest'

import { runSiteCrawl } from '../src/index.js'
import { placementSitePages } from './fixtures/placement-site.js'

describe('runSiteCrawl local HTTP smoke', () => {
  let server: Server | undefined

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()))
    server = undefined
  })

  test('crawls a real recursive site and keeps dead-link validation opt-in', async () => {
    const requested: string[] = []
    let origin = ''
    server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', origin).pathname
      requested.push(path)
      response.setHeader('content-type', 'text/html')
      if (path === '/robots.txt') {
        response.setHeader('content-type', 'text/plain')
        response.end(`User-agent: *\nDisallow: /blocked\nSitemap: ${origin}/sitemap.xml\n`)
      } else if (path === '/sitemap.xml') {
        response.setHeader('content-type', 'application/xml')
        response.end(`<urlset><url><loc>${origin}/orphan</loc></url><url><loc>${origin}/blocked</loc></url></urlset>`)
      } else if (path === '/sitemap-index.xml' || path === '/llms.txt' || path === '/llms-full.txt') {
        response.statusCode = 404
        response.end('missing')
      } else if (path === '/') {
        response.end('<a href="/a">a</a><a href="/go">go</a><a href="/gone">gone</a><a href="https://outside.invalid/never">external</a>')
      } else if (path === '/a') {
        response.end('<link rel="canonical" href="/a"><a href="/">home</a>')
      } else if (path === '/go') {
        response.statusCode = 302
        response.setHeader('location', '/target')
        response.end()
      } else if (path === '/target' || path === '/orphan') {
        response.end(`<p>${path}</p>`)
      } else if (path === '/gone') {
        response.statusCode = 404
        response.end('gone')
      } else {
        response.statusCode = 500
        response.end('unexpected')
      }
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', () => {
        server!.off('error', reject)
        resolve()
      })
    })
    const address = server.address() as AddressInfo
    origin = `http://127.0.0.1:${address.port}`

    const disabled = await runSiteCrawl(`${origin}/`, { allowPrivateHost: '127.0.0.1', concurrency: 3 })
    expect(disabled.deadLinks).toEqual({ state: 'disabled', findings: [] })
    expect(requested).not.toContain('/blocked')
    if (disabled.mode !== 'full') throw new Error('expected full report')
    expect(disabled.pages.find((page) => page.finalUrl === `${origin}/`)?.metrics.shortestFollowableAnchorDepth).toBe(0)
    expect(disabled.pages.find((page) => page.finalUrl === `${origin}/a`)?.metrics.shortestFollowableAnchorDepth).toBe(1)
    expect(disabled.pages.find((page) => page.requestedUrl === `${origin}/blocked`)?.state).toBe('robots-blocked')
    expect(disabled.pages.find((page) => page.requestedUrl === `${origin}/go`)?.state).toBe('redirect')
    expect(disabled.edges.some((edge) => edge.type === 'redirect' && edge.to === `${origin}/target`)).toBe(true)
    expect(disabled.pages.some((page) => page.finalUrl === `${origin}/orphan`)).toBe(true)

    const enabled = await runSiteCrawl(`${origin}/`, {
      allowPrivateHost: '127.0.0.1',
      checkDeadLinks: true,
      concurrency: 3,
    })
    expect(enabled.deadLinks.state).toBe('complete')
    expect(enabled.deadLinks.findings).toEqual([
      expect.objectContaining({ from: `${origin}/`, to: `${origin}/gone`, reason: 'http-error', statusCode: 404 }),
    ])
  })

  test('records where each link sits over real HTTP', async () => {
    let origin = ''
    server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', origin).pathname
      const page = Object.hasOwn(placementSitePages, path) ? placementSitePages[path] : undefined
      if (page === undefined) {
        response.statusCode = 404
        response.setHeader('content-type', 'text/plain')
        response.end('missing')
        return
      }
      response.setHeader('content-type', 'text/html')
      response.end(page)
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', () => {
        server!.off('error', reject)
        resolve()
      })
    })
    const address = server.address() as AddressInfo
    origin = `http://127.0.0.1:${address.port}`

    const report = await runSiteCrawl(`${origin}/`, { allowPrivateHost: '127.0.0.1', concurrency: 3 })
    if (report.mode !== 'full') throw new Error('expected full report')
    const placement = (from: string, to: string) => report.edges
      .find((edge) => edge.type === 'anchor' && edge.from === `${origin}${from}` && edge.to === `${origin}${to}`)
      ?.placementOccurrences
    const post = '/blog/how-to-rank-on-chatgpt'

    expect(report.pages.filter((page) => page.state === 'html')).toHaveLength(Object.keys(placementSitePages).length)
    // Nav and prose link the same target with the same anchor text on one page.
    expect(placement(post, '/chatgpt-seo-agency')).toEqual({ navigation: 1, content: 1, unknown: 0 })
    // The post's own header and footer are scoped by the article, so they are
    // the post's content, while the site header and footer stay chrome.
    expect(placement(post, '/authors/dana')).toEqual({ navigation: 0, content: 1, unknown: 0 })
    expect(placement(post, '/tags/answer-engines')).toEqual({ navigation: 0, content: 1, unknown: 0 })
    expect(placement(post, '/terms')).toEqual({ navigation: 1, content: 0, unknown: 0 })
    expect(placement('/', '/chatgpt-seo-agency')).toEqual({ navigation: 1, content: 0, unknown: 0 })
    expect(placement('/', '/terms')).toEqual({ navigation: 1, content: 0, unknown: 0 })
    expect(placement('/', post)).toEqual({ navigation: 0, content: 1, unknown: 0 })
    expect(placement('/legacy-page', '/chatgpt-seo-agency')).toEqual({ navigation: 0, content: 0, unknown: 1 })
    expect(report.summary.crawlSchemaVersion).toBe('1.2')
    expect(report.summary.linkPlacementRulesetVersion).toBe('1.0.0')
  })
})

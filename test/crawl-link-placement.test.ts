import { afterEach, describe, expect, test, vi } from 'vitest'

import { runSiteCrawl } from '../src/index.js'
import type { CrawlEdgeObservation, FullSiteCrawlReport } from '../src/types.js'
import { placementSitePages } from './fixtures/placement-site.js'

const ORIGIN = 'https://example.test'

/** Serve a path-to-HTML map; anything else is a 404 the crawl records as an edge target. */
function serve(pages: Readonly<Record<string, string>>): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const body = pages[new URL(input).pathname]
    if (body === undefined) return new Response('missing', { status: 404 })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })
  }))
}

async function crawl(pages: Readonly<Record<string, string>>): Promise<FullSiteCrawlReport> {
  serve(pages)
  const report = await runSiteCrawl(`${ORIGIN}/`, { allowPrivateHost: 'example.test', maxPages: 50 })
  if (report.mode !== 'full') throw new Error('expected full report')
  return report
}

function anchorEdge(report: FullSiteCrawlReport, from: string, to: string): CrawlEdgeObservation {
  const found = report.edges.find((edge) => edge.type === 'anchor' && edge.from === `${ORIGIN}${from}` && edge.to === `${ORIGIN}${to}`)
  if (!found) throw new Error(`no anchor edge ${from} -> ${to}`)
  return found
}

/** One page per landmark shape, each link pointing at a target only it links to. */
const landmarkPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Landmarks</title></head><body>
<nav><a href="/from-nav">Nav</a></nav>
<header><a href="/from-header">Header</a></header>
<footer><a href="/from-footer">Footer</a></footer>
<aside><a href="/from-aside">Aside</a></aside>
<main>
  <p><a href="/from-main">Main</a></p>
  <nav><a href="/from-nav-in-main">Nav nested in main</a></nav>
</main>
<article><p><a href="/from-article">Article</a></p></article>
<div role="navigation"><a href="/from-role-navigation">Role navigation</a></div>
<div role="banner"><a href="/from-role-banner">Role banner</a></div>
<div role="contentinfo"><a href="/from-role-contentinfo">Role contentinfo</a></div>
<div role="complementary"><a href="/from-role-complementary">Role complementary</a></div>
<div role="main"><a href="/from-role-main">Role main</a></div>
</body></html>`

const noLandmarkPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>No landmarks</title></head><body>
<div class="site-nav"><a href="/from-nav-div">Nav</a></div>
<div id="footer"><a href="/from-footer-div">Footer</a></div>
<p><a href="/from-prose">Prose</a></p>
</body></html>`

afterEach(() => vi.unstubAllGlobals())

describe('crawl link placement', () => {
  test('classifies each link occurrence by the landmark it sits in', async () => {
    const report = await crawl({ '/': landmarkPage })
    const placements = Object.fromEntries(report.edges
      .filter((edge) => edge.type === 'anchor')
      .map((edge) => [new URL(edge.to).pathname, edge.placementOccurrences]))

    expect(placements['/from-nav']).toEqual({ navigation: 1, content: 0, unknown: 0 })
    expect(placements['/from-header']).toEqual({ navigation: 1, content: 0, unknown: 0 })
    expect(placements['/from-footer']).toEqual({ navigation: 1, content: 0, unknown: 0 })
    expect(placements['/from-aside']).toEqual({ navigation: 1, content: 0, unknown: 0 })
    expect(placements['/from-main']).toEqual({ navigation: 0, content: 1, unknown: 0 })
    expect(placements['/from-article']).toEqual({ navigation: 0, content: 1, unknown: 0 })
    // Nearest matching ancestor wins: an inner nav inside main is still chrome.
    expect(placements['/from-nav-in-main']).toEqual({ navigation: 1, content: 0, unknown: 0 })
    expect(placements['/from-role-navigation']).toEqual({ navigation: 1, content: 0, unknown: 0 })
    expect(placements['/from-role-banner']).toEqual({ navigation: 1, content: 0, unknown: 0 })
    expect(placements['/from-role-contentinfo']).toEqual({ navigation: 1, content: 0, unknown: 0 })
    expect(placements['/from-role-complementary']).toEqual({ navigation: 1, content: 0, unknown: 0 })
    expect(placements['/from-role-main']).toEqual({ navigation: 0, content: 1, unknown: 0 })
  })

  test('reports unknown rather than guessing when a page declares no landmarks', async () => {
    const report = await crawl({ '/': noLandmarkPage })
    const anchors = report.edges.filter((edge) => edge.type === 'anchor')

    expect(anchors).toHaveLength(3)
    for (const edge of anchors) {
      expect(edge.placementOccurrences).toEqual({ navigation: 0, content: 0, unknown: 1 })
    }
  })

  test('an explicit landmark role beats the tag name, an unknown role does not', async () => {
    const report = await crawl({
      '/': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Roles</title></head><body>
<nav role="main"><a href="/role-wins">Role wins</a></nav>
<nav role="tablist"><a href="/tag-wins">Tag wins</a></nav>
</body></html>`,
    })

    expect(anchorEdge(report, '/', '/role-wins').placementOccurrences).toEqual({ navigation: 0, content: 1, unknown: 0 })
    expect(anchorEdge(report, '/', '/tag-wins').placementOccurrences).toEqual({ navigation: 1, content: 0, unknown: 0 })
  })

  test('one edge carries both placements when a page links a target from nav and from prose', async () => {
    const report = await crawl(placementSitePages)

    // The production case: identical target, identical anchor text, and the only
    // difference between the two occurrences is where they sit in the page.
    const editorial = anchorEdge(report, '/blog/how-to-rank-on-chatgpt', '/chatgpt-seo-agency')
    expect(editorial.totalOccurrences).toBe(2)
    expect(editorial.anchorSummaries).toEqual([{ text: 'ChatGPT SEO Agency', occurrences: 2 }])
    expect(editorial.placementOccurrences).toEqual({ navigation: 1, content: 1, unknown: 0 })

    // A page that only links it from the nav keeps a pure navigation count.
    expect(anchorEdge(report, '/pricing', '/chatgpt-seo-agency').placementOccurrences)
      .toEqual({ navigation: 1, content: 0, unknown: 0 })

    // Ubiquity cannot make that distinction: the (target, anchor) pair appears on
    // every crawled page, so a >= 70% chrome rule hides the editorial link too.
    const htmlPages = report.pages.filter((page) => page.state === 'html')
    const pagesLinkingThePair = new Set(report.edges
      .filter((edge) => edge.type === 'anchor'
        && edge.to === `${ORIGIN}/chatgpt-seo-agency`
        && edge.anchorSummaries.some((summary) => summary.text === 'ChatGPT SEO Agency'))
      .map((edge) => edge.from))
    expect(htmlPages).toHaveLength(Object.keys(placementSitePages).length)
    expect(pagesLinkingThePair.size / htmlPages.length).toBeGreaterThanOrEqual(0.7)
  })

  test('landmark-free pages stay unknown inside a site that uses landmarks elsewhere', async () => {
    const report = await crawl(placementSitePages)

    expect(anchorEdge(report, '/legacy-page', '/chatgpt-seo-agency').placementOccurrences)
      .toEqual({ navigation: 0, content: 0, unknown: 1 })
    expect(anchorEdge(report, '/legacy-page', '/pricing').placementOccurrences)
      .toEqual({ navigation: 0, content: 0, unknown: 1 })
    expect(anchorEdge(report, '/legacy-page', '/terms').placementOccurrences)
      .toEqual({ navigation: 0, content: 0, unknown: 1 })
    // The nested-in-main nav and the aside of the blog post, end to end.
    expect(anchorEdge(report, '/blog/how-to-rank-on-chatgpt', '/blog/citations').placementOccurrences)
      .toEqual({ navigation: 1, content: 0, unknown: 0 })
    expect(anchorEdge(report, '/blog/how-to-rank-on-chatgpt', '/glossary').placementOccurrences)
      .toEqual({ navigation: 1, content: 0, unknown: 0 })
    expect(anchorEdge(report, '/', '/blog/how-to-rank-on-chatgpt').placementOccurrences)
      .toEqual({ navigation: 0, content: 1, unknown: 0 })
  })

  test('placement counts account for every anchor occurrence and no non-anchor edge', async () => {
    const report = await crawl(placementSitePages)

    for (const edge of report.edges) {
      const counted = edge.placementOccurrences.navigation + edge.placementOccurrences.content + edge.placementOccurrences.unknown
      expect(counted).toBe(edge.type === 'anchor' ? edge.totalOccurrences : 0)
    }
    expect(report.edges.some((edge) => edge.type === 'canonical')).toBe(false)
    expect(report.summary.linkPlacementRulesetVersion).toBe('1.0.0')
  })

  test('a canonical edge carries zeros because it has no position in a page', async () => {
    const report = await crawl({
      '/': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Canonical</title>
<link rel="canonical" href="/canonical-target"></head><body><main><a href="/linked">Linked</a></main></body></html>`,
    })

    const canonical = report.edges.find((edge) => edge.type === 'canonical')
    expect(canonical?.placementOccurrences).toEqual({ navigation: 0, content: 0, unknown: 0 })
    expect(anchorEdge(report, '/', '/linked').placementOccurrences).toEqual({ navigation: 0, content: 1, unknown: 0 })
  })

  test('placement counts are stable across repeated crawls of identical HTML', async () => {
    const first = await crawl(placementSitePages)
    vi.unstubAllGlobals()
    const second = await crawl(placementSitePages)

    const shape = (report: FullSiteCrawlReport): Array<[string, string, string]> => report.edges
      .map((edge): [string, string, string] => [edge.key, edge.type, JSON.stringify(edge.placementOccurrences)])
    expect(shape(second)).toEqual(shape(first))
  })
})

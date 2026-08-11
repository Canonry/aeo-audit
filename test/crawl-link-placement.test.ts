import { afterEach, describe, expect, test, vi } from 'vitest'

import { runSiteCrawl } from '../src/index.js'
import { RECOGNIZED_ARIA_ROLES } from '../src/crawl.js'
import type { CrawlEdgeObservation, CrawlPlacementOccurrences, CrawlSummary, FullSiteCrawlReport } from '../src/types.js'
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

/** A single page whose links all start at the root, keyed by target path. */
async function placementsOf(html: string): Promise<Record<string, CrawlPlacementOccurrences>> {
  const report = await crawl({ '/': html })
  return Object.fromEntries(report.edges
    .filter((edge) => edge.type === 'anchor')
    .map((edge) => [new URL(edge.to).pathname, placement(edge)]))
}

function placement(edge: CrawlEdgeObservation): CrawlPlacementOccurrences {
  if (!edge.placementOccurrences) throw new Error(`edge ${edge.from} -> ${edge.to} carries no placement`)
  return edge.placementOccurrences
}

function anchorEdge(report: FullSiteCrawlReport, from: string, to: string): CrawlEdgeObservation {
  const found = report.edges.find((edge) => edge.type === 'anchor' && edge.from === `${ORIGIN}${from}` && edge.to === `${ORIGIN}${to}`)
  if (!found) throw new Error(`no anchor edge ${from} -> ${to}`)
  return found
}

const NAVIGATION = { navigation: 1, content: 0, unknown: 0 }
const CONTENT = { navigation: 0, content: 1, unknown: 0 }
const UNKNOWN = { navigation: 0, content: 0, unknown: 1 }

const doc = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Placement</title></head><body>${body}</body></html>`

afterEach(() => vi.unstubAllGlobals())

describe('crawl link placement', () => {
  test('classifies each link occurrence by the landmark it sits in', async () => {
    const placements = await placementsOf(doc(`
<nav><a href="/from-nav">Nav</a></nav>
<header><a href="/from-header">Header</a></header>
<footer><a href="/from-footer">Footer</a></footer>
<aside><a href="/from-aside">Aside</a></aside>
<main>
  <p><a href="/from-main">Main</a></p>
  <nav><a href="/from-nav-in-main">Nav nested in main</a></nav>
</main>
<article><p><a href="/from-article">Article</a></p></article>`))

    expect(placements['/from-nav']).toEqual(NAVIGATION)
    expect(placements['/from-header']).toEqual(NAVIGATION)
    expect(placements['/from-footer']).toEqual(NAVIGATION)
    expect(placements['/from-aside']).toEqual(NAVIGATION)
    expect(placements['/from-main']).toEqual(CONTENT)
    expect(placements['/from-article']).toEqual(CONTENT)
    // Nearest matching ancestor wins: an inner nav inside main is still chrome.
    expect(placements['/from-nav-in-main']).toEqual(NAVIGATION)
  })

  test('a scoped header or footer is content, not site chrome', async () => {
    // HTML-AAM: header maps to banner and footer to contentinfo only when the
    // element is not inside article, aside, main, nav, or section. A blog post's
    // own byline and tag links are the post's content.
    const placements = await placementsOf(doc(`
<header><a href="/site-header">Site header</a></header>
<footer><a href="/site-footer">Site footer</a></footer>
<article>
  <header><a href="/post-byline">Byline</a></header>
  <p><a href="/post-prose">Prose</a></p>
  <nav><a href="/post-nav">Post nav</a></nav>
  <footer><a href="/post-tags">Tags</a></footer>
</article>
<main><header><a href="/main-header">Main header</a></header></main>`))

    expect(placements['/site-header']).toEqual(NAVIGATION)
    expect(placements['/site-footer']).toEqual(NAVIGATION)
    expect(placements['/post-byline']).toEqual(CONTENT)
    expect(placements['/post-prose']).toEqual(CONTENT)
    expect(placements['/post-tags']).toEqual(CONTENT)
    // nav is navigation regardless of nesting.
    expect(placements['/post-nav']).toEqual(NAVIGATION)
    expect(placements['/main-header']).toEqual(CONTENT)
  })

  test('a header scoped by section resolves no landmark rather than guessing', async () => {
    // section scopes the header out of banner, but section is not itself a
    // placement landmark, so nothing on the ancestor path answers the question.
    const placements = await placementsOf(doc(`
<section><header><a href="/section-header">Section header</a></header></section>
<section><footer><a href="/section-footer">Section footer</a></footer></section>`))

    expect(placements['/section-header']).toEqual(UNKNOWN)
    expect(placements['/section-footer']).toEqual(UNKNOWN)
  })

  test('an aside is chrome at every nesting depth', async () => {
    const placements = await placementsOf(doc(`
<aside><a href="/top-aside">Top aside</a></aside>
<article><aside><a href="/nested-aside">Nested aside</a></aside></article>`))

    expect(placements['/top-aside']).toEqual(NAVIGATION)
    expect(placements['/nested-aside']).toEqual(NAVIGATION)
  })

  test('reports unknown rather than guessing when a page declares no landmarks', async () => {
    const report = await crawl({
      '/': doc(`
<div class="site-nav"><a href="/from-nav-div">Nav</a></div>
<div id="footer"><a href="/from-footer-div">Footer</a></div>
<p><a href="/from-prose">Prose</a></p>`),
    })
    const anchors = report.edges.filter((edge) => edge.type === 'anchor')

    expect(anchors).toHaveLength(3)
    for (const edge of anchors) expect(placement(edge)).toEqual(UNKNOWN)
  })

  test('role resolution takes the first recognized role, landmark or not', async () => {
    const placements = await placementsOf(doc(`
<div role="navigation"><a href="/landmark-role">Landmark role</a></div>
<div role="main"><a href="/content-role">Content role</a></div>
<nav role="button navigation"><a href="/recognized-non-landmark">Recognized non-landmark</a></nav>
<nav role="tablist"><a href="/tablist">Tablist</a></nav>
<nav role="totally-made-up"><a href="/unrecognized-role">Unrecognized role</a></nav>
<div role="doc-chapter main"><a href="/skips-unrecognized">Skips unrecognized</a></div>`))

    // 1. First recognized token is a landmark role.
    expect(placements['/landmark-role']).toEqual(NAVIGATION)
    expect(placements['/content-role']).toEqual(CONTENT)
    // 2. First recognized token is a recognized non-landmark role: it overrides
    //    the native tag semantics, so the element is not a landmark and `nav` is
    //    NOT consulted. The later `navigation` token is never reached.
    expect(placements['/recognized-non-landmark']).toEqual(UNKNOWN)
    expect(placements['/tablist']).toEqual(UNKNOWN)
    // 3. No token is a recognized role, so the tag name decides.
    expect(placements['/unrecognized-role']).toEqual(NAVIGATION)
    // 4. Unrecognized tokens are skipped until the first recognized one.
    expect(placements['/skips-unrecognized']).toEqual(CONTENT)
  })

  test('the recognized role list excludes abstract roles', async () => {
    for (const role of ['navigation', 'main', 'button', 'tablist', 'generic', 'none']) {
      expect(RECOGNIZED_ARIA_ROLES.has(role)).toBe(true)
    }
    // Authors must not use abstract roles and user agents ignore them, so they
    // must not suppress a tag's native landmark semantics.
    for (const role of ['landmark', 'widget', 'structure', 'roletype', 'section', 'sectionhead', 'window']) {
      expect(RECOGNIZED_ARIA_ROLES.has(role)).toBe(false)
    }
    expect(await placementsOf(doc('<nav role="landmark"><a href="/abstract">Abstract</a></nav>')))
      .toEqual({ '/abstract': NAVIGATION })
  })

  test('one edge carries both placements when a page links a target from nav and from prose', async () => {
    const report = await crawl(placementSitePages)

    // The production case: identical target, identical anchor text, and the only
    // difference between the two occurrences is where they sit in the page.
    const editorial = anchorEdge(report, '/blog/how-to-rank-on-chatgpt', '/chatgpt-seo-agency')
    expect(editorial.totalOccurrences).toBe(2)
    expect(editorial.anchorSummaries).toEqual([{ text: 'ChatGPT SEO Agency', occurrences: 2 }])
    expect(placement(editorial)).toEqual({ navigation: 1, content: 1, unknown: 0 })

    // A page that only links it from the nav keeps a pure navigation count.
    expect(placement(anchorEdge(report, '/pricing', '/chatgpt-seo-agency'))).toEqual(NAVIGATION)

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

  test('a blog post keeps its own header and footer links as content', async () => {
    const report = await crawl(placementSitePages)
    const post = '/blog/how-to-rank-on-chatgpt'

    // The article's byline and tag links live in its own header and footer.
    // Treating those as site chrome would hide the post's own editorial links.
    expect(placement(anchorEdge(report, post, '/authors/dana'))).toEqual(CONTENT)
    expect(placement(anchorEdge(report, post, '/tags/answer-engines'))).toEqual(CONTENT)
    // The site header and footer on the same page stay chrome.
    expect(placement(anchorEdge(report, post, '/pricing'))).toEqual(NAVIGATION)
    expect(placement(anchorEdge(report, post, '/terms'))).toEqual(NAVIGATION)
    // The nested-in-main nav and the aside of the blog post, end to end.
    expect(placement(anchorEdge(report, post, '/blog/citations'))).toEqual(NAVIGATION)
    expect(placement(anchorEdge(report, post, '/glossary'))).toEqual(NAVIGATION)
  })

  test('landmark-free pages stay unknown inside a site that uses landmarks elsewhere', async () => {
    const report = await crawl(placementSitePages)

    expect(placement(anchorEdge(report, '/legacy-page', '/chatgpt-seo-agency'))).toEqual(UNKNOWN)
    expect(placement(anchorEdge(report, '/legacy-page', '/pricing'))).toEqual(UNKNOWN)
    expect(placement(anchorEdge(report, '/legacy-page', '/terms'))).toEqual(UNKNOWN)
    expect(placement(anchorEdge(report, '/', '/blog/how-to-rank-on-chatgpt'))).toEqual(CONTENT)
  })

  test('placement counts account for every anchor occurrence and no non-anchor edge', async () => {
    const report = await crawl(placementSitePages)

    for (const edge of report.edges) {
      const counts = placement(edge)
      const counted = counts.navigation + counts.content + counts.unknown
      expect(counted).toBe(edge.type === 'anchor' ? edge.totalOccurrences : 0)
    }
    expect(report.summary.linkPlacementRulesetVersion).toBe('1.0.0')
  })

  test('a canonical edge carries zeros because it has no position in a page', async () => {
    const report = await crawl({
      '/': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Canonical</title>
<link rel="canonical" href="/canonical-target"></head><body><main><a href="/linked">Linked</a></main></body></html>`,
    })

    const canonical = report.edges.find((edge) => edge.type === 'canonical')
    expect(canonical && placement(canonical)).toEqual({ navigation: 0, content: 0, unknown: 0 })
    expect(placement(anchorEdge(report, '/', '/linked'))).toEqual(CONTENT)
  })

  test('the new fields are optional, so a graph from before this ruleset still fits the contract', async () => {
    // Both assignments fail to compile (TS2741) if either field is required, which
    // is why a minor release can add them. The engine always populates them.
    const legacyEdge: CrawlEdgeObservation = {
      key: 'edge:legacy',
      from: `${ORIGIN}/blog/how-to-rank-on-chatgpt`,
      to: `${ORIGIN}/chatgpt-seo-agency`,
      type: 'anchor',
      classification: 'internal',
      totalOccurrences: 2,
      followableOccurrences: 2,
      nofollowOccurrences: 0,
      anchorSummaries: [{ text: 'ChatGPT SEO Agency', occurrences: 2 }],
    }
    expect(legacyEdge.placementOccurrences).toBeUndefined()

    const report = await crawl(placementSitePages)
    const withoutRulesetVersion: Omit<CrawlSummary, 'linkPlacementRulesetVersion'> = report.summary
    const legacySummary: CrawlSummary = withoutRulesetVersion
    expect(legacySummary.linkPlacementRulesetVersion).toBe('1.0.0')
    expect(report.edges.every((edge) => edge.placementOccurrences !== undefined)).toBe(true)
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

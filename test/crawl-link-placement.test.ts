import { afterEach, describe, expect, test, vi } from 'vitest'

import { RECOGNIZED_ARIA_ROLES, runSiteCrawl } from '../src/index.js'
import type { CrawlEdgeObservation, CrawlLinkPlacement, CrawlPlacementOccurrences, CrawlSummary, FullSiteCrawlReport } from '../src/types.js'
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

/**
 * One page of probe links, resolved in a single crawl.
 *
 * Targets are off-host so the crawler records the edge and never fetches them,
 * which keeps a 400-cell sweep to five page loads.
 */
const PROBE_HOST = 'https://probes.invalid'

async function probePlacements(links: Array<[id: string, html: (anchor: string) => string]>): Promise<Record<string, CrawlLinkPlacement>> {
  const body = links.map(([id, wrap]) => wrap(`<a href="${PROBE_HOST}/${id}">${id}</a>`)).join('\n')
  const report = await crawl({ '/': doc(body) })
  const resolved: Record<string, CrawlLinkPlacement> = {}
  for (const edge of report.edges) {
    if (edge.type !== 'anchor' || !edge.to.startsWith(PROBE_HOST)) continue
    const counts = placement(edge)
    const hit = (['navigation', 'content', 'unknown'] as const).filter((key) => counts[key] > 0)
    if (hit.length !== 1) throw new Error(`probe ${edge.to} resolved to ${hit.length} placements`)
    resolved[edge.to.slice(`${PROBE_HOST}/`.length)] = hit[0]
  }
  return resolved
}

afterEach(() => vi.unstubAllGlobals())

/* ── The interaction matrix ──
 *
 * Two rounds of spec findings were all the same shape: a rule applied on the tag
 * path but not the role path, or on the placement path but not the scoping path.
 * This enumerates that interaction space directly. Every element under test is
 * the link's parent; every context is its grandparent.
 *
 * Columns are the ancestor contexts below. A context that is itself a landmark
 * both scopes a `header` / `footer` and answers the walk when the element under
 * test is not a landmark.
 */
const N: CrawlLinkPlacement = 'navigation'
const C: CrawlLinkPlacement = 'content'
const U: CrawlLinkPlacement = 'unknown'

const CONTEXTS: Array<[name: string, wrap: (inner: string) => string]> = [
  ['root', (inner) => inner],
  ['inArticle', (inner) => `<article>${inner}</article>`],
  ['inRoleMain', (inner) => `<div role="main">${inner}</div>`],
  ['inSection', (inner) => `<section>${inner}</section>`],
  ['inNav', (inner) => `<nav>${inner}</nav>`],
]

/** [tag, role, root, inArticle, inRoleMain, inSection, inNav] */
const MATRIX: Array<[string, string | null, CrawlLinkPlacement, CrawlLinkPlacement, CrawlLinkPlacement, CrawlLinkPlacement, CrawlLinkPlacement]> = [
  ['nav', null, N, N, N, N, N],
  ['nav', 'navigation', N, N, N, N, N],
  ['nav', 'main', C, C, C, C, C],
  ['nav', 'article', C, C, C, C, C],
  ['nav', 'banner', N, N, N, N, N],
  ['nav', 'region', U, C, C, U, N],
  ['nav', 'button', U, C, C, U, N],
  ['nav', 'doc-chapter', U, C, C, U, N],
  ['nav', 'made-up', N, N, N, N, N],
  ['nav', 'button navigation', U, C, C, U, N],
  ['nav', 'made-up main', C, C, C, C, C],

  ['aside', null, N, N, N, N, N],
  ['aside', 'navigation', N, N, N, N, N],
  ['aside', 'main', C, C, C, C, C],
  ['aside', 'article', C, C, C, C, C],
  ['aside', 'banner', N, N, N, N, N],
  ['aside', 'region', U, C, C, U, N],
  ['aside', 'button', U, C, C, U, N],
  ['aside', 'doc-chapter', U, C, C, U, N],
  ['aside', 'made-up', N, N, N, N, N],
  ['aside', 'button navigation', U, C, C, U, N],
  ['aside', 'made-up main', C, C, C, C, C],

  ['header', null, N, C, C, U, N],
  ['header', 'navigation', N, N, N, N, N],
  ['header', 'main', C, C, C, C, C],
  ['header', 'article', C, C, C, C, C],
  ['header', 'banner', N, N, N, N, N],
  ['header', 'region', U, C, C, U, N],
  ['header', 'button', U, C, C, U, N],
  ['header', 'doc-chapter', U, C, C, U, N],
  ['header', 'made-up', N, C, C, U, N],
  ['header', 'button navigation', U, C, C, U, N],
  ['header', 'made-up main', C, C, C, C, C],

  ['footer', null, N, C, C, U, N],
  ['footer', 'navigation', N, N, N, N, N],
  ['footer', 'main', C, C, C, C, C],
  ['footer', 'article', C, C, C, C, C],
  ['footer', 'banner', N, N, N, N, N],
  ['footer', 'region', U, C, C, U, N],
  ['footer', 'button', U, C, C, U, N],
  ['footer', 'doc-chapter', U, C, C, U, N],
  ['footer', 'made-up', N, C, C, U, N],
  ['footer', 'button navigation', U, C, C, U, N],
  ['footer', 'made-up main', C, C, C, C, C],

  ['main', null, C, C, C, C, C],
  ['main', 'navigation', N, N, N, N, N],
  ['main', 'main', C, C, C, C, C],
  ['main', 'article', C, C, C, C, C],
  ['main', 'banner', N, N, N, N, N],
  ['main', 'region', U, C, C, U, N],
  ['main', 'button', U, C, C, U, N],
  ['main', 'doc-chapter', U, C, C, U, N],
  ['main', 'made-up', C, C, C, C, C],
  ['main', 'button navigation', U, C, C, U, N],
  ['main', 'made-up main', C, C, C, C, C],

  ['article', null, C, C, C, C, C],
  ['article', 'navigation', N, N, N, N, N],
  ['article', 'main', C, C, C, C, C],
  ['article', 'article', C, C, C, C, C],
  ['article', 'banner', N, N, N, N, N],
  ['article', 'region', U, C, C, U, N],
  ['article', 'button', U, C, C, U, N],
  ['article', 'doc-chapter', U, C, C, U, N],
  ['article', 'made-up', C, C, C, C, C],
  ['article', 'button navigation', U, C, C, U, N],
  ['article', 'made-up main', C, C, C, C, C],

  ['section', null, U, C, C, U, N],
  ['section', 'navigation', N, N, N, N, N],
  ['section', 'main', C, C, C, C, C],
  ['section', 'article', C, C, C, C, C],
  ['section', 'banner', N, N, N, N, N],
  ['section', 'region', U, C, C, U, N],
  ['section', 'button', U, C, C, U, N],
  ['section', 'doc-chapter', U, C, C, U, N],
  ['section', 'made-up', U, C, C, U, N],
  ['section', 'button navigation', U, C, C, U, N],
  ['section', 'made-up main', C, C, C, C, C],

  ['div', null, U, C, C, U, N],
  ['div', 'navigation', N, N, N, N, N],
  ['div', 'main', C, C, C, C, C],
  ['div', 'article', C, C, C, C, C],
  ['div', 'banner', N, N, N, N, N],
  ['div', 'region', U, C, C, U, N],
  ['div', 'button', U, C, C, U, N],
  ['div', 'doc-chapter', U, C, C, U, N],
  ['div', 'made-up', U, C, C, U, N],
  ['div', 'button navigation', U, C, C, U, N],
  ['div', 'made-up main', C, C, C, C, C],
]

const cellId = (tag: string, role: string | null) => `${tag}.${(role ?? 'norole').replace(/\s+/g, '_')}`

describe('crawl link placement matrix', () => {
  test.each(CONTEXTS.map(([name], index) => [name, index] as const))('resolves every tag and role inside %s', async (_name, contextIndex) => {
    const wrap = CONTEXTS[contextIndex][1]
    const resolved = await probePlacements(MATRIX.map(([tag, role]) => [
      cellId(tag, role),
      (anchor: string) => wrap(`<${tag}${role === null ? '' : ` role="${role}"`}>${anchor}</${tag}>`),
    ]))

    const actual = MATRIX.map(([tag, role]) => [cellId(tag, role), resolved[cellId(tag, role)]])
    const expected = MATRIX.map((row) => [cellId(row[0], row[1]), row[2 + contextIndex]])
    expect(actual).toEqual(expected)
  })

  test('a native element and the author role that mirrors it always agree', async () => {
    // The landmark table is one row per landmark, so these two paths cannot
    // drift apart. `section`/`region` agree by both carrying no placement.
    const pairs: Array<[tag: string, role: string]> = [
      ['nav', 'navigation'],
      ['aside', 'complementary'],
      ['main', 'main'],
      ['article', 'article'],
      ['section', 'region'],
      ['header', 'banner'],
      ['footer', 'contentinfo'],
    ]
    for (const [, wrap] of CONTEXTS) {
      const resolved = await probePlacements(pairs.flatMap(([tag, role]) => ([
        [`tag.${tag}`, (anchor: string) => wrap(`<${tag}>${anchor}</${tag}>`)],
        [`role.${tag}`, (anchor: string) => wrap(`<div role="${role}">${anchor}</div>`)],
      ] as Array<[string, (anchor: string) => string]>)))
      for (const [tag] of pairs) {
        // header/footer are the one asymmetry, and it is the spec's: the native
        // element's mapping is conditional on scope, while an explicit
        // role="banner" is unconditional. Compare them only where scope agrees.
        if ((tag === 'header' || tag === 'footer') && wrap('x') !== 'x') continue
        expect([tag, resolved[`tag.${tag}`]]).toEqual([tag, resolved[`role.${tag}`]])
      }
      vi.unstubAllGlobals()
    }
  })
})

describe('crawl link placement', () => {
  test('recognizes DPUB roles, so a doc role overrides its native tag', async () => {
    for (const role of ['doc-chapter', 'doc-footnote', 'doc-toc', 'doc-biblioref', 'doc-pagebreak']) {
      expect(RECOGNIZED_ARIA_ROLES.has(role)).toBe(true)
    }
    const resolved = await probePlacements([
      ['footnote', (a) => `<footer role="doc-footnote">${a}</footer>`],
      ['toc', (a) => `<nav role="doc-toc">${a}</nav>`],
      ['chapter-in-aside', (a) => `<aside role="doc-chapter">${a}</aside>`],
      ['scoped-footnote', (a) => `<article><footer role="doc-footnote">${a}</footer></article>`],
    ])

    // No doc-* role carries a placement, so the element is not a landmark and
    // its tag is not consulted. The walk continues to whatever encloses it.
    expect(resolved.footnote).toBe(U)
    expect(resolved.toc).toBe(U)
    expect(resolved['chapter-in-aside']).toBe(U)
    expect(resolved['scoped-footnote']).toBe(C)
  })

  test('the recognized role list excludes abstract roles', async () => {
    for (const role of ['navigation', 'main', 'button', 'tablist', 'generic', 'none', 'region', 'search', 'form']) {
      expect(RECOGNIZED_ARIA_ROLES.has(role)).toBe(true)
    }
    // Authors must not use abstract roles and user agents ignore them, so they
    // must not suppress a tag's native landmark semantics.
    for (const role of ['landmark', 'widget', 'structure', 'roletype', 'section', 'sectionhead', 'window']) {
      expect(RECOGNIZED_ARIA_ROLES.has(role)).toBe(false)
    }
    const resolved = await probePlacements([['abstract', (a) => `<nav role="landmark">${a}</nav>`]])
    expect(resolved.abstract).toBe(N)
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

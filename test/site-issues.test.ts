import { describe, expect, it } from 'vitest'
import { buildSiteIssues } from '../src/sitemap.js'
import type { SitemapPageResult } from '../src/types.js'

const page = (path: string, over: { description?: string | null; links?: string[] } = {}) =>
  ({
    url: `https://x.test${path}`,
    overallScore: 70,
    status: 'success',
    factors: [],
    metadata: {
      fetchTimeMs: 1,
      pageTitle: 'T',
      wordCount: 500,
      metaDescription: over.description ?? null,
      internalLinks: (over.links ?? []).map((l) => `https://x.test${l}`),
      auxiliary: {
        llmsTxt: 'missing',
        llmsFullTxt: 'missing',
        robotsTxt: 'missing',
        sitemapXml: 'missing',
      },
      redirectChain: [],
    },
  }) as unknown as SitemapPageResult

describe('two pages saying the same thing', () => {
  it('names every page sharing a description, once', () => {
    const same = 'A boutique hotel at 15 Rose Avenue in Venice, California.'
    const issues = buildSiteIssues(
      [
        page('/', { description: same }),
        page('/contact', { description: same }),
        page('/location', { description: same }),
        page('/rooms', { description: 'Something else entirely.' }),
      ],
      0,
      0,
    )
    const dupes = issues.filter((i) => i.code === 'site.duplicate-meta-description')
    expect(dupes).toHaveLength(1)
    expect(dupes[0]?.affectedUrls).toEqual([
      'https://x.test/',
      'https://x.test/contact',
      'https://x.test/location',
    ])
    expect(dupes[0]?.message).toContain('3 pages share the same meta description')
  })

  it('says nothing when every description is its own', () => {
    const issues = buildSiteIssues([page('/', { description: 'a' }), page('/b', { description: 'b' })], 0, 0)
    expect(issues.filter((i) => i.code === 'site.duplicate-meta-description')).toEqual([])
  })

  it('does not treat two missing descriptions as a match', () => {
    // Absent is not a shared value. Grouping on null would report every
    // description-less site as one giant duplicate.
    const issues = buildSiteIssues([page('/'), page('/b'), page('/c')], 0, 0)
    expect(issues.filter((i) => i.code === 'site.duplicate-meta-description')).toEqual([])
  })
})

describe('a page nothing links to', () => {
  const site = (extra: SitemapPageResult[] = []) => [
    page('/', { links: ['/rooms', '/about'] }),
    page('/rooms', { links: ['/', '/about'] }),
    page('/about', { links: ['/'] }),
    page('/faq', { links: ['/'] }),
    page('/orphan', { links: ['/'] }),
    ...extra,
  ]

  it('names it, and never names the homepage', () => {
    const issues = buildSiteIssues(site(), 0, 0)
    const orphans = issues.filter((i) => i.code === 'site.orphan-page')
    // The homepage is arrived at directly; /faq and /orphan are linked from
    // nowhere. The homepage must not appear however few pages point at it.
    expect(orphans.map((o) => o.affectedUrls[0])).toEqual([
      'https://x.test/faq',
      'https://x.test/orphan',
    ])
    expect(orphans.some((o) => o.affectedUrls[0] === 'https://x.test/')).toBe(false)
  })

  it('ignores the fragment and the query when matching a link to a page', () => {
    const pages = site()
    pages[0] = page('/', { links: ['/rooms', '/about', '/faq#hours', '/orphan?utm=x'] })
    expect(buildSiteIssues(pages, 0, 0).filter((i) => i.code === 'site.orphan-page')).toEqual([])
  })

  it('SAYS NOTHING when the crawl did not see the whole site', () => {
    // The one that matters. Inbound links from a page never fetched are never
    // observed, so on a truncated crawl every unlinked page looks orphaned on
    // the strength of not having looked. A hedged finding on an automated board
    // is worse than none.
    expect(buildSiteIssues(site(), 5, 0).filter((i) => i.code === 'site.orphan-page')).toEqual([])
    expect(buildSiteIssues(site(), 0, 3).filter((i) => i.code === 'site.orphan-page')).toEqual([])
  })

  it('says nothing about a site too small for a link graph to mean anything', () => {
    const tiny = [page('/', { links: ['/a'] }), page('/a', { links: ['/'] }), page('/b')]
    expect(buildSiteIssues(tiny, 0, 0).filter((i) => i.code === 'site.orphan-page')).toEqual([])
  })
})

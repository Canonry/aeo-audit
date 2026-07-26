import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Per-page audits must not run for real; capture them so the fan-out assertions are
// about sitemap fetching only.
const runAeoAuditMock = vi.hoisted(() => vi.fn())
vi.mock('../src/index.js', () => ({ runAeoAudit: runAeoAuditMock }))

import { runSitemapAudit } from '../src/sitemap.js'
import type { SitemapAuditPlan } from '../src/types.js'

// Mirrors the constant in src/sitemap.ts. Kept in sync by the cap test below, which
// would fail loudly (wrong fetched count) if the source value changed.
const MAX_CHILD_SITEMAPS = 1000

function xml(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } })
}

function indexOf(locs: string[]): string {
  const children = locs.map((loc) => `  <sitemap><loc>${loc}</loc></sitemap>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${children}\n</sitemapindex>`
}

function childOf(page: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${page}</loc></url>\n</urlset>`
}

function fakeReport(url: string) {
  return {
    url,
    finalUrl: url,
    auditedAt: '2026-01-01T00:00:00.000Z',
    overallScore: 90,
    summary: '',
    factors: [],
    metadata: {
      fetchTimeMs: 0,
      pageTitle: '',
      wordCount: 0,
      metaDescription: null,
      internalLinks: [],
      auxiliary: { llmsTxt: 'missing', llmsFullTxt: 'missing', robotsTxt: 'missing', sitemapXml: 'missing' },
      redirectChain: [],
    },
  }
}

beforeEach(() => {
  runAeoAuditMock.mockReset()
  runAeoAuditMock.mockImplementation((url: string) => Promise.resolve(fakeReport(url)))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('runSitemapAudit child-sitemap fan-out', () => {
  it('fetches index children with bounded concurrency (no unbounded fan-out)', async () => {
    const locs = Array.from({ length: 30 }, (_, i) => `http://1.1.1.1/child-${i}.xml`)
    let inFlight = 0
    let maxInFlight = 0

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('sitemap-index.xml')) return xml(indexOf(locs))
      // Hold each child fetch open briefly so overlapping requests are observable.
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 10))
      inFlight -= 1
      const n = url.match(/child-(\d+)\.xml/)?.[1] ?? '0'
      return xml(childOf(`http://1.1.1.1/page-${n}`))
    }))

    await runSitemapAudit('http://1.1.1.1/', { sitemapUrl: 'http://1.1.1.1/sitemap-index.xml' })

    // The safety property: never more than DEFAULT_CONCURRENCY (5) child fetches at once.
    expect(maxInFlight).toBeLessThanOrEqual(5)
    // Sanity: it really did run them concurrently, not one-at-a-time.
    expect(maxInFlight).toBeGreaterThan(1)
  })

  it('caps child sitemaps at MAX_CHILD_SITEMAPS and reports the skipped count', async () => {
    const total = MAX_CHILD_SITEMAPS + 3
    const locs = Array.from({ length: total }, (_, i) => `http://1.1.1.1/child-${i}.xml`)
    const childFetches: string[] = []

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('sitemap-index.xml')) return xml(indexOf(locs))
      childFetches.push(url)
      const n = url.match(/child-(\d+)\.xml/)?.[1] ?? '0'
      return xml(childOf(`http://1.1.1.1/page-${n}`))
    }))

    let plan: SitemapAuditPlan | undefined
    await runSitemapAudit('http://1.1.1.1/', {
      sitemapUrl: 'http://1.1.1.1/sitemap-index.xml',
      onPlan: (p) => { plan = p },
    })

    // Exactly the first MAX_CHILD_SITEMAPS children were fetched; the rest were dropped.
    expect(childFetches).toHaveLength(MAX_CHILD_SITEMAPS)
    expect(childFetches.some((u) => u.includes(`child-${total - 1}.xml`))).toBe(false)
    expect(plan?.childSitemapsSkipped).toBe(3)
  })
})

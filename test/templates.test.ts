import { describe, it, expect } from 'vitest'

import { buildTemplateGroups, summarizeFixReach } from '../src/templates.js'
import type { ScoredFactor, SitemapPageResult } from '../src/types.js'

function factors(scores: Record<string, number>): ScoredFactor[] {
  return Object.entries(scores).map(([id, score]) => ({
    id,
    name: id,
    weight: 5,
    score,
    findings: [],
    recommendations: [],
  }))
}

function page(url: string, scores: Record<string, number>, overallScore = 50): SitemapPageResult {
  return { url, overallScore, status: 'success', factors: factors(scores) }
}

const TEMPLATED = { 'content-depth': 58, 'schema-completeness': 42 }

describe('buildTemplateGroups', () => {
  it('collapses same-shape pages that score alike into one template', () => {
    const pages = Array.from({ length: 194 }, (_, i) =>
      page(`https://example.com/properties/city${i % 10}/p-${i}`, TEMPLATED),
    )
    const groups = buildTemplateGroups(pages)

    expect(groups).toHaveLength(1)
    expect(groups[0]?.templateKey).toBe('/properties/*/*')
    expect(groups[0]?.pageCount).toBe(194)
  })

  it('absorbs boundary noise rather than splitting on a one-point drift', () => {
    // One property description a few words longer crosses a content-depth
    // bucket. Exact score-vector equality would call that a second template and
    // report the same one-line fix twice.
    const pages = [
      ...Array.from({ length: 20 }, (_, i) => page(`https://example.com/p/a-${i}`, { depth: 58 })),
      ...Array.from({ length: 20 }, (_, i) => page(`https://example.com/p/b-${i}`, { depth: 57 })),
    ]
    expect(buildTemplateGroups(pages)).toHaveLength(1)
  })

  it('will not merge pages that only happen to be equally bad', () => {
    // Identical scores, unrelated routes. Score alone would call this one
    // template and tell someone 40 pages are a single edit.
    const pages = [
      ...Array.from({ length: 20 }, (_, i) => page(`https://example.com/properties/p-${i}`, TEMPLATED)),
      ...Array.from({ length: 20 }, (_, i) => page(`https://example.com/careers/job-${i}`, TEMPLATED)),
    ]
    const groups = buildTemplateGroups(pages)

    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.templateKey).sort()).toEqual(['/careers/*', '/properties/*'])
  })

  it('will not merge same-shape pages whose scores genuinely differ', () => {
    const pages = [
      ...Array.from({ length: 10 }, (_, i) => page(`https://example.com/p/good-${i}`, { depth: 90 })),
      ...Array.from({ length: 10 }, (_, i) => page(`https://example.com/p/bad-${i}`, { depth: 20 })),
    ]
    const groups = buildTemplateGroups(pages)

    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.avgScore >= 0)).toEqual([true, true])
    expect(groups.every((g) => g.scoreRange <= 2)).toBe(true)
  })

  it('does not let a chain of small steps drift into one template', () => {
    // 58 → 57 → 56 … every page is within tolerance of its neighbour, but the
    // ends are nothing alike. Comparing each page against the one that opened
    // its cluster caps the spread; comparing against the previous page would
    // walk the whole range and call all 12 one template.
    const pages = Array.from({ length: 12 }, (_, i) =>
      page(`https://example.com/p/${i}`, { depth: 58 - i }),
    )
    const groups = buildTemplateGroups(pages)

    expect(groups).toHaveLength(4)
    expect(groups.every((g) => g.scoreRange <= 2)).toBe(true)
  })

  it('ignores pages with too few instances to be a pattern', () => {
    const pages = [
      page('https://example.com/a', { depth: 50 }),
      page('https://example.com/b', { depth: 90 }),
    ]
    expect(buildTemplateGroups(pages)).toEqual([])
  })

  it('skips error pages and pages with no factors', () => {
    const pages: SitemapPageResult[] = [
      ...Array.from({ length: 12 }, (_, i) => page(`https://example.com/p/${i}`, TEMPLATED)),
      { url: 'https://example.com/p/broken', overallScore: 0, status: 'error', error: 'timeout' },
    ]
    const groups = buildTemplateGroups(pages)

    expect(groups).toHaveLength(1)
    expect(groups[0]?.urls).not.toContain('https://example.com/p/broken')
  })

  it('declines to infer a template from too few URLs to tell route from id', () => {
    // 4 URLs at /p/<x>: with this little to go on, `x` could just as easily be a
    // route name as an identifier. Staying split is the conservative error.
    const pages = Array.from({ length: 4 }, (_, i) => page(`https://example.com/p/${i}`, TEMPLATED))
    expect(buildTemplateGroups(pages)).toEqual([])
  })

  it('does not compare pages that ran different factors', () => {
    const pages = [
      ...Array.from({ length: 5 }, (_, i) => page(`https://example.com/p/a-${i}`, { depth: 58 })),
      ...Array.from({ length: 5 }, (_, i) => page(`https://example.com/p/b-${i}`, { depth: 58, extra: 58 })),
    ]
    expect(buildTemplateGroups(pages)).toHaveLength(2)
  })

  it('points the fix at the strongest instance of the template', () => {
    const pages = [
      ...Array.from({ length: 12 }, (_, i) => page(`https://example.com/p/x-${i}`, { depth: 56 })),
      page('https://example.com/p/best', { depth: 58 }),
    ]
    const groups = buildTemplateGroups(pages)

    expect(groups).toHaveLength(1)
    expect(groups[0]?.representativeUrl).toBe('https://example.com/p/best')
  })

  it('lists every page in the group — grouping is an overlay, not a filter', () => {
    const pages = Array.from({ length: 50 }, (_, i) => page(`https://example.com/p/x-${i}`, TEMPLATED))
    const groups = buildTemplateGroups(pages)

    expect(groups[0]?.urls).toHaveLength(50)
    expect(new Set(groups[0]?.urls)).toEqual(new Set(pages.map((p) => p.url)))
  })

  it('is deterministic across page orderings', () => {
    const pages = Array.from({ length: 30 }, (_, i) => page(`https://example.com/p/x-${i}`, TEMPLATED))
    const forward = buildTemplateGroups(pages)
    const reversed = buildTemplateGroups([...pages].reverse())
    expect(forward).toEqual(reversed)
  })
})

describe('summarizeFixReach', () => {
  const pages = Array.from({ length: 194 }, (_, i) =>
    page(`https://example.com/properties/city${i % 10}/p-${i}`, TEMPLATED),
  )
  const groups = buildTemplateGroups(pages)

  it('costs a templated fix as one unit of work', () => {
    const reach = summarizeFixReach(pages.map((p) => p.url), groups)
    expect(reach).toEqual({ templates: 1, instances: 194 })
  })

  it('counts pages outside any template individually', () => {
    const reach = summarizeFixReach(
      [...pages.map((p) => p.url), 'https://example.com/about', 'https://example.com/contact'],
      groups,
    )
    expect(reach).toEqual({ templates: 3, instances: 196 })
  })

  it('reports nothing for a fix with no affected pages', () => {
    expect(summarizeFixReach([], groups)).toEqual({ templates: 0, instances: 0 })
  })
})

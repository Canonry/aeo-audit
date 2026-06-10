import { describe, it, expect } from 'vitest'

import { buildCrossCuttingIssues, buildPrioritizedFixes } from '../src/sitemap.js'
import type { AuditReport, ScoredFactor } from '../src/types.js'

function factor(overrides: Partial<ScoredFactor> & { id: string; name: string }): ScoredFactor {
  return {
    id: overrides.id,
    name: overrides.name,
    weight: 5,
    score: overrides.score ?? 60,
    findings: overrides.findings ?? [],
    recommendations: overrides.recommendations ?? [],
  }
}

function report(url: string, factors: ScoredFactor[]): AuditReport {
  return {
    schemaVersion: '1.1',
    url,
    finalUrl: url,
    auditedAt: '2026-04-18T00:00:00.000Z',
    overallScore: 60,
    summary: '',
    factors,
    criticalDefects: [],
    metadata: {
      fetchTimeMs: 0,
      pageTitle: '',
      wordCount: 0,
      auxiliary: { llmsTxt: 'missing', llmsFullTxt: 'missing', robotsTxt: 'missing', sitemapXml: 'missing' },
      redirectChain: [],
    },
  }
}

describe('buildCrossCuttingIssues', () => {
  it('aggregates affected URLs per recommendation across pages', () => {
    const metaShortRec = 'Expand the meta description to 150–160 characters.'
    const canonicalRec = 'Add <link rel="canonical" ...>'

    const pages: AuditReport[] = [
      report('https://example.com/a', [
        factor({ id: 'technical-seo', name: 'Technical SEO', score: 50, recommendations: [metaShortRec, canonicalRec] }),
      ]),
      report('https://example.com/b', [
        factor({ id: 'technical-seo', name: 'Technical SEO', score: 55, recommendations: [metaShortRec] }),
      ]),
      report('https://example.com/c', [
        factor({ id: 'technical-seo', name: 'Technical SEO', score: 90, recommendations: [] }),
      ]),
    ]

    const issues = buildCrossCuttingIssues(pages)
    expect(issues).toHaveLength(1)

    const issue = issues[0]
    expect(issue.factorId).toBe('technical-seo')
    expect(issue.topIssues).toHaveLength(2)

    const metaIssue = issue.topIssues.find((i) => i.recommendation === metaShortRec)
    expect(metaIssue).toBeDefined()
    expect(metaIssue?.affectedUrls).toEqual(['https://example.com/a', 'https://example.com/b'])

    const canonicalIssue = issue.topIssues.find((i) => i.recommendation === canonicalRec)
    expect(canonicalIssue?.affectedUrls).toEqual(['https://example.com/a'])
  })

  it('surfaces issues even when all page scores are above 70 for that factor', () => {
    const rec = 'Expand the meta description to 150–160 characters.'
    const pages: AuditReport[] = [
      report('https://example.com/a', [
        factor({ id: 'technical-seo', name: 'Technical SEO', score: 85, recommendations: [rec] }),
      ]),
    ]

    const issues = buildCrossCuttingIssues(pages)
    expect(issues).toHaveLength(1)
    expect(issues[0].topIssues[0].recommendation).toBe(rec)
    expect(issues[0].topIssues[0].affectedUrls).toEqual(['https://example.com/a'])
  })

  it('omits factors with no recommendations and no low-scoring pages', () => {
    const pages: AuditReport[] = [
      report('https://example.com/a', [
        factor({ id: 'citations', name: 'Citations', score: 95, recommendations: [] }),
      ]),
    ]

    expect(buildCrossCuttingIssues(pages)).toHaveLength(0)
  })
})

describe('buildPrioritizedFixes', () => {
  it('unions every recommendation, so a homepage hit by a non-top recommendation still flips affectsHomepage', () => {
    const metaRec = 'Expand the meta description to 150–160 characters.' // top: two non-homepage pages
    const canonicalRec = 'Add <link rel="canonical" ...>' // homepage only

    const pages: AuditReport[] = [
      report('https://example.com/a', [
        factor({ id: 'technical-seo', name: 'Technical SEO', score: 50, recommendations: [metaRec] }),
      ]),
      report('https://example.com/b', [
        factor({ id: 'technical-seo', name: 'Technical SEO', score: 55, recommendations: [metaRec] }),
      ]),
      report('https://example.com/', [
        factor({ id: 'technical-seo', name: 'Technical SEO', score: 50, recommendations: [canonicalRec] }),
      ]),
    ]

    const fixes = buildPrioritizedFixes(buildCrossCuttingIssues(pages), pages.length)
    const tech = fixes.find((f) => f.id === 'technical-seo')
    expect(tech).toBeDefined()

    // The top recommendation (most pages) hits /a and /b, not the homepage; the homepage
    // is only hit by the canonical recommendation. Reach must union both, so the homepage
    // is included, flagged, and counted — not dropped because it wasn't the top sub-issue.
    expect(tech?.affectsHomepage).toBe(true)
    expect(tech?.affectedPages).toEqual([
      'https://example.com/',
      'https://example.com/a',
      'https://example.com/b',
    ])
    expect(tech?.prevalencePct).toBe(100)
  })
})

describe('page-specific factors (FAQ, definitions): demote, relabel, surface best-page', () => {
  const tuneRec = 'Use question-style headings to match conversational prompts.'
  const addFaqRec = 'Add FAQPage schema for key question-and-answer content.'

  it('classifies an isolated FAQ as limited, demotes it below site-wide gaps, and scopes the fix to the page that has it', () => {
    const pages: AuditReport[] = [
      // Homepage and a product page: a genuine site-wide gap (technical-seo) plus no
      // FAQ — which is correct for those page types, not a defect.
      report('https://example.com/', [
        factor({ id: 'technical-seo', name: 'Technical SEO', score: 50, recommendations: ['Add a meta description.'] }),
        factor({ id: 'faq-content', name: 'FAQ Content', score: 0, recommendations: [addFaqRec, tuneRec] }),
      ]),
      report('https://example.com/product', [
        factor({ id: 'technical-seo', name: 'Technical SEO', score: 55, recommendations: ['Add a meta description.'] }),
        factor({ id: 'faq-content', name: 'FAQ Content', score: 0, recommendations: [addFaqRec, tuneRec] }),
      ]),
      // The FAQ page: FAQPage schema present (34) but no question headings — a tune-up.
      report('https://example.com/faq', [
        factor({ id: 'technical-seo', name: 'Technical SEO', score: 60, recommendations: ['Add a meta description.'] }),
        factor({ id: 'faq-content', name: 'FAQ Content', score: 34, recommendations: [tuneRec] }),
      ]),
    ]

    const issues = buildCrossCuttingIssues(pages)
    const faq = issues.find((i) => i.factorId === 'faq-content')!
    expect(faq.status).toBe('limited')
    expect(faq.pageSpecific).toBe(true)
    expect(faq.bestScore).toBe(34)
    expect(faq.bestPageUrl).toBe('https://example.com/faq')
    // The average stays an honest coverage number: (0 + 0 + 34) / 3 ≈ 11, not recomputed.
    expect(faq.avgScore).toBe(11)

    // The site-wide factor ranks ahead of the page-specific one in the issue list…
    const tech = issues.find((i) => i.factorId === 'technical-seo')!
    expect(tech.status).toBe('sitewide')
    expect(issues.indexOf(tech)).toBeLessThan(issues.indexOf(faq))

    // …and in the prioritized fixes.
    const fixes = buildPrioritizedFixes(issues, pages.length, [], pages)
    expect(fixes.findIndex((f) => f.id === 'technical-seo')).toBeLessThan(
      fixes.findIndex((f) => f.id === 'faq-content'),
    )

    const faqFix = fixes.find((f) => f.id === 'faq-content')!
    expect(faqFix.status).toBe('limited')
    // Scoped to the one page that carries the FAQ — not all three.
    expect(faqFix.affectedPages).toEqual(['https://example.com/faq'])
    // The headline is the tune-up from that page, never "add a FAQ" from the pages
    // that correctly lack one.
    expect(faqFix.recommendation).toBe(tuneRec)
    expect(faqFix.bestScore).toBe(34)
    expect(faqFix.bestPageUrl).toBe('https://example.com/faq')
  })

  it('surfaces best-page context on site-wide factors too (propagate-from-best, not just "add it")', () => {
    const pages: AuditReport[] = [
      report('https://example.com/', [
        factor({ id: 'structured-data', name: 'Structured Data', score: 100, recommendations: [] }),
      ]),
      report('https://example.com/a', [
        factor({ id: 'structured-data', name: 'Structured Data', score: 20, recommendations: ['Add JSON-LD schema.'] }),
      ]),
      report('https://example.com/b', [
        factor({ id: 'structured-data', name: 'Structured Data', score: 20, recommendations: ['Add JSON-LD schema.'] }),
      ]),
    ]
    const issue = buildCrossCuttingIssues(pages).find((i) => i.factorId === 'structured-data')!
    expect(issue.status).toBe('sitewide')
    expect(issue.pageSpecific).toBe(false)
    expect(issue.bestScore).toBe(100)
    expect(issue.bestPageUrl).toBe('https://example.com/') // homepage wins as the propagate-from page

    const fix = buildPrioritizedFixes([issue], pages.length, [], pages).find((f) => f.id === 'structured-data')!
    expect(fix.bestScore).toBe(100)
    // Site-wide reach is unchanged — both low pages still reported, in full.
    expect(fix.affectedPages).toEqual(['https://example.com/a', 'https://example.com/b'])
  })

  it('classifies a page-specific factor absent everywhere as an optional opportunity', () => {
    const addDefRec = 'Add definition blocks or HowTo schema for key terms.'
    const pages: AuditReport[] = [
      report('https://example.com/', [
        factor({ id: 'definition-blocks', name: 'Definition Blocks', score: 0, recommendations: [addDefRec] }),
      ]),
      report('https://example.com/a', [
        factor({ id: 'definition-blocks', name: 'Definition Blocks', score: 10, recommendations: [addDefRec] }),
      ]),
    ]
    const issue = buildCrossCuttingIssues(pages).find((i) => i.factorId === 'definition-blocks')!
    expect(issue.status).toBe('opportunity') // best (10) is below the presence threshold

    const fix = buildPrioritizedFixes([issue], pages.length, [], pages).find((f) => f.id === 'definition-blocks')!
    expect(fix.status).toBe('opportunity')
    expect(fix.affectedPages).toEqual([]) // adding it is discretionary, not a per-page defect
    expect(fix.prevalencePct).toBe(0)
    expect(fix.recommendation).toBe(addDefRec)
  })

  it('keeps status limited under thin coverage — presence, not breadth, is the gate', () => {
    const pages: AuditReport[] = [
      report('https://example.com/faq', [
        factor({ id: 'faq-content', name: 'FAQ Content', score: 34, recommendations: [tuneRec] }),
      ]),
      ...Array.from({ length: 9 }, (_, i) =>
        report(`https://example.com/p${i}`, [
          factor({ id: 'faq-content', name: 'FAQ Content', score: 0, recommendations: [addFaqRec] }),
        ]),
      ),
    ]
    const issue = buildCrossCuttingIssues(pages).find((i) => i.factorId === 'faq-content')!
    // Present on just 1 of 10 pages, yet still a tune-up — low coverage is expected
    // for a page-specific factor and must not downgrade it past `limited`.
    expect(issue.status).toBe('limited')
    expect(issue.bestScore).toBe(34)
  })
})

import { describe, it, expect } from 'vitest'

import { buildCrossCuttingIssues, buildPrioritizedFixes } from '../src/sitemap.js'
import { analyzeFaqContent } from '../src/analyzers/faq-content.js'
import { analyzeDefinitionBlocks } from '../src/analyzers/definition-blocks.js'
import * as cheerio from 'cheerio'
import type { AuditContext, AuditReport, ScoredFactor } from '../src/types.js'

function factor(overrides: Partial<ScoredFactor> & { id: string; name: string }): ScoredFactor {
  return {
    id: overrides.id,
    name: overrides.name,
    weight: 8,
    score: overrides.score ?? 60,
    findings: [],
    recommendations: overrides.recommendations ?? [],
    ...(overrides.applicable === undefined ? {} : { applicable: overrides.applicable }),
  }
}

function report(url: string, factors: ScoredFactor[]): AuditReport {
  return {
    schemaVersion: '3.4',
    url,
    finalUrl: url,
    auditedAt: '2026-08-05T00:00:00.000Z',
    overallScore: 60,
    summary: '',
    factors,
    criticalDefects: [],
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

/** 8 real FAQ pages scoring 58, and 492 pages that were never meant to have one. */
function cortlandShapedSite(): AuditReport[] {
  return [
    ...Array.from({ length: 8 }, (_, i) =>
      report(`https://example.com/faq/topic-${i}`, [
        factor({ id: 'faq-content', name: 'FAQ Content', score: 58, applicable: true, recommendations: ['Expand the FAQ.'] }),
      ]),
    ),
    ...Array.from({ length: 492 }, (_, i) =>
      report(`https://example.com/properties/p-${i}`, [
        factor({ id: 'faq-content', name: 'FAQ Content', score: 0, applicable: false }),
      ]),
    ),
  ]
}

describe('applicable-page rollup', () => {
  it('averages a page-specific factor over the pages it applies to', () => {
    const [issue] = buildCrossCuttingIssues(cortlandShapedSite())

    // The number that could not go in a client deliverable: 1/100 over 500 pages.
    // Still reported, because "how much of the site has this" is a real question.
    expect(issue?.avgScore).toBe(1)
    expect(issue?.affectedPages).toBe(500)
    expect(issue?.totalPages).toBe(500)

    // The number that describes the site: 58/100 across the 8 pages with an FAQ.
    expect(issue?.applicablePages).toBe(8)
    expect(issue?.applicableAvgScore).toBe(58)
    expect(issue?.applicableAffectedPages).toBe(8)
  })

  it('scopes prevalence to the applicable pages, not the whole site', () => {
    const issues = buildCrossCuttingIssues(cortlandShapedSite())
    const [fix] = buildPrioritizedFixes(issues, 500, [], cortlandShapedSite())

    // 8 of 8 pages that have an FAQ need work — not 2% of the site.
    expect(fix?.status).toBe('limited')
    expect(fix?.prevalencePct).toBe(100)
    expect(fix?.applicablePages).toBe(8)
    expect(fix?.applicableAvgScore).toBe(58)
  })

  it('leaves site-wide factors with identical numbers under both denominators', () => {
    const pages = Array.from({ length: 10 }, (_, i) =>
      report(`https://example.com/p-${i}`, [
        factor({ id: 'content-freshness', name: 'Content Freshness', score: 26, recommendations: ['Add dateModified.'] }),
      ]),
    )
    const [issue] = buildCrossCuttingIssues(pages)

    expect(issue?.applicablePages).toBe(issue?.totalPages)
    expect(issue?.applicableAvgScore).toBe(issue?.avgScore)
    expect(issue?.applicableAffectedPages).toBe(issue?.affectedPages)
  })

  it('falls back to the presence threshold when an analyzer stays silent', () => {
    // definition-blocks with no `applicable` declared: pages at or above 30 are
    // read as carrying the factor, which is the pre-existing behavior.
    const pages = [
      ...Array.from({ length: 3 }, (_, i) =>
        report(`https://example.com/guide-${i}`, [factor({ id: 'definition-blocks', name: 'Definition Blocks', score: 54 })]),
      ),
      ...Array.from({ length: 7 }, (_, i) =>
        report(`https://example.com/other-${i}`, [factor({ id: 'definition-blocks', name: 'Definition Blocks', score: 0 })]),
      ),
    ]
    const [issue] = buildCrossCuttingIssues(pages)

    expect(issue?.applicablePages).toBe(3)
    expect(issue?.applicableAvgScore).toBe(54)
    expect(issue?.status).toBe('limited')
  })

  it('scopes a limited fix by the same applicability test as the rollup', () => {
    // Regression: the fix branch filtered on the raw presence threshold while the
    // rollup honoured the analyzer's declaration. A factor the rollup counted on
    // 18 pages reported "present on 0 pages" with an empty affected list, because
    // every one of those pages scored below the threshold.
    const pages = Array.from({ length: 18 }, (_, i) =>
      report(`https://example.com/faq/topic-${i}`, [
        factor({ id: 'faq-content', name: 'FAQ Content', score: 24, applicable: true, recommendations: ['Add FAQPage schema.'] }),
      ]),
    )
    const [fix] = buildPrioritizedFixes(buildCrossCuttingIssues(pages), 18, [], pages)

    expect(fix?.summary).toContain('present on 18 pages')
    expect(fix?.affectedPages).toHaveLength(18)
    expect(fix?.prevalencePct).toBe(100)
  })

  it('reports a factor applying nowhere as an opportunity with no affected pages', () => {
    const pages = Array.from({ length: 10 }, (_, i) =>
      report(`https://example.com/p-${i}`, [factor({ id: 'faq-content', name: 'FAQ Content', score: 0, applicable: false })]),
    )
    const [issue] = buildCrossCuttingIssues(pages)

    expect(issue?.status).toBe('opportunity')
    expect(issue?.applicablePages).toBe(0)
    expect(issue?.applicableAvgScore).toBe(0)
  })
})

function context(html: string, url = 'https://example.com/pricing'): AuditContext {
  const $ = cheerio.load(html)
  return {
    $,
    html,
    url,
    headers: {},
    auxiliary: { llmsTxt: 'missing', llmsFullTxt: 'missing', robotsTxt: 'missing', sitemapXml: 'missing' },
    structuredData: [],
    textContent: $('body').text(),
    pageTitle: $('title').text(),
  } as unknown as AuditContext
}

describe('analyzer-declared applicability', () => {
  it('marks a page that is not an FAQ surface inapplicable', () => {
    const result = analyzeFaqContent(context('<html><title>Floor Plans</title><body><h1>Floor Plans</h1></body></html>'))
    expect(result.applicable).toBe(false)
  })

  it('marks an FAQ page applicable from its URL alone', () => {
    const result = analyzeFaqContent(
      context('<html><title>Help</title><body><h1>Help</h1></body></html>', 'https://example.com/faq'),
    )
    expect(result.applicable).toBe(true)
  })

  it('marks a page built as Q&A applicable even without the naming', () => {
    const html = `<html><title>Leasing</title><body>
      <h2>What is the deposit?</h2><h2>How do I apply?</h2><h3>Can I have pets?</h3>
    </body></html>`
    expect(analyzeFaqContent(context(html)).applicable).toBe(true)
  })

  it('marks a property page inapplicable for definition blocks', () => {
    const html = '<html><title>The Mark</title><body><h1>The Mark</h1><p>Two bedroom.</p></body></html>'
    const result = analyzeDefinitionBlocks(context(html, 'https://example.com/properties/austin/the-mark'))
    expect(result.applicable).toBe(false)
  })

  it('marks explanatory content applicable for definition blocks', () => {
    const html = '<html><title>Guide</title><body><h2>What is a co-signer?</h2></body></html>'
    expect(analyzeDefinitionBlocks(context(html, 'https://example.com/guides/leasing')).applicable).toBe(true)
  })
})

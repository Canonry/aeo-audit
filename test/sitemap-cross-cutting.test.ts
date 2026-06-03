import { describe, it, expect } from 'vitest'

import { buildCrossCuttingIssues } from '../src/sitemap.js'
import type { AuditReport, ScoredFactor } from '../src/types.js'

function factor(overrides: Partial<ScoredFactor> & { id: string; name: string }): ScoredFactor {
  return {
    id: overrides.id,
    name: overrides.name,
    weight: 5,
    grade: overrides.grade ?? 'C',
    status: overrides.status ?? 'partial',
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
    overallGrade: 'C',
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

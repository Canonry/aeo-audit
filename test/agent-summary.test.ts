import { describe, it, expect } from 'vitest'

import { agentSummaryFromAudit, agentSummaryFromSitemap } from '../src/agent-summary.js'
import { formatAgent, formatSitemapAgent } from '../src/formatters/agent.js'
import type {
  AuditReport,
  CriticalDefect,
  CriticalDefectGroup,
  PrioritizedFix,
  ScoredFactor,
  SitemapAuditReport,
} from '../src/types.js'

function factor(overrides: Partial<ScoredFactor> & { id: string; name: string }): ScoredFactor {
  return {
    id: overrides.id,
    name: overrides.name,
    weight: 8,
    score: overrides.score ?? 40,
    findings: overrides.findings ?? [],
    recommendations: overrides.recommendations ?? [],
  }
}

function auditReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    schemaVersion: '1.1',
    url: 'https://example.com/',
    finalUrl: 'https://example.com/',
    auditedAt: '2026-04-18T00:00:00.000Z',
    overallScore: 60,
    summary: '',
    factors: [],
    criticalDefects: [],
    metadata: {
      fetchTimeMs: 0,
      pageTitle: '',
      wordCount: 0,
      auxiliary: { llmsTxt: 'missing', llmsFullTxt: 'missing', robotsTxt: 'missing', sitemapXml: 'missing' },
      redirectChain: [],
    },
    ...overrides,
  }
}

const MULTIPLE_H1: CriticalDefect = {
  id: 'multiple-h1',
  severity: 'critical',
  detail: '2 H1 tags found (expected exactly one).',
  recommendation: 'Consolidate to a single H1; 2 are present.',
}

describe('agentSummaryFromAudit', () => {
  it('reduces a single-page report to a decision with a ranked issue list', () => {
    const report = auditReport({
      criticalDefects: [MULTIPLE_H1],
      factors: [factor({ id: 'faq-content', name: 'FAQ Content', score: 40, recommendations: ['Add FAQPage schema.'] })],
    })
    const summary = agentSummaryFromAudit(report)

    expect(summary.mode).toBe('single')
    expect(summary.url).toBe('https://example.com/')
    expect(summary.score).toBe(60)
    expect(summary.pass).toBe(false)
    expect(summary.criticalDefectCount).toBe(1)
    // Critical defect leads, then the cross-cutting factor fix.
    expect(summary.issues[0]).toMatchObject({ kind: 'critical-defect', id: 'multiple-h1' })
    expect(summary.issues.some((i) => i.id === 'faq-content')).toBe(true)
  })

  it('reports pass=true and no issues for a clean, passing page', () => {
    const report = auditReport({
      overallScore: 92,
      factors: [factor({ id: 'structured-data', name: 'Structured Data', score: 95, recommendations: [] })],
    })
    const summary = agentSummaryFromAudit(report)

    expect(summary.pass).toBe(true)
    expect(summary.criticalDefectCount).toBe(0)
    expect(summary.issues).toEqual([])
  })
})

describe('agentSummaryFromSitemap', () => {
  function sitemapReport(
    criticalDefects: CriticalDefectGroup[],
    prioritizedFixes: PrioritizedFix[],
  ): SitemapAuditReport {
    return {
      schemaVersion: '1.1',
      sitemapUrl: 'https://example.com/sitemap.xml',
      auditedAt: '2026-04-18T00:00:00.000Z',
      pagesDiscovered: 25,
      pagesAudited: 25,
      pagesSkipped: 0,
      pagesFiltered: 0,
      pagesTruncated: 0,
      effectiveLimit: 200,
      aggregateScore: 64,
      pages: [],
      criticalDefects,
      crossCuttingIssues: [],
      prioritizedFixes,
      budget: { exhausted: false, discoveryComplete: true },
    }
  }

  it('maps aggregate fields and forwards prioritizedFixes as issues', () => {
    const group: CriticalDefectGroup = {
      id: 'missing-h1',
      severity: 'critical',
      title: 'Missing H1',
      recommendation: 'Add exactly one H1.',
      pages: [{ url: 'https://example.com/contact', detail: 'No H1 tag.', isHomepage: false }],
    }
    const fix: PrioritizedFix = {
      kind: 'critical-defect',
      id: 'missing-h1',
      title: 'Missing H1',
      recommendation: 'Add exactly one H1.',
      severity: 'critical',
      affectedPages: ['https://example.com/contact'],
      affectsHomepage: false,
      prevalencePct: 4,
      summary: 'Missing H1 (critical) — 1 page: Add exactly one H1.',
    }
    const summary = agentSummaryFromSitemap(sitemapReport([group], [fix]))

    expect(summary.mode).toBe('sitemap')
    expect(summary.url).toBe('https://example.com/sitemap.xml')
    expect(summary.score).toBe(64)
    expect(summary.pass).toBe(false)
    expect(summary.criticalDefectCount).toBe(1)
    expect(summary.issues).toEqual([fix])
  })
})

describe('formatAgent / formatSitemapAgent', () => {
  it('emits valid JSON with the decision keys and none of the heavy detail', () => {
    const parsed = JSON.parse(formatAgent(auditReport({ factors: [factor({ id: 'x', name: 'X' })] })))
    expect(Object.keys(parsed).sort()).toEqual(
      ['criticalDefectCount', 'issues', 'mode', 'pass', 'schemaVersion', 'score', 'tool', 'url'].sort(),
    )
    // The point of agent mode: no 27 pages of factor/page detail.
    expect(parsed.factors).toBeUndefined()
    expect(parsed.pages).toBeUndefined()
    expect(parsed.tool).toBe('@ainyc/aeo-audit')
  })

  it('formatSitemapAgent emits valid JSON', () => {
    const report: SitemapAuditReport = {
      schemaVersion: '1.1',
      sitemapUrl: 'https://example.com/sitemap.xml',
      auditedAt: '2026-04-18T00:00:00.000Z',
      pagesDiscovered: 1,
      pagesAudited: 1,
      pagesSkipped: 0,
      pagesFiltered: 0,
      pagesTruncated: 0,
      effectiveLimit: 200,
      aggregateScore: 80,
      pages: [],
      criticalDefects: [],
      crossCuttingIssues: [],
      prioritizedFixes: [],
      budget: { exhausted: false, discoveryComplete: true },
    }
    const parsed = JSON.parse(formatSitemapAgent(report))
    expect(parsed.mode).toBe('sitemap')
    expect(parsed.pass).toBe(true)
    expect(parsed.pages).toBeUndefined()
  })
})

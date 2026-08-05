import { describe, it, expect } from 'vitest'

import { compareReports, renderCompareMarkdown, driftLevel, isSitemapReport, DEFAULT_COMPARE_POLICY } from '../src/compare.js'
import { isAeoAuditError } from '../src/errors.js'
import type {
  AuditReport,
  ComparePolicy,
  CriticalDefect,
  CriticalDefectGroup,
  CriticalDefectId,
  CriticalDefectSeverity,
  ScoredFactor,
  SitemapAuditReport,
  SitemapPageResult,
} from '../src/types.js'

/* ── fixtures ── */

function factor(id: string, score: number): ScoredFactor {
  return { id, name: id, weight: 10, score, findings: [], recommendations: [] }
}

function singleReport(opts: {
  score: number
  factors?: ScoredFactor[]
  defects?: CriticalDefect[]
  schemaVersion?: string
  engineVersion?: string | null
  factorIds?: string[]
  finalUrl?: string
}): AuditReport {
  const factors = opts.factors ?? [factor('structured-data', opts.score)]
  const finalUrl = opts.finalUrl ?? 'https://x.test/'
  const report: AuditReport = {
    schemaVersion: opts.schemaVersion ?? '3.0',
    url: finalUrl,
    finalUrl,
    auditedAt: '2026-01-01T00:00:00.000Z',
    overallScore: opts.score,
    summary: '',
    factors,
    criticalDefects: opts.defects ?? [],
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
  if (opts.engineVersion !== null) {
    report.compareMeta = {
      engineVersion: opts.engineVersion ?? '4.1.0',
      factorIds: opts.factorIds ?? factors.map((f) => f.id).sort(),
    }
  }
  return report
}

function page(
  url: string,
  score: number,
  opts: { status?: 'success' | 'error'; factors?: ScoredFactor[]; error?: string } = {},
): SitemapPageResult {
  const status = opts.status ?? 'success'
  return {
    url,
    overallScore: status === 'success' ? score : 0,
    status,
    error: opts.error,
    factors: status === 'success' ? (opts.factors ?? [factor('structured-data', score)]) : undefined,
  }
}

function defectGroup(
  id: CriticalDefectId,
  severity: CriticalDefectSeverity,
  urls: string[],
): CriticalDefectGroup {
  return {
    id,
    severity,
    title: id,
    recommendation: '',
    pages: urls.map((url) => ({ url, detail: '', isHomepage: url.endsWith('/') })),
  }
}

function sitemapReport(opts: {
  pages: SitemapPageResult[]
  defects?: CriticalDefectGroup[]
  schemaVersion?: string
  engineVersion?: string | null
  factorIds?: string[]
  pagesDiscovered?: number
  pagesAudited?: number
  pagesTruncated?: number
}): SitemapAuditReport {
  const success = opts.pages.filter((p) => p.status === 'success')
  const agg = success.length ? Math.round(success.reduce((a, p) => a + p.overallScore, 0) / success.length) : 0
  const report: SitemapAuditReport = {
    schemaVersion: opts.schemaVersion ?? '3.0',
    sitemapUrl: 'https://x.test/sitemap.xml',
    auditedAt: '2026-01-01T00:00:00.000Z',
    pagesDiscovered: opts.pagesDiscovered ?? opts.pages.length,
    pagesAudited: opts.pagesAudited ?? opts.pages.length,
    pagesSkipped: 0,
    pagesFiltered: 0,
    pagesTruncated: opts.pagesTruncated ?? 0,
    effectiveLimit: 200,
    aggregateScore: agg,
    pages: opts.pages,
    criticalDefects: opts.defects ?? [],
    coverage: { pagesAudited: 1, pagesDiscovered: 1, coveragePct: 100, sampled: false, selection: 'all', templatesDiscovered: 1, templatesRepresented: 1, confidence: 'full' },
    templateGroups: [],
    crossCuttingIssues: [],
    siteIssues: [],
    prioritizedFixes: [],
  }
  if (opts.engineVersion !== null) {
    report.compareMeta = {
      engineVersion: opts.engineVersion ?? '4.1.0',
      factorIds: opts.factorIds ?? [...new Set(success.flatMap((p) => (p.factors ?? []).map((f) => f.id)))].sort(),
    }
  }
  return report
}

function policy(overrides: Partial<ComparePolicy> = {}): ComparePolicy {
  return { ...DEFAULT_COMPARE_POLICY, failOn: [], ...overrides }
}

/* ── tests ── */

describe('driftLevel', () => {
  it('classifies major/minor/none', () => {
    expect(driftLevel('3.0', '4.0')).toBe('major')
    expect(driftLevel('3.0', '3.1')).toBe('minor')
    expect(driftLevel('3.0', '3.0')).toBe('none')
    expect(driftLevel('4.0.1', '4.1.0')).toBe('minor')
    expect(driftLevel('4.0.1', '4.0.9')).toBe('none')
  })
})

describe('isSitemapReport', () => {
  it('discriminates report modes', () => {
    expect(isSitemapReport(sitemapReport({ pages: [page('https://x.test/', 80)] }))).toBe(true)
    expect(isSitemapReport(singleReport({ score: 80 }))).toBe(false)
  })
})

describe('no baseline', () => {
  it('passes with result no-baseline by default', () => {
    const r = compareReports(null, singleReport({ score: 80 }), policy())
    expect(r.result).toBe('no-baseline')
    expect(r.verdict).toBe('pass')
    expect(r.currentScore).toBe(80)
  })

  it('fails when on-missing-baseline=fail', () => {
    const r = compareReports(null, singleReport({ score: 80 }), policy({ onMissingBaseline: 'fail' }))
    expect(r.verdict).toBe('fail')
  })
})

describe('overall score (single)', () => {
  it('passes when identical', () => {
    const r = compareReports(singleReport({ score: 80 }), singleReport({ score: 80 }), policy())
    expect(r.verdict).toBe('pass')
    expect(r.result).toBe('pass')
    expect(r.overall?.delta).toBe(0)
  })

  it('fails when overall drops beyond tolerance', () => {
    const r = compareReports(singleReport({ score: 80 }), singleReport({ score: 77 }), policy({ overallTolerance: 2 }))
    expect(r.verdict).toBe('fail')
    expect(r.result).toBe('regression')
    expect(r.overall?.regressed).toBe(true)
  })

  it('passes when overall drop is within tolerance', () => {
    const r = compareReports(singleReport({ score: 80 }), singleReport({ score: 78 }), policy({ overallTolerance: 2 }))
    expect(r.verdict).toBe('pass')
    expect(r.overall?.regressed).toBe(false)
  })

  it('reports an improvement', () => {
    const r = compareReports(singleReport({ score: 80 }), singleReport({ score: 88 }), policy())
    expect(r.result).toBe('improvement')
    expect(r.verdict).toBe('pass')
  })
})

describe('per-factor (single)', () => {
  it('fails when a factor drops beyond tolerance even if overall holds', () => {
    const base = singleReport({ score: 80, factors: [factor('structured-data', 90), factor('content-depth', 70)] })
    const cur = singleReport({ score: 80, factors: [factor('structured-data', 70), factor('content-depth', 70)] })
    const r = compareReports(base, cur, policy({ factorTolerance: 8 }))
    expect(r.verdict).toBe('fail')
    expect(r.regressedFactors.map((f) => f.id)).toEqual(['structured-data'])
  })
})

describe('per-page + availability (sitemap)', () => {
  it('fails when a single page drops beyond tolerance while aggregate holds', () => {
    const base = sitemapReport({ pages: [page('https://x.test/', 90), page('https://x.test/a', 70)] })
    // /a tanks to 50; aggregate 80 -> 70, within overall tolerance is false but page is.
    const cur = sitemapReport({ pages: [page('https://x.test/', 90), page('https://x.test/a', 50)] })
    const r = compareReports(base, cur, policy({ overallTolerance: 50, pageTolerance: 5 }))
    expect(r.verdict).toBe('fail')
    expect(r.regressedPages.map((p) => p.url)).toEqual(['https://x.test/a'])
  })

  it('gates on a page breaking into an error (success -> error) even if aggregate rises', () => {
    const base = sitemapReport({ pages: [page('https://x.test/', 60), page('https://x.test/a', 60)] })
    // /a errors out; aggregate computed from /,only = 90 (rises!). Must still fail.
    const cur = sitemapReport({
      pages: [page('https://x.test/', 90), page('https://x.test/a', 0, { status: 'error', error: 'timeout' })],
    })
    const r = compareReports(base, cur, policy())
    expect(r.verdict).toBe('fail')
    expect(r.droppedPages).toEqual([{ url: 'https://x.test/a', now: 'error', error: 'timeout' }])
    expect(r.overall?.delta).toBeGreaterThan(0) // aggregate actually went up
  })

  it('treats a deleted page as removed (report-only by default, gated via fail-on)', () => {
    const base = sitemapReport({ pages: [page('https://x.test/', 80), page('https://x.test/a', 80)] })
    const cur = sitemapReport({ pages: [page('https://x.test/', 80)] })
    const lenient = compareReports(base, cur, policy())
    expect(lenient.removedPages).toEqual(['https://x.test/a'])
    expect(lenient.verdict).toBe('pass')
    const strict = compareReports(base, cur, policy({ failOn: ['removed-pages'] }))
    expect(strict.verdict).toBe('fail')
  })
})

describe('defects', () => {
  it('gates on a new critical defect type', () => {
    const base = sitemapReport({ pages: [page('https://x.test/', 80)] })
    const cur = sitemapReport({
      pages: [page('https://x.test/', 80)],
      defects: [defectGroup('multiple-h1', 'critical', ['https://x.test/'])],
    })
    const r = compareReports(base, cur, policy())
    expect(r.verdict).toBe('fail')
    expect(r.newDefects[0]).toMatchObject({ id: 'multiple-h1', kind: 'new-type' })
  })

  it('does NOT gate on a new warning-severity defect by default (missing-meta-description)', () => {
    const base = sitemapReport({ pages: [page('https://x.test/', 80)] })
    const cur = sitemapReport({
      pages: [page('https://x.test/', 80)],
      defects: [defectGroup('missing-meta-description', 'warning', ['https://x.test/'])],
    })
    expect(compareReports(base, cur, policy()).verdict).toBe('pass')
    expect(compareReports(base, cur, policy({ failOn: ['warnings'] })).verdict).toBe('fail')
  })

  it('treats a known defect on a NET-NEW page as report-only (new-page), not a regression', () => {
    const base = sitemapReport({
      pages: [page('https://x.test/', 80), page('https://x.test/a', 80)],
      defects: [defectGroup('multiple-h1', 'critical', ['https://x.test/a'])], // template debt already present
    })
    const cur = sitemapReport({
      pages: [page('https://x.test/', 80), page('https://x.test/a', 80), page('https://x.test/b', 80)],
      defects: [defectGroup('multiple-h1', 'critical', ['https://x.test/a', 'https://x.test/b'])], // same bug on new /b
    })
    const r = compareReports(base, cur, policy())
    expect(r.verdict).toBe('pass')
    expect(r.newDefects).toEqual([
      { id: 'multiple-h1', severity: 'critical', title: 'multiple-h1', kind: 'new-page', pages: ['https://x.test/b'] },
    ])
  })

  it('gates when a known defect spreads to an existing, previously-clean page (page-regression)', () => {
    // missing-h1 already exists on / in the baseline; it spreads to the existing,
    // previously-clean /a in the current run — that page existed and got worse.
    const base = sitemapReport({
      pages: [page('https://x.test/', 80), page('https://x.test/a', 80)],
      defects: [defectGroup('missing-h1', 'critical', ['https://x.test/'])],
    })
    const cur = sitemapReport({
      pages: [page('https://x.test/', 80), page('https://x.test/a', 80)],
      defects: [defectGroup('missing-h1', 'critical', ['https://x.test/', 'https://x.test/a'])],
    })
    const r = compareReports(base, cur, policy())
    expect(r.verdict).toBe('fail')
    expect(r.newDefects).toEqual([
      { id: 'missing-h1', severity: 'critical', title: 'missing-h1', kind: 'page-regression', pages: ['https://x.test/a'] },
    ])
  })
})

describe('comparability guards', () => {
  it('does not gate factor/overall deltas on a factor-set mismatch, and warns', () => {
    const base = singleReport({ score: 80, factors: [factor('structured-data', 80)], factorIds: ['structured-data'] })
    const cur = singleReport({
      score: 60,
      factors: [factor('structured-data', 60), factor('geographic-signals', 40)],
      factorIds: ['geographic-signals', 'structured-data'],
    })
    const r = compareReports(base, cur, policy())
    expect(r.verdict).toBe('pass')
    expect(r.overall?.regressed).toBe(false)
    expect(r.warnings.some((w) => w.includes('Factor set differs'))).toBe(true)
  })

  it('throws COMPARE_MISCONFIG on factor-set mismatch under strictComparability', () => {
    const base = singleReport({ score: 80, factors: [factor('structured-data', 80)], factorIds: ['structured-data'] })
    const cur = singleReport({
      score: 60,
      factors: [factor('structured-data', 60), factor('geographic-signals', 40)],
      factorIds: ['geographic-signals', 'structured-data'],
    })
    try {
      compareReports(base, cur, policy({ strictComparability: true }))
      throw new Error('expected throw')
    } catch (err) {
      expect(isAeoAuditError(err) && err.code).toBe('COMPARE_MISCONFIG')
    }
  })

  it('warns (does not gate) on a major engine drift', () => {
    const base = singleReport({ score: 80, engineVersion: '4.1.0' })
    const cur = singleReport({ score: 60, engineVersion: '5.0.0' })
    const r = compareReports(base, cur, policy())
    expect(r.engineDrift).toBe('major')
    expect(r.overall?.regressed).toBe(false)
    expect(r.verdict).toBe('pass')
  })

  it('reports unknown engine drift when the baseline predates compareMeta', () => {
    const base = singleReport({ score: 80, engineVersion: null })
    const cur = singleReport({ score: 79, engineVersion: '4.1.0' })
    const r = compareReports(base, cur, policy())
    expect(r.engineDrift).toBe('unknown')
    expect(r.warnings.some((w) => w.includes('no engineVersion'))).toBe(true)
  })
})

describe('schema drift', () => {
  it('hard-fails on a major schema drift', () => {
    const base = singleReport({ score: 80, schemaVersion: '2.0' })
    const cur = singleReport({ score: 80, schemaVersion: '3.0' })
    const r = compareReports(base, cur, policy())
    expect(r.verdict).toBe('fail')
    expect(r.schemaDrift).toBe('major')
    expect(r.failReasons.some((f) => f.includes('Schema major'))).toBe(true)
  })

  it('allows an additive minor schema drift with a warning', () => {
    const base = singleReport({ score: 80, schemaVersion: '3.0' })
    const cur = singleReport({ score: 80, schemaVersion: '3.1' })
    const r = compareReports(base, cur, policy())
    expect(r.verdict).toBe('pass')
    expect(r.schemaDrift).toBe('minor')
  })
})

describe('mode mismatch', () => {
  it('throws COMPARE_MISCONFIG when comparing single vs sitemap', () => {
    const base = sitemapReport({ pages: [page('https://x.test/', 80)] })
    const cur = singleReport({ score: 80 })
    try {
      compareReports(base, cur, policy())
      throw new Error('expected throw')
    } catch (err) {
      expect(isAeoAuditError(err) && err.code).toBe('COMPARE_MISCONFIG')
    }
  })
})

describe('report-only mode', () => {
  it('never fails the build but still records the regression', () => {
    const base = singleReport({ score: 80 })
    const cur = singleReport({ score: 50 })
    const r = compareReports(base, cur, policy({ reportOnly: true }))
    expect(r.verdict).toBe('pass')
    expect(r.result).toBe('regression')
    expect(r.regressionCount).toBeGreaterThan(0)
  })
})

describe('truncation warning', () => {
  it('warns when either side was truncated by --limit', () => {
    const base = sitemapReport({ pages: [page('https://x.test/', 80)], pagesDiscovered: 500, pagesTruncated: 300 })
    const cur = sitemapReport({ pages: [page('https://x.test/', 80)], pagesDiscovered: 500, pagesTruncated: 300 })
    const r = compareReports(base, cur, policy())
    expect(r.warnings.some((w) => w.includes('truncated'))).toBe(true)
  })
})

describe('renderCompareMarkdown', () => {
  it('lists every regressed page without truncation', () => {
    const basePages = Array.from({ length: 30 }, (_, i) => page(`https://x.test/p${i}`, 90))
    const curPages = Array.from({ length: 30 }, (_, i) => page(`https://x.test/p${i}`, 50))
    const r = compareReports(sitemapReport({ pages: basePages }), sitemapReport({ pages: curPages }), policy())
    const md = renderCompareMarkdown(r)
    for (let i = 0; i < 30; i += 1) {
      expect(md).toContain(`https://x.test/p${i}`)
    }
    expect(md).not.toContain('more')
  })

  it('renders a first-run no-baseline body', () => {
    const md = renderCompareMarkdown(compareReports(null, singleReport({ score: 72 }), policy()))
    expect(md).toContain('BASELINE')
    expect(md).toContain('72')
  })
})

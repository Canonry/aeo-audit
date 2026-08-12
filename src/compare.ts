import { AeoAuditError } from './errors.js'
import { DEFECT_TITLES } from './critical-defects.js'
import { deepFreeze } from './immutable.js'
import type {
  AuditReport,
  CompareReport,
  ComparePolicy,
  CompareResult,
  DefectChange,
  DefectChangeKind,
  DriftLevel,
  FactorDelta,
  OverallDelta,
  PageAvailabilityChange,
  PageDelta,
  SitemapAuditReport,
  SitemapPageResult,
} from './types.js'

const TOOL = '@canonry/aeo-audit'

/**
 * Conservative, noise-aware defaults. Tolerances are deliberately non-zero:
 * scores are clamped/rounded integers and time-dependent factors (content
 * freshness) drift a point or two between runs, so a 0 tolerance false-fails.
 */
export const DEFAULT_COMPARE_POLICY: Readonly<ComparePolicy> = deepFreeze({
  overallTolerance: 2,
  pageTolerance: 5,
  factorTolerance: 8,
  failOnNewCritical: true,
  failOn: [],
  onMissingBaseline: 'warn',
  reportOnly: false,
  strictComparability: false,
})

type AnyReport = AuditReport | SitemapAuditReport

/** A `SitemapAuditReport` (directory / sitemap run) carries `aggregateScore`. */
export function isSitemapReport(report: AnyReport): report is SitemapAuditReport {
  return 'aggregateScore' in report
}

function scoreOf(report: AnyReport): number {
  return isSitemapReport(report) ? report.aggregateScore : report.overallScore
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`
}

/**
 * Compare two `major.minor[.patch]` version strings: differing major ⇒ `major`,
 * same major but differing minor ⇒ `minor`, otherwise `none`. Patch is ignored.
 */
export function driftLevel(baseline: string, current: string): DriftLevel {
  const [bMaj, bMin = ''] = baseline.split('.')
  const [cMaj, cMin = ''] = current.split('.')
  if (bMaj !== cMaj) return 'major'
  if (bMin !== cMin) return 'minor'
  return 'none'
}

/** Active factor-id set, preferring the embedded `compareMeta` and falling back
 * to deriving it from the report's factor scores (older reports lack the meta). */
function factorIdSet(report: AnyReport): Set<string> {
  const embedded = report.compareMeta?.factorIds
  if (embedded && embedded.length > 0) return new Set(embedded)
  if (isSitemapReport(report)) {
    const ids = new Set<string>()
    for (const page of report.pages) {
      if (page.status === 'success' && page.factors) {
        for (const factor of page.factors) ids.add(factor.id)
      }
    }
    return ids
  }
  return new Set(report.factors.map((factor) => factor.id))
}

function setEquals(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) if (!b.has(value)) return false
  return true
}

interface DimensionResult {
  regressedFactors: FactorDelta[]
  improvedFactorCount: number
  regressedPages: PageDelta[]
  improvedPageCount: number
  droppedPages: PageAvailabilityChange[]
  removedPages: string[]
  addedPages: string[]
  newDefects: DefectChange[]
}

const EMPTY_DIMENSIONS: DimensionResult = {
  regressedFactors: [],
  improvedFactorCount: 0,
  regressedPages: [],
  improvedPageCount: 0,
  droppedPages: [],
  removedPages: [],
  addedPages: [],
  newDefects: [],
}

/**
 * Diff two reports into a regression verdict. `baseline` may be null (first run).
 * Throws `AeoAuditError('COMPARE_MISCONFIG')` for situations where a diff is
 * meaningless — the CLI maps that to exit code 2 (distinct from a real regression).
 *
 * Correctness notes:
 * - `aggregateScore` is the mean of SUCCESS pages only, so a page breaking into an
 *   error REMOVES itself from the mean and can lift the aggregate. The page-
 *   availability dimension (success → error) gates on exactly that, independent of
 *   the score delta.
 * - Score/factor deltas only gate when the two runs are COMPARABLE (same factor
 *   set, no major engine change); otherwise the renormalized scores are apples-to-
 *   oranges and we warn rather than emit a bogus verdict.
 */
export function compareReports(
  baseline: AnyReport | null,
  current: AnyReport,
  policy: ComparePolicy = DEFAULT_COMPARE_POLICY,
): CompareReport {
  const reportMode: 'single' | 'sitemap' = isSitemapReport(current) ? 'sitemap' : 'single'
  const currentScore = scoreOf(current)
  const currentEngineVersion = current.compareMeta?.engineVersion ?? null

  const base: CompareReport = {
    tool: TOOL,
    reportMode,
    result: 'pass',
    verdict: 'pass',
    regressionCount: 0,
    failReasons: [],
    warnings: [],
    currentScore,
    baselineScore: null,
    overall: null,
    regressedFactors: [],
    improvedFactorCount: 0,
    regressedPages: [],
    improvedPageCount: 0,
    droppedPages: [],
    removedPages: [],
    addedPages: [],
    newDefects: [],
    currentSchemaVersion: current.schemaVersion,
    baselineSchemaVersion: null,
    schemaDrift: 'none',
    currentEngineVersion,
    baselineEngineVersion: null,
    engineDrift: 'unknown',
    baselineAuditedAt: null,
    currentAuditedAt: current.auditedAt,
    policy,
  }

  // ── No baseline (first run) ──────────────────────────────────────────────
  if (!baseline) {
    const fail = policy.onMissingBaseline === 'fail' && !policy.reportOnly
    return {
      ...base,
      result: 'no-baseline',
      verdict: fail ? 'fail' : 'pass',
      regressionCount: 0,
      warnings: ['No baseline supplied — nothing to compare against (first run).'],
      failReasons: fail ? ['No baseline available and --on-missing-baseline=fail.'] : [],
    }
  }

  // ── Report-mode mismatch is a misconfiguration, not a regression ─────────
  if (isSitemapReport(baseline) !== isSitemapReport(current)) {
    throw new AeoAuditError(
      'COMPARE_MISCONFIG',
      `Report mode mismatch: baseline is ${isSitemapReport(baseline) ? 'multi-page (sitemap/static-dir)' : 'single-page'}, ` +
        `current is ${reportMode === 'sitemap' ? 'multi-page (sitemap/static-dir)' : 'single-page'}. ` +
        'Regenerate the baseline in the same mode.',
    )
  }

  const baselineScore = scoreOf(baseline)
  const baselineEngineVersion = baseline.compareMeta?.engineVersion ?? null
  const warnings: string[] = []
  const failReasons: string[] = []

  // ── Comparability: factor set + engine major ─────────────────────────────
  const baseFactors = factorIdSet(baseline)
  const curFactors = factorIdSet(current)
  const factorSetMismatch = !setEquals(baseFactors, curFactors)
  const engineDrift: DriftLevel =
    baselineEngineVersion && currentEngineVersion
      ? driftLevel(baselineEngineVersion, currentEngineVersion)
      : 'unknown'

  if (policy.strictComparability && factorSetMismatch) {
    throw new AeoAuditError(
      'COMPARE_MISCONFIG',
      `Factor-set mismatch: baseline [${[...baseFactors].sort().join(', ')}] vs current [${[...curFactors].sort().join(', ')}]. ` +
        'Scores are renormalized over different factor sets and are not comparable. ' +
        'Align --factors/--include-* flags on both sides or regenerate the baseline.',
    )
  }
  if (policy.strictComparability && engineDrift === 'major') {
    throw new AeoAuditError(
      'COMPARE_MISCONFIG',
      `Engine major-version mismatch: baseline produced by ${baselineEngineVersion}, current by ${currentEngineVersion}. ` +
        'Scoring may differ across majors; regenerate the baseline with the current engine.',
    )
  }

  const comparable = !factorSetMismatch && engineDrift !== 'major'
  if (factorSetMismatch) {
    warnings.push(
      `Factor set differs between baseline and current — overall/factor deltas are reported but NOT gated. ` +
        `Baseline: [${[...baseFactors].sort().join(', ')}], current: [${[...curFactors].sort().join(', ')}].`,
    )
  }
  if (engineDrift === 'major') {
    warnings.push(
      `Baseline engine ${baselineEngineVersion} → current ${currentEngineVersion} (major change). ` +
        'Scoring may differ; overall/factor deltas are advisory only — regenerate the baseline.',
    )
  } else if (engineDrift === 'unknown' && !baselineEngineVersion) {
    warnings.push('Baseline has no engineVersion (older report) — engine comparability could not be checked.')
  }

  // ── Schema drift ─────────────────────────────────────────────────────────
  const schemaDrift = driftLevel(baseline.schemaVersion, current.schemaVersion)
  if (schemaDrift === 'minor') {
    warnings.push(`Report schema ${baseline.schemaVersion} → ${current.schemaVersion} (additive minor change).`)
  }

  // ── Overall / aggregate score (always computable from the top level) ─────
  const overallDelta = currentScore - baselineScore
  const overall: OverallDelta = {
    baseline: baselineScore,
    current: currentScore,
    delta: overallDelta,
    regressed: comparable && overallDelta < -policy.overallTolerance,
  }
  if (overall.regressed) {
    failReasons.push(
      `Overall score dropped ${baselineScore} → ${currentScore} (${signed(overallDelta)}, limit ${policy.overallTolerance}).`,
    )
  }

  // A breaking shape change can't be diffed field-by-field safely; gate on it and
  // skip the detailed dimensions (the top-level scores above are still reported).
  if (schemaDrift === 'major') {
    failReasons.unshift(
      `Schema major-version drift: baseline ${baseline.schemaVersion} vs current ${current.schemaVersion}. ` +
        'The diff cannot be trusted across a breaking shape change — regenerate the baseline.',
    )
    const regressionCount = 1 + (overall.regressed ? 1 : 0)
    return {
      ...base,
      result: 'regression',
      verdict: policy.reportOnly ? 'pass' : 'fail',
      regressionCount,
      failReasons,
      warnings,
      baselineScore,
      overall,
      baselineSchemaVersion: baseline.schemaVersion,
      schemaDrift,
      baselineEngineVersion,
      engineDrift,
      baselineAuditedAt: baseline.auditedAt,
    }
  }

  // ── Detailed dimensions ──────────────────────────────────────────────────
  const dims =
    reportMode === 'sitemap'
      ? diffSitemap(baseline as SitemapAuditReport, current as SitemapAuditReport, policy, comparable, warnings)
      : diffSingle(baseline as AuditReport, current as AuditReport, policy, comparable)

  // ── Gate assembly ────────────────────────────────────────────────────────
  for (const page of dims.regressedPages) {
    failReasons.push(
      `Page ${page.url} dropped ${page.baseline} → ${page.current} (${signed(page.delta)}, limit ${policy.pageTolerance}).`,
    )
  }
  for (const factor of dims.regressedFactors) {
    const where = factor.page ? ` on ${factor.page}` : ''
    failReasons.push(
      `Factor ${factor.id}${where} dropped ${factor.baseline} → ${factor.current} (${signed(factor.delta)}, limit ${policy.factorTolerance}).`,
    )
  }
  for (const dropped of dims.droppedPages) {
    failReasons.push(
      dropped.now === 'error'
        ? `Page ${dropped.url} stopped auditing (success → error): ${dropped.error ?? 'unknown error'}.`
        : `Page ${dropped.url} is no longer audited (success → absent).`,
    )
  }

  const gatingDefects = dims.newDefects.filter((defect) => isDefectGating(defect, policy))
  for (const defect of gatingDefects) {
    const verb = defect.kind === 'new-type' ? 'New' : 'Regressed'
    failReasons.push(
      `${verb} ${defect.severity} defect "${defect.title}" on ${defect.pages.length} page(s): ${defect.pages.join(', ')}.`,
    )
  }

  const gateRemoved = policy.failOn.includes('removed-pages') && dims.removedPages.length > 0
  if (gateRemoved) {
    failReasons.push(`Removed pages (--fail-on removed-pages): ${dims.removedPages.join(', ')}.`)
  }

  const dimensionsTripped =
    (overall.regressed ? 1 : 0) +
    (dims.regressedPages.length > 0 ? 1 : 0) +
    (dims.regressedFactors.length > 0 ? 1 : 0) +
    (dims.droppedPages.length > 0 ? 1 : 0) +
    (gatingDefects.length > 0 ? 1 : 0) +
    (gateRemoved ? 1 : 0)

  const hasRegression = dimensionsTripped > 0
  const verdict: 'pass' | 'fail' = hasRegression && !policy.reportOnly ? 'fail' : 'pass'
  const result: CompareResult = hasRegression
    ? 'regression'
    : overallDelta > 0
      ? 'improvement'
      : 'pass'

  return {
    ...base,
    result,
    verdict,
    regressionCount: dimensionsTripped,
    failReasons,
    warnings,
    baselineScore,
    overall,
    regressedFactors: dims.regressedFactors,
    improvedFactorCount: dims.improvedFactorCount,
    regressedPages: dims.regressedPages,
    improvedPageCount: dims.improvedPageCount,
    droppedPages: dims.droppedPages,
    removedPages: dims.removedPages,
    addedPages: dims.addedPages,
    newDefects: dims.newDefects,
    baselineSchemaVersion: baseline.schemaVersion,
    schemaDrift,
    baselineEngineVersion,
    engineDrift,
    baselineAuditedAt: baseline.auditedAt,
  }
}

function isDefectGating(defect: DefectChange, policy: ComparePolicy): boolean {
  if (defect.kind === 'new-page') return false // pre-existing template debt on new content
  if (defect.severity === 'critical') return policy.failOnNewCritical
  return policy.failOn.includes('warnings')
}

function diffSingle(
  baseline: AuditReport,
  current: AuditReport,
  policy: ComparePolicy,
  comparable: boolean,
): DimensionResult {
  const regressedFactors: FactorDelta[] = []
  let improvedFactorCount = 0

  const baseByFactor = new Map(baseline.factors.map((factor) => [factor.id, factor]))
  for (const factor of current.factors) {
    const prior = baseByFactor.get(factor.id)
    if (!prior) continue
    const delta = factor.score - prior.score
    if (delta > 0) improvedFactorCount += 1
    if (comparable && delta < -policy.factorTolerance) {
      regressedFactors.push({
        id: factor.id,
        name: factor.name,
        baseline: prior.score,
        current: factor.score,
        delta,
        regressed: true,
      })
    }
  }

  // A single report is one page that always exists, so there are no per-page or
  // availability changes — a new defect id is a regression of the existing page.
  const baseDefectIds = new Set(baseline.criticalDefects.map((defect) => defect.id))
  const newDefects: DefectChange[] = []
  for (const defect of current.criticalDefects) {
    if (baseDefectIds.has(defect.id)) continue
    newDefects.push({
      id: defect.id,
      severity: defect.severity,
      title: DEFECT_TITLES[defect.id] ?? defect.id,
      kind: 'new-type',
      pages: [current.finalUrl],
    })
  }

  return { ...EMPTY_DIMENSIONS, regressedFactors, improvedFactorCount, newDefects }
}

function diffSitemap(
  baseline: SitemapAuditReport,
  current: SitemapAuditReport,
  policy: ComparePolicy,
  comparable: boolean,
  warnings: string[],
): DimensionResult {
  if (baseline.pagesTruncated > 0 || current.pagesTruncated > 0) {
    warnings.push(
      `Page set was truncated by --limit (baseline ${baseline.pagesAudited}/${baseline.pagesDiscovered}, ` +
        `current ${current.pagesAudited}/${current.pagesDiscovered}); per-page coverage is partial. ` +
        'Raise --limit above the page count on both sides for complete per-page gating.',
    )
  }

  const baseSuccess = new Map<string, SitemapPageResult>()
  const baseAll = new Set<string>()
  for (const page of baseline.pages) {
    baseAll.add(page.url)
    if (page.status === 'success') baseSuccess.set(page.url, page)
  }
  const curSuccess = new Map<string, SitemapPageResult>()
  const curAll = new Set<string>()
  for (const page of current.pages) {
    curAll.add(page.url)
    if (page.status === 'success') curSuccess.set(page.url, page)
  }

  const regressedPages: PageDelta[] = []
  let improvedPageCount = 0
  const regressedFactors: FactorDelta[] = []
  let improvedFactorCount = 0
  const droppedPages: PageAvailabilityChange[] = []
  const removedPages: string[] = []

  for (const [url, basePage] of baseSuccess) {
    const curPage = curSuccess.get(url)
    if (curPage) {
      const delta = curPage.overallScore - basePage.overallScore
      if (delta > 0) improvedPageCount += 1
      if (comparable && delta < -policy.pageTolerance) {
        regressedPages.push({
          url,
          baseline: basePage.overallScore,
          current: curPage.overallScore,
          delta,
          regressed: true,
        })
      }
      // Per-page, per-factor deltas.
      const baseByFactor = new Map((basePage.factors ?? []).map((factor) => [factor.id, factor]))
      for (const factor of curPage.factors ?? []) {
        const prior = baseByFactor.get(factor.id)
        if (!prior) continue
        const fDelta = factor.score - prior.score
        if (fDelta > 0) improvedFactorCount += 1
        if (comparable && fDelta < -policy.factorTolerance) {
          regressedFactors.push({
            id: factor.id,
            name: factor.name,
            page: url,
            baseline: prior.score,
            current: factor.score,
            delta: fDelta,
            regressed: true,
          })
        }
      }
    } else if (curAll.has(url)) {
      // Present in current but no longer scoring → it broke into an error.
      const errored = current.pages.find((page) => page.url === url)
      droppedPages.push({ url, now: 'error', error: errored?.error })
    } else {
      // Gone from the audited set entirely (intentional delete or truncation shift).
      removedPages.push(url)
    }
  }

  const addedPages: string[] = []
  for (const url of curSuccess.keys()) {
    if (!baseAll.has(url)) addedPages.push(url)
  }

  const newDefects = diffSitemapDefects(baseline, current, baseSuccess)

  return {
    regressedFactors,
    improvedFactorCount,
    regressedPages,
    improvedPageCount,
    droppedPages,
    removedPages: removedPages.sort(),
    addedPages: addedPages.sort(),
    newDefects,
  }
}

/**
 * Classify newly-present critical defects. A defect id absent from the baseline is
 * a `new-type`; the same id appearing on a page that existed-and-was-clean is a
 * `page-regression`; the same id on a brand-new page is `new-page` (template debt
 * arriving with new content, not a regression of existing pages).
 */
function diffSitemapDefects(
  baseline: SitemapAuditReport,
  current: SitemapAuditReport,
  baseSuccess: Map<string, SitemapPageResult>,
): DefectChange[] {
  const baseOccurrences = new Map<string, Set<string>>() // id → set of urls
  for (const group of baseline.criticalDefects) {
    const urls = new Set(group.pages.map((page) => page.url))
    baseOccurrences.set(group.id, urls)
  }

  const changes = new Map<string, DefectChange>() // `${id}|${kind}` → change
  for (const group of current.criticalDefects) {
    const baseUrls = baseOccurrences.get(group.id)
    for (const page of group.pages) {
      if (baseUrls?.has(page.url)) continue // pre-existing on this page
      let kind: DefectChangeKind
      if (!baseUrls) {
        kind = 'new-type'
      } else if (baseSuccess.has(page.url)) {
        kind = 'page-regression' // page existed and was clean of this defect
      } else {
        kind = 'new-page' // defect arrived with a net-new page
      }
      const key = `${group.id}|${kind}`
      let change = changes.get(key)
      if (!change) {
        change = { id: group.id, severity: group.severity, title: group.title, kind, pages: [] }
        changes.set(key, change)
      }
      change.pages.push(page.url)
    }
  }

  for (const change of changes.values()) change.pages.sort()
  // Order: new-type first, then page-regression, then new-page; critical before warning.
  const kindRank: Record<DefectChangeKind, number> = { 'new-type': 0, 'page-regression': 1, 'new-page': 2 }
  return [...changes.values()].sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1) ||
      kindRank[a.kind] - kindRank[b.kind] ||
      a.title.localeCompare(b.title),
  )
}

/* ── Markdown rendering (the tool owns the comment format; the action only adds
 *    GitHub chrome around this). Lists are never truncated. ── */

const RESULT_BADGE: Record<CompareResult, string> = {
  pass: '✅ PASS',
  regression: '❌ REGRESSION',
  improvement: '🎉 IMPROVEMENT',
  'no-baseline': '🆕 BASELINE',
}

export function renderCompareMarkdown(report: CompareReport): string {
  const lines: string[] = []
  const badge =
    report.result === 'regression' ? `${RESULT_BADGE.regression} (${report.regressionCount})` : RESULT_BADGE[report.result]
  lines.push(`## AEO Audit Guard — ${badge}`)
  lines.push('')

  if (report.result === 'no-baseline') {
    lines.push(`No baseline to compare against (first run). Current score: **${report.currentScore}**.`)
    lines.push('')
    lines.push('Commit the current report as the baseline to start gating regressions.')
    return lines.join('\n')
  }

  const o = report.overall
  const deltaStr = o ? ` (${signed(o.delta)}, limit ${report.policy.overallTolerance})` : ''
  const driftStr =
    report.schemaDrift === 'none'
      ? `schema ${report.currentSchemaVersion} ✓`
      : `schema ${report.baselineSchemaVersion} → ${report.currentSchemaVersion} ⚠️`
  lines.push(
    `**Score ${report.baselineScore ?? '—'} → ${report.currentScore}${deltaStr}** · ${report.reportMode} · ${driftStr}` +
      (report.currentEngineVersion ? ` · engine ${report.currentEngineVersion}` : ''),
  )
  lines.push('')

  // Summary table.
  lines.push('| | Baseline | Current | Δ |')
  lines.push('|---|---|---|---|')
  if (o) lines.push(`| Score | ${o.baseline} | ${o.current} | ${deltaIcon(o.delta)} ${signed(o.delta)} |`)
  if (report.reportMode === 'sitemap') {
    lines.push(`| Pages regressed | — | ${report.regressedPages.length} | |`)
    lines.push(`| Pages dropped (broke) | — | ${report.droppedPages.length} | ${report.droppedPages.length ? '🔴' : ''} |`)
  }
  lines.push(
    `| New defects (gating) | — | ${report.newDefects.filter((d) => isDefectGating(d, report.policy)).length} | ${
      report.newDefects.some((d) => isDefectGating(d, report.policy)) ? '🔴' : ''
    } |`,
  )
  lines.push('')

  if (report.failReasons.length > 0) {
    lines.push('### Regressions')
    for (const reason of report.failReasons) lines.push(`- 🔴 ${reason}`)
    lines.push('')
  }

  if (report.regressedFactors.length > 0) {
    lines.push('### Regressed factors')
    lines.push('| Factor | Scope | Baseline | Current | Δ |')
    lines.push('|---|---|---|---|---|')
    for (const f of report.regressedFactors) {
      lines.push(`| ${f.name} (\`${f.id}\`) | ${f.page ?? '—'} | ${f.baseline} | ${f.current} | ${deltaIcon(f.delta)} ${signed(f.delta)} |`)
    }
    lines.push('')
  }

  if (report.regressedPages.length > 0) {
    lines.push('### Regressed pages')
    lines.push('| Page | Baseline | Current | Δ |')
    lines.push('|---|---|---|---|')
    for (const p of report.regressedPages) {
      lines.push(`| ${p.url} | ${p.baseline} | ${p.current} | ${deltaIcon(p.delta)} ${signed(p.delta)} |`)
    }
    lines.push('')
  }

  if (report.droppedPages.length > 0) {
    lines.push('### Pages that stopped auditing')
    for (const d of report.droppedPages) {
      lines.push(`- 🔴 \`${d.url}\` — success → ${d.now}${d.error ? `: ${d.error}` : ''}`)
    }
    lines.push('')
  }

  if (report.newDefects.length > 0) {
    lines.push('### New defects')
    for (const d of report.newDefects) {
      const gating = isDefectGating(d, report.policy)
      const icon = gating ? '🔴' : '⚪'
      const tag = d.kind === 'new-page' ? ' _(new page — report-only)_' : ''
      lines.push(`- ${icon} ${d.severity} \`${d.id}\` (${d.title})${tag} on ${d.pages.length} page(s):`)
      for (const page of d.pages) lines.push(`  - ${page}`)
    }
    lines.push('')
  }

  if (report.removedPages.length > 0) {
    lines.push('<details><summary>Removed pages (informational)</summary>')
    lines.push('')
    for (const url of report.removedPages) lines.push(`- ${url}`)
    lines.push('')
    lines.push('</details>')
    lines.push('')
  }

  if (report.warnings.length > 0) {
    lines.push('### ⚠️ Warnings')
    for (const warning of report.warnings) lines.push(`- ${warning}`)
    lines.push('')
  }

  return lines.join('\n')
}

function deltaIcon(delta: number): string {
  if (delta < 0) return '🔴'
  if (delta > 0) return '🟢'
  return '⚪'
}

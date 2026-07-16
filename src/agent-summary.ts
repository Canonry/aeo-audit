import { buildCriticalDefects } from './critical-defects.js'
import { buildCrossCuttingIssues, buildPrioritizedFixes } from './sitemap.js'
import type { AgentSummary, AuditReport, SitemapAuditReport } from './types.js'

const TOOL = '@canonry/aeo-audit'

// The score >= 70 gate, mirrored from the CLI's exit-code rule. Kept as a named
// constant so the agent surface and the exit code can't drift apart.
const PASS_THRESHOLD = 70

/**
 * Reduce a single-page `AuditReport` to the decision an agent acts on. The ranked
 * `issues` list is computed by running the same critical-defect and cross-cutting
 * aggregation used for sitemaps over a one-page "site", so single-URL and sitemap
 * runs return the identical `PrioritizedFix` shape.
 */
export function agentSummaryFromAudit(report: AuditReport): AgentSummary {
  const criticalDefects = buildCriticalDefects([report])
  const crossCutting = buildCrossCuttingIssues([report])
  const issues = buildPrioritizedFixes(crossCutting, 1, criticalDefects, [report])

  return {
    schemaVersion: report.schemaVersion,
    tool: TOOL,
    mode: 'single',
    url: report.finalUrl,
    score: report.overallScore,
    pass: report.overallScore >= PASS_THRESHOLD,
    criticalDefectCount: criticalDefects.filter((g) => g.severity === 'critical').length,
    issues,
  }
}

/** Reduce a multi-page `SitemapAuditReport` to the same decision shape. */
export function agentSummaryFromSitemap(report: SitemapAuditReport): AgentSummary {
  return {
    schemaVersion: report.schemaVersion,
    tool: TOOL,
    mode: 'sitemap',
    url: report.sitemapUrl,
    score: report.aggregateScore,
    pass: report.aggregateScore >= PASS_THRESHOLD,
    criticalDefectCount: report.criticalDefects.filter((g) => g.severity === 'critical').length,
    issues: report.prioritizedFixes,
  }
}

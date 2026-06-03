import { agentSummaryFromAudit, agentSummaryFromSitemap } from '../agent-summary.js'
import type { AuditReport, SitemapAuditReport } from '../types.js'

/**
 * `--format agent`: emit the pre-computed decision (score, pass gate, critical
 * defect count, ranked fix list) as JSON, omitting the full per-factor and
 * per-page detail an agent would otherwise have to average and re-rank itself.
 */
export function formatAgent(report: AuditReport): string {
  return JSON.stringify(agentSummaryFromAudit(report), null, 2)
}

export function formatSitemapAgent(report: SitemapAuditReport): string {
  return JSON.stringify(agentSummaryFromSitemap(report), null, 2)
}

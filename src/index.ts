import { auditHtmlPage, assertValidFactorIds } from './audit-html.js'
import { fetchPage, normalizeTargetUrl } from './fetch-page.js'
import type { FetchBudgetController } from './fetch-page.js'
import type { AuditReport, RunAeoAuditOptions } from './types.js'

export {
  AeoAuditError,
  getAeoAuditErrorCode,
  isAeoAuditError,
  isAeoAuditErrorCode,
} from './errors.js'
export type { AeoAuditErrorCode, AeoAuditErrorOptions } from './errors.js'
export { auditHtmlPage } from './audit-html.js'
export type { AuditHtmlPageInput } from './audit-html.js'
export { runSitemapAudit } from './sitemap.js'
export { runStaticAudit } from './static-audit.js'
export {
  runSiteCrawl,
  normalizeCrawlUrl,
  SITE_CRAWL_SCHEMA_VERSION,
  SITE_CRAWL_ENGINE_VERSION,
  URL_NORMALIZATION_VERSION,
  INDEXABILITY_RULESET_VERSION,
  LINK_SCORE_ALGORITHM_VERSION,
  LINK_PLACEMENT_RULESET_VERSION,
} from './crawl.js'
export { detectCriticalDefects, buildCriticalDefects } from './critical-defects.js'
export { agentSummaryFromAudit, agentSummaryFromSitemap } from './agent-summary.js'
export { SCHEMA_VERSION, engineVersion } from './schema.js'
export { compareReports, renderCompareMarkdown, isSitemapReport, driftLevel, DEFAULT_COMPARE_POLICY } from './compare.js'
export { detectPlatform, detectPlatformBatch } from './detect-platform.js'
export { SPEC_RULES, FACTOR_SPEC_RULES, SPEC_SITE, specCitation } from './spec-references.js'
export type { SpecRule, SpecRuleId, SpecStatus } from './spec-references.js'
export type {
  AeoAuditOutboundAttempt,
  AeoAuditOutboundAttemptKind,
  AeoAuditOutboundAttemptObserver,
  AuditReport,
  RunAeoAuditOptions,
  SitemapAuditBudgetMetadata,
  SitemapAuditMetadata,
  SitemapAuditOptions,
  SitemapAuditPartialReason,
  SitemapAuditReport,
} from './types.js'
export type {
  CrawlAnchorSummary,
  CrawlDeadLinkFinding,
  CrawlDeadLinkResult,
  CrawlDiscoveryProvenance,
  CrawlEdgeClassification,
  CrawlEdgeObservation,
  CrawlEdgeType,
  CrawlEvent,
  CrawlEventBase,
  CrawlIndexabilityState,
  CrawlLinkPlacement,
  CrawlPageMetrics,
  CrawlPageObservation,
  CrawlPageState,
  CrawlPlacementOccurrences,
  CrawlProgress,
  CrawlSummary,
  CrawlTerminationReason,
  CrawlWarning,
  FullSiteCrawlReport,
  SiteCrawlEventHandler,
  SiteCrawlLimits,
  SiteCrawlOptions,
  SiteCrawlReport,
  SummarySiteCrawlReport,
} from './types.js'
export {
  CRAWL_ENGINE_VERSION,
  CRAWL_INDEXABILITY_RULESET_VERSION,
  CRAWL_LINK_PLACEMENT_RULESET_VERSION,
  CRAWL_LINK_SCORE_ALGORITHM_VERSION,
  CRAWL_SCHEMA_VERSION,
  CRAWL_URL_NORMALIZATION_VERSION,
  DEFAULT_SITE_CRAWL_LIMITS,
} from './types.js'
export type {
  AgentSummary,
  CriticalDefect,
  CriticalDefectAffectedPage,
  CriticalDefectGroup,
  CriticalDefectId,
  CriticalDefectSeverity,
  PrioritizedFix,
} from './types.js'
export type { StaticAuditOptions, StaticAuditResult } from './static-audit.js'
export type {
  CompareMeta,
  ComparePolicy,
  CompareFailOn,
  CompareReport,
  CompareResult,
  DefectChange,
  DefectChangeKind,
  DriftLevel,
  FactorDelta,
  OverallDelta,
  PageAvailabilityChange,
  PageDelta,
} from './types.js'
export type {
  BatchDetectionEntry,
  BatchPlatformDetectionReport,
  DetectedPlatform,
  PlatformCategory,
  PlatformConfidence,
  PlatformDetectionReport,
} from './types.js'

/** Fetch one URL and run the legacy single-page audit pipeline. */
export async function runAeoAudit(rawUrl: string, options: RunAeoAuditOptions = {}): Promise<AuditReport> {
  const internalOptions = options as RunAeoAuditOptions & { budget?: FetchBudgetController }
  const normalizedUrl = normalizeTargetUrl(rawUrl)
  assertValidFactorIds(options.factors ?? [])
  const fetchedPage = await fetchPage(normalizedUrl.toString(), {
    allowPrivateHost: options.allowPrivateHost,
    signal: options.signal,
    onOutboundAttempt: options.onOutboundAttempt,
    budget: internalOptions.budget,
  })
  return auditHtmlPage({
    inputUrl: fetchedPage.inputUrl,
    finalUrl: fetchedPage.finalUrl,
    html: fetchedPage.html,
    headers: fetchedPage.headers,
    redirectChain: fetchedPage.redirectChain,
    auxiliary: fetchedPage.auxiliary,
    fetchTimeMs: fetchedPage.timings.fetchTimeMs,
  }, options)
}

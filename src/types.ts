import type { CheerioAPI } from 'cheerio'

export type FindingType = 'found' | 'missing' | 'info' | 'timeout' | 'unreachable'

export interface AuditFinding {
  type: FindingType
  /**
   * Stable machine code for this finding, namespaced as
   * `<factor-id>.<check>[.<variant>]` (e.g. `technical-seo.h1.multiple`). Lets an
   * agent key on the specific finding rather than regex-matching `message`. Codes
   * are stable across releases; the full registry lives in docs/finding-codes.md.
   */
  code: string
  message: string
}

export interface AnalysisResult {
  score: number
  findings: AuditFinding[]
  recommendations: string[]
  /**
   * Whether this factor is one this page was ever meant to satisfy.
   *
   * A product page correctly has no FAQ, so its 0 is not a failure and must not
   * be averaged in as one: rolled up across a site, 8 real FAQ pages among 500
   * produce "FAQ Content: 1/100, 100% of pages affected", which is arithmetically
   * true about the wrong denominator and false about the site.
   *
   * Only analyzers that can actually tell need to answer. Omitting it means
   * "applicable" for a factor expected everywhere, and falls back to a
   * presence threshold for the page-specific ones (see `PAGE_SPECIFIC_FACTOR_IDS`).
   * The score is unaffected either way — this changes what a site-wide average
   * is taken over, not what a page is worth.
   */
  applicable?: boolean
}

export interface StructuredDataEntry {
  [key: string]: unknown
  '@graph'?: StructuredDataEntry | StructuredDataEntry[]
  '@type'?: string | string[]
  acceptedAnswer?: StructuredDataEntry
  address?: StructuredDataEntry | string
  areaServed?: unknown
  contactPoint?: StructuredDataEntry | StructuredDataEntry[]
  dateModified?: string
  email?: string
  founder?: StructuredDataEntry | StructuredDataEntry[] | string
  geo?: StructuredDataEntry
  knowsAbout?: unknown
  mainEntity?: StructuredDataEntry | StructuredDataEntry[]
  name?: string
  sameAs?: string | string[]
  step?: StructuredDataEntry | StructuredDataEntry[]
  telephone?: string
}

export type AuxiliaryResourceState = 'ok' | 'missing' | 'timeout' | 'unreachable' | 'not-html'

export interface RedirectHop {
  status: number
  from: string
  to: string
}

export interface AuxiliaryDiagnostics {
  // File responds OK with Accept star-slash-star but 404/redirect under Accept: text/markdown —
  // host does content negotiation that hides the file from AI tools that prefer markdown
  // (Astro/Vercel sites that redirect .txt to a non-existent .md variant).
  contentNegotiation?: boolean
}

export interface AuxiliaryResource {
  state: AuxiliaryResourceState
  url?: string
  statusCode?: number | null
  contentType?: string
  body: string
  redirectChain?: RedirectHop[]
  timingMs?: number
  errorCode?: string
  diagnostics?: AuxiliaryDiagnostics
}

export interface AuxiliaryResources {
  llmsTxt?: AuxiliaryResource
  llmsFullTxt?: AuxiliaryResource
  robotsTxt?: AuxiliaryResource
  sitemapXml?: AuxiliaryResource
  [key: string]: AuxiliaryResource | undefined
}

export interface AuditContext {
  $: CheerioAPI
  html: string
  url: string
  headers: Record<string, string>
  auxiliary: AuxiliaryResources
  structuredData: StructuredDataEntry[]
  textContent: string
  pageTitle: string
}

export type AeoAuditOutboundAttemptKind =
  | 'page'
  | 'auxiliary'
  | 'sitemap'
  | 'robots'
  | 'diagnostic'

export interface AeoAuditOutboundAttempt {
  kind: AeoAuditOutboundAttemptKind
  method: 'GET'
  url: string
  redirectDepth: number
}

export type AeoAuditOutboundAttemptObserver = (attempt: AeoAuditOutboundAttempt) => void | Promise<void>

export interface RunAeoAuditOptions {
  factors?: string[] | null
  includeGeo?: boolean
  includeAgentSkills?: boolean
  includeLighthouse?: boolean
  /** Abort the audit. Caller cancellation rejects with the signal's original reason. */
  signal?: AbortSignal
  /** Observes each outbound GET after SSRF preflight validation and before the socket is opened. */
  onOutboundAttempt?: AeoAuditOutboundAttemptObserver
  /**
   * Narrowly-scoped escape hatch for the SSRF guard. Set to a single hostname
   * (e.g. `localhost`, `127.0.0.1`, `staging.internal`) to permit that ONE host
   * to resolve to a private/loopback/link-local address. This is intentionally a
   * host string, not a boolean: there is no way to disable the guard wholesale.
   *
   * The relaxation is evaluated per request hop against `url.hostname`, so a
   * redirect or sitemap `<loc>` pointing at any OTHER private host (cloud metadata
   * at 169.254.169.254, internal services, …) is still blocked. The CLI derives
   * this from the exact target host the user typed for `--allow-local`; library
   * and service callers that never set it remain fully protected.
   */
  allowPrivateHost?: string
}

export interface RawFactorResult extends AnalysisResult {
  id: string
  name: string
  weight: number
}

/**
 * A factor with its score finalized (clamped to 0–100). Structurally identical to
 * `RawFactorResult`: the audit reports a raw 0–100 score per factor, with no
 * derived letter grade or pass/partial/fail band.
 */
export type ScoredFactor = RawFactorResult

export interface AuditMetadata {
  fetchTimeMs: number
  pageTitle: string
  wordCount: number
  /**
   * The page's meta description, verbatim, or `null` when it has none.
   *
   * Only its LENGTH used to survive scoring, which meant a report could say a
   * description was the wrong length but never what it said. Two pages sharing
   * one description word for word is a real and common fault, and it is
   * undetectable without the text: a consumer had no way to compare pages it
   * only had numbers about.
   */
  metaDescription: string | null
  /**
   * Same-origin links found on this page, absolute and de-duplicated.
   *
   * Kept so the report can answer a question no single page can: which pages
   * nothing links to. `citations` already walks every anchor and throws the
   * internal ones away as not its concern; this keeps them.
   */
  internalLinks: string[]
  auxiliary: {
    llmsTxt: AuxiliaryResourceState | 'missing'
    llmsFullTxt: AuxiliaryResourceState | 'missing'
    robotsTxt: AuxiliaryResourceState | 'missing'
    sitemapXml: AuxiliaryResourceState | 'missing'
  }
  redirectChain: RedirectHop[]
}

export type CriticalDefectId =
  | 'missing-h1'
  | 'multiple-h1'
  | 'missing-title'
  | 'missing-meta-description'

export type CriticalDefectSeverity = 'critical' | 'warning'

/**
 * A binary, page-level structural defect (issue #42). Unlike the weighted factor
 * scores — which bundle many sub-checks and can average a single bad signal away —
 * these are detected directly from the DOM and are simply present or not. They are
 * surfaced separately so a high-impact defect on one important page (e.g. a
 * homepage with four `<h1>`s) is never hidden by low prevalence or a passing score.
 */
export interface CriticalDefect {
  id: CriticalDefectId
  severity: CriticalDefectSeverity
  /** Page-specific description, e.g. `"4 H1 tags found (expected exactly one)."` */
  detail: string
  recommendation: string
}

export interface AuditReport {
  /**
   * Version of the report's JSON shape, independent of the package version, so an
   * agent parser can detect breaking shape drift. Bumps minor for additive fields,
   * major for breaking changes. See `SCHEMA_VERSION`.
   */
  schemaVersion: string
  url: string
  finalUrl: string
  auditedAt: string
  overallScore: number
  summary: string
  factors: ScoredFactor[]
  /** Binary structural defects on this page, detected independently of scoring. */
  criticalDefects: CriticalDefect[]
  metadata: AuditMetadata
  /**
   * Provenance for regression comparison (issue: AEO regression gate). Records the
   * engine version that produced this report so a stored baseline can be checked
   * for comparability against a current run — scoring changes ship under package
   * versions that do NOT bump `schemaVersion`, so the shape version alone can't tell
   * whether two reports' scores are comparable. Optional: reports produced before
   * this field existed simply omit it and `compare` degrades to a warning.
   */
  compareMeta?: CompareMeta
}

export interface FactorDefinition {
  id: string
  name: string
  weight: number
}

export interface ScoredFactorSummary {
  overallScore: number
  factors: ScoredFactor[]
}

export interface FetchedPage {
  inputUrl: string
  finalUrl: string
  html: string
  headers: Record<string, string>
  redirectChain: RedirectHop[]
  auxiliary: Record<string, AuxiliaryResource>
  timings: {
    fetchTimeMs: number
    mainFetchMs: number
    auxiliaryFetchMs: number
  }
}

export type Analyzer = (context: AuditContext) => AnalysisResult | Promise<AnalysisResult>

/* ── Sitemap audit types ── */

/**
 * Something wrong with the site that no single page can see.
 *
 * Every other finding in this report is scoped to one page, because an analyzer
 * is handed one page and nothing else. These are the ones that only exist in the
 * comparison: two pages sharing a description, a page nothing links to. They are
 * computed after the crawl, over the pages that came back.
 */
export interface SiteIssue {
  /** Stable machine code. Messages may change; this may not. */
  code: string
  /** One plain sentence naming what is wrong. */
  message: string
  /** Every page involved. For a duplicate, all of them; for an orphan, the one. */
  affectedUrls: string[]
}

export interface SitemapPageResult {
  url: string
  overallScore: number
  status: 'success' | 'error'
  error?: string
  factors?: ScoredFactor[]
  metadata?: AuditMetadata
  /** Sitemap `<priority>` for this URL, when the sitemap declared one. Absent in static-output mode. */
  priority?: number
}

export interface CriticalDefectAffectedPage {
  url: string
  /** Page-specific defect description carried up from the per-page audit. */
  detail: string
  /** True when this URL is the site root (`/`). Such pages are ranked first. */
  isHomepage: boolean
  /** Sitemap `<priority>` for this URL, when declared. */
  priority?: number
}

/**
 * A single binary defect (issue #42) rolled up across every page that exhibits
 * it. Keyed by defect rather than by factor, so the specific actionable — and the
 * exact pages it lives on — survives into the top-level report instead of being
 * collapsed into a factor average.
 */
export interface CriticalDefectGroup {
  id: CriticalDefectId
  severity: CriticalDefectSeverity
  /** Short human label, e.g. `"Multiple H1 tags"`. */
  title: string
  recommendation: string
  /** Affected pages, most important first (homepage, then sitemap priority). */
  pages: CriticalDefectAffectedPage[]
}

/**
 * A single ranked, machine-readable fix — the unit of the prioritized to-do list.
 * Carries stable identifiers and the complete affected-page set so an agent can
 * act on it without parsing prose (issue #42). The ranking puts critical per-page
 * defects first, then cross-cutting factor issues by prevalence.
 */
export interface PrioritizedFix {
  /** Source of this fix: a binary per-page defect, or a cross-cutting factor issue. */
  kind: 'critical-defect' | 'cross-cutting'
  /** Stable machine code: a `CriticalDefectId` (e.g. `"multiple-h1"`) or a factor id (e.g. `"technical-seo"`). */
  id: string
  /** Short human label, e.g. `"Multiple H1 tags"` or `"Technical SEO"`. */
  title: string
  /** The single highest-priority recommendation to apply for this entry. */
  recommendation: string
  /** Severity, for critical-defect fixes. Cross-cutting entries are ranked by prevalence instead. */
  severity?: CriticalDefectSeverity
  /** Every page this fix applies to — the complete list, never truncated. */
  affectedPages: string[]
  /** Whether any affected page is the site homepage. */
  affectsHomepage: boolean
  /** Share of audited pages this fix applies to (0–100). */
  prevalencePct: number
  /** Average factor score (0–100) across audited pages (cross-cutting only). */
  avgScore?: number
  /** Average factor score over the pages the factor applies to (cross-cutting only). */
  applicableAvgScore?: number
  /** Pages the factor applies to — the denominator behind `prevalencePct` (cross-cutting only). */
  applicablePages?: number
  /**
   * Distinct templates the affected pages belong to — the unit of work.
   *
   * `affectedPages.length` counts instances, which on a templated site is the
   * wrong number to plan against: 194 property pages missing schema is one
   * template edit, not 194. Pages belonging to no detected template count
   * individually, so this never understates the job.
   */
  templateCount?: number
  /** Affected page count, i.e. `affectedPages.length`, alongside `templateCount`. */
  instanceCount?: number
  /** How the factor reads site-wide (cross-cutting only): `sitewide`, `limited`, or `opportunity`. */
  status?: CrossCuttingStatus
  /** Best single-page factor score across the audit (cross-cutting only). */
  bestScore?: number
  /** URL achieving `bestScore` — the page to propagate from / tune up (cross-cutting only). */
  bestPageUrl?: string
  /** Ready-to-display one-line headline (does not inline the page list). */
  summary: string
}

/**
 * The slim, pre-computed decision an agent consumes via `--format agent`: the
 * score, the pass/fail gate, and the ranked fix list, with none of the per-factor
 * or per-page detail. Same underlying data as the full report, shaped as a
 * decision an agent can act on directly instead of re-ranking factor scores.
 */
export interface AgentSummary {
  /** Report schema version (see `AuditReport.schemaVersion`). */
  schemaVersion: string
  /** Package identity, for consumers aggregating output from multiple tools. */
  tool: string
  /** `single` for a one-URL/one-file audit, `sitemap` for a multi-page run. */
  mode: 'single' | 'sitemap'
  /** The audited page URL (single) or the sitemap/root URL (multi). */
  url: string
  score: number
  /** True when the score meets the >= 70 gate (the default exit-0 threshold). */
  pass: boolean
  /** Number of critical-severity binary defects (e.g. a missing or duplicated H1). */
  criticalDefectCount: number
  /** The ranked to-do list: critical defects first, then cross-cutting by prevalence. */
  issues: PrioritizedFix[]
}

export interface CrossCuttingIssueDetail {
  recommendation: string
  affectedUrls: string[]
}

/**
 * How a cross-cutting factor's site-wide average should be read:
 * - `sitewide`    — expected on every page; a low average is a real coverage gap.
 * - `limited`     — a page-specific factor (FAQ, definitions) present on at least
 *                   one page but isolated. A tune-up/extend, not build-from-scratch.
 * - `opportunity` — a page-specific factor not yet present on any audited page.
 * Only `sitewide` issues rank by prevalence; the page-specific two are demoted.
 */
export type CrossCuttingStatus = 'sitewide' | 'limited' | 'opportunity'

export interface CrossCuttingIssue {
  factorId: string
  factorName: string
  /**
   * Mean factor score across every audited page, applicable or not — the
   * site-wide coverage number. Unchanged in meaning; for a factor that only some
   * page types can satisfy, read `applicableAvgScore` instead, and see it for why.
   */
  avgScore: number
  /** Pages scoring below 70, counted across every audited page. */
  affectedPages: number
  totalPages: number
  /**
   * Pages this factor was ever meant to apply to — the denominator that makes
   * `applicableAvgScore` and `applicableAffectedPages` mean what a reader
   * assumes they mean. Equal to `totalPages` for factors expected site-wide.
   */
  applicablePages: number
  /**
   * Mean factor score over the applicable pages only.
   *
   * This is the number to show: "FAQ Content 58/100 across the 8 pages that have
   * one" is actionable, where the same factor's 1/100 across all 500 pages
   * describes a site that doesn't exist. Both are reported because they answer
   * different questions — how good is it where it exists, and how much of the
   * site has it.
   */
  applicableAvgScore: number
  /** Pages scoring below 70 among the applicable ones. */
  applicableAffectedPages: number
  topRecommendations: string[]
  topIssues: CrossCuttingIssueDetail[]
  /** True when this factor legitimately applies to only some page types (FAQ, definitions). */
  pageSpecific: boolean
  /** How to read `avgScore` site-wide; drives ranking and the report label. */
  status: CrossCuttingStatus
  /** Best single-page score for this factor across the audit (0–100). */
  bestScore: number
  /** URL of the page achieving `bestScore` (homepage wins ties, then lexical). */
  bestPageUrl: string
}

export interface SitemapAuditReport {
  /** Version of the report's JSON shape; see `AuditReport.schemaVersion` and `SCHEMA_VERSION`. */
  schemaVersion: string
  sitemapUrl: string
  auditedAt: string
  pagesDiscovered: number
  pagesAudited: number
  pagesSkipped: number
  pagesFiltered: number
  pagesTruncated: number
  effectiveLimit: number
  aggregateScore: number
  /**
   * Sample size and reach for `aggregateScore`. The score itself is unchanged —
   * the mean of every successfully audited page — but a consumer reading it as a
   * site score needs to know what it was taken over.
   */
  coverage: AuditCoverage
  pages: SitemapPageResult[]
  /**
   * Pages collapsed into the templates that produced them, so a fix can be
   * costed as one template edit rather than N page edits. An overlay on the
   * per-page results, which stay complete and authoritative.
   */
  templateGroups: TemplateGroup[]
  /**
   * High-impact binary defects surfaced regardless of prevalence (issue #42).
   * These do not depend on the prevalence ranking that drives `prioritizedFixes`,
   * so a defect on a single important page still appears here.
   */
  criticalDefects: CriticalDefectGroup[]
  crossCuttingIssues: CrossCuttingIssue[]
  /**
   * Faults only visible across pages. Absent from single-page audits, which by
   * definition have nothing to compare against.
   */
  siteIssues: SiteIssue[]
  /**
   * The ranked, machine-readable to-do list: critical per-page defects first, then
   * cross-cutting factor issues by prevalence. Each entry carries stable ids and the
   * full affected-page set so an agent can act without parsing prose.
   */
  prioritizedFixes: PrioritizedFix[]
  /** Run metadata for hosted/agent consumers, including partial budgeted results. */
  metadata?: SitemapAuditMetadata
  /** Provenance for regression comparison; see `AuditReport.compareMeta`. */
  compareMeta?: CompareMeta
}

/**
 * One route rendered many times, and the pages that are instances of it.
 * See `buildTemplateGroups` for how a group is established.
 */
export interface TemplateGroup {
  /** Inferred URL shape, identifier segments collapsed, e.g. `/properties/*`. */
  templateKey: string
  /** The instance to inspect and fix — homepage if present, else the strongest. */
  representativeUrl: string
  /** Every page in the group, sorted. Complete: grouping never drops a URL. */
  urls: string[]
  pageCount: number
  /** Mean overall score across the group's pages. */
  avgScore: number
  /** Spread between the group's best and worst overall score; near 0 by construction. */
  scoreRange: number
}

/**
 * What share of the site the report actually looked at.
 *
 * An aggregate score with no sample size attached reads as a statement about the
 * site when it may be a statement about 6% of it. The number worth reporting is
 * not the raw percentage, though: a stratified sample covering every URL template
 * generalizes, and a much larger prefix that missed whole sections does not.
 */
export interface AuditCoverage {
  pagesAudited: number
  pagesDiscovered: number
  /** Audited share of discovered pages, 0–100. */
  coveragePct: number
  /** True when fewer pages were audited than discovered. */
  sampled: boolean
  /** How the audited set was chosen. */
  selection: 'all' | 'stratified'
  /** Distinct URL templates across every discovered page. */
  templatesDiscovered: number
  /** Distinct URL templates with at least one audited page. */
  templatesRepresented: number
  /**
   * How far the aggregate generalizes:
   * - `full`           — every discovered page was audited.
   * - `representative` — sampled, but every template has at least one page in it.
   * - `indicative`     — whole templates went unsampled; sections of the site are
   *                      unmeasured and the aggregate cannot speak for them.
   */
  confidence: 'full' | 'representative' | 'indicative'
}

export type SitemapAuditPartialReason = 'fetch-budget-exceeded' | 'duration-budget-exceeded'

export interface SitemapAuditBudgetMetadata {
  maxFetches?: number
  fetchesStarted: number
  maxDurationMs?: number
  elapsedMs: number
  pagesQueued: number
  pagesCompleted: number
  pagesRemaining: number
  exhaustedReason?: SitemapAuditPartialReason
}

export interface SitemapAuditMetadata {
  partial: boolean
  budget?: SitemapAuditBudgetMetadata
}

export interface SitemapAuditPlan {
  discovered: number
  filtered: number
  truncated: number
  willAudit: number
  effectiveLimit: number
  /** Child sitemaps dropped by the per-index safety cap (0 when none were dropped). */
  childSitemapsSkipped: number
}

export interface SitemapAuditOptions extends RunAeoAuditOptions {
  sitemapUrl?: string
  limit?: number
  topIssuesOnly?: boolean
  /**
   * Cumulative outbound GET budget for sitemap mode. Counts sitemap discovery,
   * child sitemaps, pages, auxiliary files, redirects, and diagnostics after SSRF
   * preflight validation. When exhausted after discovery, the report is returned
   * as partial with `metadata.budget.exhaustedReason`.
   */
  maxFetches?: number
  /**
   * Cumulative wall-clock budget for sitemap mode in milliseconds. When exhausted
   * after discovery, no additional pages are started and the partial report records
   * the budget metadata.
   */
  maxDurationMs?: number
  /**
   * Rewrite every sitemap `<loc>`'s origin to the origin of the target URL passed
   * to `runSitemapAudit` before crawling. Useful when a sitemap hardcodes the
   * canonical/prod domain but you want to audit a different origin that serves the
   * same paths (a staging host, or a local dev server behind a tunnel). No
   * security cost: every crawled URL is pinned to the origin you explicitly named.
   */
  rewriteOrigin?: boolean
  /**
   * Optional path allow-list for PR/changed-page audits. Values may be paths or
   * full URLs; matching uses normalized URL pathnames and ignores query strings.
   */
  includePaths?: string[]
  onPlan?: (plan: SitemapAuditPlan) => void
}

/* ── Full site crawl types ── */

/** A report-shape version owned by the crawl engine, independent from `SCHEMA_VERSION`. */
export const CRAWL_SCHEMA_VERSION = '1.0'
/** Version identifiers let persisted checkpoints detect changes in crawl semantics. */
export const CRAWL_ENGINE_VERSION = '1.0.0'
export const CRAWL_URL_NORMALIZATION_VERSION = '1.0.0'
export const CRAWL_INDEXABILITY_RULESET_VERSION = '1.0.0'
export const CRAWL_LINK_SCORE_ALGORITHM_VERSION = 'pagerank-1.0.0'

export interface SiteCrawlLimits {
  maxPages: number
  maxEdges: number
  maxFetches: number
  maxDurationMs: number
  maxBytes: number
  maxPageBytes: number
  maxDepth: number
  maxLinksPerPage: number
  maxQueryVariants: number
  maxSitemapFanout: number
  maxSitemapUrls: number
  concurrency: number
}

/** Safe defaults for an untrusted public site. Every value may be tightened by callers. */
export const DEFAULT_SITE_CRAWL_LIMITS: Readonly<SiteCrawlLimits> = {
  maxPages: 1_000,
  maxEdges: 100_000,
  maxFetches: 5_000,
  maxDurationMs: 120_000,
  maxBytes: 100 * 1024 * 1024,
  maxPageBytes: 5 * 1024 * 1024,
  maxDepth: 10,
  maxLinksPerPage: 1_000,
  maxQueryVariants: 10,
  maxSitemapFanout: 1_000,
  maxSitemapUrls: 50_000,
  concurrency: 5,
}

export type CrawlTerminationReason =
  | 'max-pages'
  | 'max-edges'
  | 'max-fetches'
  | 'max-duration'
  | 'max-bytes'
  | 'max-page-bytes'
  | 'max-depth'
  | 'max-links-per-page'
  | 'max-query-variants'
  | 'max-sitemap-fanout'
  | 'max-sitemap-urls'

export type CrawlPageState = 'discovered' | 'robots-blocked' | 'html' | 'redirect' | 'non-html' | 'fetch-error'
export type CrawlEdgeType = 'anchor' | 'redirect' | 'canonical'
export type CrawlEdgeClassification = 'internal' | 'external'
export type CrawlIndexabilityState = 'indexable' | 'noindex' | 'blocked' | 'unknown'

export interface CrawlDiscoveryProvenance {
  /** Canonical crawl URLs that linked to or redirected to this page. */
  discoveredFrom: string[]
  /** Sitemap documents that named this page. */
  sitemapSources: string[]
  /** True for the single URL explicitly passed to `runSiteCrawl`. */
  root: boolean
}

export interface CrawlPageMetrics {
  inbound: { totalOccurrences: number; uniqueEdges: number }
  outbound: { totalOccurrences: number; uniqueEdges: number }
  /** Link distance from the final root across followable internal anchors. */
  shortestFollowableAnchorDepth: number | null
  /** Stationary probability over unique followable internal anchor edges. */
  linkScoreRaw: number
  /** Link score relative to the crawl maximum, normalized to 0–100. */
  linkScore: number
}

export interface CrawlPageObservation {
  /** Stable, URL-derived key suitable for idempotent checkpoint upserts. */
  key: string
  requestedUrl: string
  finalUrl: string | null
  state: CrawlPageState
  depth: number | null
  provenance: CrawlDiscoveryProvenance
  statusCode: number | null
  contentType: string | null
  redirectChain: RedirectHop[]
  canonicalUrl: string | null
  metaRobots: string[]
  xRobots: string[]
  path: string | null
  directory: string | null
  indexability: {
    state: CrawlIndexabilityState
    reasons: string[]
    rulesetVersion: string
  }
  audit: AuditReport | null
  error: string | null
  metrics: CrawlPageMetrics
}

export interface CrawlAnchorSummary {
  text: string
  occurrences: number
}

export interface CrawlEdgeObservation {
  /** Stable, endpoint-and-type-derived key suitable for idempotent checkpoint upserts. */
  key: string
  from: string
  to: string
  type: CrawlEdgeType
  classification: CrawlEdgeClassification
  totalOccurrences: number
  followableOccurrences: number
  nofollowOccurrences: number
  /** At most five normalized anchor texts, ordered deterministically. */
  anchorSummaries: CrawlAnchorSummary[]
}

export interface CrawlDeadLinkFinding {
  key: string
  from: string
  to: string
  statusCode: number | null
  reason: 'http-error' | 'fetch-error'
}

export type CrawlDeadLinkResult =
  | { state: 'disabled'; findings: [] }
  | { state: 'complete'; findings: CrawlDeadLinkFinding[] }
  | { state: 'partial'; findings: CrawlDeadLinkFinding[] }

export interface CrawlSummary {
  crawlSchemaVersion: string
  /** npm package version that produced the report (`engineVersion()`). */
  engineVersion: string
  /** Crawl traversal implementation version, separate from package version. */
  crawlEngineVersion: string
  urlNormalizationVersion: string
  indexabilityRulesetVersion: string
  linkScoreAlgorithmVersion: string
  rootUrl: string
  finalRootUrl: string | null
  startedAt: string
  completedAt: string
  complete: boolean
  terminationReason: CrawlTerminationReason | null
  pagesDiscovered: number
  pagesFetched: number
  pagesObserved: number
  edgesObserved: number
  bytesRead: number
  fetchesStarted: number
  elapsedMs: number
  limits: SiteCrawlLimits
  /** Stream-aggregateable audit results retained even in summary-only mode. */
  auditRollup: {
    auditedPages: number
    aggregateScore: number | null
    factors: Array<{ id: string; name: string; count: number; averageScore: number }>
  }
}

export interface CrawlProgress {
  pagesDiscovered: number
  pagesFetched: number
  pagesObserved: number
  edgesObserved: number
  fetchesStarted: number
  bytesRead: number
}

export interface CrawlEventBase {
  sequence: number
  /** Content-addressed and stable across retries for the same logical batch. */
  batchId: string
  checksum: string
}

export type CrawlEvent =
  | (CrawlEventBase & { type: 'pages'; rows: CrawlPageObservation[] })
  | (CrawlEventBase & { type: 'edges'; rows: CrawlEdgeObservation[] })
  | (CrawlEventBase & { type: 'progress'; progress: CrawlProgress })
  | (CrawlEventBase & { type: 'metrics'; rows: Array<{ key: string; metrics: CrawlPageMetrics }> })
  | (CrawlEventBase & { type: 'summary'; summary: CrawlSummary })

export type SiteCrawlEventHandler = (event: CrawlEvent) => void | Promise<void>

export interface SiteCrawlOptions extends RunAeoAuditOptions {
  /** Full reports retain page and edge rows. Summary mode streams rows but does not return the graph. */
  mode?: 'full' | 'summary'
  /** Alias for `mode: 'summary'`, useful for config-driven callers. */
  summaryOnly?: boolean
  /** One explicit sitemap seed. When set, the default /sitemap.xml probes are skipped. */
  sitemapUrl?: string
  /** Additional explicit sitemap seeds, useful for split sitemap families. */
  sitemapUrls?: string[]
  respectRobots?: boolean
  /** Derive internal dead-link findings from crawl observations. Defaults to false; external links are never probed. */
  checkDeadLinks?: boolean
  maxPages?: number
  maxEdges?: number
  maxFetches?: number
  maxDurationMs?: number
  maxBytes?: number
  maxPageBytes?: number
  maxDepth?: number
  maxLinksPerPage?: number
  maxQueryVariants?: number
  maxSitemapFanout?: number
  maxSitemapUrls?: number
  concurrency?: number
  /** Awaited after each checkpoint-safe observed/derived batch. */
  onEvent?: SiteCrawlEventHandler
}

interface SiteCrawlReportBase {
  mode: 'full' | 'summary'
  summary: CrawlSummary
  deadLinks: CrawlDeadLinkResult
}

export interface FullSiteCrawlReport extends SiteCrawlReportBase {
  mode: 'full'
  pages: CrawlPageObservation[]
  edges: CrawlEdgeObservation[]
}

export interface SummarySiteCrawlReport extends SiteCrawlReportBase {
  mode: 'summary'
  pages?: never
  edges?: never
}

export type SiteCrawlReport = FullSiteCrawlReport | SummarySiteCrawlReport

/* ── Platform detection types ── */

export type PlatformCategory = 'cms' | 'site-builder' | 'ecommerce' | 'framework' | 'ssg' | 'hosting'

export type PlatformConfidence = 'high' | 'medium' | 'low'

export interface DetectedPlatform {
  id: string
  name: string
  category: PlatformCategory
  confidence: PlatformConfidence
  confidenceScore: number
  version?: string
  evidence: string[]
}

export interface PlatformDetectionReport {
  url: string
  finalUrl: string
  detectedAt: string
  isCustom: boolean
  detected: DetectedPlatform[]
  rawSignals: {
    generator: string | null
    xPoweredBy: string | null
    server: string | null
  }
  fetchTimeMs: number
}

export interface BatchDetectionEntry {
  url: string
  status: 'success' | 'error'
  error?: string
  finalUrl?: string
  isCustom?: boolean
  detected?: DetectedPlatform[]
  rawSignals?: {
    generator: string | null
    xPoweredBy: string | null
    server: string | null
  }
  fetchTimeMs?: number
}

export interface BatchPlatformDetectionReport {
  detectedAt: string
  totalUrls: number
  successful: number
  failed: number
  totalFetchTimeMs: number
  results: BatchDetectionEntry[]
}

/* ── Regression comparison types ── */

/**
 * Report provenance used by `compare` to decide whether two reports are
 * comparable. Embedded at audit time; absent on reports from older engines.
 */
export interface CompareMeta {
  /** npm package version (`@canonry/aeo-audit`) that produced the report. */
  engineVersion: string
  /** Active factor-id set for the audit, sorted. A mismatch means the weighted
   * basis differs (`--factors`/`--include-*`), so score deltas are apples-to-oranges. */
  factorIds: string[]
}

/** Knobs controlling which deltas fail the build. Mirrors the `compare` CLI flags. */
export interface ComparePolicy {
  /** Max overall/aggregate score drop before [GATE]. Default 2 (absorbs rounding/freshness jitter). */
  overallTolerance: number
  /** Max single-page score drop before [GATE]. Default 5. */
  pageTolerance: number
  /** Max single-factor score drop before [GATE]. Default 8 (sub-checks toggle). */
  factorTolerance: number
  /** Fail when a new severity:critical defect type/page-regression appears. Default true. */
  failOnNewCritical: boolean
  /** Promote normally report-only dimensions to gating failures. */
  failOn: CompareFailOn[]
  /** What to do when no baseline is supplied. Default 'warn' (pass + note); 'fail'
   * blocks the build until a baseline is seeded (see the action's update-baseline mode). */
  onMissingBaseline: 'warn' | 'fail'
  /** Report every dimension but never fail the build (soak mode). */
  reportOnly: boolean
  /**
   * Treat a factor-set or major engine-version mismatch as a hard misconfiguration
   * (exit 2) instead of a non-gating warning. The action sets this for
   * committed/artifact baselines, where matched audit settings can't be guaranteed
   * by construction; base-rebuild leaves it off (settings are identical both sides).
   */
  strictComparability: boolean
}

export type CompareFailOn = 'removed-pages' | 'warnings'

export type CompareResult = 'pass' | 'regression' | 'improvement' | 'no-baseline'

export type DriftLevel = 'none' | 'minor' | 'major' | 'unknown'

export interface OverallDelta {
  baseline: number
  current: number
  delta: number
  regressed: boolean
}

export interface FactorDelta {
  id: string
  name: string
  /** Page URL the factor was scored on (multi-report only); omitted for single reports. */
  page?: string
  baseline: number
  current: number
  delta: number
  regressed: boolean
}

export interface PageDelta {
  url: string
  baseline: number
  current: number
  delta: number
  regressed: boolean
}

/**
 * A page that was successfully audited in the baseline but is no longer producing
 * a score in the current run — it either errored (`status:'error'`) or dropped out
 * of the audited set entirely. The strongest possible regression signal, and one
 * the aggregate score actively hides because it averages success pages only.
 */
export interface PageAvailabilityChange {
  url: string
  now: 'error' | 'absent'
  /** Error message, when the page transitioned success → error. */
  error?: string
}

/**
 * How a newly-present defect relates to the baseline:
 * - `new-type`        — this defect id was absent from the baseline entirely (a genuinely new failure mode).
 * - `page-regression` — a page that existed and was clean in the baseline now carries this defect.
 * - `new-page`        — the defect appears on a page that did not exist in the baseline (pre-existing
 *                       template debt arriving with new content, not a regression of existing pages).
 * Only the first two gate by default; `new-page` is report-only.
 */
export type DefectChangeKind = 'new-type' | 'page-regression' | 'new-page'

export interface DefectChange {
  id: string
  severity: CriticalDefectSeverity
  title: string
  kind: DefectChangeKind
  /** Pages exhibiting this defect change. Never truncated. */
  pages: string[]
}

/**
 * The full regression verdict produced by `compareReports`. stdout-serializable;
 * the action reads it directly rather than re-deriving any verdict in shell.
 */
export interface CompareReport {
  tool: string
  reportMode: 'single' | 'sitemap'
  result: CompareResult
  verdict: 'pass' | 'fail'
  /** Number of gating dimensions that tripped (0 when green). */
  regressionCount: number
  /** One human line per gating failure (drives the CI annotation and comment). */
  failReasons: string[]
  /** Non-gating comparability/staleness/truncation notices. */
  warnings: string[]
  currentScore: number
  baselineScore: number | null
  overall: OverallDelta | null
  /** Regressed factor deltas (full list, never truncated). */
  regressedFactors: FactorDelta[]
  improvedFactorCount: number
  /** Regressed per-page deltas (full list). */
  regressedPages: PageDelta[]
  improvedPageCount: number
  /** Pages that stopped scoring (success → error/absent). */
  droppedPages: PageAvailabilityChange[]
  /** Pages present in baseline, absent from current (intentional deletes or truncation). */
  removedPages: string[]
  /** Pages new in current vs baseline. */
  addedPages: string[]
  newDefects: DefectChange[]
  currentSchemaVersion: string
  baselineSchemaVersion: string | null
  schemaDrift: DriftLevel
  currentEngineVersion: string | null
  baselineEngineVersion: string | null
  engineDrift: DriftLevel
  baselineAuditedAt: string | null
  currentAuditedAt: string
  policy: ComparePolicy
}

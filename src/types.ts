import type { CheerioAPI } from 'cheerio'

export type FindingType = 'found' | 'missing' | 'info' | 'timeout' | 'unreachable'

export interface AuditFinding {
  type: FindingType
  message: string
}

export interface AnalysisResult {
  score: number
  findings: AuditFinding[]
  recommendations: string[]
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

export interface RunAeoAuditOptions {
  factors?: string[] | null
  includeGeo?: boolean
  includeAgentSkills?: boolean
  includeLighthouse?: boolean
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

export interface ScoredFactor extends RawFactorResult {
  grade: string
  status: 'pass' | 'partial' | 'fail'
}

export interface AuditMetadata {
  fetchTimeMs: number
  pageTitle: string
  wordCount: number
  auxiliary: {
    llmsTxt: AuxiliaryResourceState | 'missing'
    llmsFullTxt: AuxiliaryResourceState | 'missing'
    robotsTxt: AuxiliaryResourceState | 'missing'
    sitemapXml: AuxiliaryResourceState | 'missing'
  }
  redirectChain: RedirectHop[]
}

export interface AuditReport {
  url: string
  finalUrl: string
  auditedAt: string
  overallScore: number
  overallGrade: string
  summary: string
  factors: ScoredFactor[]
  metadata: AuditMetadata
}

export interface FactorDefinition {
  id: string
  name: string
  weight: number
}

export interface ScoredFactorSummary {
  overallScore: number
  overallGrade: string
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

export interface SitemapPageResult {
  url: string
  overallScore: number
  overallGrade: string
  status: 'success' | 'error'
  error?: string
  factors?: ScoredFactor[]
  metadata?: AuditMetadata
}

export interface CrossCuttingIssueDetail {
  recommendation: string
  affectedUrls: string[]
}

export interface CrossCuttingIssue {
  factorId: string
  factorName: string
  avgScore: number
  avgGrade: string
  affectedPages: number
  totalPages: number
  topRecommendations: string[]
  topIssues: CrossCuttingIssueDetail[]
}

export interface SitemapAuditReport {
  sitemapUrl: string
  auditedAt: string
  pagesDiscovered: number
  pagesAudited: number
  pagesSkipped: number
  pagesFiltered: number
  pagesTruncated: number
  effectiveLimit: number
  aggregateScore: number
  aggregateGrade: string
  pages: SitemapPageResult[]
  crossCuttingIssues: CrossCuttingIssue[]
  prioritizedFixes: string[]
}

export interface SitemapAuditPlan {
  discovered: number
  filtered: number
  truncated: number
  willAudit: number
  effectiveLimit: number
}

export interface SitemapAuditOptions extends RunAeoAuditOptions {
  sitemapUrl?: string
  limit?: number
  topIssuesOnly?: boolean
  /**
   * Rewrite every sitemap `<loc>`'s origin to the origin of the target URL passed
   * to `runSitemapAudit` before crawling. Useful when a sitemap hardcodes the
   * canonical/prod domain but you want to audit a different origin that serves the
   * same paths (a staging host, or a local dev server behind a tunnel). No
   * security cost: every crawled URL is pinned to the origin you explicitly named.
   */
  rewriteOrigin?: boolean
  onPlan?: (plan: SitemapAuditPlan) => void
}

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

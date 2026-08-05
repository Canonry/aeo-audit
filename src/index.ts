import { load } from 'cheerio'
import type { CheerioAPI } from 'cheerio'
import { fetchPage, normalizeTargetUrl } from './fetch-page.js'
import { AeoAuditError } from './errors.js'
import { analyzeStructuredData } from './analyzers/structured-data.js'
import { analyzeAiAccessFiles } from './analyzers/ai-access-files.js'
import { analyzeEntityConsistency } from './analyzers/entity-consistency.js'
import { analyzeContentDepth } from './analyzers/content-depth.js'
import { analyzeDefinitionBlocks } from './analyzers/definition-blocks.js'
import { analyzeFaqContent } from './analyzers/faq-content.js'
import { analyzeNamedEntities } from './analyzers/named-entities.js'
import { analyzeCitations } from './analyzers/citations.js'
import { analyzeContentFreshness } from './analyzers/content-freshness.js'
import { analyzeGeographicSignals } from './analyzers/geographic-signals.js'
import { analyzeEeatSignals } from './analyzers/eeat-signals.js'
import { analyzeAiCrawlerAccess } from './analyzers/ai-crawler-access.js'
import { analyzeSchemaCompleteness } from './analyzers/schema-completeness.js'
import { analyzeSchemaValidity } from './analyzers/schema-validity.js'
import { analyzeContentExtractability } from './analyzers/content-extractability.js'
import { analyzeTechnicalSeo } from './analyzers/technical-seo.js'
import { analyzeSnippetEligibility } from './analyzers/snippet-eligibility.js'
import { analyzeAgentSkillExposure } from './analyzers/agent-skill-exposure.js'
import { analyzeLighthouse } from './analyzers/lighthouse.js'
import { getVisibleText, parseJsonLdScripts, countWords } from './analyzers/helpers.js'
import { detectCriticalDefects } from './critical-defects.js'
import { SCHEMA_VERSION, engineVersion } from './schema.js'
import { FACTOR_DEFINITIONS, OPTIONAL_FACTOR_DEFINITIONS, scoreFactors } from './scoring.js'
import type {
  Analyzer,
  AuditContext,
  AuditReport,
  AuxiliaryResources,
  RedirectHop,
  RunAeoAuditOptions,
  ScoredFactor,
} from './types.js'
import type { FetchBudgetController } from './fetch-page.js'

export {
  AeoAuditError,
  getAeoAuditErrorCode,
  isAeoAuditError,
  isAeoAuditErrorCode,
} from './errors.js'
export type { AeoAuditErrorCode, AeoAuditErrorOptions } from './errors.js'
export { runSitemapAudit } from './sitemap.js'
export { runStaticAudit } from './static-audit.js'
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

const ANALYZER_BY_ID: Record<string, Analyzer> = {
  'structured-data': analyzeStructuredData,
  'ai-access-files': analyzeAiAccessFiles,
  'entity-consistency': analyzeEntityConsistency,
  'content-depth': analyzeContentDepth,
  'definition-blocks': analyzeDefinitionBlocks,
  'faq-content': analyzeFaqContent,
  'named-entities': analyzeNamedEntities,
  citations: analyzeCitations,
  'content-freshness': analyzeContentFreshness,
  'geographic-signals': analyzeGeographicSignals,
  'eeat-signals': analyzeEeatSignals,
  'ai-crawler-access': analyzeAiCrawlerAccess,
  'schema-completeness': analyzeSchemaCompleteness,
  'schema-validity': analyzeSchemaValidity,
  'content-extractability': analyzeContentExtractability,
  'technical-seo': analyzeTechnicalSeo,
  'snippet-eligibility': analyzeSnippetEligibility,
  'agent-skill-exposure': analyzeAgentSkillExposure,
  lighthouse: analyzeLighthouse,
}

const ALL_FACTOR_IDS = new Set([
  ...FACTOR_DEFINITIONS.map((d) => d.id),
  ...OPTIONAL_FACTOR_DEFINITIONS.map((d) => d.id),
])

function buildSummary(factors: ScoredFactor[], overallScore: number): string {
  if (!factors.length) {
    return `Overall score ${overallScore}/100. No factors evaluated.`
  }

  const ranked = [...factors].sort((a, b) => b.score - a.score)
  const strengths = ranked.slice(0, 2).map((factor) => factor.name)
  const weaknesses = ranked.slice(-2).map((factor) => factor.name)

  return `Overall score ${overallScore}/100. Strongest signals: ${strengths.join(', ')}. Biggest opportunities: ${weaknesses.join(', ')}.`
}

function assertValidFactorIds(selectedFactors: string[]): void {
  if (selectedFactors.length === 0) {
    return
  }

  const invalid = selectedFactors.filter((id) => !ALL_FACTOR_IDS.has(id))
  if (invalid.length > 0) {
    throw new AeoAuditError('BAD_INPUT', `Unknown factor ID(s): ${invalid.join(', ')}. Valid IDs: ${[...ALL_FACTOR_IDS].join(', ')}`)
  }
}

/**
 * A page's raw inputs, decoupled from how it was obtained. `runAeoAudit` builds
 * this from a network fetch; `runStaticAudit` builds it from HTML on disk. Both
 * feed the identical analyzer pipeline below.
 */
export interface AuditHtmlPageInput {
  inputUrl: string
  finalUrl: string
  html: string
  /** Response headers. Empty `{}` is valid (static mode) — every header read is optional. */
  headers: Record<string, string>
  redirectChain: RedirectHop[]
  auxiliary: AuxiliaryResources
  fetchTimeMs: number
}

/**
 * Run the analyzer pipeline against already-fetched HTML and produce a report.
 * This is the shared core of single-URL and static-output auditing — it performs
 * no network I/O, so callers are responsible for sourcing `html`, `headers`, and
 * `auxiliary` (over the network, or from the filesystem).
 */
/** The page's meta description, verbatim, or null when it has none. */
function readMetaDescription($: CheerioAPI): string | null {
  const raw = $('meta[name="description"]').first().attr('content')
  const text = (raw ?? '').trim()
  return text === '' ? null : text
}

/**
 * Same-origin links on the page, absolute and de-duplicated.
 *
 * Same walk `citations` does, with the host test inverted: it keeps what leaves
 * the site, this keeps what stays on it. Fragments and query strings are
 * stripped, because `/faq#hours` and `/faq?x=1` are the same page for the
 * purpose of asking whether anything links to `/faq`.
 */
function readInternalLinks($: CheerioAPI, pageUrl: string): string[] {
  let origin: string
  try {
    origin = new URL(pageUrl).origin
  } catch {
    return []
  }
  const out = new Set<string>()
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')
    if (!href) return
    try {
      const abs = new URL(href, pageUrl)
      if (abs.origin !== origin) return
      abs.hash = ''
      abs.search = ''
      out.add(abs.toString().replace(/\/$/, '') || abs.origin)
    } catch {
      // Malformed href: not a link we can reason about.
    }
  })
  return [...out]
}

export async function auditHtmlPage(page: AuditHtmlPageInput, options: RunAeoAuditOptions = {}): Promise<AuditReport> {
  const selectedFactors = options.factors ?? []
  assertValidFactorIds(selectedFactors)

  const $ = load(page.html)
  const structuredData = parseJsonLdScripts($)
  const textContent = getVisibleText($, page.html)

  const context: AuditContext = {
    $,
    html: page.html,
    url: page.finalUrl,
    headers: page.headers,
    auxiliary: page.auxiliary,
    structuredData,
    textContent,
    pageTitle: $('title').first().text().trim(),
  }

  // Determine which factors to run
  const enabledOptional = new Set<string>()
  if (options.includeGeo) enabledOptional.add('geographic-signals')
  if (options.includeAgentSkills) enabledOptional.add('agent-skill-exposure')
  if (options.includeLighthouse) enabledOptional.add('lighthouse')

  let activeDefs = [
    ...FACTOR_DEFINITIONS,
    ...OPTIONAL_FACTOR_DEFINITIONS.filter((def) => enabledOptional.has(def.id)),
  ]

  if (selectedFactors.length > 0) {
    // Explicit --factors overrides opt-in flags: let users target any factor by id.
    const universe = [...FACTOR_DEFINITIONS, ...OPTIONAL_FACTOR_DEFINITIONS]
    activeDefs = universe.filter((def) => selectedFactors.includes(def.id))
  }

  const rawFactorResults = await Promise.all(
    activeDefs.map(async (definition) => {
      const analyzer = ANALYZER_BY_ID[definition.id]!
      const result = await analyzer(context)

      return {
        id: definition.id,
        name: definition.name,
        weight: definition.weight,
        score: result.score,
        findings: result.findings,
        recommendations: result.recommendations,
        // Only analyzers that can tell answer this; spread conditionally so the
        // rest don't emit `applicable: undefined` into every report's JSON.
        ...(result.applicable === undefined ? {} : { applicable: result.applicable }),
      }
    }),
  )

  const { overallScore, factors } = scoreFactors(rawFactorResults)

  return {
    schemaVersion: SCHEMA_VERSION,
    url: page.inputUrl,
    finalUrl: page.finalUrl,
    auditedAt: new Date().toISOString(),
    overallScore,
    summary: buildSummary(factors, overallScore),
    factors,
    criticalDefects: detectCriticalDefects(context),
    compareMeta: {
      engineVersion: engineVersion(),
      factorIds: factors.map((factor) => factor.id).sort(),
    },
    metadata: {
      fetchTimeMs: page.fetchTimeMs,
      pageTitle: context.pageTitle,
      wordCount: countWords(textContent),
      metaDescription: readMetaDescription($),
      internalLinks: readInternalLinks($, page.finalUrl),
      auxiliary: {
        llmsTxt: page.auxiliary.llmsTxt?.state || 'missing',
        llmsFullTxt: page.auxiliary.llmsFullTxt?.state || 'missing',
        robotsTxt: page.auxiliary.robotsTxt?.state || 'missing',
        sitemapXml: page.auxiliary.sitemapXml?.state || 'missing',
      },
      redirectChain: page.redirectChain,
    },
  }
}

export async function runAeoAudit(rawUrl: string, options: RunAeoAuditOptions = {}): Promise<AuditReport> {
  const internalOptions = options as RunAeoAuditOptions & { budget?: FetchBudgetController }
  const normalizedUrl = normalizeTargetUrl(rawUrl)

  // Validate factor IDs up front so a typo'd --factors fails before the fetch.
  assertValidFactorIds(options.factors ?? [])

  const fetchedPage = await fetchPage(normalizedUrl.toString(), {
    allowPrivateHost: options.allowPrivateHost,
    signal: options.signal,
    onOutboundAttempt: options.onOutboundAttempt,
    budget: internalOptions.budget,
  })

  return auditHtmlPage(
    {
      inputUrl: fetchedPage.inputUrl,
      finalUrl: fetchedPage.finalUrl,
      html: fetchedPage.html,
      headers: fetchedPage.headers,
      redirectChain: fetchedPage.redirectChain,
      auxiliary: fetchedPage.auxiliary,
      fetchTimeMs: fetchedPage.timings.fetchTimeMs,
    },
    options,
  )
}

import { load } from 'cheerio'
import type { CheerioAPI } from 'cheerio'
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
import { AeoAuditError } from './errors.js'
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
  ...FACTOR_DEFINITIONS.map((definition) => definition.id),
  ...OPTIONAL_FACTOR_DEFINITIONS.map((definition) => definition.id),
])

function buildSummary(factors: ScoredFactor[], overallScore: number): string {
  if (!factors.length) return `Overall score ${overallScore}/100. No factors evaluated.`
  const ranked = [...factors].sort((left, right) => right.score - left.score)
  return `Overall score ${overallScore}/100. Strongest signals: ${ranked.slice(0, 2).map((factor) => factor.name).join(', ')}. Biggest opportunities: ${ranked.slice(-2).map((factor) => factor.name).join(', ')}.`
}

export function assertValidFactorIds(selectedFactors: string[]): void {
  if (!selectedFactors.length) return
  const invalid = selectedFactors.filter((id) => !ALL_FACTOR_IDS.has(id))
  if (invalid.length) {
    throw new AeoAuditError('BAD_INPUT', `Unknown factor ID(s): ${invalid.join(', ')}. Valid IDs: ${[...ALL_FACTOR_IDS].join(', ')}`)
  }
}

export interface AuditHtmlPageInput {
  inputUrl: string
  finalUrl: string
  html: string
  headers: Record<string, string>
  redirectChain: RedirectHop[]
  auxiliary: AuxiliaryResources
  fetchTimeMs: number
}

function readMetaDescription($: CheerioAPI): string | null {
  const text = ($('meta[name="description"]').first().attr('content') ?? '').trim()
  return text || null
}

function readInternalLinks($: CheerioAPI, pageUrl: string): string[] {
  let origin: string
  try {
    origin = new URL(pageUrl).origin
  } catch {
    return []
  }
  const out = new Set<string>()
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href')
    if (!href) return
    try {
      const url = new URL(href, pageUrl)
      if (url.origin !== origin) return
      url.hash = ''
      url.search = ''
      out.add(url.toString().replace(/\/$/, '') || url.origin)
    } catch {
      // Ignore malformed references.
    }
  })
  return [...out]
}

/** Run the pure analyzer pipeline against already-fetched HTML. */
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
  const enabledOptional = new Set<string>()
  if (options.includeGeo) enabledOptional.add('geographic-signals')
  if (options.includeAgentSkills) enabledOptional.add('agent-skill-exposure')
  if (options.includeLighthouse) enabledOptional.add('lighthouse')
  let activeDefs = [...FACTOR_DEFINITIONS, ...OPTIONAL_FACTOR_DEFINITIONS.filter((definition) => enabledOptional.has(definition.id))]
  if (selectedFactors.length) {
    activeDefs = [...FACTOR_DEFINITIONS, ...OPTIONAL_FACTOR_DEFINITIONS].filter((definition) => selectedFactors.includes(definition.id))
  }
  const rawFactorResults = await Promise.all(activeDefs.map(async (definition) => {
    const result = await ANALYZER_BY_ID[definition.id]!(context)
    const applicable = (result as typeof result & { applicable?: boolean }).applicable
    return {
      id: definition.id,
      name: definition.name,
      weight: definition.weight,
      score: result.score,
      findings: result.findings,
      recommendations: result.recommendations,
      ...(applicable === undefined ? {} : { applicable }),
    }
  }))
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
    compareMeta: { engineVersion: engineVersion(), factorIds: factors.map((factor) => factor.id).sort() },
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

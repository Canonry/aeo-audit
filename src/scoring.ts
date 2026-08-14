import { clampScore } from './analyzers/helpers.js'
import type { FactorDefinition, RawFactorResult, ScoredFactorSummary } from './types.js'

export const FACTOR_DEFINITIONS: FactorDefinition[] = [
  { id: 'structured-data', name: 'Structured Data (JSON-LD)', weight: 12 },
  { id: 'content-depth', name: 'Content Depth', weight: 10 },
  { id: 'ai-access-files', name: 'AI Access Files (llms.txt, sitemap)', weight: 5 },
  { id: 'eeat-signals', name: 'E-E-A-T Signals', weight: 8 },
  { id: 'faq-content', name: 'FAQ Content', weight: 8 },
  { id: 'citations', name: 'Citations & Authority Signals', weight: 8 },
  { id: 'schema-completeness', name: 'Schema Completeness', weight: 8 },
  { id: 'schema-validity', name: 'Schema Validity', weight: 5 },
  { id: 'entity-consistency', name: 'Entity Consistency', weight: 7 },
  { id: 'content-freshness', name: 'Content Freshness', weight: 7 },
  { id: 'content-extractability', name: 'Content Extractability', weight: 6 },
  { id: 'definition-blocks', name: 'Definition Blocks', weight: 6 },
  { id: 'ai-crawler-access', name: 'AI Crawler Access', weight: 4 },
  { id: 'named-entities', name: 'Named Entities', weight: 6 },
  { id: 'technical-seo', name: 'Technical SEO', weight: 5 },
  { id: 'snippet-eligibility', name: 'Snippet Eligibility', weight: 6 },
]

export const OPTIONAL_FACTOR_DEFINITIONS: FactorDefinition[] = [
  { id: 'geographic-signals', name: 'Geographic Signals', weight: 7 },
  { id: 'agent-skill-exposure', name: 'Agent Skill Exposure', weight: 6 },
  { id: 'lighthouse', name: 'Lighthouse (Performance/A11y/Best Practices)', weight: 8 },
]

/**
 * Factors that legitimately apply to only some page types. The test: when this
 * factor is absent from a page, is that a gap or correct? A product or portfolio
 * page has no business carrying an FAQ or a glossary definition, so a 0 there is
 * correct — not a site-wide failure. Every other factor (schema, E-E-A-T,
 * freshness, citations) is expected on every page, so a low average there is a
 * real coverage gap.
 *
 * The sitemap rollup reports two averages for these (see `buildCrossCuttingIssues`).
 * `avgScore` is still taken across every page — an honest coverage number, and the
 * answer to "how much of the site has this". `applicableAvgScore` is taken over the
 * pages the factor applies to, and answers "how good is it where it exists". The
 * second is the one to show: a factor living on 8 of 500 pages averages ~1/100
 * site-wide, which is arithmetically true and describes a site that doesn't exist.
 *
 * What this set changes is ranking and labelling: a page-specific factor must not
 * float to the top of the prioritized fixes on a structurally-inflated "affected"
 * count and read as "Critical: build an FAQ" when the site already has one on `/faq`.
 */
export const PAGE_SPECIFIC_FACTOR_IDS: ReadonlySet<string> = new Set([
  'faq-content',
  'definition-blocks',
])

/**
 * Minimum single-page score at which a page-specific factor counts as "present
 * somewhere", i.e. a tune-up (`limited`) rather than an absent `opportunity`. 30
 * clears a lone FAQPage schema (34) or the primary definition signal (30) without
 * being tripped by a stray question-mark heading (12). Tunable; presence — not
 * coverage breadth — is the gate, since low coverage is the expected state here.
 *
 * This is now the fallback rather than the primary test: an analyzer that can
 * report `applicable` directly is believed instead (see `factorApplies`). The
 * threshold is what a page-specific factor gets judged by when no analyzer says.
 * It reads presence as applicability, which flatters the average slightly — a
 * genuine FAQ page implemented badly drops out of its own denominator.
 */
export const PAGE_SPECIFIC_PRESENT_THRESHOLD = 30

export function scoreFactors(rawFactorResults: RawFactorResult[]): ScoredFactorSummary {
  const clamped = rawFactorResults.map((factor) => ({
    ...factor,
    score: clampScore(factor.score),
  }))

  const totalWeight = clamped.reduce((sum, factor) => sum + factor.weight, 0)

  // Weights are RELATIVE, and the set they are drawn from does not sum to 100:
  // the core factors sum to 111, and the optional ones move it again. The score
  // below already divides by the real total, so each factor's true share is
  // weight/totalWeight, not weight. Report that share rather than leaving every
  // consumer to either divide correctly or, as happened in both formatters here
  // and in a customer dashboard, print `weight` with a percent sign and overstate
  // all sixteen into a column that never adds up.
  const factors = clamped.map((factor) => ({
    ...factor,
    sharePct: totalWeight > 0 ? Math.round((factor.weight / totalWeight) * 1000) / 10 : 0,
  }))

  const weightedTotal = factors.reduce((sum, factor) => (
    sum + ((factor.score / 100) * (factor.weight / totalWeight) * 100)
  ), 0)

  const overallScore = clampScore(weightedTotal)

  return {
    overallScore,
    factors,
  }
}

/**
 * A factor's share of the overall score, for a consumer holding a report.
 *
 * Prefers the value the engine recorded, and falls back to the report's OWN
 * weight sum for a report produced before `sharePct` existed. Never falls back
 * to `weight`: that is the mistake this exists to prevent, and it silently
 * overstates every factor because the weights do not sum to 100.
 */
export function factorSharePct(
  factor: { weight: number; sharePct?: number },
  allFactors: readonly { weight: number }[],
): number {
  if (typeof factor.sharePct === 'number') return factor.sharePct
  const totalWeight = allFactors.reduce((sum, f) => sum + f.weight, 0)
  return totalWeight > 0 ? Math.round((factor.weight / totalWeight) * 1000) / 10 : 0
}

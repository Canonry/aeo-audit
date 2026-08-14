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

/**
 * Does this factor apply to this page at all?
 *
 * An analyzer that reports `applicable` is believed. Otherwise a page-specific
 * factor is judged by presence (the pre-existing rule, so a silent analyzer
 * behaves exactly as before), and every other factor always applies.
 *
 * ONE predicate, used by both the page score below and the sitemap rollup. They
 * disagreed before: the rollup already excluded non-applicable factors from
 * `applicableAvgScore`, while the page score counted them as zeros.
 */
export function factorApplies(factor: { id: string; score: number; applicable?: boolean }): boolean {
  if (typeof factor.applicable === 'boolean') return factor.applicable
  if (!PAGE_SPECIFIC_FACTOR_IDS.has(factor.id)) return true
  return factor.score >= PAGE_SPECIFIC_PRESENT_THRESHOLD
}

/**
 * Split 100 across the scored factors so the shares actually SUM to 100.
 *
 * Rounding each weight/total independently does not preserve the total: the 16
 * core factors over a denominator of 111 round to 99.9. A consumer that adds a
 * total row then prints 99.9 percent, which is the same "column that never adds
 * up" this field exists to remove, one decimal place down.
 *
 * Largest remainder: floor everyone to a tenth, then hand the leftover tenths to
 * the largest fractional parts. Ties break on weight then id so the allocation is
 * deterministic for a given factor set rather than dependent on input order.
 */
function allocateShares(scored: readonly { id: string; weight: number }[]): Map<string, number> {
  const shares = new Map<string, number>()
  const totalWeight = scored.reduce((sum, factor) => sum + factor.weight, 0)
  if (totalWeight <= 0 || scored.length === 0) {
    for (const factor of scored) shares.set(factor.id, 0)
    return shares
  }
  // Work in TENTHS of a percent so the arithmetic is integer and exact.
  const exact = scored.map((factor) => ({
    id: factor.id,
    weight: factor.weight,
    tenths: (factor.weight / totalWeight) * 1000,
  }))
  const floored = exact.map((entry) => ({ ...entry, floor: Math.floor(entry.tenths) }))
  let remaining = 1000 - floored.reduce((sum, entry) => sum + entry.floor, 0)
  const byRemainder = [...floored].sort(
    (a, b) =>
      (b.tenths - b.floor) - (a.tenths - a.floor) || b.weight - a.weight || a.id.localeCompare(b.id),
  )
  const bonus = new Set<string>()
  for (const entry of byRemainder) {
    if (remaining <= 0) break
    bonus.add(entry.id)
    remaining--
  }
  for (const entry of floored) {
    shares.set(entry.id, (entry.floor + (bonus.has(entry.id) ? 1 : 0)) / 10)
  }
  return shares
}

export function scoreFactors(rawFactorResults: RawFactorResult[]): ScoredFactorSummary {
  const clamped = rawFactorResults.map((factor) => ({
    ...factor,
    score: clampScore(factor.score),
  }))

  // Score only what APPLIES. A factor the analyzer says does not apply to this
  // page still reports 0, and counting that 0 against the page penalizes it for
  // lacking something it has no reason to have: a product page with no FAQ was
  // losing real points for not being an FAQ page. The flag existed to say exactly
  // that, and the sitemap rollup already honored it; the page score did not.
  //
  // Excluding it from BOTH sides is the point. Dropping only the numerator would
  // be worse than the bug, silently capping every such page below 100.
  const applicable = clamped.filter((factor) => factorApplies(factor))
  // Nothing applying at all is not a real page shape (14 of the 16 factors always
  // apply), but an empty denominator must not become a divide-by-zero or a
  // fabricated 0, so fall back to scoring everything.
  const scored = applicable.length > 0 ? applicable : clamped
  const totalWeight = scored.reduce((sum, factor) => sum + factor.weight, 0)

  // Weights are RELATIVE, and the set they are drawn from does not sum to 100:
  // the core factors sum to 111, and the optional ones move it again. The score
  // below divides by the real total of what it scored, so a factor's true share
  // is weight/totalWeight, not weight. Report that share rather than leaving every
  // consumer to either divide correctly or, as happened in both formatters here
  // and in a customer dashboard, print `weight` with a percent sign and overstate
  // all sixteen into a column that never adds up.
  //
  // A factor that did not apply has NO share: it moved the score by nothing.
  const shares = allocateShares(scored)
  const factors = clamped.map((factor) => ({
    ...factor,
    // Record the RESOLVED applicability, not just what an analyzer volunteered.
    // Otherwise a page-specific factor judged by the presence fallback reports
    // score 0 and sharePct 0 with no flag, and a consumer cannot tell "did not
    // apply here" from "applied and scored zero" without reimplementing
    // PAGE_SPECIFIC_FACTOR_IDS and the threshold. Same argument as sharePct: the
    // payload was missing the answer.
    applicable: factorApplies(factor),
    sharePct: shares.get(factor.id) ?? 0,
  }))

  const weightedTotal = scored.reduce((sum, factor) => (
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
  factor: { id: string; weight: number; score: number; applicable?: boolean; sharePct?: number },
  allFactors: readonly { id: string; weight: number; score: number; applicable?: boolean }[],
): number {
  if (typeof factor.sharePct === 'number') return factor.sharePct
  if (!factorApplies(factor)) return 0
  const scored = allFactors.filter((f) => factorApplies(f))
  const pool = scored.length > 0 ? scored : allFactors
  // The SAME allocation the engine uses, so a derived column and a recorded one
  // both add to 100 rather than differing by a tenth depending on the report age.
  return allocateShares(pool).get(factor.id) ?? 0
}

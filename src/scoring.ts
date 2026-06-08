import { clampScore } from './analyzers/helpers.js'
import type { FactorDefinition, RawFactorResult, ScoredFactorSummary } from './types.js'

export const FACTOR_DEFINITIONS: FactorDefinition[] = [
  { id: 'structured-data', name: 'Structured Data (JSON-LD)', weight: 12 },
  { id: 'content-depth', name: 'Content Depth', weight: 10 },
  { id: 'ai-readable-content', name: 'AI-Readable Content', weight: 5 },
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

export function scoreFactors(rawFactorResults: RawFactorResult[]): ScoredFactorSummary {
  const factors = rawFactorResults.map((factor) => ({
    ...factor,
    score: clampScore(factor.score),
  }))

  const totalWeight = factors.reduce((sum, factor) => sum + factor.weight, 0)

  const weightedTotal = factors.reduce((sum, factor) => (
    sum + ((factor.score / 100) * (factor.weight / totalWeight) * 100)
  ), 0)

  const overallScore = clampScore(weightedTotal)

  return {
    overallScore,
    factors,
  }
}

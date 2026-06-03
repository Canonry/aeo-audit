import { clampScore, extractJsonLdBlocks } from './helpers.js'
import type { AnalysisResult, AuditContext } from '../types.js'

const SINGLETON_TYPES = new Set([
  'FAQPage',
  'HowTo',
  'Article',
  'BlogPosting',
  'NewsArticle',
  'BreadcrumbList',
  'Product',
  'Recipe',
])

export function analyzeSchemaValidity(context: AuditContext): AnalysisResult {
  const findings: AnalysisResult['findings'] = []
  const recommendations: string[] = []

  const { totalBlocks, blocks } = extractJsonLdBlocks(context.$)

  if (totalBlocks === 0) {
    findings.push({
      type: 'info',
      code: 'schema-validity.json-ld.none',
      message: 'No JSON-LD blocks found; nothing to validate. Presence of structured data is scored by the structured-data factor.',
    })
    return { score: 100, findings, recommendations }
  }

  let score = 100

  for (const block of blocks) {
    if (block.isEmpty) {
      score -= 5
      findings.push({
        type: 'missing',
        code: 'schema-validity.block.empty',
        message: `JSON-LD block #${block.index + 1} is empty or whitespace-only.`,
      })
      recommendations.push(`Remove the empty <script type="application/ld+json"> block at position ${block.index + 1}, or populate it with valid JSON-LD.`)
    }
  }

  for (const block of blocks) {
    if (block.parseError) {
      score -= 15
      findings.push({
        type: 'missing',
        code: 'schema-validity.block.invalid',
        message: `JSON-LD block #${block.index + 1} has invalid JSON syntax: ${block.parseError}`,
      })
      recommendations.push(`Fix JSON syntax error in block #${block.index + 1} (${block.parseError}). Invalid JSON is silently dropped by Google and AI crawlers.`)
    }
  }

  const typeOccurrences = new Map<string, number[]>()
  for (const block of blocks) {
    if (block.parseError || block.isEmpty) continue
    for (const type of block.topLevelTypes) {
      if (!SINGLETON_TYPES.has(type)) continue
      const positions = typeOccurrences.get(type) ?? []
      positions.push(block.index + 1)
      typeOccurrences.set(type, positions)
    }
  }

  let duplicateCount = 0
  for (const [type, positions] of typeOccurrences) {
    if (positions.length > 1) {
      duplicateCount += 1
      score -= 25
      findings.push({
        type: 'missing',
        code: 'schema-validity.singleton.duplicate',
        message: `Duplicate singleton @type "${type}" appears ${positions.length} times (blocks #${positions.join(', #')}). Google Search Console flags this as "Duplicate field ${type}" and invalidates rich results.`,
      })
      recommendations.push(`Remove duplicate "${type}" — keep one canonical block. Duplicate "${type}" entries cause Google to drop both from rich results.`)
    }
  }

  const hasParseError = blocks.some((block) => Boolean(block.parseError))
  const hasStructuralError = hasParseError || duplicateCount > 0

  // Cap structural-error scores at fail level so the factor surfaces in text-mode
  // top-recommendations regardless of how many other factors are also failing.
  // Schema parse errors and duplicate singletons are silent but break rich results,
  // so they must be visible to the user — flagged irrespective of numeric score.
  if (hasStructuralError) {
    score = Math.min(score, 69)
  }

  if (findings.length === 0) {
    findings.push({
      type: 'found',
      code: 'schema-validity.block.valid',
      message: `All ${totalBlocks} JSON-LD block(s) are valid and unique.`,
    })
  }

  return {
    score: clampScore(score),
    findings,
    recommendations,
  }
}

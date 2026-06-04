import { clampScore, countWords } from './helpers.js'
import type { AnalysisResult, AuditContext } from '../types.js'

export function analyzeContentDepth(context: AuditContext): AnalysisResult {
  const findings: AnalysisResult['findings'] = []
  const recommendations: string[] = []

  const wordCount = countWords(context.textContent)
  const h1Count = context.$('h1').length
  const h2Count = context.$('h2').length
  const h3Count = context.$('h3').length
  const paragraphCount = context.$('p').length
  const listCount = context.$('ul, ol').length

  let score = 0

  if (wordCount >= 1200) {
    score += 35
    findings.push({ type: 'found', code: 'content-depth.word-count.strong', message: `Strong visible content depth (${wordCount} words).` })
  } else if (wordCount >= 500) {
    score += 22
    findings.push({ type: 'info', code: 'content-depth.word-count.moderate', message: `Moderate content depth (${wordCount} words).` })
    recommendations.push('Increase topical depth with more explanatory content.')
  } else {
    score += 8
    findings.push({ type: 'missing', code: 'content-depth.word-count.low', message: `Low content depth (${wordCount} words).` })
    recommendations.push('Add more comprehensive copy covering key user questions.')
  }

  if (h1Count === 1) {
    score += 15
    findings.push({ type: 'found', code: 'content-depth.h1.single', message: 'Exactly one H1 detected.' })
  } else if (h1Count > 1) {
    score += 6
    findings.push({ type: 'info', code: 'content-depth.h1.multiple', message: `Multiple H1 elements detected (${h1Count}).` })
    recommendations.push('Use a single primary H1 and nest additional sections under H2/H3.')
  } else {
    findings.push({ type: 'missing', code: 'content-depth.h1.missing', message: 'No H1 heading detected.' })
    recommendations.push('Add an H1 that clearly defines the page topic.')
  }

  if (h2Count >= 3 && h3Count >= 2) {
    score += 22
    findings.push({ type: 'found', code: 'content-depth.headings.strong', message: 'Heading hierarchy (H2/H3) is well developed.' })
  } else if (h2Count >= 2) {
    score += 14
    findings.push({ type: 'info', code: 'content-depth.headings.moderate', message: 'Basic heading hierarchy detected.' })
    recommendations.push('Expand section depth with additional H3 subsections.')
  } else {
    score += 4
    findings.push({ type: 'missing', code: 'content-depth.headings.low', message: 'Limited heading structure detected.' })
    recommendations.push('Break content into structured H2/H3 sections for parseability.')
  }

  if (paragraphCount >= 8) {
    score += 16
    findings.push({ type: 'found', code: 'content-depth.paragraphs.strong', message: 'Substantial paragraph-level content present.' })
  } else if (paragraphCount >= 4) {
    score += 10
    findings.push({ type: 'info', code: 'content-depth.paragraphs.moderate', message: 'Some paragraph depth detected.' })
  } else {
    findings.push({ type: 'missing', code: 'content-depth.paragraphs.low', message: 'Very few paragraph blocks detected.' })
  }

  if (listCount > 0) {
    score += 12
    findings.push({ type: 'found', code: 'content-depth.lists.present', message: 'Lists detected for structured information.' })
  } else {
    findings.push({ type: 'info', code: 'content-depth.lists.none', message: 'No list structures detected.' })
    recommendations.push('Use bullet/numbered lists for key concepts and process steps.')
  }

  return {
    score: clampScore(score),
    findings,
    recommendations,
  }
}

import { clampScore, countWords, normalizeText } from './helpers.js'
import type { AnalysisResult, AuditContext } from '../types.js'

export function analyzeContentExtractability(context: AuditContext): AnalysisResult {
  const findings: AnalysisResult['findings'] = []
  const recommendations: string[] = []
  let score = 0

  // Content-to-boilerplate ratio
  const visibleTextLength = (context.textContent || '').length
  const htmlLength = (context.html || '').length

  if (htmlLength > 0) {
    const ratio = visibleTextLength / htmlLength

    if (ratio > 0.3) {
      score += 25
      findings.push({ type: 'found', code: 'content-extractability.content-ratio.strong', message: `Strong content-to-markup ratio (${(ratio * 100).toFixed(0)}%).` })
    } else if (ratio > 0.15) {
      score += 15
      findings.push({ type: 'info', code: 'content-extractability.content-ratio.moderate', message: `Moderate content-to-markup ratio (${(ratio * 100).toFixed(0)}%).` })
    } else {
      score += 5
      findings.push({ type: 'info', code: 'content-extractability.content-ratio.low', message: `Low content-to-markup ratio (${(ratio * 100).toFixed(0)}%).` })
      recommendations.push('Reduce boilerplate HTML and increase content density.')
    }
  }

  // Clean text block detection (paragraphs with 40-200 words — ideal citation length)
  let citableBlocks = 0
  context.$('p').each((_, element) => {
    const text = normalizeText(context.$(element).text())
    const words = countWords(text)
    if (words >= 40 && words <= 200) {
      citableBlocks += 1
    }
  })

  if (citableBlocks >= 5) {
    score += 25
    findings.push({ type: 'found', code: 'content-extractability.citable-blocks.strong', message: `${citableBlocks} citation-ready text blocks found (40-200 words each).` })
  } else if (citableBlocks >= 2) {
    score += 15
    findings.push({ type: 'info', code: 'content-extractability.citable-blocks.moderate', message: `${citableBlocks} citation-ready text blocks found.` })
    recommendations.push('Add more substantive paragraphs (40-200 words) for citation extraction.')
  } else {
    score += 5
    findings.push({ type: 'missing', code: 'content-extractability.citable-blocks.missing', message: 'Few citation-ready text blocks detected.' })
    recommendations.push('Structure content into focused paragraphs of 40-200 words each.')
  }

  // Paywall / gate detection
  const paywallSignals = []
  const htmlLower = (context.html || '').toLowerCase()

  if (htmlLower.includes('paywall') || htmlLower.includes('subscribe to read') || htmlLower.includes('sign in to continue')) {
    paywallSignals.push('paywall/subscription text')
  }

  const gateClasses = context.$('[class*="paywall"], [class*="login-wall"], [class*="gate-"], [id*="paywall"]')
  if (gateClasses.length > 0) {
    paywallSignals.push('gate-related CSS classes')
  }

  if (paywallSignals.length > 0) {
    score -= 20
    findings.push({ type: 'missing', code: 'content-extractability.paywall.found', message: `Content gate signals detected: ${paywallSignals.join(', ')}.` })
    recommendations.push('Ensure primary content is accessible without login/subscription for AI crawlers.')
  } else {
    score += 10
    findings.push({ type: 'found', code: 'content-extractability.paywall.none', message: 'No paywall or content gate signals detected.' })
  }

  // Ad density
  const adElements = context.$('[class*="ad-"], [class*="ads-"], [id*="ad-"], [id*="ads-"], iframe[src*="ads"], iframe[src*="doubleclick"], [class*="advertisement"]')
  const adCount = adElements.length

  if (adCount >= 5) {
    score -= 15
    findings.push({ type: 'info', code: 'content-extractability.ad-density.high', message: `High ad element density detected (${adCount} elements).` })
    recommendations.push('Reduce ad density to improve content extractability for AI crawlers.')
  } else if (adCount > 0) {
    score += 5
    findings.push({ type: 'info', code: 'content-extractability.ad-density.low', message: `Low ad density (${adCount} elements).` })
  } else {
    score += 10
    findings.push({ type: 'found', code: 'content-extractability.ad-density.none', message: 'No ad elements detected.' })
  }

  // Direct answer blocks (content immediately following H2/H3 that's 1-3 sentences)
  let directAnswerCount = 0
  context.$('h2, h3').each((_, heading) => {
    const nextP = context.$(heading).next('p')
    if (nextP.length) {
      const text = normalizeText(nextP.text())
      const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 10)
      if (sentences.length >= 1 && sentences.length <= 3) {
        directAnswerCount += 1
      }
    }
  })

  if (directAnswerCount >= 3) {
    score += 15
    findings.push({ type: 'found', code: 'content-extractability.direct-answer.strong', message: `${directAnswerCount} direct-answer blocks follow headings.` })
  } else if (directAnswerCount >= 1) {
    score += 8
    findings.push({ type: 'info', code: 'content-extractability.direct-answer.moderate', message: `${directAnswerCount} direct-answer block(s) follow headings.` })
  } else {
    findings.push({ type: 'info', code: 'content-extractability.direct-answer.none', message: 'No clear direct-answer blocks following headings.' })
    recommendations.push('Place concise 1-3 sentence answers immediately after H2/H3 headings.')
  }

  return {
    score: clampScore(score),
    findings,
    recommendations,
  }
}

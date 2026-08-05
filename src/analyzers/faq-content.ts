import { clampScore, extractSchemaTypes } from './helpers.js'
import type { AnalysisResult, AuditContext } from '../types.js'

/** Route names sites give the page that answers questions. */
const FAQ_URL_PATTERN = /\/(faqs?|frequently-asked[a-z-]*|questions|help|support)(\/|$)/i
const FAQ_TITLE_PATTERN = /\bfaqs?\b|frequently asked/i

export function analyzeFaqContent(context: AuditContext): AnalysisResult {
  const findings: AnalysisResult['findings'] = []
  const recommendations: string[] = []
  let score = 0

  const schemaTypes = extractSchemaTypes(context.structuredData)
  if (schemaTypes.has('FAQPage')) {
    score += 34
    findings.push({ type: 'found', code: 'faq-content.faqpage.present', message: 'FAQPage schema detected.' })
  } else {
    findings.push({ type: 'missing', code: 'faq-content.faqpage.missing', message: 'FAQPage schema not detected.' })
    recommendations.push('Add FAQPage schema for key question-and-answer content.')
  }

  const detailsCount = context.$('details > summary').length
  if (detailsCount >= 3) {
    score += 24
    findings.push({ type: 'found', code: 'faq-content.details.multiple', message: `Detected ${detailsCount} FAQ details blocks.` })
  } else if (detailsCount > 0) {
    score += 14
    findings.push({ type: 'info', code: 'faq-content.details.single', message: `Detected ${detailsCount} details-based FAQ block(s).` })
  } else {
    findings.push({ type: 'info', code: 'faq-content.details.none', message: 'No details/summary FAQ blocks detected.' })
  }

  let questionHeadingCount = 0
  context.$('h2, h3, h4, summary').each((_, element) => {
    const text = context.$(element).text().trim()
    if (text.endsWith('?')) {
      questionHeadingCount += 1
    }
  })

  if (questionHeadingCount >= 3) {
    score += 24
    findings.push({ type: 'found', code: 'faq-content.headings.multiple', message: 'Multiple question-style headings detected.' })
  } else if (questionHeadingCount > 0) {
    score += 12
    findings.push({ type: 'info', code: 'faq-content.headings.low', message: 'A small number of question headings detected.' })
  } else {
    findings.push({ type: 'missing', code: 'faq-content.headings.missing', message: 'No explicit question headings detected.' })
    recommendations.push('Use question-style headings to match conversational prompts.')
  }

  const qaPairs = Math.min(
    context.$('details').length,
    context.$('details > summary').length,
  )

  if (qaPairs >= 3) {
    score += 18
    findings.push({ type: 'found', code: 'faq-content.qa-pairs.multiple', message: 'FAQ content includes multiple question-answer pairs.' })
  } else if (qaPairs > 0) {
    score += 10
    findings.push({ type: 'info', code: 'faq-content.qa-pairs.low', message: 'FAQ pairs exist but are limited in count.' })
  } else {
    findings.push({ type: 'info', code: 'faq-content.qa-pairs.none', message: 'Question-answer pairing appears limited.' })
  }

  // Is this a page that was ever supposed to answer questions? A pricing or
  // product page has no business carrying an FAQ, and rolling its 0 into the
  // site-wide average is how "FAQ Content: 1/100, 100% of pages affected" gets
  // reported about a site whose FAQ is fine. Declaring inapplicability leaves the
  // score untouched and only removes the page from that average.
  //
  // Any one of: it says it's an FAQ (schema, URL, title), or it is built like one.
  const applicable =
    schemaTypes.has('FAQPage') ||
    FAQ_URL_PATTERN.test(context.url) ||
    FAQ_TITLE_PATTERN.test(context.pageTitle) ||
    questionHeadingCount >= 3 ||
    qaPairs >= 3

  return {
    score: clampScore(score),
    findings,
    recommendations,
    applicable,
  }
}

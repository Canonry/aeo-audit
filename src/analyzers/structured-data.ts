import { clampScore, describeRecommendedSchemas, detectSiteCategory, extractSchemaTypes } from './helpers.js'
import type { AnalysisResult, AuditContext } from '../types.js'

const PRIORITY_TYPES = ['LocalBusiness', 'FAQPage', 'Service', 'HowTo']

export function analyzeStructuredData(context: AuditContext): AnalysisResult {
  const findings: AnalysisResult['findings'] = []
  const recommendations: string[] = []
  const structuredData = context.structuredData || []
  const schemaTypes = extractSchemaTypes(structuredData)
  const detection = detectSiteCategory(context)

  // Record what the site was taken to be and on what evidence. Every schema
  // recommendation below is downstream of this call, so when one comes out wrong
  // — the reason is usually a keyword that fires on the wrong kind of site — the
  // report already says which signals were responsible instead of requiring the
  // detection to be re-run by hand to find out.
  findings.push({
    type: 'info',
    code: 'structured-data.site-category.detected',
    message: detection.category === 'unknown'
      ? 'Site category could not be determined; schema advice stays generic.'
      : `Site read as ${detection.category}${detection.evidence.length > 0 ? ` (${detection.evidence.join('; ')})` : ''}.`,
  })

  let score = 0

  if (structuredData.length > 0) {
    score += 30
    findings.push({ type: 'found', code: 'structured-data.json-ld.found', message: `Detected ${structuredData.length} JSON-LD block(s).` })
  } else {
    findings.push({ type: 'missing', code: 'structured-data.json-ld.missing', message: 'No JSON-LD structured data found.' })
    // Issue #33: recommend schemas that fit the detected site category instead
    // of always suggesting LocalBusiness/Service (which is wrong for SaaS,
    // dev tools, blogs, e-commerce, etc.).
    recommendations.push(`Add JSON-LD with ${describeRecommendedSchemas(detection)}.`)
  }

  for (const type of PRIORITY_TYPES) {
    if (schemaTypes.has(type)) {
      score += 12
      findings.push({ type: 'found', code: 'structured-data.schema.found', message: `${type} schema detected.` })
    } else {
      findings.push({ type: 'missing', code: 'structured-data.schema.missing', message: `${type} schema not found.` })
    }
  }

  const avgProperties = structuredData.length
    ? structuredData.reduce((sum, item) => sum + Object.keys(item).length, 0) / structuredData.length
    : 0

  if (avgProperties >= 8) {
    score += 22
    findings.push({ type: 'found', code: 'structured-data.schema-depth.strong', message: 'Structured data has strong property depth.' })
  } else if (avgProperties >= 4) {
    score += 12
    findings.push({ type: 'info', code: 'structured-data.schema-depth.moderate', message: 'Structured data exists but could be more detailed.' })
    recommendations.push('Expand schema properties (contact, areaServed, sameAs, etc.).')
  } else if (structuredData.length) {
    findings.push({ type: 'info', code: 'structured-data.schema-depth.low', message: 'Structured data appears shallow.' })
    recommendations.push('Increase schema completeness with richer properties.')
  }

  if (!recommendations.length && score >= 70) {
    recommendations.push('Maintain schema parity as new pages and services are added.')
  }

  return {
    score: clampScore(score),
    findings,
    recommendations,
  }
}

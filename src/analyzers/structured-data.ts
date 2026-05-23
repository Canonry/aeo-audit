import { clampScore, detectSiteCategory, extractSchemaTypes } from './helpers.js'
import type { AnalysisResult, AuditContext } from '../types.js'

const PRIORITY_TYPES = ['LocalBusiness', 'FAQPage', 'Service', 'HowTo']

function formatSchemaList(schemas: string[]): string {
  if (schemas.length === 0) return 'Organization'
  if (schemas.length === 1) return schemas[0]
  if (schemas.length === 2) return `${schemas[0]} and ${schemas[1]}`
  return `${schemas.slice(0, -1).join(', ')}, and ${schemas[schemas.length - 1]}`
}

export function analyzeStructuredData(context: AuditContext): AnalysisResult {
  const findings: AnalysisResult['findings'] = []
  const recommendations: string[] = []
  const structuredData = context.structuredData || []
  const schemaTypes = extractSchemaTypes(structuredData)
  const detection = detectSiteCategory(context)

  let score = 0

  if (structuredData.length > 0) {
    score += 30
    findings.push({ type: 'found', message: `Detected ${structuredData.length} JSON-LD block(s).` })
  } else {
    findings.push({ type: 'missing', message: 'No JSON-LD structured data found.' })
    // Issue #33: recommend schemas that fit the detected site category instead
    // of always suggesting LocalBusiness/Service (which is wrong for SaaS,
    // dev tools, blogs, e-commerce, etc.).
    recommendations.push(`Add JSON-LD with ${formatSchemaList(detection.recommendedSchemas)} schema.`)
  }

  for (const type of PRIORITY_TYPES) {
    if (schemaTypes.has(type)) {
      score += 12
      findings.push({ type: 'found', message: `${type} schema detected.` })
    } else {
      findings.push({ type: 'missing', message: `${type} schema not found.` })
    }
  }

  const avgProperties = structuredData.length
    ? structuredData.reduce((sum, item) => sum + Object.keys(item).length, 0) / structuredData.length
    : 0

  if (avgProperties >= 8) {
    score += 22
    findings.push({ type: 'found', message: 'Structured data has strong property depth.' })
  } else if (avgProperties >= 4) {
    score += 12
    findings.push({ type: 'info', message: 'Structured data exists but could be more detailed.' })
    recommendations.push('Expand schema properties (contact, areaServed, sameAs, etc.).')
  } else if (structuredData.length) {
    findings.push({ type: 'info', message: 'Structured data appears shallow.' })
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

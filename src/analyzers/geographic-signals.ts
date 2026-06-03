import { clampScore, extractSchemaTypes } from './helpers.js'
import type { AnalysisResult, AuditContext, StructuredDataEntry } from '../types.js'

function hasAddressInSchema(structuredData: StructuredDataEntry[]): boolean {
  return structuredData.some((item) => typeof item?.address === 'object' && item.address)
}

function hasGeoInSchema(structuredData: StructuredDataEntry[]): boolean {
  return structuredData.some((item) => typeof item?.geo === 'object' && item.geo)
}

function hasAreaServed(structuredData: StructuredDataEntry[]): boolean {
  return structuredData.some((item) => item?.areaServed)
}

export function analyzeGeographicSignals(context: AuditContext): AnalysisResult {
  const findings: AnalysisResult['findings'] = []
  const recommendations: string[] = []
  let score = 0

  const schemaTypes = extractSchemaTypes(context.structuredData)
  if (schemaTypes.has('LocalBusiness')) {
    score += 32
    findings.push({ type: 'found', code: 'geographic-signals.localbusiness-schema.found', message: 'LocalBusiness schema detected.' })
  } else {
    findings.push({ type: 'missing', code: 'geographic-signals.localbusiness-schema.missing', message: 'LocalBusiness schema not detected.' })
    recommendations.push('Add LocalBusiness schema for local search relevance.')
  }

  if (hasGeoInSchema(context.structuredData)) {
    score += 22
    findings.push({ type: 'found', code: 'geographic-signals.geo-coordinates.found', message: 'GeoCoordinates found in structured data.' })
  } else {
    findings.push({ type: 'info', code: 'geographic-signals.geo-coordinates.missing', message: 'No geo coordinates found in structured data.' })
    recommendations.push('Add geo coordinates to LocalBusiness schema.')
  }

  if (hasAddressInSchema(context.structuredData)) {
    score += 18
    findings.push({ type: 'found', code: 'geographic-signals.postal-address.found', message: 'Postal address found in structured data.' })
  } else {
    findings.push({ type: 'info', code: 'geographic-signals.postal-address.missing', message: 'No postal address found in structured data.' })
  }

  if (hasAreaServed(context.structuredData)) {
    score += 14
    findings.push({ type: 'found', code: 'geographic-signals.area-served.found', message: 'areaServed signal detected in structured data.' })
  } else {
    findings.push({ type: 'missing', code: 'geographic-signals.area-served.missing', message: 'No areaServed signal detected.' })
    recommendations.push('Declare areaServed to clarify geographic coverage.')
  }

  const hasGeoMeta = context.$('meta[name^="geo."]').length > 0
  if (hasGeoMeta) {
    score += 8
    findings.push({ type: 'found', code: 'geographic-signals.geo-meta.found', message: 'Geo meta tags detected.' })
  } else {
    findings.push({ type: 'info', code: 'geographic-signals.geo-meta.missing', message: 'Geo meta tags not detected.' })
  }

  const addressPattern = /(\b\d{1,5}\s+[A-Za-z0-9.'\-\s]+,?\s+[A-Za-z.'\-\s]+,?\s+[A-Z]{2}\b)/i
  if (addressPattern.test(context.textContent)) {
    score += 12
    findings.push({ type: 'found', code: 'geographic-signals.visible-location.found', message: 'Visible content includes geographic/location signals.' })
  } else {
    findings.push({ type: 'info', code: 'geographic-signals.visible-location.missing', message: 'Visible location signals appear limited.' })
    recommendations.push('Include service area/city signals in visible content.')
  }

  return {
    score: clampScore(score),
    findings,
    recommendations,
  }
}

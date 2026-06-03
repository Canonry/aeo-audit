import { clampScore, getBusinessName } from './helpers.js'
import type { AnalysisResult, AuditContext } from '../types.js'

function properNounDensity(text: string): number {
  const words = text.split(/\s+/).filter(Boolean)
  if (!words.length) {
    return 0
  }

  const properNouns = words.filter((word) => /^[A-Z][a-zA-Z0-9]+$/.test(word))
  return properNouns.length / words.length
}

export function analyzeNamedEntities(context: AuditContext): AnalysisResult {
  const findings: AnalysisResult['findings'] = []
  const recommendations: string[] = []
  let score = 0

  const businessName = getBusinessName(context)
  const text = context.textContent || ''

  if (businessName) {
    const escapedName = businessName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const occurrences = (text.match(new RegExp(escapedName, 'gi')) || []).length

    if (occurrences >= 3) {
      score += 36
      findings.push({ type: 'found', code: 'named-entities.brand-name.strong', message: `Brand/entity name appears ${occurrences} times in content.` })
    } else if (occurrences > 0) {
      score += 20
      findings.push({ type: 'info', code: 'named-entities.brand-name.low', message: `Brand/entity name appears ${occurrences} time(s) in content.` })
      recommendations.push('Use consistent brand naming throughout key content sections.')
    } else {
      score += 6
      findings.push({ type: 'missing', code: 'named-entities.brand-name.missing', message: 'Brand/entity name not clearly present in visible text.' })
      recommendations.push('Include business/entity name in key headings and explanatory text.')
    }
  } else {
    findings.push({ type: 'missing', code: 'named-entities.entity-name.missing', message: 'Could not infer a primary business/entity name.' })
    recommendations.push('Ensure schema and titles expose a clear entity name.')
  }

  let knowsAboutCount = 0
  let founderCount = 0
  for (const item of context.structuredData) {
    if (Array.isArray(item?.knowsAbout)) {
      knowsAboutCount += item.knowsAbout.length
    }

    if (Array.isArray(item?.founder)) {
      founderCount += item.founder.length
    } else if (item?.founder) {
      founderCount += 1
    }
  }

  if (knowsAboutCount > 0 || founderCount > 0) {
    score += 34
    findings.push({ type: 'found', code: 'named-entities.knows-about.present', message: 'Schema includes entity knowledge/founder signals.' })
  } else {
    score += 10
    findings.push({ type: 'info', code: 'named-entities.knows-about.missing', message: 'No explicit knowsAbout/founder entity signals in schema.' })
    recommendations.push('Add knowsAbout and founder/person associations in schema where relevant.')
  }

  const density = properNounDensity(text)
  if (density >= 0.08) {
    score += 30
    findings.push({ type: 'found', code: 'named-entities.proper-noun-density.strong', message: 'Proper noun density indicates strong entity context.' })
  } else if (density >= 0.04) {
    score += 18
    findings.push({ type: 'info', code: 'named-entities.proper-noun-density.moderate', message: 'Moderate proper noun density detected.' })
  } else {
    score += 8
    findings.push({ type: 'info', code: 'named-entities.proper-noun-density.low', message: 'Low proper noun density detected.' })
    recommendations.push('Add explicit entities: brands, places, people, and product/service names.')
  }

  return {
    score: clampScore(score),
    findings,
    recommendations,
  }
}

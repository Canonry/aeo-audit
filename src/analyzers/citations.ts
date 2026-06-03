import { clampScore, domainFromUrl } from './helpers.js'
import type { AnalysisResult, AuditContext } from '../types.js'

interface ExternalLink {
  url: string
  hostname: string
  text: string
}

function anchorQuality(anchorText: string): number {
  const words = anchorText.trim().split(/\s+/).filter(Boolean)
  if (!words.length) {
    return 0
  }

  if (words.length >= 3) {
    return 1
  }

  if (words.length === 2) {
    return 0.6
  }

  return 0.2
}

export function analyzeCitations(context: AuditContext): AnalysisResult {
  const findings: AnalysisResult['findings'] = []
  const recommendations: string[] = []
  let score = 0

  const pageDomain = domainFromUrl(context.url)
  const externalLinks: ExternalLink[] = []

  context.$('a[href]').each((_, element) => {
    const href = context.$(element).attr('href')
    if (!href) {
      return
    }

    try {
      const absolute = new URL(href, context.url)
      if (!['http:', 'https:'].includes(absolute.protocol)) {
        return
      }

      if (absolute.hostname.toLowerCase() !== pageDomain) {
        externalLinks.push({
          url: absolute.toString(),
          hostname: absolute.hostname.toLowerCase(),
          text: context.$(element).text().trim(),
        })
      }
    } catch {
      // Ignore malformed links.
    }
  })

  if (externalLinks.length >= 8) {
    score += 30
    findings.push({ type: 'found', code: 'citations.external-links.strong', message: `Strong external citation coverage (${externalLinks.length} links).` })
  } else if (externalLinks.length >= 3) {
    score += 18
    findings.push({ type: 'info', code: 'citations.external-links.moderate', message: `Moderate external citation coverage (${externalLinks.length} links).` })
  } else {
    score += 6
    findings.push({ type: 'missing', code: 'citations.external-links.low', message: 'Limited external citations detected.' })
    recommendations.push('Reference authoritative third-party sources to strengthen trust signals.')
  }

  const authoritativeLinks = externalLinks.filter((link) => (
    link.hostname.endsWith('.gov')
      || link.hostname.endsWith('.edu')
      || link.hostname.includes('wikipedia.org')
  ))

  if (authoritativeLinks.length > 0) {
    score += 24
    findings.push({ type: 'found', code: 'citations.authoritative-domains.found', message: 'Authoritative domain citations detected (.gov/.edu/Wikipedia).' })
  } else {
    score += 8
    findings.push({ type: 'info', code: 'citations.authoritative-domains.none', message: 'No clearly authoritative domains detected in external links.' })
  }

  let sameAsCount = 0
  for (const item of context.structuredData) {
    const sameAs = item?.sameAs
    if (Array.isArray(sameAs)) {
      sameAsCount += sameAs.length
    } else if (typeof sameAs === 'string') {
      sameAsCount += 1
    }
  }

  if (sameAsCount >= 3) {
    score += 24
    findings.push({ type: 'found', code: 'citations.sameas.strong', message: `Structured data includes ${sameAsCount} sameAs link(s).` })
  } else if (sameAsCount > 0) {
    score += 14
    findings.push({ type: 'info', code: 'citations.sameas.moderate', message: `Structured data includes ${sameAsCount} sameAs link(s).` })
  } else {
    score += 4
    findings.push({ type: 'missing', code: 'citations.sameas.missing', message: 'No sameAs references found in structured data.' })
    recommendations.push('Add sameAs references for key profiles/directories in JSON-LD.')
  }

  const anchorsWithText = externalLinks.filter((link) => link.text)
  const quality = anchorsWithText.length
    ? anchorsWithText.reduce((sum, link) => sum + anchorQuality(link.text), 0) / anchorsWithText.length
    : 0

  if (quality >= 0.75) {
    score += 22
    findings.push({ type: 'found', code: 'citations.anchor-text.strong', message: 'External anchor text quality is strong.' })
  } else if (quality >= 0.45) {
    score += 12
    findings.push({ type: 'info', code: 'citations.anchor-text.moderate', message: 'Anchor text quality is moderate.' })
  } else {
    score += 6
    findings.push({ type: 'info', code: 'citations.anchor-text.low', message: 'Anchor text quality is weak or generic.' })
    recommendations.push('Use descriptive external anchor text instead of generic labels.')
  }

  return {
    score: clampScore(score),
    findings,
    recommendations,
  }
}

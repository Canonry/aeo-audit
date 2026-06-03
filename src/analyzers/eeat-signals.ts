import { clampScore, extractSchemaTypes, findTopLevelSchemaByType } from './helpers.js'
import type { AnalysisResult, AuditContext, StructuredDataEntry } from '../types.js'

export function analyzeEeatSignals(context: AuditContext): AnalysisResult {
  const findings: AnalysisResult['findings'] = []
  const recommendations: string[] = []
  let score = 0

  // Person schema with credentials (jobTitle, alumniOf, hasCredential).
  // Count top-level Person declarations AND Persons in explicit authorial roles
  // (author, creator, contributor) on any top-level schema — e.g. Article.author.
  // Exclude deeply nested Persons (review authors, customers, etc.) which are not
  // authoritative E-E-A-T signals for the page itself.
  const persons: StructuredDataEntry[] = [
    ...findTopLevelSchemaByType(context.structuredData, 'Person'),
  ]
  for (const item of context.structuredData) {
    for (const prop of ['author', 'creator', 'contributor']) {
      const val = (item as Record<string, unknown>)[prop]
      if (!val) continue
      for (const c of (Array.isArray(val) ? val : [val])) {
        if (!c || typeof c !== 'object' || Array.isArray(c)) continue
        const entry = c as StructuredDataEntry
        const rawType = entry['@type']
        const entryTypes = Array.isArray(rawType) ? rawType : [rawType]
        if (entryTypes.some((t) => typeof t === 'string' && t === 'Person')) {
          persons.push(entry)
        }
      }
    }
  }
  const credentialedPersons = persons.filter((person) =>
    person.jobTitle || person.alumniOf || person.hasCredential,
  )

  if (credentialedPersons.length > 0) {
    score += 25
    findings.push({ type: 'found', code: 'eeat-signals.author.credentialed', message: 'Person schema with credentials detected.' })
  } else if (persons.length > 0) {
    score += 12
    findings.push({ type: 'info', code: 'eeat-signals.author.no-credentials', message: 'Person schema found but lacks credential properties.' })
    recommendations.push('Add jobTitle, alumniOf, or hasCredential to Person schema.')
  } else {
    findings.push({ type: 'missing', code: 'eeat-signals.author.missing', message: 'No Person schema found.' })
    recommendations.push('Add Person schema with expertise signals for key team members.')
  }

  // Meta author tag
  const authorMeta = context.$('meta[name="author"]').attr('content')
  if (authorMeta && authorMeta.trim()) {
    score += 15
    findings.push({ type: 'found', code: 'eeat-signals.author-meta.found', message: `Author meta tag found: "${authorMeta.trim()}".` })
  } else {
    findings.push({ type: 'missing', code: 'eeat-signals.author-meta.missing', message: 'No <meta name="author"> tag detected.' })
    recommendations.push('Add a meta author tag to identify content authorship.')
  }

  // Review / AggregateRating schema
  const schemaTypes = extractSchemaTypes(context.structuredData)
  if (schemaTypes.has('Review') || schemaTypes.has('AggregateRating')) {
    score += 20
    findings.push({ type: 'found', code: 'eeat-signals.review.found', message: 'Review or AggregateRating schema detected.' })
  } else {
    findings.push({ type: 'info', code: 'eeat-signals.review.missing', message: 'No Review or AggregateRating schema found.' })
    recommendations.push('Add Review or AggregateRating schema if customer reviews exist.')
  }

  // Trust page links (privacy, terms, about)
  const trustPaths = ['/privacy', '/terms', '/about']
  let trustLinkCount = 0

  context.$('a[href]').each((_, element) => {
    const href = (context.$(element).attr('href') || '').toLowerCase()
    for (const path of trustPaths) {
      if (href.includes(path)) {
        trustLinkCount += 1
        break
      }
    }
  })

  if (trustLinkCount >= 2) {
    score += 15
    findings.push({ type: 'found', code: 'eeat-signals.trust-links.strong', message: 'Trust page links detected (privacy, terms, about).' })
  } else if (trustLinkCount === 1) {
    score += 8
    findings.push({ type: 'info', code: 'eeat-signals.trust-links.partial', message: 'Some trust page links detected.' })
    recommendations.push('Add links to privacy policy, terms of service, and about page.')
  } else {
    findings.push({ type: 'missing', code: 'eeat-signals.trust-links.missing', message: 'No trust page links detected.' })
    recommendations.push('Add footer links to privacy, terms, and about pages.')
  }

  // Organization schema with founder or employee.
  // Only consider top-level entity declarations — not orgs nested as publisher,
  // brand, memberOf, etc. inside other schemas — since those are references rather
  // than the primary entity the page represents.
  const orgs = [
    ...findTopLevelSchemaByType(context.structuredData, 'Organization'),
    ...findTopLevelSchemaByType(context.structuredData, 'LocalBusiness'),
    ...findTopLevelSchemaByType(context.structuredData, 'ProfessionalService'),
  ]

  const orgWithPeople = orgs.filter((org) => org.founder || org.employee || org.member)

  if (orgWithPeople.length > 0) {
    score += 25
    findings.push({ type: 'found', code: 'eeat-signals.organization.with-people', message: 'Organization schema includes founder/employee signals.' })
  } else if (orgs.length > 0) {
    score += 10
    findings.push({ type: 'info', code: 'eeat-signals.organization.no-people', message: 'Organization schema found but lacks people associations.' })
    recommendations.push('Add founder or employee properties to Organization schema.')
  } else {
    findings.push({ type: 'missing', code: 'eeat-signals.organization.missing', message: 'No Organization schema detected.' })
  }

  return {
    score: clampScore(score),
    findings,
    recommendations,
  }
}

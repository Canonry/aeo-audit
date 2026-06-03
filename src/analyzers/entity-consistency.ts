import {
  clampScore,
  collectEmails,
  collectPhones,
  getStructuredDataNames,
  normalizeEntityName,
  normalizeText,
} from './helpers.js'
import type { AnalysisResult, AuditContext, StructuredDataEntry } from '../types.js'

function extractSchemaContacts(structuredData: StructuredDataEntry[]): { emails: string[]; phones: string[] } {
  const emails: string[] = []
  const phones: string[] = []

  for (const item of structuredData) {
    if (typeof item?.email === 'string') {
      emails.push(item.email)
    }

    if (typeof item?.telephone === 'string') {
      phones.push(item.telephone)
    }

    const contactPoint = item?.contactPoint
    const points = Array.isArray(contactPoint) ? contactPoint : contactPoint ? [contactPoint] : []
    for (const point of points) {
      if (typeof point?.email === 'string') {
        emails.push(point.email)
      }

      if (typeof point?.telephone === 'string') {
        phones.push(point.telephone)
      }
    }
  }

  return { emails, phones }
}

export function analyzeEntityConsistency(context: AuditContext): AnalysisResult {
  const findings: AnalysisResult['findings'] = []
  const recommendations: string[] = []
  let score = 0

  const schemaNames = getStructuredDataNames(context.structuredData)
  const pageTitle = normalizeText(context.pageTitle)
  const ogTitle = normalizeText(context.$('meta[property="og:title"]').attr('content') || '')

  const normalizedCandidates = [
    ...schemaNames.slice(0, 2),
    pageTitle.split(/[|\-–—]/)[0],
    ogTitle.split(/[|\-–—]/)[0],
  ]
    .map((candidate) => normalizeEntityName(candidate))
    .filter(Boolean)

  const uniqueCandidates = [...new Set(normalizedCandidates)]

  if (!uniqueCandidates.length) {
    findings.push({ type: 'missing', code: 'entity-consistency.name.missing', message: 'Could not determine a consistent business entity name.' })
    recommendations.push('Expose business name consistently in title tags and JSON-LD.')
  } else if (uniqueCandidates.length === 1) {
    score += 40
    findings.push({ type: 'found', code: 'entity-consistency.name.single', message: 'Business naming looks consistent across key metadata.' })
  } else if (uniqueCandidates.length === 2) {
    score += 24
    findings.push({ type: 'info', code: 'entity-consistency.name.moderate', message: 'Minor business name inconsistencies found across metadata.' })
    recommendations.push('Align title, og:title, and schema name fields to the same canonical brand name.')
  } else {
    score += 12
    findings.push({ type: 'missing', code: 'entity-consistency.name.multiple', message: 'Business naming appears inconsistent across sources.' })
    recommendations.push('Standardize brand/entity naming in HTML metadata and JSON-LD.')
  }

  // Title length check — titles over 70 characters get truncated in search and AI citations
  const rawTitle = (context.pageTitle || '').trim()
  if (rawTitle.length > 0 && rawTitle.length <= 70) {
    score += 10
    findings.push({ type: 'found', code: 'entity-consistency.title.ok', message: `Page title is ${rawTitle.length} characters (within 70-char limit).` })
  } else if (rawTitle.length > 70) {
    findings.push({ type: 'info', code: 'entity-consistency.title.long', message: `Page title is ${rawTitle.length} characters (exceeds 70-char limit).` })
    recommendations.push('Shorten the page title to 70 characters or fewer to avoid truncation in AI citations.')
  }

  const canonicalHref = context.$('link[rel="canonical"]').attr('href')
  if (canonicalHref) {
    score += 20
    findings.push({ type: 'found', code: 'entity-consistency.canonical.present', message: 'Canonical URL tag is present.' })
  } else {
    findings.push({ type: 'missing', code: 'entity-consistency.canonical.missing', message: 'Canonical URL tag is missing.' })
    recommendations.push('Add a canonical link tag to declare the primary page URL.')
  }

  const schemaContacts = extractSchemaContacts(context.structuredData)
  const pageEmails = collectEmails(context.textContent)
  const pagePhones = collectPhones(context.textContent)

  const emailOverlap = schemaContacts.emails.length
    ? schemaContacts.emails.some((email) => pageEmails.some((candidate) => candidate.toLowerCase() === email.toLowerCase()))
    : false

  const phoneOverlap = schemaContacts.phones.length
    ? schemaContacts.phones.some((phone) => pagePhones.some((candidate) => normalizeText(candidate) === normalizeText(phone)))
    : false

  if (emailOverlap || phoneOverlap) {
    score += 40
    findings.push({ type: 'found', code: 'entity-consistency.contact.ok', message: 'Contact information appears consistent between schema and page content.' })
  } else if (schemaContacts.emails.length || schemaContacts.phones.length) {
    score += 16
    findings.push({ type: 'info', code: 'entity-consistency.contact.partial', message: 'Schema contact details were found but consistency is unclear in visible content.' })
    recommendations.push('Mirror key contact details in visible content and JSON-LD.')
  } else {
    findings.push({ type: 'missing', code: 'entity-consistency.contact.missing', message: 'No reliable contact details found in structured data.' })
    recommendations.push('Add email/telephone contact fields in LocalBusiness schema.')
  }

  return {
    score: clampScore(score),
    findings,
    recommendations,
  }
}

import { load, type CheerioAPI } from 'cheerio'
import type { AuditContext, StructuredDataEntry } from '../types.js'

export function clampScore(score: number): number {
  if (!Number.isFinite(score)) {
    return 0
  }

  return Math.max(0, Math.min(100, Math.round(score)))
}

export function normalizeText(value = ''): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeEntityName(value = ''): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/["'`]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(llc|inc|corp|co|ltd|agency|company)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function countWords(value = ''): number {
  if (!value) {
    return 0
  }

  return value
    .split(/\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .length
}

export function parseJsonLdScripts($: CheerioAPI): StructuredDataEntry[] {
  const scripts = $('script[type="application/ld+json"]')
  const items: StructuredDataEntry[] = []

  scripts.each((_, element) => {
    const raw = $(element).html()
    if (!raw || !raw.trim()) {
      return
    }

    try {
      const parsed: unknown = JSON.parse(raw)
      flattenStructuredData(parsed, items)
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  })

  return items
}

export interface JsonLdBlockInfo {
  index: number
  isEmpty: boolean
  parseError?: string
  parsed?: unknown
  topLevelTypes: string[]
}

export interface JsonLdExtraction {
  totalBlocks: number
  blocks: JsonLdBlockInfo[]
}

export function extractJsonLdBlocks($: CheerioAPI): JsonLdExtraction {
  const scripts = $('script[type="application/ld+json"]')
  const blocks: JsonLdBlockInfo[] = []

  scripts.each((index, element) => {
    const raw = $(element).html() ?? ''

    if (!raw.trim()) {
      blocks.push({ index, isEmpty: true, topLevelTypes: [] })
      return
    }

    try {
      const parsed: unknown = JSON.parse(raw)
      blocks.push({
        index,
        isEmpty: false,
        parsed,
        topLevelTypes: collectTopLevelTypes(parsed),
      })
    } catch (error) {
      blocks.push({
        index,
        isEmpty: false,
        parseError: error instanceof Error ? error.message : String(error),
        topLevelTypes: [],
      })
    }
  })

  return { totalBlocks: blocks.length, blocks }
}

function collectTopLevelTypes(value: unknown): string[] {
  const types: string[] = []
  walkRoots(value, (record) => {
    const rawType = record['@type']
    if (typeof rawType === 'string' && rawType.trim()) {
      types.push(rawType.trim())
    } else if (Array.isArray(rawType)) {
      for (const candidate of rawType) {
        if (typeof candidate === 'string' && candidate.trim()) {
          types.push(candidate.trim())
        }
      }
    }
  })
  return types
}

function walkRoots(value: unknown, visit: (record: Record<string, unknown>) => void): void {
  if (!value) return

  if (Array.isArray(value)) {
    for (const item of value) {
      walkRoots(item, visit)
    }
    return
  }

  if (typeof value !== 'object') return

  const record = value as Record<string, unknown>
  const graph = record['@graph']
  if (graph) {
    walkRoots(graph, visit)
    return
  }

  visit(record)
}

function flattenStructuredData(candidate: unknown, accumulator: StructuredDataEntry[]): void {
  if (!candidate) {
    return
  }

  if (Array.isArray(candidate)) {
    for (const item of candidate) {
      flattenStructuredData(item, accumulator)
    }

    return
  }

  if (typeof candidate !== 'object') {
    return
  }

  const structuredCandidate = candidate as StructuredDataEntry

  if (structuredCandidate['@graph']) {
    flattenStructuredData(structuredCandidate['@graph'], accumulator)
  }

  accumulator.push(structuredCandidate)
}

export function getVisibleText(_$: CheerioAPI, html: string): string {
  const cloned = load(html)
  cloned('script, style, noscript').remove()

  return normalizeText(cloned('body').text())
}

export function extractSchemaTypes(structuredData: StructuredDataEntry[]): Set<string> {
  const types = new Set<string>()

  for (const item of structuredData) {
    collectNestedTypes(item, types)
  }

  return types
}

function collectNestedTypes(obj: unknown, types: Set<string>, seen = new WeakSet<object>()): void {
  if (!obj || typeof obj !== 'object') {
    return
  }

  if (seen.has(obj as object)) {
    return
  }
  seen.add(obj as object)

  if (Array.isArray(obj)) {
    for (const item of obj) {
      collectNestedTypes(item, types, seen)
    }
    return
  }

  const record = obj as Record<string, unknown>
  const rawType = record['@type']
  if (rawType) {
    const typeValues = Array.isArray(rawType) ? rawType : [rawType]
    for (const type of typeValues) {
      if (typeof type === 'string' && type.trim()) {
        types.add(type.trim())
      }
    }
  }

  for (const value of Object.values(record)) {
    if (value && typeof value === 'object') {
      collectNestedTypes(value, types, seen)
    }
  }
}

export function findTopLevelSchemaByType(structuredData: StructuredDataEntry[], typeName: string): StructuredDataEntry[] {
  return structuredData.filter((item) => {
    const rawType = item?.['@type']
    const types = Array.isArray(rawType) ? rawType : [rawType]
    return types.some((type) => typeof type === 'string' && type === typeName)
  })
}

export function findSchemaByType(structuredData: StructuredDataEntry[], typeName: string): StructuredDataEntry[] {
  const results: StructuredDataEntry[] = []

  for (const item of structuredData) {
    collectNestedByType(item, typeName, results, new WeakSet())
  }

  return results
}

function collectNestedByType(obj: unknown, typeName: string, results: StructuredDataEntry[], seen: WeakSet<object>): void {
  if (!obj || typeof obj !== 'object') {
    return
  }

  if (seen.has(obj as object)) {
    return
  }
  seen.add(obj as object)

  if (Array.isArray(obj)) {
    for (const item of obj) {
      collectNestedByType(item, typeName, results, seen)
    }
    return
  }

  const record = obj as StructuredDataEntry
  const rawType = record['@type']
  if (rawType) {
    const types = Array.isArray(rawType) ? rawType : [rawType]
    if (types.some((type) => typeof type === 'string' && type === typeName)) {
      results.push(record)
    }
  }

  for (const value of Object.values(record)) {
    if (value && typeof value === 'object') {
      collectNestedByType(value, typeName, results, seen)
    }
  }
}

export function getStructuredDataNames(structuredData: StructuredDataEntry[]): string[] {
  const names: string[] = []

  for (const item of structuredData) {
    if (typeof item?.name === 'string' && item.name.trim()) {
      names.push(item.name.trim())
    }
  }

  return names
}

export function getBusinessName(context: Pick<AuditContext, 'structuredData' | 'pageTitle'>): string {
  const schemaName = getStructuredDataNames(context.structuredData)[0]
  if (schemaName) {
    return schemaName
  }

  const title = normalizeText(context.pageTitle || '')
  if (!title) {
    return ''
  }

  return title.split(/[|\-–—]/)[0].trim()
}

export function collectEmails(value = ''): string[] {
  return value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []
}

export function collectPhones(value = ''): string[] {
  return value.match(/\+?\d[\d\s().-]{7,}\d/g) || []
}

export function parseIsoDate(raw: unknown): Date | null {
  if (!raw || typeof raw !== 'string') {
    return null
  }

  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }

  return parsed
}

export function domainFromUrl(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export type SiteCategory =
  | 'saas-devtools'
  | 'ecommerce'
  | 'local-business'
  | 'service-business'
  | 'blog-or-content'
  | 'real-estate'
  | 'unknown'

export interface SiteCategoryDetection {
  category: SiteCategory
  /** 0–1 confidence in the chosen category; under 0.4 we treat as unknown. */
  confidence: number
  /** Recommended JSON-LD types for this category, in priority order. */
  recommendedSchemas: string[]
  /**
   * Whether the evidence supports naming vertical-specific types at all. When
   * false, `recommendedSchemas` is deliberately generic and callers should ask
   * for the type matching the site's primary entity rather than guess one.
   */
  specific: boolean
  /** Concrete signals that drove the classification. */
  evidence: string[]
}

interface CategorySignalAccumulator {
  category: SiteCategory
  score: number
  evidence: string[]
}

const SAAS_DEVTOOLS_KEYWORDS = [
  'api', 'sdk', 'documentation', 'docs', 'github', 'npm install', 'pip install',
  'yarn add', 'pnpm add', 'cli', 'developers', 'integration', 'webhook',
  'open source', 'opensource', 'authentication', 'oauth', 'api key',
  'pricing', 'enterprise', 'self-host', 'self host', 'getting started',
]

const ECOMMERCE_KEYWORDS = [
  'add to cart', 'add to bag', 'shopping cart', 'checkout', 'shop now',
  'buy now', 'in stock', 'out of stock', 'free shipping', 'returns',
  'product details', 'sku', 'add to wishlist', 'view product',
]

// Deliberately not restaurant-only. The original list was almost entirely
// hospitality phrasing, so any premises-based business that isn't a restaurant
// scored near zero here and lost to whichever category had looser keywords.
const LOCAL_BUSINESS_KEYWORDS = [
  'opening hours', 'business hours', 'directions', 'visit us', 'our location',
  'find us', 'reservations', 'book a table', 'menu', 'walk-ins welcome',
  'serving the', 'in the heart of', 'get directions', 'our locations',
  'schedule a tour', 'book a tour', 'visit our', 'nearest location',
  'parking', 'neighborhood',
]

const REAL_ESTATE_KEYWORDS = [
  'floor plan', 'floorplan', 'square feet', 'sq ft', 'bedroom', 'bathroom',
  'apartments', 'for rent', 'for lease', 'lease now', 'available units',
  'amenities', 'residents', 'resident portal', 'schedule a tour', 'pet policy',
  'move-in', 'per month', 'studio', 'listing', 'property', 'realtor', 'mls',
]

const SERVICE_BUSINESS_KEYWORDS = [
  'book a call', 'book a consultation', 'get a quote', 'request a quote',
  'free consultation', 'our services', 'case studies', 'client',
  'testimonials', 'schedule a meeting', 'hire us',
]

const BLOG_KEYWORDS = [
  'recent posts', 'latest articles', 'read more', 'by author', 'published on',
  'subscribe to newsletter', 'archives', 'categories', 'tags', 'comments',
]

function countKeywordHits(text: string, keywords: string[]): { count: number; matched: string[] } {
  const lower = text.toLowerCase()
  const matched: string[] = []
  let count = 0
  for (const keyword of keywords) {
    if (lower.includes(keyword)) {
      count += 1
      matched.push(keyword)
      if (matched.length >= 3) break
    }
  }
  return { count, matched }
}

/**
 * Issue #33: detect the site's category so schema recommendations match the
 * business (SaaS/dev tools shouldn't be told to add LocalBusiness schema).
 *
 * Uses three signal layers, ranked by reliability:
 *   1. Existing JSON-LD types on the page — strongest signal.
 *   2. Page text keywords — moderate signal.
 *   3. Outbound/script URLs (GitHub, npm, package registries) — supporting signal.
 *
 * Returns 'unknown' when no category clears a low confidence bar so we fall back
 * to the safe-default recommendations (Organization + something explanatory).
 */
export function detectSiteCategory(
  context: Pick<AuditContext, 'structuredData' | 'textContent' | 'html'>,
): SiteCategoryDetection {
  const schemaTypes = extractSchemaTypes(context.structuredData || [])
  const text = context.textContent || ''
  const html = context.html || ''

  const accumulators: CategorySignalAccumulator[] = [
    { category: 'saas-devtools', score: 0, evidence: [] },
    { category: 'ecommerce', score: 0, evidence: [] },
    { category: 'local-business', score: 0, evidence: [] },
    { category: 'service-business', score: 0, evidence: [] },
    { category: 'blog-or-content', score: 0, evidence: [] },
    { category: 'real-estate', score: 0, evidence: [] },
  ]

  const saas = accumulators[0]
  const ecom = accumulators[1]
  const local = accumulators[2]
  const service = accumulators[3]
  const blog = accumulators[4]
  const realEstate = accumulators[5]

  // Schema-level signals (highest confidence — the site told us what it is).
  if (schemaTypes.has('SoftwareApplication') || schemaTypes.has('WebApplication') || schemaTypes.has('MobileApplication')) {
    saas.score += 4
    saas.evidence.push('SoftwareApplication schema present')
  }
  if (schemaTypes.has('Product') || schemaTypes.has('Offer') || schemaTypes.has('AggregateOffer')) {
    ecom.score += 4
    ecom.evidence.push('Product/Offer schema present')
  }
  // Not PostalAddress: extractSchemaTypes flattens nested nodes, and an address
  // sits inside almost every schema graph (Organization, ApartmentComplex,
  // Residence). Counting it as a local-business signal handed apartment operators
  // a spurious +4 that tied the real-estate score their ApartmentComplex node had
  // just earned, collapsing the pick to `unknown`. The distinguishing types stay.
  if (schemaTypes.has('LocalBusiness') || schemaTypes.has('Restaurant') || schemaTypes.has('Store')) {
    local.score += 4
    local.evidence.push('LocalBusiness schema present')
  }
  if (schemaTypes.has('Service') || schemaTypes.has('ProfessionalService')) {
    service.score += 2
    service.evidence.push('Service schema present')
  }
  if (schemaTypes.has('Article') || schemaTypes.has('BlogPosting') || schemaTypes.has('NewsArticle')) {
    blog.score += 4
    blog.evidence.push('Article/BlogPosting schema present')
  }
  if (
    schemaTypes.has('ApartmentComplex') || schemaTypes.has('Apartment') || schemaTypes.has('Residence') ||
    schemaTypes.has('SingleFamilyResidence') || schemaTypes.has('RealEstateListing') || schemaTypes.has('Accommodation')
  ) {
    realEstate.score += 4
    realEstate.evidence.push('ApartmentComplex/Residence schema present')
  }

  // Text keyword signals.
  const saasHits = countKeywordHits(text, SAAS_DEVTOOLS_KEYWORDS)
  if (saasHits.count > 0) {
    saas.score += saasHits.count
    saas.evidence.push(`SaaS/dev keywords: ${saasHits.matched.join(', ')}`)
  }
  const ecomHits = countKeywordHits(text, ECOMMERCE_KEYWORDS)
  if (ecomHits.count > 0) {
    ecom.score += ecomHits.count * 1.5 // e-commerce phrases are very specific
    ecom.evidence.push(`E-commerce keywords: ${ecomHits.matched.join(', ')}`)
  }
  const localHits = countKeywordHits(text, LOCAL_BUSINESS_KEYWORDS)
  if (localHits.count > 0) {
    local.score += localHits.count * 1.5
    local.evidence.push(`Local-business keywords: ${localHits.matched.join(', ')}`)
  }
  const serviceHits = countKeywordHits(text, SERVICE_BUSINESS_KEYWORDS)
  if (serviceHits.count > 0) {
    service.score += serviceHits.count
    service.evidence.push(`Service keywords: ${serviceHits.matched.join(', ')}`)
  }
  const blogHits = countKeywordHits(text, BLOG_KEYWORDS)
  if (blogHits.count > 0) {
    blog.score += blogHits.count * 0.75 // blog phrases overlap with many sites
    blog.evidence.push(`Blog/content keywords: ${blogHits.matched.join(', ')}`)
  }
  const realEstateHits = countKeywordHits(text, REAL_ESTATE_KEYWORDS)
  if (realEstateHits.count > 0) {
    realEstate.score += realEstateHits.count * 1.5 // property phrasing is specific
    realEstate.evidence.push(`Real-estate keywords: ${realEstateHits.matched.join(', ')}`)
  }

  // A GitHub link corroborates a SaaS/dev-tools read; it does not establish one.
  // Plenty of non-software companies link a repo somewhere, and on its own this
  // was enough to tip a close race — so it only counts once the page text has
  // already said something developer-shaped.
  if (saasHits.count > 0 && /github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/i.test(html)) {
    saas.score += 1
    saas.evidence.push('GitHub repo link in HTML')
  }

  // A jsdelivr/unpkg/cdnjs reference used to add a point here. That is a fact
  // about how the page loads its assets, true of most of the modern web, and it
  // was free evidence for "this is a developer tool" on sites that are nothing of
  // the kind — an apartment operator on a CDN picked up the same point a real
  // SDK vendor did. Removed rather than reweighted: it carries no signal at all.

  // Pick the strongest signal and decide whether to commit.
  accumulators.sort((a, b) => b.score - a.score)
  const top = accumulators[0]
  const next = accumulators[1]

  const MIN_SCORE = 2 // need at least one strong schema signal or two keyword matches
  const MARGIN = 1 // top must beat runner-up by at least one point

  if (top.score < MIN_SCORE || top.score - next.score < MARGIN) {
    return {
      category: 'unknown',
      confidence: 0,
      recommendedSchemas: ['Organization'],
      specific: false,
      evidence: [],
    }
  }

  const totalScore = accumulators.reduce((sum, a) => sum + a.score, 0)
  const confidence = totalScore > 0 ? Math.min(1, top.score / Math.max(totalScore, 1)) : 0

  // Naming a type is a much stronger claim than picking a category, and it is the
  // one a developer implements literally: telling an apartment operator to add
  // SoftwareApplication produces exactly that markup on 194 property pages. So a
  // named type needs a clear win, not just a win.
  //
  // The test is margin, not absolute score. Absolute score can't carry
  // confidence here — `countKeywordHits` stops at 3 matches and each category
  // multiplies differently, so an unmistakable blog tops out at 2.25 while an
  // unmistakable local business reaches 4.5. What separates a safe call from a
  // coin flip is whether anything else came close.
  const STRONG_MARGIN = 2
  const specific = top.score - next.score >= STRONG_MARGIN

  return {
    category: top.category,
    confidence,
    recommendedSchemas: specific ? recommendedSchemasFor(top.category) : ['Organization'],
    specific,
    evidence: top.evidence,
  }
}

function formatSchemaList(schemas: string[]): string {
  if (schemas.length === 0) return 'Organization'
  if (schemas.length === 1) return schemas[0] as string
  if (schemas.length === 2) return `${schemas[0]} and ${schemas[1]}`
  return `${schemas.slice(0, -1).join(', ')}, and ${schemas[schemas.length - 1]}`
}

/**
 * Phrase a schema recommendation at the confidence the detection actually has.
 *
 * A named type is what gets implemented, verbatim and site-wide. When the
 * evidence doesn't support naming one, say what to look for instead of guessing
 * — a wrong guess here is worse than no guess, because it reads as instruction.
 *
 * Includes the word "schema" so both forms stay grammatical: the generic phrase
 * ends in a noun phrase of its own and can't take a trailing "schema" after it.
 */
export function describeRecommendedSchemas(detection: SiteCategoryDetection): string {
  if (detection.specific) return `${formatSchemaList(detection.recommendedSchemas)} schema`
  return 'Organization schema, plus the schema.org type that matches your primary entity'
}

function recommendedSchemasFor(category: SiteCategory): string[] {
  switch (category) {
    case 'saas-devtools':
      return ['Organization', 'SoftwareApplication', 'FAQPage']
    case 'ecommerce':
      return ['Organization', 'Product', 'AggregateRating']
    case 'local-business':
      return ['LocalBusiness', 'Service', 'FAQPage']
    case 'service-business':
      return ['Organization', 'Service', 'FAQPage']
    case 'blog-or-content':
      return ['Organization', 'Article', 'BreadcrumbList']
    case 'real-estate':
      return ['Organization', 'ApartmentComplex', 'FAQPage']
    case 'unknown':
    default:
      // Organization is the safest broad default; suggest Article and FAQPage
      // as common follow-ups regardless of business type.
      return ['Organization', 'Article', 'FAQPage']
  }
}

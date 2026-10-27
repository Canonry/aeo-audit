import { clampScore, describeRecommendedSchemas, detectSiteCategory, findSchemaByType } from './helpers.js'
import type { AnalysisResult, AuditContext, StructuredDataEntry } from '../types.js'

interface BestSchemaMatch {
  score: number
  item: StructuredDataEntry | null
}

function propertyCompleteness(item: StructuredDataEntry | null, requiredProps: string[]): number {
  if (!item) {
    return 0
  }

  let present = 0
  for (const prop of requiredProps) {
    const value = item[prop]
    if (value !== undefined && value !== null && value !== '') {
      present += 1
    }
  }

  return present / requiredProps.length
}

const LOCAL_BUSINESS_PROPS = [
  'name', 'address', 'telephone', 'openingHours',
  'priceRange', 'image', 'url', 'geo',
]

const ORGANIZATION_PROPS = [
  'name', 'logo', 'contactPoint', 'sameAs',
  'foundingDate', 'url', 'description',
]

const FAQ_MIN_PAIRS = 3
const HOWTO_MIN_STEPS = 3

/** Whether a JSON-LD node lists `typeName` in its `@type`. */
function hasSchemaType(node: unknown, typeName: string): boolean {
  if (!node || typeof node !== 'object') {
    return false
  }

  const rawType = (node as StructuredDataEntry)['@type']
  return Array.isArray(rawType) ? rawType.includes(typeName) : rawType === typeName
}

/** A reference names a node without describing it: it holds only `@id`, and perhaps `@type`. */
function isNodeReference(node: StructuredDataEntry): boolean {
  return Object.keys(node).every((key) => key === '@id' || key === '@type')
}

/**
 * Follows JSON-LD node references. A schema graph often names a node in one
 * place and defines it in another: Yoast, for one, writes an FAQ as
 * `"mainEntity": [{"@id": ".../#faq-question-1"}]` and puts each Question
 * elsewhere in the graph. The returned function maps such a reference to the
 * node it names, in any JSON-LD block on the page. Ids are compared after
 * resolving them against the page URL, as JSON-LD does, so "#q1" matches
 * "https://example.com/faq#q1". Blank node ids ("_:b0") are not followed: each
 * block scopes its own, and the parsed list no longer says which block a node
 * came from. Anything else comes back unchanged, as does a reference to a node
 * the page does not define. Non-objects come back as null.
 */
function createSchemaRefResolver(
  structuredData: StructuredDataEntry[],
  pageUrl: string,
): (value: unknown) => StructuredDataEntry | null {
  const resolveId = (id: string): string | null => {
    if (id.startsWith('_:')) {
      return null
    }

    try {
      return new URL(id, pageUrl).href
    } catch {
      return id
    }
  }

  const nodesById = new Map<string, StructuredDataEntry>()
  const seen = new WeakSet<object>()
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || seen.has(value)) {
      return
    }
    seen.add(value)

    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }

    const node = value as StructuredDataEntry
    const id = node['@id']
    const key = typeof id === 'string' && !isNodeReference(node) ? resolveId(id) : null
    if (key !== null && !nodesById.has(key)) {
      nodesById.set(key, node)
    }
    Object.values(node).forEach(visit)
  }
  visit(structuredData)

  return (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null
    }

    const node = value as StructuredDataEntry
    const id = node['@id']
    const key = typeof id === 'string' && isNodeReference(node) ? resolveId(id) : null
    return (key !== null && nodesById.get(key)) || node
  }
}

export function analyzeSchemaCompleteness(context: AuditContext): AnalysisResult {
  const findings: AnalysisResult['findings'] = []
  const recommendations: string[] = []
  let score = 0

  const structuredData = context.structuredData || []
  const detection = detectSiteCategory(context)

  if (!structuredData.length) {
    findings.push({ type: 'missing', code: 'schema-completeness.schema.none', message: 'No structured data found to evaluate completeness.' })
    // Issue #33: tailor the missing-schema recommendation to the detected
    // category so the suggestion is actually applicable.
    recommendations.push(
      `Add JSON-LD with ${describeRecommendedSchemas(detection)}, and complete property coverage.`,
    )
    return { score: clampScore(score), findings, recommendations }
  }

  let checksRun = 0
  let checksScore = 0
  // Questions, answers and steps may be written inline or as `@id` references.
  const resolveRef = createSchemaRefResolver(structuredData, context.url)

  // LocalBusiness completeness
  const localBiz = [
    ...findSchemaByType(structuredData, 'LocalBusiness'),
    ...findSchemaByType(structuredData, 'ProfessionalService'),
  ]

  if (localBiz.length > 0) {
    checksRun += 1
    const best = localBiz.reduce<BestSchemaMatch>((max, item) => {
      const comp = propertyCompleteness(item, LOCAL_BUSINESS_PROPS)
      return comp > max.score ? { score: comp, item } : max
    }, { score: 0, item: null })

    const pct = best.score
    if (pct >= 0.75) {
      checksScore += 100
      findings.push({ type: 'found', code: 'schema-completeness.local-business.strong', message: `LocalBusiness schema is ${Math.round(pct * 100)}% complete.` })
    } else if (pct >= 0.5) {
      checksScore += 60
      const missing = LOCAL_BUSINESS_PROPS.filter((p) => !best.item?.[p])
      findings.push({ type: 'info', code: 'schema-completeness.local-business.partial', message: `LocalBusiness schema is ${Math.round(pct * 100)}% complete.` })
      recommendations.push(`Add missing LocalBusiness properties: ${missing.join(', ')}.`)
    } else {
      checksScore += 25
      findings.push({ type: 'missing', code: 'schema-completeness.local-business.low', message: `LocalBusiness schema is only ${Math.round(pct * 100)}% complete.` })
      recommendations.push('Expand LocalBusiness schema with address, telephone, openingHours, geo, etc.')
    }
  }

  // FAQPage completeness
  const faqPages = findSchemaByType(structuredData, 'FAQPage')
  if (faqPages.length > 0) {
    checksRun += 1

    for (const faq of faqPages) {
      const mainEntity = (Array.isArray(faq.mainEntity) ? faq.mainEntity : faq.mainEntity ? [faq.mainEntity] : []) as StructuredDataEntry[]
      const questions = mainEntity
        .map(resolveRef)
        .filter((question): question is StructuredDataEntry => hasSchemaType(question, 'Question'))

      if (questions.length >= FAQ_MIN_PAIRS) {
        // Check answer quality
        const substantiveAnswers = questions.filter((question) => {
          const acceptedAnswer = resolveRef(question.acceptedAnswer)
          const answer = typeof acceptedAnswer?.text === 'string' ? acceptedAnswer.text : ''
          return answer.split(/\s+/).length >= 15
        })

        if (substantiveAnswers.length >= FAQ_MIN_PAIRS) {
          checksScore += 100
          findings.push({ type: 'found', code: 'schema-completeness.faqpage.strong', message: `FAQPage has ${questions.length} Q&A pairs with substantive answers.` })
        } else {
          checksScore += 65
          findings.push({ type: 'info', code: 'schema-completeness.faqpage.partial', message: `FAQPage has ${questions.length} questions but some answers are thin.` })
          recommendations.push('Expand FAQ answers to at least 15 words each for citation readiness.')
        }
      } else {
        checksScore += 35
        findings.push({ type: 'info', code: 'schema-completeness.faqpage.low', message: `FAQPage has only ${questions.length} Q&A pair(s) (recommend >= ${FAQ_MIN_PAIRS}).` })
        recommendations.push(`Add at least ${FAQ_MIN_PAIRS} question-answer pairs to FAQPage schema.`)
      }
    }
  }

  // HowTo completeness
  const howTos = findSchemaByType(structuredData, 'HowTo')
  if (howTos.length > 0) {
    checksRun += 1

    for (const howTo of howTos) {
      const steps = (Array.isArray(howTo.step) ? howTo.step : howTo.step ? [howTo.step] : []) as StructuredDataEntry[]
      const stepsWithText = steps.map(resolveRef).filter((step) => step?.name || step?.text)

      if (stepsWithText.length >= HOWTO_MIN_STEPS) {
        checksScore += 100
        findings.push({ type: 'found', code: 'schema-completeness.howto.strong', message: `HowTo schema has ${stepsWithText.length} detailed steps.` })
      } else {
        checksScore += 40
        findings.push({ type: 'info', code: 'schema-completeness.howto.partial', message: `HowTo schema has only ${stepsWithText.length} step(s).` })
        recommendations.push(`Add at least ${HOWTO_MIN_STEPS} steps with descriptive text to HowTo schema.`)
      }
    }
  }

  // Organization completeness
  const orgs = findSchemaByType(structuredData, 'Organization')
  if (orgs.length > 0) {
    checksRun += 1
    const best = orgs.reduce<BestSchemaMatch>((max, item) => {
      const comp = propertyCompleteness(item, ORGANIZATION_PROPS)
      return comp > max.score ? { score: comp, item } : max
    }, { score: 0, item: null })

    const pct = best.score
    if (pct >= 0.7) {
      checksScore += 100
      findings.push({ type: 'found', code: 'schema-completeness.organization.strong', message: `Organization schema is ${Math.round(pct * 100)}% complete.` })
    } else if (pct >= 0.4) {
      checksScore += 55
      const missing = ORGANIZATION_PROPS.filter((p) => !best.item?.[p])
      findings.push({ type: 'info', code: 'schema-completeness.organization.partial', message: `Organization schema is ${Math.round(pct * 100)}% complete.` })
      recommendations.push(`Add missing Organization properties: ${missing.join(', ')}.`)
    } else {
      checksScore += 20
      findings.push({ type: 'missing', code: 'schema-completeness.organization.low', message: `Organization schema is only ${Math.round(pct * 100)}% complete.` })
    }
  }

  // If no schema types were checked, score based on generic property depth
  if (checksRun === 0) {
    const avgProps = structuredData.reduce((sum, item) => sum + Object.keys(item).length, 0) / structuredData.length
    if (avgProps >= 8) {
      score = 70
      findings.push({ type: 'info', code: 'schema-completeness.schema-depth.moderate', message: 'Structured data has reasonable depth but uses no recognized high-priority schema types.' })
    } else {
      score = 30
      findings.push({ type: 'info', code: 'schema-completeness.schema-depth.low', message: 'Structured data present but shallow and uses no recognized schema types.' })
    }

    // Issue #33: recommendation reflects the detected site category instead of
    // always suggesting LocalBusiness for any site.
    recommendations.push(
      `Add ${describeRecommendedSchemas(detection)}.`,
    )
  } else {
    score = checksScore / checksRun
  }

  return {
    score: clampScore(score),
    findings,
    recommendations,
  }
}

import { describe, expect, it } from 'vitest'
import { load } from 'cheerio'

import { analyzeSchemaCompleteness } from '../../src/analyzers/schema-completeness.js'
import { getVisibleText, parseJsonLdScripts } from '../../src/analyzers/helpers.js'
import type { AnalysisResult, AuditContext } from '../../src/types.js'

const PAGE_URL = 'https://example.com/faq'
const LONG_ANSWER = 'Yes. We ship to every state in the continental United States, usually within three business days of your order.'
const STRONG_FAQ = {
  type: 'found',
  code: 'schema-completeness.faqpage.strong',
  message: 'FAQPage has 3 Q&A pairs with substantive answers.',
}

function analyze(...jsonLdBlocks: unknown[]): AnalysisResult {
  const scripts = jsonLdBlocks
    .map((block) => `<script type="application/ld+json">${JSON.stringify(block)}</script>`)
    .join('')
  const html = `<!doctype html><html><head><title>FAQ</title>${scripts}</head><body></body></html>`
  const $ = load(html)
  const context: AuditContext = {
    $,
    html,
    url: PAGE_URL,
    headers: {},
    auxiliary: {},
    structuredData: parseJsonLdScripts($),
    textContent: getVisibleText($, html),
    pageTitle: 'FAQ',
  }
  return analyzeSchemaCompleteness(context)
}

function findingsFor(result: AnalysisResult, check: string): AnalysisResult['findings'] {
  return result.findings.filter((finding) => finding.code.startsWith(`schema-completeness.${check}.`))
}

function question(n: number, id = `${PAGE_URL}#q${n}`): Record<string, unknown> {
  return { '@type': 'Question', '@id': id, name: `Question ${n}?`, acceptedAnswer: { '@type': 'Answer', text: LONG_ANSWER } }
}

const ref = (id: string) => ({ '@id': id })

describe('FAQPage questions', () => {
  it('counts questions that mainEntity links by @id, as Yoast writes them', () => {
    const result = analyze({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': ['WebPage', 'FAQPage'], '@id': PAGE_URL, mainEntity: [ref(`${PAGE_URL}#q1`), ref(`${PAGE_URL}#q2`), ref(`${PAGE_URL}#q3`)] },
        question(1),
        question(2),
        question(3),
      ],
    })
    expect(findingsFor(result, 'faqpage')).toEqual([STRONG_FAQ])
  })

  it('follows relative ids into another JSON-LD block', () => {
    const result = analyze(
      { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [ref('#q1'), ref('#q2'), ref('#q3')] },
      { '@context': 'https://schema.org', '@graph': [question(1), question(2), question(3)] },
    )
    expect(findingsFor(result, 'faqpage')).toEqual([STRONG_FAQ])
  })

  it('follows acceptedAnswer references when judging answer length', () => {
    const questionWithLinkedAnswer = (n: number) => ({ ...question(n), acceptedAnswer: ref(`#a${n}`) })
    const answer = (n: number) => ({ '@type': 'Answer', '@id': `#a${n}`, text: LONG_ANSWER })
    const result = analyze({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'FAQPage', mainEntity: [1, 2, 3].map(questionWithLinkedAnswer) },
        answer(1),
        answer(2),
        answer(3),
      ],
    })
    expect(findingsFor(result, 'faqpage')).toEqual([STRONG_FAQ])
  })

  it('does not count a reference to a question the page never defines', () => {
    const result = analyze({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'FAQPage', mainEntity: [ref('#q1'), ref('#q2'), ref('#q-deleted')] },
        question(1, '#q1'),
        question(2, '#q2'),
      ],
    })
    expect(findingsFor(result, 'faqpage').map((finding) => finding.message)).toEqual([
      'FAQPage has only 2 Q&A pair(s) (recommend >= 3).',
    ])
  })

  it('does not join blank node ids across JSON-LD blocks', () => {
    const result = analyze(
      { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [ref('_:b0'), ref('_:b1'), ref('_:b2')] },
      { '@context': 'https://schema.org', '@graph': [question(1, '_:b0'), question(2, '_:b1'), question(3, '_:b2')] },
    )
    expect(findingsFor(result, 'faqpage').map((finding) => finding.message)).toEqual([
      'FAQPage has only 0 Q&A pair(s) (recommend >= 3).',
    ])
  })

  it('evaluates an FAQPage inside @graph once, so it is not counted twice in the score', () => {
    const result = analyze({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'FAQPage', mainEntity: [question(1), question(2), question(3)] },
        { '@type': 'Organization', name: 'Acme' },
      ],
    })
    expect(findingsFor(result, 'faqpage')).toEqual([STRONG_FAQ])
    // FAQPage 100 and a 1-of-7 Organization 20, averaged over the two checks.
    expect(result.score).toBe(60)
  })
})

describe('HowTo steps', () => {
  it('counts steps linked by @id', () => {
    const step = (n: number) => ({ '@type': 'HowToStep', '@id': `#step${n}`, text: `Do step ${n}.` })
    const result = analyze({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'HowTo', name: 'Set up', step: [ref('#step1'), ref('#step2'), ref('#step3')] },
        step(1),
        step(2),
        step(3),
      ],
    })
    expect(findingsFor(result, 'howto').map((finding) => finding.message)).toEqual(['HowTo schema has 3 detailed steps.'])
  })
})

describe('LocalBusiness subtypes', () => {
  // Synthetic business; 7 of the 8 LocalBusiness properties (no geo).
  const inn = {
    '@context': 'https://schema.org',
    '@type': 'Hotel',
    name: 'Juniper Cove Inn',
    address: { '@type': 'PostalAddress', streetAddress: '12 Harbor Road', addressLocality: 'Port Alder', addressRegion: 'ME', postalCode: '04001', addressCountry: 'US' },
    telephone: '+1-207-555-0142',
    openingHours: 'Mo-Su 00:00-23:59',
    priceRange: '$$',
    image: 'https://example.com/inn.jpg',
    url: 'https://example.com/',
  }
  const STRONG_LOCAL = {
    type: 'found',
    code: 'schema-completeness.local-business.strong',
    message: 'LocalBusiness schema is 88% complete.',
  }

  it('checks a Hotel as LocalBusiness rather than as unrecognized schema', () => {
    const result = analyze(inn)
    expect(findingsFor(result, 'local-business')).toEqual([STRONG_LOCAL])
    expect(findingsFor(result, 'schema-depth')).toEqual([])
    expect(result.score).toBe(100)
  })

  it.each<[string, unknown[]]>([
    ['in @graph', [{ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebSite', name: 'Juniper Cove Inn' }, inn] }]],
    ['with a schema.org type URL', [{ ...inn, '@type': 'https://schema.org/Resort' }]],
    ['as a page mainEntity', [{ '@type': 'WebPage', mainEntity: inn }]],
    ['as an @id reference to a node defined elsewhere', [
      { '@type': 'WebPage', mainEntity: { '@type': 'Hotel', '@id': 'https://example.com/#inn' } },
      { '@type': 'Organization', name: 'Harborlight Group', subOrganization: { ...inn, '@id': 'https://example.com/#inn' } },
    ]],
  ])('counts a subtype declared %s', (_where, blocks) => {
    expect(findingsFor(analyze(...blocks), 'local-business')).toEqual([STRONG_LOCAL])
  })

  it('lists the properties a partial Restaurant is missing', () => {
    const result = analyze({ '@type': 'Restaurant', name: 'Cantina Faro Rojo', address: '8 Wharf Lane, Port Alder', telephone: '+1-207-555-0199', url: 'https://example.com/' })
    expect(findingsFor(result, 'local-business')).toEqual([
      { type: 'info', code: 'schema-completeness.local-business.partial', message: 'LocalBusiness schema is 50% complete.' },
    ])
    expect(result.recommendations).toContain('Add missing LocalBusiness properties: openingHours, priceRange, image, geo.')
  })

  it.each<[string, unknown]>([
    ['an Offer seller', { '@type': 'Product', name: 'Trail Map', offers: { '@type': 'Offer', price: '5.00', seller: { '@type': 'Store', name: 'Harbor Outfitters' } } }],
    ['a reference the page never defines', { '@type': 'WebPage', mainEntity: { '@type': 'Hotel', '@id': 'https://example.com/#missing' } }],
  ])('does not check %s as the page business', (_what, block) => {
    expect(findingsFor(analyze(block), 'local-business')).toEqual([])
  })
})

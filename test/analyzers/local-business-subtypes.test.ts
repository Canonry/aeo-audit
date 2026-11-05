import { describe, expect, it } from 'vitest'
import { load } from 'cheerio'
import { getVisibleText, parseJsonLdScripts } from '../../src/analyzers/helpers.js'
import { analyzeEeatSignals } from '../../src/analyzers/eeat-signals.js'
import { analyzeGeographicSignals } from '../../src/analyzers/geographic-signals.js'
import { analyzeStructuredData } from '../../src/analyzers/structured-data.js'
import type { AnalysisResult, AuditContext } from '../../src/types.js'

// Every business and person here is made up.
function context(...blocks: unknown[]): AuditContext {
  const scripts = blocks.map((block) => `<script type="application/ld+json">${JSON.stringify(block)}</script>`).join('')
  const html = `<!doctype html><html><head><title>Juniper Cove Inn</title>${scripts}</head><body><h1>Juniper Cove Inn</h1></body></html>`
  const $ = load(html)
  return {
    $, html, url: 'https://example.com/', headers: {}, auxiliary: {},
    structuredData: parseJsonLdScripts($), textContent: getVisibleText($, html), pageTitle: 'Juniper Cove Inn',
  }
}

const codes = (result: AnalysisResult): string[] => result.findings.map((finding) => finding.code)

const inn = { '@context': 'https://schema.org', '@type': 'Hotel', name: 'Juniper Cove Inn', founder: { '@type': 'Person', name: 'Ada Marsh' } }
// A product page names its seller, a business that is not the page's own.
const product = {
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: 'Trail Map',
  offers: { '@type': 'Offer', price: '5.00', seller: { '@type': 'Store', name: 'Harbor Outfitters', founder: { '@type': 'Person', name: 'Ada Marsh' } } },
}

describe('LocalBusiness subtypes outside Schema Completeness', () => {
  it.each<[string, unknown]>([
    ['a top-level Hotel', inn],
    ['a Restaurant in @graph', { '@context': 'https://schema.org', '@graph': [{ '@type': 'WebSite', name: 'Cantina Faro Rojo' }, { '@type': 'Restaurant', name: 'Cantina Faro Rojo' }] }],
    ['a schema.org type URL', { '@context': 'https://schema.org', '@type': 'https://schema.org/Resort', name: 'Juniper Cove Inn' }],
    ['a page mainEntity', { '@context': 'https://schema.org', '@type': 'WebPage', mainEntity: inn }],
  ])('Structured Data counts %s as LocalBusiness', (_what, block) => {
    const { findings } = analyzeStructuredData(context(block))
    expect(findings).toContainEqual({ type: 'found', code: 'structured-data.schema.found', message: 'LocalBusiness schema detected.' })
    expect(findings).not.toContainEqual(expect.objectContaining({ message: 'LocalBusiness schema not found.' }))
  })

  it('E-E-A-T reads a Hotel as the page organization, with or without people', () => {
    expect(codes(analyzeEeatSignals(context(inn)))).toContain('eeat-signals.organization.with-people')
    const withoutPeople = { '@context': 'https://schema.org', '@type': 'WebPage', mainEntity: { '@type': 'Hotel', name: 'Juniper Cove Inn' } }
    expect(codes(analyzeEeatSignals(context(withoutPeople)))).toContain('eeat-signals.organization.no-people')
  })

  it('Geographic Signals counts a Hotel as LocalBusiness schema', () => {
    expect(codes(analyzeGeographicSignals(context(inn)))).toContain('geographic-signals.localbusiness-schema.found')
  })

  it('none of them count an Offer seller as the page business', () => {
    expect(analyzeStructuredData(context(product)).findings)
      .toContainEqual({ type: 'missing', code: 'structured-data.schema.missing', message: 'LocalBusiness schema not found.' })
    expect(codes(analyzeEeatSignals(context(product)))).toContain('eeat-signals.organization.missing')
    expect(codes(analyzeGeographicSignals(context(product)))).toContain('geographic-signals.localbusiness-schema.missing')
  })
})

import { describe, it, expect } from 'vitest'
import { load } from 'cheerio'

import { analyzeTechnicalSeo } from '../../src/analyzers/technical-seo.js'
import { getVisibleText, parseJsonLdScripts } from '../../src/analyzers/helpers.js'
import type { AuditContext, AuxiliaryResources } from '../../src/types.js'

function aux(): AuxiliaryResources {
  return {
    llmsTxt: { state: 'missing', body: '' },
    llmsFullTxt: { state: 'missing', body: '' },
    robotsTxt: { state: 'missing', body: '' },
    sitemapXml: { state: 'missing', body: '' },
  }
}

function buildContext(html: string): AuditContext {
  const $ = load(html)
  return {
    $,
    html,
    url: 'https://example.com/',
    headers: {},
    auxiliary: aux(),
    structuredData: parseJsonLdScripts($),
    textContent: getVisibleText($, html),
    pageTitle: $('title').first().text().trim(),
  }
}

function pageWithMetaDesc(desc: string): string {
  return `<!doctype html><html><head><title>T</title><meta name="description" content="${desc}"><link rel="canonical" href="https://example.com/"></head><body><h1>Topic</h1></body></html>`
}

describe('meta description scoring', () => {
  it('flags a missing meta description and recommends 150–160 characters', () => {
    const html = `<!doctype html><html><head><title>T</title><link rel="canonical" href="https://example.com/"></head><body><h1>Topic</h1></body></html>`
    const result = analyzeTechnicalSeo(buildContext(html))

    expect(result.findings.some((f) => f.type === 'missing' && f.message.includes('No meta description'))).toBe(true)
    expect(result.recommendations.some((r) => r.includes('150–160 characters'))).toBe(true)
  })

  it('flags a meta description under 120 chars as too short', () => {
    const desc = 'A'.repeat(100)
    const result = analyzeTechnicalSeo(buildContext(pageWithMetaDesc(desc)))

    const tooShort = result.findings.find((f) => f.message.includes('too short'))
    expect(tooShort).toBeDefined()
    expect(tooShort?.message).toContain('100 chars')
    expect(result.recommendations.some((r) => r.includes('Expand the meta description to 150–160 characters'))).toBe(true)
  })

  it('awards full meta-description credit in the 120–160 sweet spot', () => {
    const short = 'A'.repeat(119)
    const good = 'A'.repeat(150)

    const shortScore = analyzeTechnicalSeo(buildContext(pageWithMetaDesc(short))).score
    const goodScore = analyzeTechnicalSeo(buildContext(pageWithMetaDesc(good))).score

    expect(goodScore - shortScore).toBe(12)
  })

  it('flags a meta description over 160 chars as too long', () => {
    const desc = 'A'.repeat(200)
    const result = analyzeTechnicalSeo(buildContext(pageWithMetaDesc(desc)))

    expect(result.findings.some((f) => f.message.includes('long (200 chars)'))).toBe(true)
    expect(result.recommendations.some((r) => r.includes('Trim the meta description'))).toBe(true)
  })
})

describe('canonical validation', () => {
  it('does not credit ignored or invalid declarations as present', () => {
    for (const markup of [
      '<link rel="canonical" href="javascript:alert(1)">',
      '<link rel="canonical" href="/alternate" hreflang="en">',
      '<template><link rel="canonical" href="/template"></template>',
      '</head><body><link rel="canonical" href="/body">',
    ]) {
      const result = analyzeTechnicalSeo(buildContext(`<html><head>${markup}</head></html>`))
      expect(result.findings.some((finding) => finding.code === 'technical-seo.canonical.present')).toBe(false)
      expect(result.findings.some((finding) => finding.type === 'missing' && finding.code.startsWith('technical-seo.canonical.'))).toBe(true)
    }
  })

  it('shares broken target evidence with correctly namespaced findings', () => {
    const context = buildContext(pageWithMetaDesc('A'.repeat(150)))
    context.canonicalTargets = {
      'https://example.com/': { state: 'unreachable', url: 'https://example.com/', statusCode: 404, redirectChain: [] },
    }
    const result = analyzeTechnicalSeo(context)
    expect(result.findings.some((finding) => finding.code === 'technical-seo.canonical.unreachable' && finding.type === 'unreachable')).toBe(true)
    const unchecked = analyzeTechnicalSeo({ ...context, canonicalTargets: undefined })
    expect(unchecked.score - result.score).toBe(10)
  })
})

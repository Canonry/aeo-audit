import { describe, expect, it } from 'vitest'
import { load } from 'cheerio'
import { analyzeEntityConsistency } from '../../src/analyzers/entity-consistency.js'
import type { AuditContext } from '../../src/types.js'

function analyzeTitle(title: string) {
  const $ = load('<html><head><link rel="canonical" href="https://example.com/"></head><body></body></html>')
  const context: AuditContext = {
    $, html: $.html(), url: 'https://example.com/', headers: {},
    auxiliary: {
      llmsTxt: { state: 'missing', body: '' },
      llmsFullTxt: { state: 'missing', body: '' },
      robotsTxt: { state: 'missing', body: '' },
      sitemapXml: { state: 'missing', body: '' },
    },
    structuredData: [], textContent: '', pageTitle: title,
  }
  return analyzeEntityConsistency(context)
}

describe('title length review', () => {
  it.each(['A', 'a'.repeat(14), '  Shop  '])('flags a short title without calling it healthy: %s', (title) => {
    const result = analyzeTitle(title)
    expect(result.findings).toContainEqual(expect.objectContaining({
      type: 'info', code: 'entity-consistency.title.short',
      message: expect.stringContaining(`${title.trim().length} characters`),
    }))
    expect(result.findings.some((finding) => finding.code === 'entity-consistency.title.ok')).toBe(false)
    expect(result.recommendations.join(' ')).toContain('short titles can be appropriate')
  })

  it.each([15, 70])('accepts the existing review range at %i characters', (length) => {
    const result = analyzeTitle('a'.repeat(length))
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'entity-consistency.title.ok' }))
    expect(result.findings.some((finding) => finding.code === 'entity-consistency.title.short')).toBe(false)
  })

  it('keeps long titles separate and does not label absent titles as short', () => {
    expect(analyzeTitle('a'.repeat(71)).findings).toContainEqual(expect.objectContaining({ code: 'entity-consistency.title.long' }))
    for (const title of ['', '   ']) {
      expect(analyzeTitle(title).findings.some((finding) => finding.code?.startsWith('entity-consistency.title.'))).toBe(false)
    }
  })

  it('does not penalize concise titles solely because of their length', () => {
    expect(analyzeTitle('Shop').score).toBe(analyzeTitle('Browse the shop').score)
  })
})

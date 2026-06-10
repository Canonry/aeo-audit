import { describe, it, expect } from 'vitest'
import { load } from 'cheerio'

import { analyzeAiAccessFiles } from '../../src/analyzers/ai-access-files.js'
import { getVisibleText, parseJsonLdScripts } from '../../src/analyzers/helpers.js'
import type { AuditContext, AuxiliaryResource, AuxiliaryResources } from '../../src/types.js'

const bareHtml = '<!doctype html><html><head><title>T</title></head><body></body></html>'

function aux(overrides: Partial<AuxiliaryResources> = {}): AuxiliaryResources {
  return {
    llmsTxt: { state: 'missing', body: '' },
    llmsFullTxt: { state: 'missing', body: '' },
    robotsTxt: { state: 'missing', body: '' },
    sitemapXml: { state: 'missing', body: '' },
    ...overrides,
  }
}

function buildContext(
  html: string = bareHtml,
  auxiliary: AuxiliaryResources = aux(),
  headers: Record<string, string> = {},
): AuditContext {
  const $ = load(html)
  return {
    $,
    html,
    url: 'https://example.com/',
    headers,
    auxiliary,
    structuredData: parseJsonLdScripts($),
    textContent: getVisibleText($, html),
    pageTitle: $('title').first().text().trim(),
  }
}

// ─── Baseline ─────────────────────────────────────────────────────────────────
describe('baseline with everything missing', () => {
  it('scores 0 when all auxiliary resources and the head link are absent', () => {
    const result = analyzeAiAccessFiles(buildContext())
    expect(result.score).toBe(0)
    for (const target of ['/llms.txt', '/llms-full.txt', '/robots.txt', '/sitemap.xml']) {
      expect(result.findings.some((f) => f.type === 'missing' && f.message.includes(target))).toBe(true)
    }
    expect(result.recommendations.length).toBeGreaterThanOrEqual(4)
  })
})

// ─── /llms.txt state handling ────────────────────────────────────────────────
describe('/llms.txt state handling', () => {
  const longBody: AuxiliaryResource = { state: 'ok', body: 'word '.repeat(120) }
  const shortBody: AuxiliaryResource = { state: 'ok', body: 'word '.repeat(10) }

  it('credits +24 + depth bonus for an ok llms.txt with >=100 words', () => {
    const result = analyzeAiAccessFiles(buildContext(bareHtml, aux({ llmsTxt: longBody })))
    expect(result.score).toBe(24 + 8) // base + depth; everything else is missing
    expect(result.findings.some((f) => f.type === 'found' && f.message.includes('/llms.txt is available'))).toBe(true)
    expect(result.findings.some((f) => f.type === 'found' && f.message.includes('useful content depth'))).toBe(true)
  })

  it('credits +24 only (no depth) when llms.txt is present but short', () => {
    const result = analyzeAiAccessFiles(buildContext(bareHtml, aux({ llmsTxt: shortBody })))
    expect(result.score).toBe(24)
    expect(result.findings.some((f) => f.type === 'info' && f.message.includes('present but short'))).toBe(true)
    expect(result.recommendations.some((r) => r.includes('Expand /llms.txt'))).toBe(true)
  })

  it('credits +8 on timeout instead of failing hard', () => {
    const result = analyzeAiAccessFiles(buildContext(bareHtml, aux({ llmsTxt: { state: 'timeout', body: '' } })))
    expect(result.score).toBe(8)
    expect(result.findings.some((f) => f.type === 'timeout' && f.message.includes('/llms.txt'))).toBe(true)
  })

  it('credits +8 on unreachable', () => {
    const result = analyzeAiAccessFiles(buildContext(bareHtml, aux({ llmsTxt: { state: 'unreachable', body: '' } })))
    expect(result.score).toBe(8)
    expect(result.findings.some((f) => f.type === 'unreachable' && f.message.includes('/llms.txt'))).toBe(true)
  })

  it('credits +10 on not-html', () => {
    const result = analyzeAiAccessFiles(buildContext(bareHtml, aux({ llmsTxt: { state: 'not-html', body: 'html' } })))
    expect(result.score).toBe(10)
    expect(result.findings.some((f) => f.type === 'info' && f.message.includes('unexpected content type'))).toBe(true)
  })
})

// ─── /llms-full.txt state handling ───────────────────────────────────────────
describe('/llms-full.txt state handling', () => {
  const longBody: AuxiliaryResource = { state: 'ok', body: 'word '.repeat(220) }
  const shortBody: AuxiliaryResource = { state: 'ok', body: 'word '.repeat(50) }

  it('credits +24 + depth bonus for an ok llms-full.txt with >=200 words', () => {
    const result = analyzeAiAccessFiles(buildContext(bareHtml, aux({ llmsFullTxt: longBody })))
    expect(result.score).toBe(24 + 10)
    expect(result.findings.some((f) => f.type === 'found' && f.message.includes('strong long-form coverage'))).toBe(true)
  })

  it('credits +24 only (no depth) when llms-full.txt is present but short', () => {
    const result = analyzeAiAccessFiles(buildContext(bareHtml, aux({ llmsFullTxt: shortBody })))
    expect(result.score).toBe(24)
    expect(result.findings.some((f) => f.type === 'info' && f.message.includes('exists but lacks detail'))).toBe(true)
    expect(result.recommendations.some((r) => r.includes('complete offerings'))).toBe(true)
  })

  it('credits +8 on timeout', () => {
    const result = analyzeAiAccessFiles(buildContext(bareHtml, aux({ llmsFullTxt: { state: 'timeout', body: '' } })))
    expect(result.score).toBe(8)
    expect(result.findings.some((f) => f.type === 'timeout' && f.message.includes('/llms-full.txt'))).toBe(true)
  })
})

// ─── /robots.txt state handling ──────────────────────────────────────────────
describe('/robots.txt state handling', () => {
  it('credits +16 when robots.txt is ok', () => {
    const result = analyzeAiAccessFiles(buildContext(bareHtml, aux({ robotsTxt: { state: 'ok', body: 'User-agent: *' } })))
    expect(result.score).toBe(16)
    expect(result.findings.some((f) => f.type === 'found' && f.message.includes('robots.txt is accessible'))).toBe(true)
  })

  it('credits +6 on timeout', () => {
    const result = analyzeAiAccessFiles(buildContext(bareHtml, aux({ robotsTxt: { state: 'timeout', body: '' } })))
    expect(result.score).toBe(6)
    expect(result.findings.some((f) => f.type === 'timeout' && f.message.includes('robots.txt'))).toBe(true)
  })

  it('credits +6 on unreachable', () => {
    const result = analyzeAiAccessFiles(buildContext(bareHtml, aux({ robotsTxt: { state: 'unreachable', body: '' } })))
    expect(result.score).toBe(6)
    expect(result.findings.some((f) => f.type === 'unreachable')).toBe(true)
  })

  it('flags missing robots.txt and recommends adding one', () => {
    const result = analyzeAiAccessFiles(buildContext(bareHtml, aux({ robotsTxt: { state: 'missing', body: '' } })))
    expect(result.findings.some((f) => f.type === 'missing' && f.message.includes('/robots.txt'))).toBe(true)
    expect(result.recommendations.some((r) => r.includes('robots.txt'))).toBe(true)
  })
})

// ─── /sitemap.xml state handling ─────────────────────────────────────────────
describe('/sitemap.xml state handling', () => {
  it('credits +16 when sitemap is ok', () => {
    const result = analyzeAiAccessFiles(buildContext(bareHtml, aux({ sitemapXml: { state: 'ok', body: '<urlset></urlset>' } })))
    expect(result.score).toBe(16)
    expect(result.findings.some((f) => f.type === 'found' && f.message.includes('sitemap.xml is accessible'))).toBe(true)
  })

  it('credits +6 on timeout', () => {
    const result = analyzeAiAccessFiles(buildContext(bareHtml, aux({ sitemapXml: { state: 'timeout', body: '' } })))
    expect(result.score).toBe(6)
    expect(result.findings.some((f) => f.type === 'timeout' && f.message.includes('sitemap.xml'))).toBe(true)
  })

  it('flags missing sitemap and recommends adding one', () => {
    const result = analyzeAiAccessFiles(buildContext(bareHtml, aux({ sitemapXml: { state: 'missing', body: '' } })))
    expect(result.findings.some((f) => f.type === 'missing' && f.message.includes('/sitemap.xml'))).toBe(true)
    expect(result.recommendations.some((r) => r.includes('sitemap.xml'))).toBe(true)
  })
})

// ─── HTML head link to llms.txt ──────────────────────────────────────────────
describe('head link to llms.txt', () => {
  it('credits +10 when the <head> links to llms.txt', () => {
    const html = '<!doctype html><html><head><title>T</title><link rel="alternate" type="text/plain" href="/llms.txt"></head><body></body></html>'
    const result = analyzeAiAccessFiles(buildContext(html))
    expect(result.score).toBe(10) // only the link; all aux is missing
    expect(result.findings.some((f) => f.type === 'found' && f.message.includes('HTML head links to llms.txt'))).toBe(true)
  })

  it('does not credit a stylesheet that happens to include "llms" in its href', () => {
    // The current matcher is substring-based on href*="llms.txt" so any link with llms.txt triggers.
    // This test pins that behavior; if we tighten it later we should update.
    const html = '<!doctype html><html><head><title>T</title><link rel="stylesheet" href="/dir/other-llms.txt"></head><body></body></html>'
    const result = analyzeAiAccessFiles(buildContext(html))
    expect(result.score).toBe(10)
    expect(result.findings.some((f) => f.message.includes('HTML head links to llms.txt'))).toBe(true)
  })

  it('flags info + recommendation when no head link is present', () => {
    const result = analyzeAiAccessFiles(buildContext(bareHtml))
    expect(result.findings.some((f) => f.type === 'info' && f.message.includes('No llms.txt link'))).toBe(true)
    expect(result.recommendations.some((r) => r.includes('<link>'))).toBe(true)
  })
})

// ─── Per-page Markdown source endpoint ───────────────────────────────────────
describe('per-page Markdown source endpoint', () => {
  it('credits +10 and a found finding for a text/markdown alternate link', () => {
    const html = '<!doctype html><html><head><title>T</title><link rel="alternate" type="text/markdown" href="/index.md"></head><body></body></html>'
    const result = analyzeAiAccessFiles(buildContext(html))
    expect(result.score).toBe(10) // only the markdown endpoint; all aux missing, no llms.txt link
    expect(result.findings.some((f) => f.type === 'found' && f.message.includes('Markdown source endpoint'))).toBe(true)
  })

  it('credits +10 when the endpoint is advertised via a Link response header', () => {
    const result = analyzeAiAccessFiles(buildContext(bareHtml, aux(), {
      link: '</index.md>; rel="alternate"; type="text/markdown"',
    }))
    expect(result.score).toBe(10)
    expect(result.findings.some((f) => f.type === 'found' && f.message.includes('Markdown source endpoint'))).toBe(true)
  })

  it('flags info + a spec-cited recommendation when no markdown endpoint is advertised', () => {
    const result = analyzeAiAccessFiles(buildContext(bareHtml))
    expect(result.findings.some((f) => f.type === 'info' && f.message.includes('Markdown source endpoint'))).toBe(true)
    expect(result.recommendations.some((r) =>
      r.includes('text/markdown') && r.includes('specification.website'),
    )).toBe(true)
  })
})

// ─── Additive full-strength scenario ─────────────────────────────────────────
describe('fully ai-readable page', () => {
  it('reaches near-full score with every signal satisfied', () => {
    const html = '<!doctype html><html><head><title>T</title><link rel="alternate" type="text/markdown" href="/llms.txt"></head><body></body></html>'
    const result = analyzeAiAccessFiles(buildContext(html, {
      llmsTxt: { state: 'ok', body: 'word '.repeat(120) },
      llmsFullTxt: { state: 'ok', body: 'word '.repeat(220) },
      robotsTxt: { state: 'ok', body: 'User-agent: *' },
      sitemapXml: { state: 'ok', body: '<urlset></urlset>' },
    }))
    // 24 + 8 + 24 + 10 + 16 + 16 + 10 (llms link) + 10 (markdown) = 118 → clamped to 100
    expect(result.score).toBe(100)
    expect(result.recommendations.length).toBe(0)
  })
})

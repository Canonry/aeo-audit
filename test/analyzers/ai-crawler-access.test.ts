import { describe, it, expect } from 'vitest'
import { load } from 'cheerio'

import { analyzeAiCrawlerAccess } from '../../src/analyzers/ai-crawler-access.js'
import { getVisibleText, parseJsonLdScripts } from '../../src/analyzers/helpers.js'
import type { AuditContext, AuxiliaryResources } from '../../src/types.js'

const bareHtml = '<!doctype html><html><head><title>T</title></head><body></body></html>'

function aux(robotsBody: string): AuxiliaryResources {
  return {
    llmsTxt: { state: 'missing', body: '' },
    llmsFullTxt: { state: 'missing', body: '' },
    robotsTxt: { state: 'ok', body: robotsBody },
    sitemapXml: { state: 'missing', body: '' },
  }
}

function buildContext(robotsBody: string, url = 'https://example.com/'): AuditContext {
  const $ = load(bareHtml)
  return {
    $,
    html: bareHtml,
    url,
    headers: {},
    auxiliary: aux(robotsBody),
    structuredData: parseJsonLdScripts($),
    textContent: getVisibleText($, bareHtml),
    pageTitle: 'T',
  }
}

const ALLOW_ALL = 'User-agent: *\nAllow: /'

// ─── Bot access (baseline) ────────────────────────────────────────────────────
describe('AI crawler access — bot rules', () => {
  it('reports every listed AI crawler as allowed under a permissive robots.txt', () => {
    const result = analyzeAiCrawlerAccess(buildContext(ALLOW_ALL))
    for (const bot of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'OAI-SearchBot', 'Google-Extended']) {
      expect(result.findings.some((f) => f.type === 'found' && f.message.includes(`${bot} is allowed`))).toBe(true)
    }
  })

  it('flags a blocked bot and recommends allowing it', () => {
    const result = analyzeAiCrawlerAccess(buildContext('User-agent: GPTBot\nDisallow: /'))
    expect(result.findings.some((f) => f.type === 'missing' && f.message.includes('GPTBot is blocked'))).toBe(true)
    expect(result.recommendations.some((r) => r.includes('GPTBot'))).toBe(true)
  })
})

// ─── Content Signals ──────────────────────────────────────────────────────────
describe('AI crawler access — Content Signals', () => {
  it('credits +8 and a found finding when robots.txt declares a Content-Signal directive', () => {
    const withSignal = `${ALLOW_ALL}\nContent-Signal: search=yes, ai-input=yes, ai-train=no`
    const withScore = analyzeAiCrawlerAccess(buildContext(withSignal)).score
    const withoutScore = analyzeAiCrawlerAccess(buildContext(ALLOW_ALL)).score
    expect(withScore - withoutScore).toBe(8)
    const result = analyzeAiCrawlerAccess(buildContext(withSignal))
    expect(result.findings.some((f) => f.type === 'found' && f.message.includes('Content-Signal'))).toBe(true)
  })

  it('recommends Content-Signal (citing specification.website) when absent', () => {
    const result = analyzeAiCrawlerAccess(buildContext(ALLOW_ALL))
    expect(result.recommendations.some((r) =>
      r.includes('Content-Signal') && r.includes('specification.website'),
    )).toBe(true)
  })

  it('matches the Content-Signal directive case-insensitively', () => {
    const result = analyzeAiCrawlerAccess(buildContext(`${ALLOW_ALL}\ncontent-signal: ai-train=no`))
    expect(result.findings.some((f) => f.type === 'found' && f.message.includes('Content-Signal'))).toBe(true)
  })
})

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
const signalRobots = (signal: string): string => `${ALLOW_ALL}\nContent-Signal: ${signal}`
const baselineScore = analyzeAiCrawlerAccess(buildContext(ALLOW_ALL)).score
const hasCode = (result: ReturnType<typeof analyzeAiCrawlerAccess>, code: string): boolean =>
  result.findings.some((f) => f.code === code)

describe('AI crawler access — Content Signals', () => {
  it('credits the ideal policy (ai-input=yes +6, search=yes +2) and reports it as found', () => {
    const result = analyzeAiCrawlerAccess(buildContext(signalRobots('search=yes, ai-input=yes, ai-train=no')))
    expect(result.score - baselineScore).toBe(8)
    expect(hasCode(result, 'ai-crawler-access.content-signal.found')).toBe(true)
    expect(hasCode(result, 'ai-crawler-access.content-signal.ai-input-allowed')).toBe(true)
    expect(hasCode(result, 'ai-crawler-access.content-signal.search-allowed')).toBe(true)
  })

  it('recommends Content-Signal (citing specification.website) when absent', () => {
    const result = analyzeAiCrawlerAccess(buildContext(ALLOW_ALL))
    expect(result.recommendations.some((r) =>
      r.includes('Content-Signal') && r.includes('specification.website'),
    )).toBe(true)
  })

  it('matches the Content-Signal directive case-insensitively', () => {
    const result = analyzeAiCrawlerAccess(buildContext(`${ALLOW_ALL}\ncontent-signal: ai-train=no`))
    expect(hasCode(result, 'ai-crawler-access.content-signal.found')).toBe(true)
  })

  it('penalizes and flags ai-input=no — the signal that opts out of AI answers', () => {
    const result = analyzeAiCrawlerAccess(buildContext(signalRobots('search=yes, ai-input=no')))
    expect(result.score).toBeLessThan(baselineScore)
    expect(hasCode(result, 'ai-crawler-access.content-signal.ai-input-blocked')).toBe(true)
    expect(result.recommendations.some((r) => r.includes('ai-input=yes'))).toBe(true)
  })

  it('scores ai-input=yes strictly higher than ai-input=no, all else equal', () => {
    const yes = analyzeAiCrawlerAccess(buildContext(signalRobots('ai-input=yes'))).score
    const no = analyzeAiCrawlerAccess(buildContext(signalRobots('ai-input=no'))).score
    expect(yes).toBeGreaterThan(no)
  })

  it('penalizes and flags search=no', () => {
    const result = analyzeAiCrawlerAccess(buildContext(signalRobots('search=no, ai-input=yes')))
    expect(hasCode(result, 'ai-crawler-access.content-signal.search-blocked')).toBe(true)
    expect(result.recommendations.some((r) => r.includes('search=yes'))).toBe(true)
  })

  it('treats ai-train=no as neutral for AEO — info finding, no penalty, no recommendation', () => {
    const result = analyzeAiCrawlerAccess(buildContext(signalRobots('ai-train=no')))
    expect(result.score).toBe(baselineScore)
    expect(result.findings.some((f) => f.code === 'ai-crawler-access.content-signal.ai-train-blocked' && f.type === 'info')).toBe(true)
    expect(result.recommendations.some((r) => r.includes('ai-train'))).toBe(false)
  })

  it('summarizes declared signals in canonical order regardless of input order', () => {
    const result = analyzeAiCrawlerAccess(buildContext(signalRobots('ai-train=no, ai-input=yes, search=yes')))
    const summary = result.findings.find((f) => f.code === 'ai-crawler-access.content-signal.found')
    expect(summary?.message).toContain('(search=yes, ai-input=yes, ai-train=no)')
  })

  it('reads the site-wide (User-agent: *) policy even when a bot-specific group follows', () => {
    const robots = 'User-agent: *\nAllow: /\nContent-Signal: ai-input=yes\n\nUser-agent: GPTBot\nDisallow: /private'
    const result = analyzeAiCrawlerAccess(buildContext(robots))
    expect(hasCode(result, 'ai-crawler-access.content-signal.ai-input-allowed')).toBe(true)
  })

  it('reports a directive with no recognized signals as present but empty (no score change)', () => {
    const result = analyzeAiCrawlerAccess(buildContext(signalRobots('foo=bar')))
    expect(result.score).toBe(baselineScore)
    const summary = result.findings.find((f) => f.code === 'ai-crawler-access.content-signal.found')
    expect(summary?.message).toContain('no recognized signals')
  })
})

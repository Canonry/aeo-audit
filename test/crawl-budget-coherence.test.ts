import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, test } from 'vitest'

import { DEFAULT_SITE_CRAWL_LIMITS, resolveSiteCrawlLimits, runSiteCrawl } from '../src/index.js'

/**
 * A budget the crawler blows through is not a budget. These cover the two ways
 * that happened: a soft stop latching first and hiding the hard stop behind it,
 * and the flat byte/fetch/duration defaults being too small for the page count
 * the caller actually asked for.
 */
describe('crawl budget coherence', () => {
  let server: Server | undefined

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()))
    server = undefined
  })

  /**
   * Serves interlinked pages padded to `padKb`. Every path is also linked with
   * `variants` query strings, so a low `maxQueryVariants` latches a SOFT stop
   * early, while the padding trips a HARD byte stop later, the exact order
   * that used to hide the byte stop.
   */
  async function serveSite(options: {padKb: number, paths: number, variants: number}): Promise<{origin: string, served: () => number}> {
    let origin = ''
    let served = 0
    const pad = 'x'.repeat(options.padKb * 1024)
    const links = Array.from({length: options.paths}, (_, i) =>
      `<a href="/p${i}">p${i}</a>` + Array.from({length: options.variants}, (_, v) => `<a href="/p${i}?v=${v}">v${v}</a>`).join('')).join('')
    server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', origin).pathname
      if (path === '/robots.txt') {
        response.setHeader('content-type', 'text/plain')
        response.end('User-agent: *\nAllow: /\n')
        return
      }
      served += 1
      response.setHeader('content-type', 'text/html')
      response.end(`<html><body>${links}<!--${pad}--></body></html>`)
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', () => {
        server!.off('error', reject)
        resolve()
      })
    })
    origin = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
    return {origin, served: () => served}
  }

  test('a soft stop never hides the hard stop that actually ended the crawl', async () => {
    const site = await serveSite({padKb: 40, paths: 40, variants: 8})

    const report = await runSiteCrawl(`${site.origin}/`, {
      allowPrivateHost: '127.0.0.1',
      mode: 'summary',
      maxPages: 500,
      maxQueryVariants: 2,
      maxBytes: 1_000_000,
    })

    // max-query-variants latches first and is real, but it is not what STOPPED
    // the crawl. Reporting it sends anyone diagnosing the run to the wrong
    // budget, and it is the reason the run kept fetching (see below).
    expect(report.summary.terminationReason).toBe('max-bytes')
  }, 120_000)

  test('the crawl stops fetching once a hard budget is hit', async () => {
    const site = await serveSite({padKb: 40, paths: 40, variants: 8})

    const report = await runSiteCrawl(`${site.origin}/`, {
      allowPrivateHost: '127.0.0.1',
      mode: 'summary',
      maxPages: 500,
      maxQueryVariants: 2,
      maxBytes: 1_000_000,
    })

    // The overshoot is bounded by the requests already in flight when the cap
    // is crossed, not by whatever is left in the frontier. Before the fix this
    // read 4.2x the budget across 85 requests at the audited origin.
    expect(report.summary.bytesRead).toBeLessThan(2_000_000)
    expect(site.served()).toBeLessThan(40)
  }, 120_000)

  test('an explicit budget is honoured exactly, never scaled', async () => {
    const site = await serveSite({padKb: 1, paths: 30, variants: 0})

    const report = await runSiteCrawl(`${site.origin}/`, {
      allowPrivateHost: '127.0.0.1',
      mode: 'summary',
      maxPages: 500,
      maxFetches: 6,
    })

    expect(report.summary.terminationReason).toBe('max-fetches')
    expect(site.served()).toBeLessThanOrEqual(8)
  }, 120_000)

  test('unset fetch budgets scale to the page count the caller asked for', () => {
    // The production failure: 1,000 pages requested, the flat 100MB byte
    // default reached at ~140 pages of ~745KB each, and the run reported
    // `partial` naming the wrong budget. Nothing about 1,000 pages implies
    // 100MB, so the fetch-side budgets now derive from the page budget.
    const asked = resolveSiteCrawlLimits({maxPages: 1_000})
    expect(asked.maxBytes).toBeGreaterThan(DEFAULT_SITE_CRAWL_LIMITS.maxBytes)
    expect(asked.maxBytes).toBeGreaterThanOrEqual(1_000 * 745_000)
    expect(asked.maxDurationMs).toBeGreaterThan(DEFAULT_SITE_CRAWL_LIMITS.maxDurationMs)

    // Scaling is monotone in the page count, so asking for more never budgets less.
    const more = resolveSiteCrawlLimits({maxPages: 5_000})
    expect(more.maxBytes).toBeGreaterThan(asked.maxBytes)
    expect(more.maxFetches).toBeGreaterThan(asked.maxFetches)
  })

  test('a small page count never DROPS a budget below the flat default', () => {
    // The derivation shipped without its floor and silently inverted: at
    // maxPages 1 it produced maxFetches 2 and maxDurationMs 400, so the crawler
    // could not afford its own auxiliary fetches (llms.txt, robots, sitemap)
    // and a 400ms cap made the whole crawl a race it lost on a slower runtime.
    // Scaling is a CEILING RAISE. It may never lower a budget the caller did
    // not ask to lower.
    for (const maxPages of [1, 2, 5, 50, 67, 300, 1_000]) {
      const limits = resolveSiteCrawlLimits({maxPages})
      expect(limits.maxFetches).toBeGreaterThanOrEqual(DEFAULT_SITE_CRAWL_LIMITS.maxFetches)
      expect(limits.maxDurationMs).toBeGreaterThanOrEqual(DEFAULT_SITE_CRAWL_LIMITS.maxDurationMs)
      expect(limits.maxBytes).toBeGreaterThanOrEqual(DEFAULT_SITE_CRAWL_LIMITS.maxBytes)
    }
  })

  test('a stated budget is never raised or lowered by the derivation', () => {
    const limits = resolveSiteCrawlLimits({maxPages: 5_000, maxBytes: 1_000, maxDurationMs: 25, maxFetches: 7})
    expect(limits.maxBytes).toBe(1_000)
    expect(limits.maxDurationMs).toBe(25)
    expect(limits.maxFetches).toBe(7)
  })

  test('asking for nothing still gets the documented flat defaults', () => {
    const limits = resolveSiteCrawlLimits({})
    expect(limits.maxPages).toBe(DEFAULT_SITE_CRAWL_LIMITS.maxPages)
    expect(limits.maxBytes).toBe(DEFAULT_SITE_CRAWL_LIMITS.maxBytes)
    expect(limits.maxDurationMs).toBe(DEFAULT_SITE_CRAWL_LIMITS.maxDurationMs)
    expect(limits.maxFetches).toBe(DEFAULT_SITE_CRAWL_LIMITS.maxFetches)
  })
})

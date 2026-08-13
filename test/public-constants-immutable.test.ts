import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  DEFAULT_COMPARE_POLICY,
  DEFAULT_SITE_CRAWL_LIMITS,
  FACTOR_SPEC_RULES,
  RECOGNIZED_ARIA_ROLES,
  SPEC_RULES,
  runSiteCrawl,
} from '../src/index.js'
import type { ComparePolicy, SiteCrawlLimits } from '../src/types.js'

afterEach(() => vi.unstubAllGlobals())

/**
 * Any exported constant that internal logic ALSO reads is a runtime widening
 * surface: mutate it and engine behavior changes while every version string
 * still reports the published ruleset, which makes a report unreproducible and
 * the drift invisible. `readonly` and `Readonly<T>` are erased at compile time,
 * so these have to be frozen for real.
 *
 * A new exported object, array, or record that the engine reads belongs here.
 */
describe('public constants the engine reads are immutable', () => {
  test.each([
    ['DEFAULT_SITE_CRAWL_LIMITS', DEFAULT_SITE_CRAWL_LIMITS],
    ['DEFAULT_COMPARE_POLICY', DEFAULT_COMPARE_POLICY],
    ['SPEC_RULES', SPEC_RULES],
    ['FACTOR_SPEC_RULES', FACTOR_SPEC_RULES],
    ['RECOGNIZED_ARIA_ROLES', RECOGNIZED_ARIA_ROLES],
  ])('%s is frozen', (_name, value) => {
    expect(Object.isFrozen(value)).toBe(true)
  })

  test('nested members are frozen too, not just the container', () => {
    expect(Object.isFrozen(SPEC_RULES['llms-txt'])).toBe(true)
    expect(Object.isFrozen(FACTOR_SPEC_RULES['ai-access-files'])).toBe(true)
    expect(Object.isFrozen(DEFAULT_COMPARE_POLICY.failOn)).toBe(true)
  })

  test('mutating one throws instead of silently changing engine behavior', () => {
    expect(() => { (DEFAULT_SITE_CRAWL_LIMITS as SiteCrawlLimits).maxPages = 1 }).toThrow(TypeError)
    expect(() => { (DEFAULT_COMPARE_POLICY as ComparePolicy).overallTolerance = 99 }).toThrow(TypeError)
    expect(() => (RECOGNIZED_ARIA_ROLES as string[]).push('made-up')).toThrow(TypeError)
    expect(() => (FACTOR_SPEC_RULES['ai-access-files'] as string[]).pop()).toThrow(TypeError)
  })

  test('a crawl still resolves the published defaults after a mutation attempt', async () => {
    try {
      (DEFAULT_SITE_CRAWL_LIMITS as SiteCrawlLimits).maxPages = 1
    } catch {
      // Expected. The point is which limits the next crawl resolves.
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html><html><body><p>ok</p></body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })))
    const report = await runSiteCrawl('https://example.test/', { allowPrivateHost: 'example.test', mode: 'summary' })

    expect(DEFAULT_SITE_CRAWL_LIMITS.maxPages).toBe(1_000)
    expect(report.summary.limits.maxPages).toBe(1_000)
  })

  test('the exported role registry is an array view, never the live lookup', () => {
    // A Set cannot be made immutable by freezing, so the package must not export
    // one for a ruleset the engine reads.
    expect(Array.isArray(RECOGNIZED_ARIA_ROLES)).toBe(true)
    expect(RECOGNIZED_ARIA_ROLES).toContain('navigation')
    expect([...RECOGNIZED_ARIA_ROLES]).toEqual([...RECOGNIZED_ARIA_ROLES].sort())
  })
})

import { describe, expect, it } from 'vitest'
import { selectRepresentativeSample } from '../src/url-templates.js'

/**
 * The sub-value interleave must stay LINEAR.
 *
 * The shape that breaks it is ordinary, not adversarial: one dominant sub-value
 * plus a long tail of one-off ones, which is what a real sitemap of
 * /p/<city>/<slug> URLs looks like. Walking every bucket on every round makes
 * both factors ~n/2, so emitting n values costs ~n^2/4.
 *
 * It matters more than a slow function because the work is SYNCHRONOUS and runs
 * before the first page fetch: it blocks the event loop, which suspends the very
 * timeouts, AbortSignals and fetch budgets meant to bound a sitemap audit. One
 * 5 MB sitemap (about 110k URLs, one fetch of the budget) froze the process for
 * 13 seconds. This asserts the shape stays cheap; a quadratic regression blows
 * the budget by orders of magnitude, so the threshold needs no tight tuning.
 */
describe('selectRepresentativeSample cost', () => {
  it('stays linear on one dominant sub-value plus a long singleton tail', () => {
    const n = 60_000
    const items = Array.from({ length: n }, (_, i) => ({
      loc: i % 2 === 0 ? `https://e.test/p/hot/s${i}` : `https://e.test/p/u${i}/s${i}`,
    }))
    const started = Date.now()
    const picked = selectRepresentativeSample(items, 25, {
      keyOf: () => 'one-template',
      spreadBy: (item) => (item.loc.includes('/p/hot/') ? 'hot' : item.loc),
    })
    const elapsedMs = Date.now() - started
    expect(picked).toHaveLength(25)
    // Linear is a few tens of ms here; the quadratic version took ~7 s at n=40k
    // and ~53 s at n=110k, so any regression clears this by a wide margin.
    expect(elapsedMs).toBeLessThan(2_000)
  })

  it('still spreads across sub-values rather than taking a prefix', () => {
    const items = [
      { loc: 'https://e.test/p/a/1' },
      { loc: 'https://e.test/p/a/2' },
      { loc: 'https://e.test/p/a/3' },
      { loc: 'https://e.test/p/b/1' },
      { loc: 'https://e.test/p/c/1' },
    ]
    const picked = selectRepresentativeSample(items, 3, {
      keyOf: () => 'one-template',
      spreadBy: (item) => item.loc.split('/')[4] as string,
    })
    // Three picks must touch three distinct sub-values, not three from 'a'.
    const subValues = new Set(picked.map((p) => p.loc.split('/')[4]))
    expect(subValues.size).toBe(3)
  })
})

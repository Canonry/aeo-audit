import { describe, expect, it } from 'vitest'
import { selectRepresentativeSample } from '../src/url-templates.js'

/**
 * The sub-value interleave must stay LINEAR and must not change what it picks.
 *
 * The shape that broke it is ordinary, not adversarial: one dominant sub-value
 * plus a long tail of one-off ones, which is what a real sitemap of
 * /p/<city>/<slug> URLs looks like. Walking every bucket on every round makes
 * both the round count and the bucket count ~n/2, so emitting n values cost
 * ~n^2/4.
 *
 * It matters more than a slow function because the work is SYNCHRONOUS and runs
 * before the first page fetch: it blocks the event loop, which suspends the very
 * timeouts, AbortSignals and fetch budgets meant to bound a sitemap audit. One
 * 5 MB sitemap (~110k URLs, one fetch of the budget) froze the process for 13
 * seconds.
 */

/**
 * The pre-fix implementation, kept verbatim as the reference ORDER.
 *
 * The whole safety argument for the rewrite is "emits the identical sequence",
 * so the thing it is identical TO has to live in the repo. Without it the claim
 * is a sentence in a commit message and a later refactor can silently change
 * which pages a sitemap audit samples.
 */
function referenceInterleave<T>(
  indices: readonly number[],
  items: readonly T[],
  spreadBy: (item: T) => string,
): number[] {
  const buckets = new Map<string, number[]>()
  for (const index of indices) {
    const key = spreadBy(items[index] as T)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(index)
    else buckets.set(key, [index])
  }
  if (buckets.size <= 1) return [...indices]
  const ordered = [...buckets.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  )
  const result: number[] = []
  for (let round = 0; result.length < indices.length; round++) {
    for (const [, bucket] of ordered) {
      const index = bucket[round]
      if (index !== undefined) result.push(index)
    }
  }
  return result
}

/** Deterministic PRNG, so a failure reproduces exactly from the seed. */
function seeded(seed: number): () => number {
  let state = seed
  return () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
}

interface Item {
  loc: string
  sub: string
}

/** Drive the sampler through one template group so `spreadBy` is the only axis. */
function sample(items: readonly Item[], limit: number): Item[] {
  return selectRepresentativeSample(items, limit, {
    keyOf: () => 'one-template',
    spreadBy: (item) => item.sub,
  })
}

describe('selectRepresentativeSample', () => {
  it('picks exactly what the pre-fix implementation picked, across random shapes', () => {
    const rnd = seeded(20260814)
    for (let trial = 0; trial < 500; trial++) {
      const n = 1 + Math.floor(rnd() * 40)
      const subValues = 1 + Math.floor(rnd() * 6)
      const items: Item[] = Array.from({ length: n }, (_, i) => ({
        loc: `https://e.test/p/${i}`,
        sub: `s${Math.floor(rnd() * subValues)}`,
      }))
      const limit = 1 + Math.floor(rnd() * n)

      // With one template group the outer round-robin walks the interleaved
      // order straight through, so the first `limit` of it is what gets selected.
      // The function then returns its picks in DOCUMENT order, so sort before
      // comparing: what the interleave decides is WHICH pages, not their order.
      const expected = referenceInterleave(
        items.map((_, i) => i),
        items,
        (item) => item.sub,
      )
        .slice(0, limit)
        .sort((a, b) => a - b)
        .map((index) => (items[index] as Item).loc)

      expect(sample(items, limit).map((item) => item.loc)).toEqual(expected)
    }
  })

  it('stays linear on one dominant sub-value plus a long singleton tail', () => {
    // ONE absolute check at a size where the two implementations are ~3 orders of
    // magnitude apart: ~22 ms linear against ~53 s quadratic. That gap is what
    // makes a wall clock acceptable here, since no threshold tuning is possible
    // and no plausibly-loaded runner closes it.
    //
    // A ratio check at n and 2n reads as the more rigorous option and is not: at
    // those sizes linear work is a few milliseconds, so the ratio measures GC and
    // JIT rather than the algorithm. It flaked on its first CI run at 3.53
    // against a 3x bound while the code was correct, which is worse than no test,
    // because the failure teaches maintainers to re-run rather than to look.
    const n = 110_000
    const items: Item[] = Array.from({ length: n }, (_, i) => ({
      loc: `https://e.test/p/${i}`,
      sub: i % 2 === 0 ? 'hot' : `u${i}`,
    }))
    const started = Date.now()
    const picked = sample(items, 25)
    const elapsedMs = Date.now() - started
    expect(picked).toHaveLength(25)
    expect(elapsedMs).toBeLessThan(5_000)
  })

  it('still spreads across sub-values rather than taking a prefix', () => {
    const items: Item[] = [
      { loc: 'https://e.test/p/a/1', sub: 'a' },
      { loc: 'https://e.test/p/a/2', sub: 'a' },
      { loc: 'https://e.test/p/a/3', sub: 'a' },
      { loc: 'https://e.test/p/b/1', sub: 'b' },
      { loc: 'https://e.test/p/c/1', sub: 'c' },
    ]
    expect(new Set(sample(items, 3).map((item) => item.sub)).size).toBe(3)
  })
})

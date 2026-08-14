import { describe, expect, it } from 'vitest'

const EQ = (a: unknown, b: unknown) => expect(a).toBe(b)
const DEQ = (a: unknown, b: unknown) => expect(a).toEqual(b)
const OK = (a: unknown, msg?: string) => expect(a, msg).toBeTruthy()
import { FACTOR_DEFINITIONS, factorSharePct, scoreFactors } from '../src/scoring.js'
import type { RawFactorResult } from '../src/types.js'

/**
 * `weight` is not a percentage.
 *
 * The core weights sum to 111, and the score divides by that real total, so a
 * weight-12 factor is 10.8 percent of the score. Printing `weight` with a percent
 * sign overstates all sixteen and yields a column that never adds to 100. It
 * shipped that way in both formatters and in at least one consumer dashboard.
 */
const raw = (over: Partial<RawFactorResult> = {}): RawFactorResult => ({
  id: 'x',
  name: 'X',
  weight: 1,
  score: 50,
  findings: [],
  recommendations: [],
  ...over,
})

describe('factor share of score', () => {
  it('the core weights do NOT sum to 100, which is why share exists', () => {
    const total = FACTOR_DEFINITIONS.reduce((sum, f) => sum + f.weight, 0)
    OK(total !== 100, `core weights sum to ${total}`)
  })

  it('reports share against the ACTUAL weight total, not 100', () => {
    const { factors } = scoreFactors([raw({ id: 'a', weight: 12 }), raw({ id: 'b', weight: 99 })])
    // 12 / 111 = 10.8, not 12.
    EQ(factors.find((f) => f.id === 'a')?.sharePct, 10.8)
    EQ(factors.find((f) => f.id === 'b')?.sharePct, 89.2)
  })

  it('shares sum to EXACTLY 100, which independent rounding does not', () => {
    const { factors } = scoreFactors(FACTOR_DEFINITIONS.map((f) => raw({ id: f.id, weight: f.weight })))
    const total = factors.reduce((sum, f) => sum + (f.sharePct ?? 0), 0)
    EQ(Math.round(total * 10) / 10, 100)

    // The point of the allocator: rounding each weight on its own lands at 99.9
    // for this exact factor set, so a consumer printing a total row would show it.
    const totalWeight = FACTOR_DEFINITIONS.reduce((sum, f) => sum + f.weight, 0)
    const naive = FACTOR_DEFINITIONS.reduce(
      (sum, f) => sum + Math.round((f.weight / totalWeight) * 1000) / 10,
      0,
    )
    EQ(Math.round(naive * 10) / 10, 99.9)
  })

  it('sums to 100 for every subset a --factors run can produce', () => {
    // The denominator moves with the subset, so one lucky factor set proves
    // nothing. Walk many subsets and assert the invariant on each.
    for (let size = 1; size <= FACTOR_DEFINITIONS.length; size++) {
      for (let offset = 0; offset < FACTOR_DEFINITIONS.length; offset += 5) {
        const subset = [...FACTOR_DEFINITIONS, ...FACTOR_DEFINITIONS]
          .slice(offset, offset + size)
          .map((f) => raw({ id: f.id, weight: f.weight }))
        const { factors } = scoreFactors(subset)
        const total = factors.reduce((sum, f) => sum + (f.sharePct ?? 0), 0)
        EQ(Math.round(total * 10) / 10, 100)
      }
    }
  })

  it('share tracks the same denominator the overall score uses', () => {
    // One factor at 100, the rest at 0: the overall score must equal that
    // factor's share, which is the invariant that makes the number meaningful.
    const inputs = FACTOR_DEFINITIONS.map((f, i) => raw({ id: f.id, weight: f.weight, score: i === 0 ? 100 : 0 }))
    const { factors, overallScore } = scoreFactors(inputs)
    const first = factors[0]!
    EQ(Math.round(first.sharePct ?? 0), overallScore)
  })

  it('falls back to the report weight sum for a report predating the field, never to weight', () => {
    const a = { id: 'a', weight: 12, score: 50 }
    const b = { id: 'b', weight: 99, score: 50 }
    EQ(factorSharePct(a, [a, b]), 10.8)
    // A recorded value wins over the derivation.
    EQ(factorSharePct({ ...a, sharePct: 42 }, [a, b]), 42)
  })

  it('gives a NOT-APPLICABLE factor no share, because it moved the score by nothing', () => {
    const faq = { id: 'faq-content', weight: 8, score: 0, applicable: false }
    const depth = { id: 'content-depth', weight: 10, score: 70 }
    const all = [faq, depth]
    EQ(factorSharePct(faq, all), 0)
    // content-depth is then the whole of the score.
    EQ(factorSharePct(depth, all), 100)
  })

  it('an empty factor set reports 0 rather than dividing by zero', () => {
    EQ(factorSharePct({ id: 'x', weight: 5, score: 0 }, []), 0)
    DEQ(scoreFactors([]).factors, [])
  })

  /**
   * A factor the analyzer says does not apply still reports 0, and counting that
   * 0 penalized the page for lacking something it had no reason to have. The
   * flag existed to say exactly that, and the sitemap rollup already honored it.
   */
  it('does not penalize a page for a factor that does not apply to it', () => {
    const inputs = [
      raw({ id: 'content-depth', weight: 10, score: 80 }),
      raw({ id: 'faq-content', weight: 8, score: 0, applicable: false }),
    ]
    const { overallScore, factors } = scoreFactors(inputs)
    // Scored on content-depth alone: 80, not 80*10/18 = 44.
    EQ(overallScore, 80)
    EQ(factors.find((f) => f.id === 'faq-content')?.sharePct, 0)
    EQ(factors.find((f) => f.id === 'content-depth')?.sharePct, 100)
  })

  it('still counts a page-specific factor that the analyzer says DOES apply', () => {
    const inputs = [
      raw({ id: 'content-depth', weight: 10, score: 80 }),
      raw({ id: 'faq-content', weight: 8, score: 0, applicable: true }),
    ]
    // A real FAQ page implemented badly keeps its zero: 80*10/18 = 44.4 -> 44.
    EQ(scoreFactors(inputs).overallScore, 44)
  })

  it('scores everything rather than dividing by zero when nothing applies', () => {
    const inputs = [raw({ id: 'faq-content', weight: 8, score: 60, applicable: false })]
    EQ(scoreFactors(inputs).overallScore, 60)
  })

  /**
   * `factorApplies` resolves three ways: an explicit flag, the presence rule for a
   * page-specific factor, or always-true. Only the first was ever recorded, so a
   * factor judged by presence came back score 0 / sharePct 0 with NO flag, and a
   * consumer could not tell "did not apply here" from "applied and scored zero"
   * without reimplementing PAGE_SPECIFIC_FACTOR_IDS and the threshold.
   */
  it('records the RESOLVED applicability, including when it was inferred', () => {
    const { factors } = scoreFactors([
      raw({ id: 'content-depth', weight: 10, score: 80 }),
      // Page-specific, below the presence threshold, analyzer said nothing.
      raw({ id: 'faq-content', weight: 8, score: 0 }),
    ])
    const faq = factors.find((f) => f.id === 'faq-content')!
    EQ(faq.applicable, false)
    EQ(faq.sharePct, 0)
    // And an always-applicable factor is affirmatively marked, not left undefined.
    EQ(factors.find((f) => f.id === 'content-depth')?.applicable, true)
  })

  it('distinguishes a page-specific factor that DID apply and scored zero', () => {
    const { factors } = scoreFactors([
      raw({ id: 'content-depth', weight: 10, score: 80 }),
      // Above the presence threshold: a real FAQ, implemented badly.
      raw({ id: 'faq-content', weight: 8, score: 35 }),
    ])
    const faq = factors.find((f) => f.id === 'faq-content')!
    EQ(faq.applicable, true)
    OK((faq.sharePct ?? 0) > 0, 'an applicable factor carries a share')
  })

  it('never contradicts an analyzer that spoke', () => {
    const { factors } = scoreFactors([
      raw({ id: 'content-depth', weight: 10, score: 80 }),
      // Explicitly applicable despite scoring below the presence threshold.
      raw({ id: 'faq-content', weight: 8, score: 0, applicable: true }),
    ])
    EQ(factors.find((f) => f.id === 'faq-content')?.applicable, true)
  })
})

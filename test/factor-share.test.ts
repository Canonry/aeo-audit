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

  it('shares sum to 100 within rounding, which weights never did', () => {
    const { factors } = scoreFactors(FACTOR_DEFINITIONS.map((f) => raw({ id: f.id, weight: f.weight })))
    const total = factors.reduce((sum, f) => sum + (f.sharePct ?? 0), 0)
    OK(Math.abs(total - 100) < 0.5, `shares sum to ${total}`)
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
    const all = [{ weight: 12 }, { weight: 99 }]
    EQ(factorSharePct({ weight: 12 }, all), 10.8)
    // A recorded value wins over the derivation.
    EQ(factorSharePct({ weight: 12, sharePct: 42 }, all), 42)
  })

  it('an empty factor set reports 0 rather than dividing by zero', () => {
    EQ(factorSharePct({ weight: 5 }, []), 0)
    DEQ(scoreFactors([]).factors, [])
  })
})

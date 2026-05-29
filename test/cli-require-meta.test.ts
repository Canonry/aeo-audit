import { describe, expect, it } from 'vitest'

import { hasMissingMetaDescription } from '../src/cli.js'
import type { ScoredFactor } from '../src/types.js'

function technicalSeoFactor(
  findings: ScoredFactor['findings'],
): ScoredFactor {
  return {
    id: 'technical-seo',
    name: 'Technical SEO',
    weight: 5,
    score: 50,
    grade: 'D',
    status: 'partial',
    findings,
    recommendations: [],
  }
}

describe('hasMissingMetaDescription', () => {
  it('returns false when factors are undefined', () => {
    expect(hasMissingMetaDescription(undefined)).toBe(false)
  })

  it('returns false when technical-seo factor is absent', () => {
    expect(
      hasMissingMetaDescription([
        {
          id: 'structured-data',
          name: 'Structured Data',
          weight: 10,
          score: 80,
          grade: 'B',
          status: 'pass',
          findings: [],
          recommendations: [],
        },
      ]),
    ).toBe(false)
  })

  it('returns true when technical-seo has a missing-meta-description finding', () => {
    expect(
      hasMissingMetaDescription([
        technicalSeoFactor([{ type: 'missing', message: 'No meta description found.' }]),
      ]),
    ).toBe(true)
  })

  it('returns false when meta description is present (any length)', () => {
    expect(
      hasMissingMetaDescription([
        technicalSeoFactor([
          { type: 'found', message: 'Meta description present (152 chars).' },
        ]),
      ]),
    ).toBe(false)
  })

  it('returns false when meta description is merely short (info-level finding)', () => {
    expect(
      hasMissingMetaDescription([
        technicalSeoFactor([
          {
            type: 'info',
            message: 'Meta description is too short (90 chars; target 150–160): "..."',
          },
        ]),
      ]),
    ).toBe(false)
  })

  it('returns false when finding type is missing but unrelated message', () => {
    expect(
      hasMissingMetaDescription([
        technicalSeoFactor([
          { type: 'missing', message: 'No canonical tag found.' },
        ]),
      ]),
    ).toBe(false)
  })
})

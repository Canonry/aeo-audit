import { describe, it, expect } from 'vitest'

import { SPEC_RULES, FACTOR_SPEC_RULES, SPEC_SITE, specCitation } from '../src/spec-references.js'
import { FACTOR_DEFINITIONS, OPTIONAL_FACTOR_DEFINITIONS } from '../src/scoring.js'

const VALID_STATUSES = new Set(['required', 'recommended', 'optional', 'avoid'])

describe('SPEC_RULES', () => {
  it('keys each rule by its slug and points at a canonical agent-readiness URL', () => {
    for (const [key, rule] of Object.entries(SPEC_RULES)) {
      expect(rule.slug).toBe(key)
      expect(rule.url).toBe(`${SPEC_SITE}/spec/agent-readiness/${rule.slug}/`)
      expect(rule.title.length).toBeGreaterThan(0)
      expect(VALID_STATUSES.has(rule.status)).toBe(true)
    }
  })
})

describe('FACTOR_SPEC_RULES', () => {
  const knownFactorIds = new Set([
    ...FACTOR_DEFINITIONS.map((d) => d.id),
    ...OPTIONAL_FACTOR_DEFINITIONS.map((d) => d.id),
  ])

  it('maps only real factor IDs', () => {
    for (const factorId of Object.keys(FACTOR_SPEC_RULES)) {
      expect(knownFactorIds.has(factorId)).toBe(true)
    }
  })

  it('references only known spec rules', () => {
    for (const ruleIds of Object.values(FACTOR_SPEC_RULES)) {
      for (const ruleId of ruleIds) {
        expect(SPEC_RULES[ruleId]).toBeDefined()
      }
    }
  })
})

describe('specCitation', () => {
  it('includes the rule title, status, and URL', () => {
    const citation = specCitation('markdown-source-endpoints')
    const rule = SPEC_RULES['markdown-source-endpoints']
    expect(citation).toContain(rule.title)
    expect(citation).toContain(rule.status)
    expect(citation).toContain(rule.url)
    expect(citation).toContain('specification.website')
  })
})

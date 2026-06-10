import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// Maps each analyzer source file to its factor id. Every finding code must be
// namespaced `<factorId>.<check>[.<variant>]` (issue: agent-native finding codes).
const ANALYZERS: Record<string, string> = {
  'structured-data.ts': 'structured-data',
  'ai-access-files.ts': 'ai-access-files',
  'entity-consistency.ts': 'entity-consistency',
  'content-depth.ts': 'content-depth',
  'definition-blocks.ts': 'definition-blocks',
  'faq-content.ts': 'faq-content',
  'named-entities.ts': 'named-entities',
  'citations.ts': 'citations',
  'content-freshness.ts': 'content-freshness',
  'geographic-signals.ts': 'geographic-signals',
  'eeat-signals.ts': 'eeat-signals',
  'ai-crawler-access.ts': 'ai-crawler-access',
  'schema-completeness.ts': 'schema-completeness',
  'schema-validity.ts': 'schema-validity',
  'content-extractability.ts': 'content-extractability',
  'technical-seo.ts': 'technical-seo',
  'snippet-eligibility.ts': 'snippet-eligibility',
  'agent-skill-exposure.ts': 'agent-skill-exposure',
  'lighthouse.ts': 'lighthouse',
}

// kebab-case dot segments, at least `<factor>.<check>`.
const CODE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/

function readAnalyzer(file: string): string {
  return readFileSync(new URL(`../src/analyzers/${file}`, import.meta.url), 'utf8')
}

function extractCodes(source: string): string[] {
  const codes: string[] = []
  const re = /\bcode:\s*['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) codes.push(m[1])
  return codes
}

function countFindings(source: string): number {
  return (source.match(/findings\.push\(/g) ?? []).length
}

describe('finding codes', () => {
  const allCodes: string[] = []

  for (const [file, factorId] of Object.entries(ANALYZERS)) {
    describe(file, () => {
      const source = readAnalyzer(file)
      const codes = extractCodes(source)

      it('codes at least every findings.push site', () => {
        // The required `code` on AuditFinding makes the compiler the real
        // completeness gate; here we sanity-check that codes are present and
        // cover every push site. Some analyzers also build findings as inline
        // array literals (e.g. lighthouse early returns), so allow >=.
        expect(codes.length).toBeGreaterThan(0)
        expect(codes.length).toBeGreaterThanOrEqual(countFindings(source))
      })

      it('every code follows the <factor>.<check>[.<variant>] convention', () => {
        for (const code of codes) expect(code, code).toMatch(CODE_RE)
      })

      it(`every code is namespaced under "${factorId}."`, () => {
        for (const code of codes) expect(code.startsWith(`${factorId}.`), code).toBe(true)
      })

      it('codes are unique within the analyzer', () => {
        expect(new Set(codes).size).toBe(codes.length)
      })

      allCodes.push(...codes)
    })
  }

  it('codes are globally unique across all analyzers', () => {
    const seen = new Map<string, number>()
    for (const c of allCodes) seen.set(c, (seen.get(c) ?? 0) + 1)
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([c]) => c)
    expect(dupes, `duplicate codes: ${dupes.join(', ')}`).toEqual([])
  })
})

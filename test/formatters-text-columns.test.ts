import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { formatSitemapText, formatText } from '../src/formatters/text.js'
import { runStaticAudit } from '../src/static-audit.js'

const SITE = fileURLToPath(new URL('./fixtures/site', import.meta.url))
const BASE_URL = 'https://acme-robotics.example'
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

function plainLines(text: string): string[] {
  return text.replace(ANSI, '').split('\n')
}

describe('text report name columns', () => {
  it('starts every factor bar in the same column, including names longer than 30 characters', async () => {
    const result = await runStaticAudit(path.join(SITE, 'index.html'), { baseUrl: BASE_URL })
    if (result.kind !== 'single') throw new Error('expected a single-page report')

    const names = result.report.factors.map((factor) => factor.name)
    expect(names).toContain('AI Access Files (llms.txt, sitemap)')
    const longest = Math.max(...names.map((name) => name.length))
    expect(longest).toBe(35)

    const rows = plainLines(formatText(result.report)).filter((line) => /^ {2}[✓~✗] /.test(line))
    expect(rows).toHaveLength(names.length)
    // "  ✓ " is four columns, then the name padded to the longest one, then a space.
    expect(new Set(rows.map((row) => row.search(/[█░]/)))).toEqual(new Set([4 + longest + 1]))
  })

  it('starts every cross-cutting issue score in the same column', async () => {
    const result = await runStaticAudit(SITE, { baseUrl: BASE_URL })
    if (result.kind !== 'multi') throw new Error('expected a multi-page report')

    const names = result.report.crossCuttingIssues.map((issue) => issue.factorName)
    expect(names).toContain('AI Access Files (llms.txt, sitemap)')
    const width = Math.max(32, ...names.map((name) => name.length))
    expect(width).toBe(35)

    const rows = plainLines(formatSitemapText(result.report, true)).filter(
      (line) => /^ {2}\S/.test(line) && line.includes('(affects '),
    )
    expect(rows.length).toBeGreaterThan(1)
    // Two leading spaces, the name padded to the longest issue name, then a space.
    expect(new Set(rows.map((row) => row.indexOf('avg ')))).toEqual(new Set([2 + width + 1]))
  })
})

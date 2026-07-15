import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { AuditReport, CompareReport, SitemapAuditReport } from '../../src/types.js'

function captureConsole(t: TestContext): { stdout: string[]; stderr: string[] } {
  const stdout: string[] = []
  const stderr: string[] = []
  const realLog = console.log
  const realError = console.error
  console.log = (...args: unknown[]) => {
    stdout.push(args.map(String).join(' '))
  }
  console.error = (...args: unknown[]) => {
    stderr.push(args.map(String).join(' '))
  }
  t.after(() => {
    console.log = realLog
    console.error = realError
  })
  return { stdout, stderr }
}

function singleReport(score: number, schemaVersion = '3.0'): AuditReport {
  return {
    schemaVersion,
    url: 'https://x.test/',
    finalUrl: 'https://x.test/',
    auditedAt: '2026-01-01T00:00:00.000Z',
    overallScore: score,
    summary: '',
    factors: [{ id: 'structured-data', name: 'structured-data', weight: 10, score, findings: [], recommendations: [] }],
    criticalDefects: [],
    compareMeta: { engineVersion: '4.1.0', factorIds: ['structured-data'] },
    metadata: {
      fetchTimeMs: 0,
      pageTitle: '',
      wordCount: 0,
      auxiliary: { llmsTxt: 'missing', llmsFullTxt: 'missing', robotsTxt: 'missing', sitemapXml: 'missing' },
      redirectChain: [],
    },
  }
}

function sitemapReport(score: number): SitemapAuditReport {
  return {
    schemaVersion: '3.0',
    compareMeta: { engineVersion: '4.1.0', factorIds: ['structured-data'] },
    sitemapUrl: 'https://x.test/sitemap.xml',
    auditedAt: '2026-01-01T00:00:00.000Z',
    pagesDiscovered: 1,
    pagesAudited: 1,
    pagesSkipped: 0,
    pagesFiltered: 0,
    pagesTruncated: 0,
    effectiveLimit: 200,
    aggregateScore: score,
    pages: [
      {
        url: 'https://x.test/',
        overallScore: score,
        status: 'success',
        factors: [{ id: 'structured-data', name: 'structured-data', weight: 10, score, findings: [], recommendations: [] }],
      },
    ],
    criticalDefects: [],
    crossCuttingIssues: [],
    prioritizedFixes: [],
    budget: { exhausted: false, discoveryComplete: true },
  }
}

async function writeReports(files: Record<string, unknown>): Promise<Record<string, string>> {
  const dir = await mkdtemp(path.join(tmpdir(), 'aeo-compare-'))
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(files)) {
    const filePath = path.join(dir, `${name}.json`)
    await writeFile(filePath, JSON.stringify(value), 'utf-8')
    out[name] = filePath
  }
  return out
}

async function loadMain(): Promise<(argv: string[]) => Promise<number>> {
  const mod = await import(new URL('../../dist/cli.js', import.meta.url).href)
  return mod.main as (argv: string[]) => Promise<number>
}

test('compare exits 0 and emits clean JSON on stdout when there is no regression', async (t) => {
  const { stdout, stderr } = captureConsole(t)
  const main = await loadMain()
  const files = await writeReports({ base: singleReport(80), cur: singleReport(80) })

  const exit = await main(['node', 'aeo-audit', 'compare', '--baseline', files.base, '--current', files.cur])

  assert.equal(exit, 0)
  assert.equal(stdout.length, 1, 'stdout carries exactly one JSON document')
  const report = JSON.parse(stdout[0]) as CompareReport
  assert.equal(report.verdict, 'pass')
  assert.equal(report.result, 'pass')
  assert.equal(stderr.length, 0, 'no diagnostics for a clean pass')
})

test('compare exits 1 on a real regression and keeps stdout valid JSON (diagnostics on stderr)', async (t) => {
  const { stdout, stderr } = captureConsole(t)
  const main = await loadMain()
  const files = await writeReports({ base: singleReport(80), cur: singleReport(50) })

  const exit = await main(['node', 'aeo-audit', 'compare', '--baseline', files.base, '--current', files.cur])

  assert.equal(exit, 1)
  const report = JSON.parse(stdout[0]) as CompareReport
  assert.equal(report.verdict, 'fail')
  assert.equal(report.result, 'regression')
  assert.ok(stderr.some((line) => line.includes('Regression:')), 'human reasons go to stderr')
})

test('compare --report-only never exits non-zero even with a regression', async (t) => {
  captureConsole(t)
  const main = await loadMain()
  const files = await writeReports({ base: singleReport(80), cur: singleReport(20) })

  const exit = await main([
    'node',
    'aeo-audit',
    'compare',
    '--baseline',
    files.base,
    '--current',
    files.cur,
    '--report-only',
  ])

  assert.equal(exit, 0)
})

test('compare exits 2 on a report-mode mismatch (single vs sitemap)', async (t) => {
  const { stderr } = captureConsole(t)
  const main = await loadMain()
  const files = await writeReports({ base: sitemapReport(80), cur: singleReport(80) })

  const exit = await main(['node', 'aeo-audit', 'compare', '--baseline', files.base, '--current', files.cur])

  assert.equal(exit, 2)
  assert.ok(stderr.some((line) => line.includes('COMPARE_MISCONFIG')))
})

test('compare exits 2 when --current is missing', async (t) => {
  captureConsole(t)
  const main = await loadMain()
  const exit = await main(['node', 'aeo-audit', 'compare'])
  assert.equal(exit, 2)
})

test('compare exits 2 when a report file cannot be read', async (t) => {
  captureConsole(t)
  const main = await loadMain()
  const exit = await main(['node', 'aeo-audit', 'compare', '--current', '/nonexistent/aeo-report-xyz.json'])
  assert.equal(exit, 2)
})

test('compare with no baseline passes (first run) and reports no-baseline', async (t) => {
  const { stdout } = captureConsole(t)
  const main = await loadMain()
  const files = await writeReports({ cur: singleReport(72) })

  const exit = await main(['node', 'aeo-audit', 'compare', '--current', files.cur])

  assert.equal(exit, 0)
  const report = JSON.parse(stdout[0]) as CompareReport
  assert.equal(report.result, 'no-baseline')
})

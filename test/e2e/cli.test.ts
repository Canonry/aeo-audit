import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

import { strongHtml, defaultAuxiliary } from '../fixtures/pages.js'
import type { AuditReport } from '../../src/types.js'

const FIXED_NOW = '2026-03-08T12:00:00.000Z'
const FIXTURE_URL = 'http://1.1.1.1'
const FIXTURE_ORIGIN = `${FIXTURE_URL}/`
const RealDate = Date

interface MockHttpResponse {
  status: number
  contentType: string
  body: string
  headers?: Record<string, string>
}

class FixedDate extends Date {
  constructor(value?: string | number | Date) {
    super(value ?? FIXED_NOW)
  }

  static override now(): number {
    return new RealDate(FIXED_NOW).getTime()
  }

  static override parse(value: string): number {
    return RealDate.parse(value)
  }

  static override UTC(...args: Parameters<typeof Date.UTC>): number {
    return RealDate.UTC(...args)
  }
}

function installMockClock(t: TestContext): void {
  const realDate = globalThis.Date
  globalThis.Date = FixedDate as DateConstructor
  t.after(() => {
    globalThis.Date = realDate
  })
}

function buildMockResponses(): Map<string, MockHttpResponse> {
  const robotsBody = `${defaultAuxiliary.robotsTxt?.body ?? ''}\n\nUser-agent: OAI-SearchBot\nAllow: /\n\nUser-agent: Google-Extended\nAllow: /\n\nSitemap: ${FIXTURE_ORIGIN}sitemap.xml`

  return new Map<string, MockHttpResponse>([
    [`${FIXTURE_ORIGIN}`, {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: strongHtml,
      headers: {
        'last-modified': 'Wed, 21 Feb 2026 10:00:00 GMT',
      },
    }],
    [`${FIXTURE_ORIGIN}llms.txt`, {
      status: 200,
      contentType: 'text/plain; charset=utf-8',
      body: defaultAuxiliary.llmsTxt?.body ?? '',
    }],
    [`${FIXTURE_ORIGIN}llms-full.txt`, {
      status: 200,
      contentType: 'text/plain; charset=utf-8',
      body: defaultAuxiliary.llmsFullTxt?.body ?? '',
    }],
    [`${FIXTURE_ORIGIN}robots.txt`, {
      status: 200,
      contentType: 'text/plain; charset=utf-8',
      body: robotsBody,
    }],
    [`${FIXTURE_ORIGIN}sitemap.xml`, {
      status: 200,
      contentType: 'application/xml; charset=utf-8',
      body: defaultAuxiliary.sitemapXml?.body ?? '',
    }],
  ])
}

function installMockFetch(t: TestContext): void {
  const responses = buildMockResponses()
  const realFetch = globalThis.fetch

  globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const match = responses.get(url)

    if (!match) {
      throw new Error(`Unexpected URL requested in e2e test: ${url}`)
    }

    return new Response(match.body, {
      status: match.status,
      headers: {
        'content-type': match.contentType,
        ...(match.headers ?? {}),
      },
    })
  }

  t.after(() => {
    globalThis.fetch = realFetch
  })
}

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

test('--require-meta forces exit 1 when the fixture has no <meta name="description">', async (t) => {
  installMockClock(t)
  installMockFetch(t)
  const { stdout, stderr } = captureConsole(t)
  const { main } = await import(new URL('../../dist/cli.js', import.meta.url).href)

  const exitCode = await main([
    'node',
    'aeo-audit',
    FIXTURE_URL,
    '--format',
    'json',
    '--require-meta',
  ])

  assert.equal(exitCode, 1, 'expected exit 1 because fixture HTML has no meta description')
  assert.equal(stdout.length, 1, 'report still printed before failure')
  assert.ok(
    stderr.some((line) => line.includes('--require-meta failed')),
    'stderr should mention --require-meta failure',
  )

  const report = JSON.parse(stdout[0]) as AuditReport
  assert.ok(
    report.overallScore >= 70,
    'sanity check: fixture would otherwise pass the score-based exit rule',
  )
})

test('compiled CLI returns the expected JSON report for the fixture site', async (t) => {
  installMockClock(t)
  installMockFetch(t)
  const { stdout, stderr } = captureConsole(t)
  const { main } = await import(new URL('../../dist/cli.js', import.meta.url).href)

  const exitCode = await main([
    'node',
    'aeo-audit',
    FIXTURE_URL,
    '--format',
    'json',
    '--include-geo',
  ])

  assert.equal(exitCode, 0)
  assert.deepEqual(stderr, [])
  assert.equal(stdout.length, 1)

  const report = JSON.parse(stdout[0]) as AuditReport

  assert.equal(report.url, FIXTURE_ORIGIN)
  assert.equal(report.finalUrl, FIXTURE_ORIGIN)
  assert.equal(report.auditedAt, FIXED_NOW)
  assert.equal(report.overallScore, 76)
  assert.equal(report.overallGrade, 'C')
  assert.equal(
    report.summary,
    'Overall grade C. Strongest signals: AI-Readable Content, Schema Validity. Biggest opportunities: Schema Completeness, E-E-A-T Signals.',
  )
  assert.deepEqual(report.metadata, {
    fetchTimeMs: 0,
    pageTitle: 'AI NYC | Answer Engine Optimization',
    wordCount: 74,
    auxiliary: {
      llmsTxt: 'ok',
      llmsFullTxt: 'ok',
      robotsTxt: 'ok',
      sitemapXml: 'ok',
    },
    redirectChain: [],
  })
  assert.deepEqual(
    report.factors.map((factor) => ({
      id: factor.id,
      score: factor.score,
      grade: factor.grade,
      status: factor.status,
    })),
    [
      { id: 'structured-data', score: 78, grade: 'C+', status: 'pass' },
      { id: 'content-depth', score: 59, grade: 'F', status: 'partial' },
      { id: 'ai-readable-content', score: 100, grade: 'A+', status: 'pass' },
      { id: 'eeat-signals', score: 25, grade: 'F', status: 'fail' },
      { id: 'faq-content', score: 82, grade: 'B-', status: 'pass' },
      { id: 'citations', score: 66, grade: 'D', status: 'partial' },
      { id: 'schema-completeness', score: 45, grade: 'F', status: 'partial' },
      { id: 'schema-validity', score: 100, grade: 'A+', status: 'pass' },
      { id: 'entity-consistency', score: 94, grade: 'A', status: 'pass' },
      { id: 'content-freshness', score: 82, grade: 'B-', status: 'pass' },
      { id: 'content-extractability', score: 48, grade: 'F', status: 'partial' },
      { id: 'definition-blocks', score: 100, grade: 'A+', status: 'pass' },
      { id: 'ai-crawler-access', score: 100, grade: 'A+', status: 'pass' },
      { id: 'named-entities', score: 84, grade: 'B', status: 'pass' },
      { id: 'technical-seo', score: 80, grade: 'B-', status: 'pass' },
      { id: 'snippet-eligibility', score: 100, grade: 'A+', status: 'pass' },
      { id: 'geographic-signals', score: 94, grade: 'A', status: 'pass' },
    ],
  )
})

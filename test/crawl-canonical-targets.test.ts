import { afterEach, expect, test, vi } from 'vitest'
import { runAeoAudit, runSiteCrawl } from '../src/index.js'
import type { AuditReport, SiteCrawlOptions } from '../src/types.js'

const root = 'https://1.1.1.1/'
const requested: string[] = []
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); requested.length = 0 })

function site(canonicals: string[], target?: (url: URL, init?: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    requested.push(url.href)
    if (url.href === root) return new Response(`<html><head>${canonicals.map((href) => `<link rel="canonical" href="${href}">`).join('')}</head><body>Example</body></html>`, { headers: { 'content-type': 'text/html' } })
    if (url.pathname.startsWith('/canonical')) return target?.(url, init) ?? new Response(null, { status: 204 })
    return new Response(null, { status: 404 })
  }))
}

const options: SiteCrawlOptions = { requestDelayMs: 0, maxFetchRetries: 0, factors: ['entity-consistency', 'technical-seo'] }
const codes = (audit: AuditReport | null) => audit?.factors.flatMap((factor) => factor.findings.map((finding) => finding.code)) ?? []

test.each([undefined, ['technical-seo']] as const)('crawl and single-page audits probe canonical redirects with factors %j', async (factors) => {
  site(['/canonical-old'], (url) => url.pathname === '/canonical-old'
    ? new Response(null, { status: 301, headers: { location: '/canonical-missing' } })
    : new Response(null, { status: 404 }))
  const single = await runAeoAudit(root, { factors: factors ? [...factors] : undefined })
  requested.length = 0
  const report = await runSiteCrawl(root, { ...options, factors: factors ? [...factors] : undefined })
  if (report.mode !== 'full') throw new Error('Expected pages')
  const expected = ['technical-seo.canonical.redirected', 'technical-seo.canonical.unreachable']
  expect(codes(single)).toEqual(expect.arrayContaining(expected))
  expect(codes(report.pages.find((page) => page.finalUrl === root)!.audit)).toEqual(expect.arrayContaining(expected))
  expect(report.summary.fetchesStarted).toBe(requested.length)
})

test('self canonicals reuse the fetched response; unrelated factors make no target requests', async () => {
  site([root])
  await runSiteCrawl(root, options)
  expect(requested.filter((url) => url === root)).toHaveLength(1)
  requested.length = 0
  site(['/canonical-other'])
  await runSiteCrawl(root, { ...options, factors: ['content-depth'] })
  expect(requested).not.toContain(`${root}canonical-other`)
})

test('probes at most five distinct targets per page and counts them in the crawl budget', async () => {
  site(Array.from({ length: 6 }, (_, i) => `/canonical-${i}`))
  const report = await runSiteCrawl(root, options)
  expect(requested.filter((url) => url.includes('/canonical-'))).toEqual(Array.from({ length: 5 }, (_, i) => `${root}canonical-${i}`))
  expect(report.summary.fetchesStarted).toBe(requested.length)
})

test('budget exhaustion keeps the fetched page audit without inventing an unreachable target', async () => {
  site(['/canonical-other'])
  const report = await runSiteCrawl(root, { ...options, maxFetches: 1 })
  if (report.mode !== 'full') throw new Error('Expected pages')
  expect(report.summary).toMatchObject({ complete: false, terminationReason: 'max-fetches', fetchesStarted: 1 })
  expect(requested).toEqual([root])
  const audit = report.pages.find((page) => page.finalUrl === root)!.audit
  expect(codes(audit)).toContain('entity-consistency.canonical.present')
  expect(codes(audit)).not.toContain('entity-consistency.canonical.unreachable')
})

test('canonical redirects cannot reach a private host', async () => {
  site(['/canonical-other'], () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }))
  const report = await runSiteCrawl(root, options)
  if (report.mode !== 'full') throw new Error('Expected pages')
  expect(requested.some((url) => url.includes('127.0.0.1'))).toBe(false)
  expect(codes(report.pages.find((page) => page.finalUrl === root)!.audit)).toContain('entity-consistency.canonical.unreachable')
})

test('a canonical probe cannot outlive the crawl deadline', async () => {
  vi.useFakeTimers()
  let aborted = false
  site(['/canonical-slow'], (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => { aborted = true; reject(init.signal!.reason) })
  }))
  const pending = runSiteCrawl(root, { ...options, maxDurationMs: 100 })
  await vi.advanceTimersByTimeAsync(101)
  const report = await pending
  expect(aborted).toBe(true)
  expect(report.summary).toMatchObject({ complete: false, terminationReason: 'max-duration' })
  if (report.mode !== 'full') throw new Error('Expected pages')
  expect(codes(report.pages.find((page) => page.finalUrl === root)!.audit)).toContain('entity-consistency.canonical.present')
})

test('budget exhaustion waits for an already dispatched canonical probe before publishing', async () => {
  vi.useFakeTimers()
  site(['/canonical-first', '/canonical-second'], () => new Promise<Response>((resolve) => {
    setTimeout(() => resolve(new Response(null, { status: 204 })), 20)
  }))
  let completed = false
  const pending = runSiteCrawl(root, { ...options, maxFetches: 7 }).then((report) => {
    completed = true
    return report
  })
  await vi.advanceTimersByTimeAsync(19)
  expect(requested.filter((url) => url.includes('/canonical-'))).toEqual([`${root}canonical-first`])
  expect(completed).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  const report = await pending
  expect(report.summary).toMatchObject({ complete: false, terminationReason: 'max-fetches', fetchesStarted: 7 })
})

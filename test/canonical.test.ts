import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'

import { auditHtmlPage, runAeoAudit } from '../src/index.js'
import type { AuditReport, RunAeoAuditOptions, ScoredFactor } from '../src/types.js'
import { AeoAuditError } from '../src/errors.js'
import { FetchBudgetController } from '../src/fetch-page.js'

afterEach(() => vi.unstubAllGlobals())

const ORIGIN = 'https://1.1.1.1'
const PAGE_URL = `${ORIGIN}/page`
const AUXILIARY_PATHS = new Set(['/llms.txt', '/llms-full.txt', '/robots.txt', '/sitemap.xml', '/sitemap-index.xml'])
type Route = () => Response | Promise<Response>

function pageHtml(head: string, body = ''): string {
  return `<!doctype html><html><head>
    <title>Canonical Test | An intentionally long title used to isolate canonical scoring without changing other entity scores</title>${head}
    <script type="application/ld+json">{"@type":"Organization","name":"Canonical Test","email":"hello@example.com"}</script>
  </head><body><p>Contact hello@example.com.</p>${body}</body></html>`
}

function htmlResponse(head: string, status = 200, body = ''): Response {
  return new Response(pageHtml(head, body), { status, headers: { 'content-type': 'text/html' } })
}

function mockRequests(routes: Record<string, Route>): string[] {
  const requested: string[] = []
  const implementation = async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString()
    requested.push(url)
    const route = routes[url]
    if (route) return route()
    if (AUXILIARY_PATHS.has(new URL(url).pathname)) return new Response('', { status: 404 })
    assert.fail(`Unexpected request: ${url}`)
  }
  vi.stubGlobal('fetch', vi.fn(implementation))
  return requested
}

function entityFactor(report: AuditReport): ScoredFactor {
  const factor = report.factors.find((entry) => entry.id === 'entity-consistency')
  assert.ok(factor)
  return factor
}

function assertFinding(factor: ScoredFactor, type: string, message: RegExp): void {
  assert.ok(factor.findings.some((finding) => finding.type === type && message.test(finding.message)))
}

test('audit reuses its successful main response for a self canonical and preserves report metadata', async () => {
  const requested = mockRequests({
    [PAGE_URL]: () => htmlResponse('<link rel="canonical" href="/page">'),
  })
  const report = await runAeoAudit(PAGE_URL, { factors: ['entity-consistency'] })
  const factor = entityFactor(report)

  assert.equal(factor.score, 100)
  assertFinding(factor, 'found', /Canonical target .*HTTP 200/)
  assert.equal(requested.filter((url) => url === PAGE_URL).length, 1)
  assert.equal(requested.length, 6)
  assert.deepEqual(Object.keys(report).sort(), [
    'auditedAt', 'compareMeta', 'criticalDefects', 'factors', 'finalUrl', 'metadata', 'overallScore', 'schemaVersion', 'summary', 'url',
  ])
  assert.deepEqual(Object.keys(report.metadata).sort(), [
    'auxiliary', 'fetchTimeMs', 'internalLinks', 'metaDescription', 'pageTitle', 'redirectChain', 'wordCount',
  ])
  assert.deepEqual(report.metadata.auxiliary, {
    llmsTxt: 'missing', llmsFullTxt: 'missing', robotsTxt: 'missing', sitemapXml: 'missing',
  })
})

test('audit reuses the main 404 status as a broken self canonical', async () => {
  const requested = mockRequests({
    [PAGE_URL]: () => htmlResponse('<link rel="canonical" href="/page">', 404),
  })
  const factor = entityFactor(await runAeoAudit(PAGE_URL, { factors: ['entity-consistency'] }))

  assert.equal(factor.score, 80)
  assertFinding(factor, 'unreachable', /Canonical target .*HTTP 404/)
  assert.equal(requested.filter((url) => url === PAGE_URL).length, 1)
  assert.equal(requested.length, 6)
})

for (const status of [404, 500]) {
  test(`audit penalizes a canonical target returning HTTP ${status}`, async () => {
    const targetUrl = `${ORIGIN}/target`
    const requested = mockRequests({
      [PAGE_URL]: () => htmlResponse('<link rel="canonical" href="/target">'),
      [targetUrl]: () => new Response('', { status }),
    })
    const factor = entityFactor(await runAeoAudit(PAGE_URL, { factors: ['entity-consistency'] }))

    assert.equal(factor.score, 80)
    assertFinding(factor, 'unreachable', new RegExp(`Canonical target .*HTTP ${status}`))
    assert.equal(requested.filter((url) => url === targetUrl).length, 1)
  })
}

test('audit reports and penalizes a canonical redirect even when the destination is reachable', async () => {
  const targetUrl = `${ORIGIN}/target`
  const destinationUrl = `${ORIGIN}/destination`
  const requested = mockRequests({
    [PAGE_URL]: () => htmlResponse('<link rel="canonical" href="/target">'),
    [targetUrl]: () => new Response(null, { status: 301, headers: { location: '/destination' } }),
    [destinationUrl]: () => new Response('Successful destination', { status: 200 }),
  })
  const factor = entityFactor(await runAeoAudit(PAGE_URL, { factors: ['entity-consistency'] }))

  assert.equal(factor.score, 90)
  assertFinding(factor, 'info', /Canonical URL .*redirects \(1 hop\).*destination/)
  assertFinding(factor, 'found', /Canonical target .*HTTP 200/)
  assert.ok(factor.recommendations.includes('Point the canonical tag directly to the final destination URL.'))
  assert.equal(requested.filter((url) => url === targetUrl || url === destinationUrl).length, 2)
})

test('a canonical target timeout remains an uncertain finding and does not abort the audit', async () => {
  mockRequests({
    [PAGE_URL]: () => htmlResponse('<link rel="canonical" href="/target">'),
    [`${ORIGIN}/target`]: () => { throw new AeoAuditError('TIMEOUT', 'Canonical request timed out.') },
  })
  const factor = entityFactor(await runAeoAudit(PAGE_URL, { factors: ['entity-consistency'] }))

  assert.equal(factor.score, 90)
  assertFinding(factor, 'timeout', /Canonical target .*timed out/)
  assert.ok(!factor.findings.some((finding) => finding.type === 'unreachable'))
})

test('audit skips canonical target requests when Entity Consistency is excluded', async () => {
  const requested = mockRequests({
    [PAGE_URL]: () => htmlResponse('<link rel="canonical" href="/target">'),
  })
  const report = await runAeoAudit(PAGE_URL, { factors: ['structured-data'] })

  assert.deepEqual(report.factors.map((factor) => factor.id), ['structured-data'])
  assert.equal(requested.length, 6)
  assert.ok(!requested.includes(`${ORIGIN}/target`))
})

test('audit scores and probes only active head canonicals', async () => {
  const ignoredLinks = ['media', 'hreflang', 'lang', 'type'].map((attribute) => `<link rel="canonical" href="/${attribute}" ${attribute}>`).join('')
  const requested = mockRequests({
    [PAGE_URL]: () => htmlResponse(
      `<link rel="canonical" href="/page"><template><link rel="canonical" href="/template"></template>${ignoredLinks}`,
      200,
      '<link rel="canonical" href="/body"><template><link rel="canonical" href="/body-template"></template>',
    ),
  })
  const factor = entityFactor(await runAeoAudit(PAGE_URL, { factors: ['entity-consistency'] }))

  assert.equal(factor.score, 100)
  assertFinding(factor, 'info', /Canonical tag is ignored/)
  assert.ok(!factor.findings.some((finding) => /Duplicate|Conflicting/.test(finding.message)))
  assert.equal(requested.length, 6)
})

test('audit reports a missing canonical when all declarations are ignored without probing them', async () => {
  const requested = mockRequests({
    [PAGE_URL]: () => htmlResponse(
      '<template><link rel="canonical" href="/template"></template><link rel="canonical" href="/alternate" hreflang="en">',
      200,
      '<link rel="canonical" href="/body">',
    ),
  })
  const factor = entityFactor(await runAeoAudit(PAGE_URL, { factors: ['entity-consistency'] }))

  assert.equal(factor.score, 80)
  assertFinding(factor, 'missing', /Canonical URL tag is missing/)
  assertFinding(factor, 'info', /Canonical tag is ignored/)
  assert.equal(requested.length, 6)
})

for (const href of ['', 'http://[', 'ftp://1.1.1.1/file', 'javascript:alert(1)', '/page#section', 'https://user:password@1.1.1.1/page']) {
  test(`audit reports invalid canonical href ${JSON.stringify(href)} without requesting it`, async () => {
    const requested = mockRequests({
      [PAGE_URL]: () => htmlResponse(`<link rel="canonical" href="${href}">`),
    })
    const factor = entityFactor(await runAeoAudit(PAGE_URL, { factors: ['entity-consistency'] }))

    assert.equal(factor.score, 80)
    assertFinding(factor, 'missing', /Invalid canonical URL/)
    assert.equal(requested.length, 6)
  })
}

for (const [href, targetUrl] of [
  ['/target&nbsp;', `${ORIGIN}/target%C2%A0`],
  ['&nbsp;/target', `${ORIGIN}/%C2%A0/target`],
  ['&nbsp;https://8.8.8.8/target', `${ORIGIN}/%C2%A0https://8.8.8.8/target`],
]) {
  test(`audit probes the URL with preserved non-ASCII whitespace in ${href}`, async () => {
    const requested = mockRequests({
      [PAGE_URL]: () => htmlResponse(`<link rel="canonical" href="${href}">`),
      [targetUrl]: () => new Response('', { status: 200 }),
    })
    const factor = entityFactor(await runAeoAudit(PAGE_URL, { factors: ['entity-consistency'] }))

    assert.equal(factor.score, 100)
    assertFinding(factor, 'found', /Canonical target .*HTTP 200/)
    assert.equal(requested.filter((url) => url === targetUrl).length, 1)
    assert.equal(requested.length, 7)
  })
}

test('audit reports Unicode-whitespace canonical variants as conflicts and probes both distinct targets', async () => {
  const targetUrl = `${ORIGIN}/target`
  const whitespaceTargetUrl = `${ORIGIN}/target%C2%A0`
  const requested = mockRequests({
    [PAGE_URL]: () => htmlResponse('<link rel="canonical" href="/target"><link rel="canonical" href="/target&nbsp;">'),
    [targetUrl]: () => new Response('', { status: 200 }),
    [whitespaceTargetUrl]: () => new Response('', { status: 200 }),
  })
  const factor = entityFactor(await runAeoAudit(PAGE_URL, { factors: ['entity-consistency'] }))

  assert.equal(factor.score, 80)
  assertFinding(factor, 'missing', /Conflicting canonical tags/)
  assert.ok(!factor.findings.some((finding) => /Duplicate canonical tags/.test(finding.message)))
  assert.equal(requested.filter((url) => url === targetUrl).length, 1)
  assert.equal(requested.filter((url) => url === whitespaceTargetUrl).length, 1)
  assert.equal(requested.length, 8)
})

test('audit neither credits nor probes a rel value separated by non-ASCII whitespace', async () => {
  const requested = mockRequests({
    [PAGE_URL]: () => htmlResponse('<link rel="canonical&nbsp;alternate" href="/target">'),
  })
  const factor = entityFactor(await runAeoAudit(PAGE_URL, { factors: ['entity-consistency'] }))

  assert.equal(factor.score, 80)
  assertFinding(factor, 'missing', /Canonical URL tag is missing/)
  assert.equal(requested.length, 6)
})

test('audit accepts ASCII-separated rel tokens alongside an unrelated non-ASCII rel value', async () => {
  const targetUrl = `${ORIGIN}/target`
  const requested = mockRequests({
    [PAGE_URL]: () => htmlResponse('<link rel="canonical&nbsp;alternate" href="/ignored"><link rel="alternate\t\n\f\r CANONICAL" href="/target">'),
    [targetUrl]: () => new Response('', { status: 200 }),
  })
  const factor = entityFactor(await runAeoAudit(PAGE_URL, { factors: ['entity-consistency'] }))

  assert.equal(factor.score, 100)
  assertFinding(factor, 'found', /Canonical target .*HTTP 200/)
  assert.ok(!factor.findings.some((finding) => /Duplicate|Conflicting/.test(finding.message)))
  assert.equal(requested.filter((url) => url === targetUrl).length, 1)
  assert.equal(requested.length, 7)
})

test('audit reports duplicate canonical declarations and requests each distinct URL once', async () => {
  const targetUrl = `${ORIGIN}/target`
  const requested = mockRequests({
    [PAGE_URL]: () => htmlResponse(`<link rel="canonical" href="/target"><link rel="alternate CANONICAL" href="${targetUrl}">`),
    [targetUrl]: () => new Response('', { status: 200 }),
  })
  const factor = entityFactor(await runAeoAudit(PAGE_URL, { factors: ['entity-consistency'] }))

  assert.equal(factor.score, 90)
  assertFinding(factor, 'info', /Duplicate canonical tags/)
  assert.equal(requested.filter((url) => url === targetUrl).length, 1)
  assert.equal(requested.length, 7)
})

test('audit reports conflicting canonical declarations and deduplicates repeated targets', async () => {
  const targetA = `${ORIGIN}/target-a`
  const targetB = `${ORIGIN}/target-b`
  const requested = mockRequests({
    [PAGE_URL]: () => htmlResponse('<link rel="canonical" href="/target-a"><link rel="canonical" href="/target-a"><link rel="canonical" href="/target-b">'),
    [targetA]: () => new Response('', { status: 200 }),
    [targetB]: () => new Response('', { status: 200 }),
  })
  const factor = entityFactor(await runAeoAudit(PAGE_URL, { factors: ['entity-consistency'] }))

  assert.equal(factor.score, 80)
  assertFinding(factor, 'missing', /Conflicting canonical tags.*target-a.*target-b/)
  assert.equal(requested.filter((url) => url === targetA).length, 1)
  assert.equal(requested.filter((url) => url === targetB).length, 1)
  assert.equal(requested.length, 8)
})

test('audit limits canonical target checks to the first five distinct URLs', async () => {
  const targetUrls = Array.from({ length: 7 }, (_, index) => `${ORIGIN}/target-${index + 1}`)
  const routes: Record<string, Route> = {
    [PAGE_URL]: () => htmlResponse(targetUrls.map((url) => `<link rel="canonical" href="${url}">`).join('')),
  }
  for (const url of targetUrls.slice(0, 5)) routes[url] = () => new Response('', { status: 200 })
  const requested = mockRequests(routes)
  const factor = entityFactor(await runAeoAudit(PAGE_URL, { factors: ['entity-consistency'] }))

  assertFinding(factor, 'info', /Canonical target checks are limited to the first 5 distinct URLs/)
  assert.deepEqual(requested.filter((url) => targetUrls.includes(url)).sort(), targetUrls.slice(0, 5))
  assert.equal(requested.length, 11)
})

test('audit resolves relative canonical URLs against the final audited URL after a redirect', async () => {
  const finalUrl = `${ORIGIN}/section/page`
  const targetUrl = `${ORIGIN}/section/target`
  const requested = mockRequests({
    [PAGE_URL]: () => new Response(null, { status: 302, headers: { location: '/section/page' } }),
    [finalUrl]: () => htmlResponse('<link rel="canonical" href="target">'),
    [targetUrl]: () => new Response('', { status: 200 }),
  })
  const report = await runAeoAudit(PAGE_URL, { factors: ['entity-consistency'] })

  assert.equal(report.finalUrl, finalUrl)
  assert.equal(entityFactor(report).score, 100)
  assert.ok(requested.includes(targetUrl))
})

test('audit resolves a canonical URL using the first base href', async () => {
  const targetUrl = `${ORIGIN}/assets/target`
  const requested = mockRequests({
    [PAGE_URL]: () => htmlResponse('<base href="/assets/"><base href="/wrong/"><link rel="canonical" href="target">'),
    [targetUrl]: () => new Response('', { status: 200 }),
  })
  const factor = entityFactor(await runAeoAudit(PAGE_URL, { factors: ['entity-consistency'] }))

  assert.equal(factor.score, 100)
  assert.ok(requested.includes(targetUrl))
  assert.ok(!requested.includes(`${ORIGIN}/wrong/target`))
})

test('audit ignores base URLs inside inert template content', async () => {
  const targetUrl = `${ORIGIN}/active/target`
  const requested = mockRequests({
    [PAGE_URL]: () => htmlResponse('<template><base href="/wrong/"></template><base href="/active/"><link rel="canonical" href="target">'),
    [targetUrl]: () => new Response('', { status: 200 }),
  })
  const factor = entityFactor(await runAeoAudit(PAGE_URL, { factors: ['entity-consistency'] }))

  assert.equal(factor.score, 100)
  assert.ok(requested.includes(targetUrl))
  assert.ok(!requested.includes(`${ORIGIN}/wrong/target`))
})


test('pure HTML audits validate canonical markup without network requests', async () => {
  const fetchMock = vi.fn(async () => { throw new Error('pure audits must not fetch') })
  vi.stubGlobal('fetch', fetchMock)
  const report = await auditHtmlPage({
    inputUrl: PAGE_URL,
    finalUrl: PAGE_URL,
    html: pageHtml('<link rel="canonical" href="/target">'),
    headers: {},
    redirectChain: [],
    auxiliary: {},
    fetchTimeMs: 0,
  }, { factors: ['entity-consistency'] })

  assert.equal(entityFactor(report).score, 100)
  assert.equal(fetchMock.mock.calls.length, 0)
  assert.ok(!entityFactor(report).findings.some((finding) => /Canonical target .*HTTP/.test(finding.message)))
})

test('pure HTML audits apply supplied canonical target evidence without fetching', async () => {
  const fetchMock = vi.fn(async () => { throw new Error('pure audits must not fetch') })
  vi.stubGlobal('fetch', fetchMock)
  const targetUrl = `${ORIGIN}/target`
  const report = await auditHtmlPage({
    inputUrl: PAGE_URL,
    finalUrl: PAGE_URL,
    html: pageHtml('<link rel="canonical" href="/target">'),
    headers: {},
    redirectChain: [],
    auxiliary: {},
    fetchTimeMs: 0,
    canonicalTargets: {
      [targetUrl]: { state: 'unreachable', url: targetUrl, statusCode: 404, redirectChain: [] },
    },
  }, { factors: ['entity-consistency'] })

  assert.equal(entityFactor(report).score, 80)
  assertFinding(entityFactor(report), 'unreachable', /Canonical target .*HTTP 404/)
  assert.equal(fetchMock.mock.calls.length, 0)
})

test('audit forwards its observer to canonical requests and awaits it before fetch', async () => {
  const targetUrl = `${ORIGIN}/target`
  const observed: string[] = []
  mockRequests({
    [PAGE_URL]: () => htmlResponse('<link rel="canonical" href="/target">'),
    [targetUrl]: () => {
      assert.ok(observed.includes(targetUrl))
      return new Response(null, { status: 200 })
    },
  })

  await runAeoAudit(PAGE_URL, {
    factors: ['entity-consistency'],
    onOutboundAttempt: async (attempt) => {
      if (attempt.kind === 'canonical') observed.push(attempt.url)
    },
  })
  assert.deepEqual(observed, [targetUrl])
})

test('audit forwards caller cancellation to canonical requests unchanged', async () => {
  const controller = new AbortController()
  const reason = new Error('cancel the canonical check')
  mockRequests({
    [PAGE_URL]: () => htmlResponse('<link rel="canonical" href="/target">'),
    [`${ORIGIN}/target`]: () => {
      controller.abort(reason)
      throw reason
    },
  })

  await assert.rejects(runAeoAudit(PAGE_URL, {
    factors: ['entity-consistency'],
    signal: controller.signal,
  }), (error) => error === reason)
})

test('audit forwards its shared outbound budget to canonical requests', async () => {
  const budget = new FetchBudgetController({ maxFetches: 6 })
  const requested = mockRequests({
    [PAGE_URL]: () => htmlResponse('<link rel="canonical" href="/target">'),
  })

  await assert.rejects(runAeoAudit(PAGE_URL, {
    factors: ['entity-consistency'],
    budget,
  } as RunAeoAuditOptions & { budget: FetchBudgetController }), (error) => {
    assert.ok(error && typeof error === 'object' && 'code' in error)
    assert.equal(error.code, 'BUDGET_EXCEEDED')
    return true
  })
  assert.equal(budget.fetchesStarted, 6)
  assert.ok(!requested.includes(`${ORIGIN}/target`))
})

test('audit forwards allowPrivateHost to the canonical target check', async () => {
  const pageUrl = 'http://127.0.0.1/page'
  const targetUrl = 'http://127.0.0.1/target'
  const requested = mockRequests({
    [pageUrl]: () => htmlResponse('<link rel="canonical" href="/target">'),
    [targetUrl]: () => new Response(null, { status: 200 }),
  })

  const factor = entityFactor(await runAeoAudit(pageUrl, {
    factors: ['entity-consistency'],
    allowPrivateHost: '127.0.0.1',
  }))
  assert.equal(factor.score, 100)
  assert.ok(requested.includes(targetUrl))
})

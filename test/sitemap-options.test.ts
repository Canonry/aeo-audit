import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Capture the options runSitemapAudit hands to each per-page runAgentReadinessAudit call so
// we can assert opt-in factor flags are forwarded. vi.hoisted lets the hoisted
// vi.mock factory reference the spy.
const runAgentReadinessAuditMock = vi.hoisted(() => vi.fn())

vi.mock('../src/index.js', () => ({
  runAgentReadinessAudit: runAgentReadinessAuditMock,
}))

// Imported after vi.mock so sitemap.js picks up the mocked runAgentReadinessAudit.
import { runSitemapAudit } from '../src/sitemap.js'

const SITEMAP_URL = 'http://1.1.1.1/sitemap.xml'
const PAGE_URL = 'http://1.1.1.1/'

const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${PAGE_URL}</loc></url>
</urlset>`

function sitemapXml(urls: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((url) => `  <url><loc>${url}</loc></url>`).join('\n')}
</urlset>`
}

function fakeReport(url: string) {
  return {
    url,
    finalUrl: url,
    auditedAt: '2026-01-01T00:00:00.000Z',
    overallScore: 90,
    summary: '',
    factors: [],
    metadata: {
      fetchTimeMs: 0,
      pageTitle: '',
      wordCount: 0,
      metaDescription: null,
      internalLinks: [],
      auxiliary: { llmsTxt: 'missing', llmsFullTxt: 'missing', robotsTxt: 'missing', sitemapXml: 'missing' },
      redirectChain: [],
    },
  }
}

beforeEach(() => {
  runAgentReadinessAuditMock.mockReset()
  runAgentReadinessAuditMock.mockImplementation((url: string) => Promise.resolve(fakeReport(url)))
  // Serve the sitemap XML for the sitemap fetch (fetchSitemapResponse uses global fetch).
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(SITEMAP_XML, { status: 200, headers: { 'content-type': 'application/xml' } }),
  ))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('runSitemapAudit option forwarding', () => {
  it('forwards includeAgentSkills and includeGeo to per-page audits', async () => {
    await runSitemapAudit(PAGE_URL, {
      sitemapUrl: SITEMAP_URL,
      includeAgentSkills: true,
      includeGeo: true,
    })

    expect(runAgentReadinessAuditMock).toHaveBeenCalledTimes(1)
    const [auditedUrl, options] = runAgentReadinessAuditMock.mock.calls[0]
    expect(auditedUrl).toBe(PAGE_URL)
    expect(options).toMatchObject({ includeAgentSkills: true, includeGeo: true })
  })

  it('does not enable agent skills when the flag is absent', async () => {
    await runSitemapAudit(PAGE_URL, { sitemapUrl: SITEMAP_URL })

    const [, options] = runAgentReadinessAuditMock.mock.calls[0]
    expect(options.includeAgentSkills).toBeFalsy()
    expect(options.includeGeo).toBeFalsy()
  })

  it('passes a copy of the entity registry, read when the run starts, to each page', async () => {
    const entityRegistry = { entities: [{ key: 'ridge', names: ['Northwind Ridge'], urlMatchers: [{ host: '1.1.1.1', pathPrefix: '/' }] }] }
    const report = await runSitemapAudit(PAGE_URL, { sitemapUrl: SITEMAP_URL, entityRegistry })

    const [, options] = runAgentReadinessAuditMock.mock.calls[0]
    expect(options.entityRegistry).toEqual(entityRegistry)
    expect(options.entityRegistry).not.toBe(entityRegistry)
    expect(report.compareMeta?.entityCheck).toBe(true)
  })

  it('passes an explicit factor subset through to each page', async () => {
    await runSitemapAudit(PAGE_URL, {
      sitemapUrl: SITEMAP_URL,
      factors: ['agent-skill-exposure', 'structured-data'],
    })

    const [, options] = runAgentReadinessAuditMock.mock.calls[0]
    expect(options.factors).toEqual(['agent-skill-exposure', 'structured-data'])
  })

  it('never forwards includeLighthouse (excluded from sitemap mode by design)', async () => {
    // includeLighthouse is a valid (inherited) option, but runSitemapAudit must
    // drop it so PageSpeed Insights is never invoked per page.
    await runSitemapAudit(PAGE_URL, {
      sitemapUrl: SITEMAP_URL,
      includeLighthouse: true,
    })

    const [, options] = runAgentReadinessAuditMock.mock.calls[0]
    expect(options.includeLighthouse).toBeUndefined()
  })

  it('filters sitemap entries by included paths', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(`<?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>http://1.1.1.1/</loc></url>
          <url><loc>http://1.1.1.1/about/</loc></url>
          <url><loc>http://1.1.1.1/contact?ref=sitemap</loc></url>
        </urlset>`, { status: 200, headers: { 'content-type': 'application/xml' } }),
    ))

    const report = await runSitemapAudit(PAGE_URL, {
      sitemapUrl: SITEMAP_URL,
      includePaths: ['/', '/contact'],
    })

    const crawled = runAgentReadinessAuditMock.mock.calls.map((call) => call[0]).sort()
    expect(crawled).toEqual(['http://1.1.1.1/', 'http://1.1.1.1/contact?ref=sitemap'])
    expect(report.pagesDiscovered).toBe(3)
    expect(report.pagesAudited).toBe(2)
    expect(report.pagesFiltered).toBe(1)
  })

  it('returns a partial report when the cumulative fetch budget is spent before page audits start', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(sitemapXml([
        'http://1.1.1.1/',
        'http://1.1.1.1/about',
        'http://1.1.1.1/contact',
      ]), { status: 200, headers: { 'content-type': 'application/xml' } }),
    ))

    const report = await runSitemapAudit(PAGE_URL, {
      sitemapUrl: SITEMAP_URL,
      maxFetches: 1,
    })

    expect(runAgentReadinessAuditMock).not.toHaveBeenCalled()
    expect(report.pagesAudited).toBe(0)
    expect(report.pagesSkipped).toBe(3)
    expect(report.metadata?.partial).toBe(true)
    expect(report.metadata?.budget).toMatchObject({
      maxFetches: 1,
      fetchesStarted: 1,
      pagesQueued: 3,
      pagesCompleted: 0,
      pagesRemaining: 3,
      exhaustedReason: 'fetch-budget-exceeded',
    })
  })

  it('stops starting pages when the shared fetch budget is exhausted by page audits', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(sitemapXml([
        'http://1.1.1.1/',
        'http://1.1.1.1/about',
        'http://1.1.1.1/contact',
        'http://1.1.1.1/pricing',
      ]), { status: 200, headers: { 'content-type': 'application/xml' } }),
    ))
    runAgentReadinessAuditMock.mockImplementation((url: string, options?: { budget?: { consumeFetch: () => void } }) => {
      options?.budget?.consumeFetch()
      return Promise.resolve(fakeReport(url))
    })

    const report = await runSitemapAudit(PAGE_URL, {
      sitemapUrl: SITEMAP_URL,
      maxFetches: 3,
    })

    expect(runAgentReadinessAuditMock).toHaveBeenCalledTimes(2)
    expect(report.pagesAudited).toBe(2)
    expect(report.metadata?.partial).toBe(true)
    expect(report.metadata?.budget).toMatchObject({
      maxFetches: 3,
      fetchesStarted: 3,
      pagesQueued: 4,
      pagesCompleted: 2,
      pagesRemaining: 2,
      exhaustedReason: 'fetch-budget-exceeded',
    })
  })

  it('stops starting pages when the cumulative duration budget expires', async () => {
    // The budget reads Date.now(). Freezing it lets only the page audits below
    // move time, so a slow or loaded machine cannot spend the 10 ms budget
    // before the sitemap fetch or before the five workers start.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(sitemapXml(Array.from({ length: 10 }, (_, i) => `http://1.1.1.1/page-${i}`)), {
        status: 200,
        headers: { 'content-type': 'application/xml' },
      }),
    ))
    runAgentReadinessAuditMock.mockImplementation(async (url: string) => {
      // Yield first so every worker starts its page at elapsed 0, then let
      // this page take 20 ms.
      await Promise.resolve()
      vi.advanceTimersByTime(20)
      return fakeReport(url)
    })

    const report = await runSitemapAudit(PAGE_URL, {
      sitemapUrl: SITEMAP_URL,
      maxDurationMs: 10,
    })

    expect(runAgentReadinessAuditMock).toHaveBeenCalledTimes(5)
    expect(report.pagesAudited).toBe(5)
    expect(report.metadata?.partial).toBe(true)
    expect(report.metadata?.budget).toMatchObject({
      maxDurationMs: 10,
      elapsedMs: 100,
      pagesQueued: 10,
      pagesCompleted: 5,
      pagesRemaining: 5,
      exhaustedReason: 'duration-budget-exceeded',
    })
  })
})

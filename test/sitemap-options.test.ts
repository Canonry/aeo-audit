import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Capture the options runSitemapAudit hands to each per-page runAeoAudit call so
// we can assert opt-in factor flags are forwarded. vi.hoisted lets the hoisted
// vi.mock factory reference the spy.
const runAeoAuditMock = vi.hoisted(() => vi.fn())

vi.mock('../src/index.js', () => ({
  runAeoAudit: runAeoAuditMock,
}))

// Imported after vi.mock so sitemap.js picks up the mocked runAeoAudit.
import { runSitemapAudit } from '../src/sitemap.js'

const SITEMAP_URL = 'http://1.1.1.1/sitemap.xml'
const PAGE_URL = 'http://1.1.1.1/'

const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${PAGE_URL}</loc></url>
</urlset>`

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
      auxiliary: { llmsTxt: 'missing', llmsFullTxt: 'missing', robotsTxt: 'missing', sitemapXml: 'missing' },
      redirectChain: [],
    },
  }
}

beforeEach(() => {
  runAeoAuditMock.mockReset()
  runAeoAuditMock.mockImplementation((url: string) => Promise.resolve(fakeReport(url)))
  // Serve the sitemap XML for the sitemap fetch (fetchSitemapResponse uses global fetch).
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(SITEMAP_XML, { status: 200, headers: { 'content-type': 'application/xml' } }),
  ))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('runSitemapAudit option forwarding', () => {
  it('forwards includeAgentSkills and includeGeo to per-page audits', async () => {
    await runSitemapAudit(PAGE_URL, {
      sitemapUrl: SITEMAP_URL,
      includeAgentSkills: true,
      includeGeo: true,
    })

    expect(runAeoAuditMock).toHaveBeenCalledTimes(1)
    const [auditedUrl, options] = runAeoAuditMock.mock.calls[0]
    expect(auditedUrl).toBe(PAGE_URL)
    expect(options).toMatchObject({ includeAgentSkills: true, includeGeo: true })
  })

  it('does not enable agent skills when the flag is absent', async () => {
    await runSitemapAudit(PAGE_URL, { sitemapUrl: SITEMAP_URL })

    const [, options] = runAeoAuditMock.mock.calls[0]
    expect(options.includeAgentSkills).toBeFalsy()
    expect(options.includeGeo).toBeFalsy()
  })

  it('passes an explicit factor subset through to each page', async () => {
    await runSitemapAudit(PAGE_URL, {
      sitemapUrl: SITEMAP_URL,
      factors: ['agent-skill-exposure', 'structured-data'],
    })

    const [, options] = runAeoAuditMock.mock.calls[0]
    expect(options.factors).toEqual(['agent-skill-exposure', 'structured-data'])
  })

  it('never forwards includeLighthouse (excluded from sitemap mode by design)', async () => {
    // includeLighthouse is a valid (inherited) option, but runSitemapAudit must
    // drop it so PageSpeed Insights is never invoked per page.
    await runSitemapAudit(PAGE_URL, {
      sitemapUrl: SITEMAP_URL,
      includeLighthouse: true,
    })

    const [, options] = runAeoAuditMock.mock.calls[0]
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

    const crawled = runAeoAuditMock.mock.calls.map((call) => call[0]).sort()
    expect(crawled).toEqual(['http://1.1.1.1/', 'http://1.1.1.1/contact?ref=sitemap'])
    expect(report.pagesDiscovered).toBe(3)
    expect(report.pagesAudited).toBe(2)
    expect(report.pagesFiltered).toBe(1)
  })
})

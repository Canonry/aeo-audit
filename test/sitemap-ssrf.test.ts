import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Per-page audits must not run for real; capture them so we can assert which pages
// (if any) get audited after the SSRF guard has filtered the child <loc>s.
const runAeoAuditMock = vi.hoisted(() => vi.fn())
vi.mock('../src/index.js', () => ({ runAeoAudit: runAeoAuditMock }))

// Imported after vi.mock so sitemap.js picks up the mocked runAeoAudit. The
// fetch-page SSRF guard it depends on is NOT mocked — it runs for real here.
import { runSitemapAudit } from '../src/sitemap.js'

// AWS instance-metadata endpoint — the canonical SSRF target. 169.254.0.0/16 is
// link-local, so the IP guard rejects it without any DNS lookup.
const METADATA = 'http://169.254.169.254/latest/meta-data/iam/security-credentials/'

function xml(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } })
}

// Every URL the fetch layer is actually asked to retrieve. The security property
// under test: an internal-host URL never reaches fetch — the guard throws first.
let fetchedUrls: string[]

function installFetch(route: (url: string) => Response | null): void {
  fetchedUrls = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    fetchedUrls.push(url)
    return route(url) ?? new Response('', { status: 404 })
  }))
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
      auxiliary: { llmsTxt: 'missing', llmsFullTxt: 'missing', robotsTxt: 'missing', sitemapXml: 'missing' },
      redirectChain: [],
    },
  }
}

beforeEach(() => {
  runAeoAuditMock.mockReset()
  runAeoAuditMock.mockImplementation((url: string) => Promise.resolve(fakeReport(url)))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('runSitemapAudit SSRF guard', () => {
  it('never fetches a sitemap-index child <loc> that points at an internal host', async () => {
    const INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${METADATA}</loc></sitemap>
  <sitemap><loc>http://1.1.1.1/child.xml</loc></sitemap>
</sitemapindex>`
    const CHILD = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://1.1.1.1/page-1</loc></url>
</urlset>`
    installFetch((url) => {
      if (url.includes('sitemap-index.xml')) return xml(INDEX)
      if (url.includes('child.xml')) return xml(CHILD)
      return null
    })

    const report = await runSitemapAudit('http://1.1.1.1/', {
      sitemapUrl: 'http://1.1.1.1/sitemap-index.xml',
    })

    // The metadata endpoint was blocked before any request left the host.
    expect(fetchedUrls.some((u) => u.includes('169.254.169.254'))).toBe(false)
    // The public child still resolved, and only its page was audited.
    expect(fetchedUrls).toContain('http://1.1.1.1/child.xml')
    expect(runAeoAuditMock.mock.calls.map((c) => c[0])).toEqual(['http://1.1.1.1/page-1'])
    expect(report.pagesAudited).toBe(1)
  })

  it('blocks a sitemap that 302-redirects to an internal host (no auto-follow)', async () => {
    installFetch((url) => {
      if (url.includes('1.1.1.1/sitemap.xml')) {
        return new Response(null, { status: 302, headers: { location: METADATA } })
      }
      return null
    })

    await expect(
      runSitemapAudit('http://1.1.1.1/', { sitemapUrl: 'http://1.1.1.1/sitemap.xml' }),
    ).rejects.toMatchObject({ code: 'BLOCKED_IP' })

    expect(fetchedUrls).toContain('http://1.1.1.1/sitemap.xml')
    expect(fetchedUrls.some((u) => u.includes('169.254.169.254'))).toBe(false)
    expect(runAeoAuditMock).not.toHaveBeenCalled()
  })

  it('allowPrivateHost opts in the named host but still blocks a different private host', async () => {
    const INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>http://127.0.0.1/child.xml</loc></sitemap>
  <sitemap><loc>http://169.254.169.254/evil.xml</loc></sitemap>
</sitemapindex>`
    const CHILD = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://127.0.0.1/page-1</loc></url>
</urlset>`
    installFetch((url) => {
      if (url.includes('sitemap-index.xml')) return xml(INDEX)
      if (url.includes('127.0.0.1/child.xml')) return xml(CHILD)
      return null
    })

    const report = await runSitemapAudit('http://127.0.0.1/', {
      sitemapUrl: 'http://127.0.0.1/sitemap-index.xml',
      allowPrivateHost: '127.0.0.1',
    })

    // The named loopback host is reachable; the link-local metadata host — a
    // DIFFERENT private host — stays blocked even with the allowance set.
    expect(fetchedUrls).toContain('http://127.0.0.1/child.xml')
    expect(fetchedUrls.some((u) => u.includes('169.254.169.254'))).toBe(false)
    expect(runAeoAuditMock.mock.calls.map((c) => c[0])).toEqual(['http://127.0.0.1/page-1'])
    expect(report.pagesAudited).toBe(1)
  })
})

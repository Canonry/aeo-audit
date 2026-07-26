import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { rewriteLocOrigin } from '../src/sitemap.js'

// Mirror sitemap-options.test.ts: capture the per-page runAeoAudit calls so we can
// assert which URLs get crawled after origin rewriting.
const runAeoAuditMock = vi.hoisted(() => vi.fn())

vi.mock('../src/index.js', () => ({
  runAeoAudit: runAeoAuditMock,
}))

import { runSitemapAudit } from '../src/sitemap.js'

// Sitemap fetched from the dev origin but its <loc>s hardcode the prod domain.
const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://www.demand-iq.com/</loc></url>
  <url><loc>https://www.demand-iq.com/about?ref=nav</loc></url>
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
      metaDescription: null,
      internalLinks: [],
      auxiliary: { llmsTxt: 'missing', llmsFullTxt: 'missing', robotsTxt: 'missing', sitemapXml: 'missing' },
      redirectChain: [],
    },
  }
}

beforeEach(() => {
  runAeoAuditMock.mockReset()
  runAeoAuditMock.mockImplementation((url: string) => Promise.resolve(fakeReport(url)))
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(SITEMAP_XML, { status: 200, headers: { 'content-type': 'application/xml' } }),
  ))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('rewriteLocOrigin', () => {
  it('re-homes a loc onto the target origin, preserving path and query', () => {
    expect(rewriteLocOrigin('https://www.demand-iq.com/about?ref=nav', 'http://localhost:3000')).toBe(
      'http://localhost:3000/about?ref=nav',
    )
  })

  it('preserves the root path', () => {
    expect(rewriteLocOrigin('https://www.demand-iq.com/', 'https://staging.example.com')).toBe(
      'https://staging.example.com/',
    )
  })

  it('returns unparseable locs unchanged', () => {
    expect(rewriteLocOrigin('not a url', 'http://localhost:3000')).toBe('not a url')
  })
})

describe('runSitemapAudit --rewrite-sitemap-origin', () => {
  it('crawls the rewritten origin instead of the literal <loc> host', async () => {
    await runSitemapAudit('http://localhost:3000', {
      sitemapUrl: 'http://localhost:3000/sitemap.xml',
      rewriteOrigin: true,
      // The sitemap itself is fetched from localhost; opt the loopback host past the
      // SSRF guard exactly as `--allow-local` does.
      allowPrivateHost: 'localhost',
    })

    const crawled = runAeoAuditMock.mock.calls.map((c) => c[0]).sort()
    expect(crawled).toEqual(['http://localhost:3000/', 'http://localhost:3000/about?ref=nav'])
  })

  it('crawls the literal prod <loc>s when rewriting is off', async () => {
    await runSitemapAudit('http://localhost:3000', {
      sitemapUrl: 'http://localhost:3000/sitemap.xml',
      allowPrivateHost: 'localhost',
    })

    const crawled = runAeoAuditMock.mock.calls.map((c) => c[0])
    expect(crawled).toContain('https://www.demand-iq.com/')
  })

  it('forwards allowPrivateHost to every per-page audit', async () => {
    await runSitemapAudit('http://localhost:3000', {
      sitemapUrl: 'http://localhost:3000/sitemap.xml',
      rewriteOrigin: true,
      allowPrivateHost: 'localhost',
    })

    expect(runAeoAuditMock).toHaveBeenCalled()
    for (const [, options] of runAeoAuditMock.mock.calls) {
      expect(options.allowPrivateHost).toBe('localhost')
    }
  })
})

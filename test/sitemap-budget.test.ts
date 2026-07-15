import { afterEach, describe, expect, it, vi } from 'vitest'
import { runSitemapAudit } from '../src/index.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

function xml(urls: string[]): string {
  return `<?xml version="1.0"?><urlset>${urls.map((url) => `<url><loc>${url}</loc></url>`).join('')}</urlset>`
}

describe('sitemap cumulative budgets', () => {
  it('reserves before every fetch and returns a typed partial without overshooting', async () => {
    const urls = Array.from({ length: 5 }, (_, index) => `http://localhost/page-${index}`)
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/sitemap.xml')) {
        return new Response(xml(urls), { status: 200, headers: { 'Content-Type': 'application/xml' } })
      }
      return new Response('<!doctype html><html><head><title>x</title></head><body><h1>x</h1></body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    let observed = 0

    const report = await runSitemapAudit('http://localhost', {
      allowPrivateHost: 'localhost',
      maxTotalFetches: 2,
      maxDurationMs: 5_000,
      onOutboundAttempt: () => { observed += 1 },
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(observed).toBe(2)
    expect(report.budget).toEqual({ exhausted: true, reason: 'fetches', discoveryComplete: true })
    expect(report.pagesAudited).toBe(report.pages.length)
    expect(report.pagesSkipped).toBe(5)
    expect(report.pagesTruncated).toBe(0)
  })

  it('uses the normalized request URL when discovery cannot reserve its first fetch', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const report = await runSitemapAudit('http://localhost', {
      allowPrivateHost: 'localhost',
      maxTotalFetches: 0,
      maxDurationMs: 5_000,
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(report.sitemapUrl).toBe('http://localhost/')
    expect(report.budget).toEqual({ exhausted: true, reason: 'fetches', discoveryComplete: false })
    expect(report.pages).toEqual([])
  })

  it('races in-flight work against the wall-clock deadline', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const started = Date.now()
    const report = await runSitemapAudit('http://localhost', {
      allowPrivateHost: 'localhost',
      maxTotalFetches: 100,
      maxDurationMs: 25,
    })

    expect(Date.now() - started).toBeLessThan(500)
    expect(report.budget).toEqual({ exhausted: true, reason: 'duration', discoveryComplete: false })
  })

  it('uses the dedicated sitemap error identity for an explicit missing sitemap', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('', { status: 404 })))
    await expect(runSitemapAudit('http://localhost', {
      allowPrivateHost: 'localhost',
      sitemapUrl: 'http://localhost/missing.xml',
    })).rejects.toMatchObject({ code: 'SITEMAP_INVALID' })
  })
})

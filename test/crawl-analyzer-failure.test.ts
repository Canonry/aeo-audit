import { afterEach, describe, expect, test, vi } from 'vitest'

const auditHtmlPageMock = vi.hoisted(() => vi.fn())

vi.mock('../src/audit-html.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/audit-html.js')>(),
  auditHtmlPage: auditHtmlPageMock,
}))

import { runSiteCrawl } from '../src/crawl.js'

const html = (body: string) => new Response(`<!doctype html><html><body>${body}</body></html>`, {
  status: 200,
  headers: { 'content-type': 'text/html' },
})

afterEach(() => {
  vi.unstubAllGlobals()
  auditHtmlPageMock.mockReset()
})

describe('runSiteCrawl analyzer failures', () => {
  test('preserves the fetched HTML observation and records the audit failure', async () => {
    auditHtmlPageMock.mockRejectedValue(new Error('synthetic analyzer failure'))
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/robots.txt' || url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt' || url.pathname === '/map.xml') {
        return new Response('', { status: 404 })
      }
      if (url.pathname === '/') return html('<a href="/child">child</a>')
      return html('<p>child</p>')
    }))

    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test', sitemapUrl: 'https://example.test/map.xml',
    })
    if (report.mode !== 'full') throw new Error('expected full report')

    expect(report.pages).toHaveLength(2)
    expect(report.pages.find((page) => page.requestedUrl === 'https://example.test/')).toMatchObject({
      state: 'html',
      audit: null,
      error: 'Analyzer failed: synthetic analyzer failure',
    })
  })
})

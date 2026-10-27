import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { load } from 'cheerio'

import { fetchPage, isSoft404 } from '../src/fetch-page.js'
import { analyzeAiAccessFiles } from '../src/analyzers/ai-access-files.js'
import type { AuditContext } from '../src/types.js'

// The fetch tests need to bypass the SSRF guard (which blocks loopback IPs).
// We use a public IP literal so the validation logic accepts it without DNS,
// and stub global fetch so no real network traffic happens.
const ORIGIN = 'http://1.1.1.1'
const HOME_HTML = `<!doctype html><html><head><title>T</title></head><body><h1>Hi</h1></body></html>`

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>

const realFetch = globalThis.fetch
let handler: Handler = () => new Response('', { status: 404 })

function getRequestHeaders(init?: RequestInit): Record<string, string> {
  const headers = init?.headers
  if (!headers) return {}
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return headers as Record<string, string>
}

beforeEach(() => {
  globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    return handler(url, init)
  }
})

afterEach(() => {
  globalThis.fetch = realFetch
})

function makeContext(auxiliary: Record<string, unknown> = {}): AuditContext {
  const $ = load(HOME_HTML)
  return {
    $,
    html: HOME_HTML,
    url: ORIGIN,
    headers: {},
    auxiliary: auxiliary as AuditContext['auxiliary'],
    structuredData: [],
    textContent: 'Hi',
    pageTitle: 'T',
  }
}

describe('fetchPage auxiliary diagnostics', () => {
  it('flags content negotiation when /llms.txt 200s but 404s under Accept: text/markdown (issues #34/#35)', async () => {
    handler = (url, init) => {
      const accept = String(getRequestHeaders(init)['Accept'] || '')
      if (url === `${ORIGIN}/`) {
        return new Response(HOME_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (url === `${ORIGIN}/llms.txt`) {
        if (accept.includes('text/markdown')) {
          return new Response('', { status: 404, headers: { 'content-type': 'text/plain' } })
        }
        return new Response('# llms\nReal content', { status: 200, headers: { 'content-type': 'text/plain' } })
      }
      return new Response('', { status: 404 })
    }

    const page = await fetchPage(ORIGIN)
    expect(page.auxiliary.llmsTxt?.state).toBe('ok')
    expect(page.auxiliary.llmsTxt?.diagnostics?.contentNegotiation).toBe(true)

    const result = analyzeAiAccessFiles(makeContext(page.auxiliary))
    expect(result.findings.some((f) => f.message.includes('content negotiation'))).toBe(true)
    expect(result.recommendations.some((r) => r.includes('Accept'))).toBe(true)
  })

  it('does not add diagnostics when the file is served consistently across UA and Accept variants', async () => {
    handler = (url) => {
      if (url === `${ORIGIN}/`) {
        return new Response(HOME_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (url === `${ORIGIN}/llms.txt`) {
        return new Response('# llms', { status: 200, headers: { 'content-type': 'text/plain' } })
      }
      return new Response('', { status: 404 })
    }

    const page = await fetchPage(ORIGIN)
    expect(page.auxiliary.llmsTxt?.state).toBe('ok')
    expect(page.auxiliary.llmsTxt?.diagnostics).toBeUndefined()
  })

  it('falls back to /sitemap-index.xml when /sitemap.xml 404s (issue #32)', async () => {
    handler = (url) => {
      if (url === `${ORIGIN}/`) {
        return new Response(HOME_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (url === `${ORIGIN}/sitemap.xml`) {
        return new Response('', { status: 404, headers: { 'content-type': 'text/plain' } })
      }
      if (url === `${ORIGIN}/sitemap-index.xml`) {
        return new Response(
          '<sitemapindex><sitemap><loc>https://example.com/sm.xml</loc></sitemap></sitemapindex>',
          { status: 200, headers: { 'content-type': 'application/xml' } },
        )
      }
      return new Response('', { status: 404 })
    }

    const page = await fetchPage(ORIGIN)
    expect(page.auxiliary.sitemapXml?.state).toBe('ok')
    expect(page.auxiliary.sitemapXml?.url).toBe(`${ORIGIN}/sitemap-index.xml`)
  })

  it('labels the content-negotiation diagnostic with the actual fetched path when the sitemap fallback resolves to /sitemap-index.xml', async () => {
    handler = (url, init) => {
      const accept = String(getRequestHeaders(init)['Accept'] || '')
      if (url === `${ORIGIN}/`) {
        return new Response(HOME_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      if (url === `${ORIGIN}/sitemap.xml`) {
        return new Response('', { status: 404, headers: { 'content-type': 'text/plain' } })
      }
      if (url === `${ORIGIN}/sitemap-index.xml`) {
        if (accept.includes('text/markdown')) {
          return new Response('', { status: 404, headers: { 'content-type': 'text/plain' } })
        }
        return new Response(
          '<sitemapindex><sitemap><loc>https://example.com/sm.xml</loc></sitemap></sitemapindex>',
          { status: 200, headers: { 'content-type': 'application/xml' } },
        )
      }
      return new Response('', { status: 404 })
    }

    const page = await fetchPage(ORIGIN)
    expect(page.auxiliary.sitemapXml?.url).toBe(`${ORIGIN}/sitemap-index.xml`)
    expect(page.auxiliary.sitemapXml?.diagnostics?.contentNegotiation).toBe(true)

    const result = analyzeAiAccessFiles(makeContext(page.auxiliary))
    const negotiationFinding = result.findings.find((f) => f.message.includes('content negotiation'))
    expect(negotiationFinding?.message).toContain('/sitemap-index.xml')
    expect(negotiationFinding?.message).not.toContain('/sitemap.xml ')
  })
})

describe('fetchPage soft 404s', () => {
  const NOT_FOUND_PAGE = `<!DOCTYPE html>\n<html lang="en"><head><title>Page not found</title></head><body><h1>404</h1>${'<p>We could not find that page.</p>'.repeat(60)}</body></html>`
  const htmlResponse = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })

  it('reports /llms-full.txt missing when it redirects to an error page served with 200', async () => {
    handler = (url) => {
      if (url === `${ORIGIN}/`) return htmlResponse(HOME_HTML)
      if (url === `${ORIGIN}/llms-full.txt`) return new Response('', { status: 301, headers: { location: '/404' } })
      if (url === `${ORIGIN}/404`) return htmlResponse(NOT_FOUND_PAGE)
      return new Response('', { status: 404 })
    }

    const page = await fetchPage(ORIGIN)
    expect(page.auxiliary.llmsFullTxt).toMatchObject({ state: 'missing', url: `${ORIGIN}/404`, diagnostics: { soft404: true } })

    const result = analyzeAiAccessFiles(makeContext(page.auxiliary))
    expect(result.findings.filter((f) => f.message.startsWith('/llms-full.txt'))).toEqual([{
      type: 'missing',
      code: 'ai-access-files.aux-resource.missing',
      message: `/llms-full.txt is missing: ${ORIGIN}/llms-full.txt redirects to ${ORIGIN}/404, an HTML page (soft 404).`,
    }])
    expect(result.recommendations).toContain('Create /llms-full.txt at your site root.')
  })

  it('reports /llms.txt missing when an SPA serves its HTML shell for every path', async () => {
    handler = (url) => {
      if (url === `${ORIGIN}/` || url === `${ORIGIN}/llms.txt`) return htmlResponse(HOME_HTML)
      return new Response('', { status: 404 })
    }

    const page = await fetchPage(ORIGIN)
    expect(page.auxiliary.llmsTxt).toMatchObject({ state: 'missing', diagnostics: { soft404: true } })

    const result = analyzeAiAccessFiles(makeContext(page.auxiliary))
    expect(result.findings.find((f) => f.message.startsWith('/llms.txt'))?.message)
      .toBe(`/llms.txt is missing: ${ORIGIN}/llms.txt returns an HTML page (soft 404).`)
  })

  it('keeps a real llms-full.txt whose content quotes HTML', async () => {
    const llmsFull = '# Acme UI\n\n> Components for Acme UI.\n\n```html\n<!doctype html>\n<html>\n<head></head>\n<body></body>\n</html>\n```\n'
    handler = (url) => {
      if (url === `${ORIGIN}/`) return htmlResponse(HOME_HTML)
      if (url === `${ORIGIN}/llms-full.txt`) return new Response(llmsFull, { status: 200, headers: { 'content-type': 'text/plain' } })
      return new Response('', { status: 404 })
    }

    const page = await fetchPage(ORIGIN)
    expect(page.auxiliary.llmsFullTxt?.state).toBe('ok')
    expect(page.auxiliary.llmsFullTxt?.diagnostics).toBeUndefined()
  })

  it('falls back to /sitemap-index.xml when /sitemap.xml is a soft 404', async () => {
    handler = (url) => {
      if (url === `${ORIGIN}/`) return htmlResponse(HOME_HTML)
      if (url === `${ORIGIN}/sitemap.xml`) return htmlResponse(NOT_FOUND_PAGE)
      if (url === `${ORIGIN}/sitemap-index.xml`) {
        return new Response(
          '<?xml version="1.0" encoding="UTF-8"?><sitemapindex><sitemap><loc>https://example.com/sm.xml</loc></sitemap></sitemapindex>',
          { status: 200, headers: { 'content-type': 'application/xml' } },
        )
      }
      return new Response('', { status: 404 })
    }

    const page = await fetchPage(ORIGIN)
    expect(page.auxiliary.sitemapXml).toMatchObject({ state: 'ok', url: `${ORIGIN}/sitemap-index.xml` })
  })
})

describe('isSoft404', () => {
  it.each([
    ['a doctype', '<!DOCTYPE html><html><body>Not found</body></html>'],
    ['a BOM and whitespace before <html>', '﻿\n  <html lang="en"><body>Not found</body></html>'],
    ['a leading comment', '<!-- built by Example -->\n<!doctype html><html></html>'],
    ['an XHTML prolog', '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "x">\n<html></html>'],
  ])('flags a 200 HTML page opening with %s', (_, body) => {
    expect(isSoft404(200, body)).toBe(true)
  })

  it.each([
    ['an llms.txt quoting HTML', '# Acme\n\n```html\n<!doctype html>\n<html></html>\n```'],
    ['a robots.txt', 'User-agent: *\nDisallow: /admin'],
    ['an XML sitemap', '<?xml version="1.0"?><?xml-stylesheet type="text/xsl" href="/sitemap.xsl"?><urlset></urlset>'],
  ])('passes %s', (_, body) => {
    expect(isSoft404(200, body)).toBe(false)
  })

  it('leaves non-2xx responses to their status code', () => {
    expect(isSoft404(404, '<!doctype html><html></html>')).toBe(false)
  })

  it('stays linear on a run of comments that never reaches a tag', () => {
    // One absolute check at a size where the patterns are orders of magnitude
    // apart: well under a millisecond now, against seconds for a comment
    // pattern that could span several comments and so backtracked through
    // every way to split them (each added comment doubled the time).
    const started = Date.now()
    expect(isSoft404(200, '<!---->'.repeat(30) + 'x')).toBe(false)
    expect(Date.now() - started).toBeLessThan(250)
  })
})

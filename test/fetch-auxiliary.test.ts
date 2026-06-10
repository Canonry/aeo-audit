import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { load } from 'cheerio'

import { fetchPage } from '../src/fetch-page.js'
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

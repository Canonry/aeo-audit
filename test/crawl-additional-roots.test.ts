import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The SSRF guard resolves every host before fetching; these hosts resolve to a public address.
const resolve4Mock = vi.hoisted(() => vi.fn())
const resolve6Mock = vi.hoisted(() => vi.fn())
const lookupMock = vi.hoisted(() => vi.fn())

vi.mock('node:dns/promises', () => ({
  default: { resolve4: resolve4Mock, resolve6: resolve6Mock },
  resolve4: resolve4Mock,
  resolve6: resolve6Mock,
}))

vi.mock('node:dns', async () => {
  const actual = await vi.importActual<typeof import('node:dns')>('node:dns')
  return { ...actual, lookup: lookupMock }
})

import { runSiteCrawl } from '../src/index.js'
import type { CrawlPageObservation, SiteCrawlReport } from '../src/types.js'

const main = 'https://www.homes.test'
const search = 'https://search.homes.test'

function page(title: string, body: string): string {
  return `<!doctype html><html><head><title>${title}</title><meta name="description" content="Apartment homes with a pool, a fitness center, and room for pets, close to shops and parks."></head><body><h1>${title}</h1>${body}</body></html>`
}

// A main site and its search subdomain. Only the subdomain blocks /private/, lists a
// sitemap in robots.txt, and publishes llms.txt.
const site: Record<string, string> = {
  [`${main}/`]: page('Homes', `<a href="/homes/ridge/">Ridge</a> <a href="${search}/ridge">Search Ridge</a> <a href="https://elsewhere.test/">Elsewhere</a>`),
  [`${main}/homes/ridge/`]: page('Ridge', ''),
  [`${main}/robots.txt`]: 'User-agent: *\nAllow: /\n',
  [`${search}/`]: page('Search', '<a href="/ridge">Ridge</a> <a href="/private/notes">Notes</a>'),
  [`${search}/ridge`]: page('Ridge on search', `<a href="${main}/homes/ridge/">Main site</a>`),
  [`${search}/from-sitemap`]: page('Only in the sitemap', ''),
  [`${search}/private/notes`]: page('Private', ''),
  [`${search}/robots.txt`]: `User-agent: *\nDisallow: /private/\nSitemap: ${search}/pages.xml\n`,
  [`${search}/pages.xml`]: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${search}/from-sitemap</loc></url></urlset>`,
  [`${search}/llms.txt`]: '# Homes search\n\n> Find an apartment home.\n',
}

const requested: string[] = []

beforeEach(() => {
  requested.length = 0
  resolve4Mock.mockResolvedValue(['93.184.216.34'])
  resolve6Mock.mockRejectedValue(Object.assign(new Error('no IPv6'), { code: 'ENODATA' }))
  lookupMock.mockImplementation((_hostname: string, _options: unknown, callback: (...args: unknown[]) => void) => {
    callback(null, [{ address: '93.184.216.34', family: 4 }])
  })
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = new URL(String(input))
    const key = `${url.origin}${url.pathname}`
    requested.push(key)
    const body = site[key]
    if (body === undefined) return new Response('', { status: 404 })
    const type = key.endsWith('.xml') ? 'application/xml' : key.endsWith('.txt') ? 'text/plain' : 'text/html'
    return new Response(body, { headers: { 'content-type': type } })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function byUrl(report: SiteCrawlReport): Map<string, CrawlPageObservation> {
  if (report.mode !== 'full') throw new Error('expected a full crawl report')
  return new Map(report.pages.map((observation) => [observation.requestedUrl, observation]))
}

describe('runSiteCrawl additionalRoots', () => {
  it('crawls each owned host with its own robots.txt, sitemaps and llms.txt', async () => {
    const report = await runSiteCrawl(main, { mode: 'full', factors: ['ai-access-files'], additionalRoots: [`${search}/`] })
    const pages = byUrl(report)
    // The second root and the pages reachable from it, by link and by its robots.txt sitemap.
    expect(pages.get(`${search}/`)).toMatchObject({ state: 'html', provenance: { root: true } })
    expect(pages.get(`${search}/ridge`)?.state).toBe('html')
    expect(pages.get(`${search}/from-sitemap`)).toMatchObject({ state: 'html', provenance: { sitemapSources: [`${search}/pages.xml`] } })
    // Only the subdomain's robots.txt blocks /private/; the root's rules allow everything.
    expect(pages.get(`${search}/private/notes`)?.state).toBe('robots-blocked')
    expect(requested).not.toContain(`${search}/private/notes`)
    // Each page is audited with its own host's files.
    expect(pages.get(`${search}/ridge`)?.audit?.metadata.auxiliary.llmsTxt).toBe('ok')
    expect(pages.get(`${main}/homes/ridge/`)?.audit?.metadata.auxiliary.llmsTxt).toBe('missing')
    // The root stays the root, and hosts outside the set are still never fetched.
    expect(pages.get(`${main}/`)?.provenance.root).toBe(true)
    expect(report.summary.finalRootUrl).toBe(`${main}/`)
    expect(requested.some((key) => key.startsWith('https://elsewhere.test'))).toBe(false)
  })

  it('treats links between owned hosts as internal', async () => {
    const report = await runSiteCrawl(main, { mode: 'full', factors: ['ai-access-files'], additionalRoots: [`${search}/`] })
    if (report.mode !== 'full') throw new Error('expected a full crawl report')
    const edge = report.edges.find((candidate) => candidate.from === `${main}/` && candidate.to === `${search}/ridge`)
    const outside = report.edges.find((candidate) => candidate.from === `${main}/` && candidate.to === 'https://elsewhere.test/')
    expect(edge?.classification).not.toBe(outside?.classification)
    expect(byUrl(report).get(`${search}/ridge`)?.provenance.discoveredFrom).toContain(`${main}/`)
  })

  it('checks pages on an additional host against the entity registry', async () => {
    // The search host's Ridge page names Harbor, a sibling owned on the main host.
    const ridgeFaq = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Is there a pool?', acceptedAnswer: { '@type': 'Answer', text: 'Yes, Northwind Harbor has a heated pool.' } }] }
    site[`${search}/ridge`] = page('Northwind Ridge', `<script type="application/ld+json">${JSON.stringify(ridgeFaq)}</script>`)
    try {
      const entityRegistry = { entities: [
        { key: 'ridge', names: ['Northwind Ridge'], urlMatchers: [{ host: 'search.homes.test', pathPrefix: '/ridge' }] },
        { key: 'harbor', names: ['Northwind Harbor'], urlMatchers: [{ host: 'www.homes.test', pathPrefix: '/homes/harbor/' }] },
      ] }
      const pages = byUrl(await runSiteCrawl(main, { mode: 'full', factors: ['technical-seo'], additionalRoots: [`${search}/`], entityRegistry }))
      const defect = pages.get(`${search}/ridge`)?.audit?.criticalDefects.find((item) => item.id === 'names-another-entity')
      expect(defect?.evidence?.map((item) => [item.field, item.entityKey])).toEqual([['faq-answer', 'harbor']])
    } finally {
      site[`${search}/ridge`] = page('Ridge on search', `<a href="${main}/homes/ridge/">Main site</a>`)
    }
  })

  it('crawls only the root host without additional roots, and ignores one on the root host', async () => {
    for (const additionalRoots of [undefined, [`${main}/homes/`]]) {
      requested.length = 0
      const report = await runSiteCrawl(main, { mode: 'full', factors: ['ai-access-files'], ...(additionalRoots ? { additionalRoots } : {}) })
      const pages = byUrl(report)
      expect([...pages.values()].filter((observation) => observation.requestedUrl.startsWith(search) && observation.state === 'html')).toEqual([])
      expect(requested.some((key) => key.startsWith(search))).toBe(false)
      expect(pages.has(`${main}/homes/`)).toBe(false)
    }
  })
})

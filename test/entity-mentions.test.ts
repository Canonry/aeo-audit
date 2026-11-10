import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { load } from 'cheerio'

import { buildCriticalDefects, DEFECT_TITLES, detectCriticalDefects } from '../src/critical-defects.js'
import { getVisibleText, parseJsonLdScripts } from '../src/analyzers/helpers.js'
import { runSiteCrawl } from '../src/index.js'
import { runStaticAudit } from '../src/static-audit.js'
import type { AuditContext, AuditReport, CrawlEvent, CrawlPageObservation, CriticalDefect, EntityRegistry } from '../src/types.js'

const host = 'homes.example.test'
const site = `https://${host}`

// Shaped like a real property portfolio: one page per property, FAQ answers in FAQPage JSON-LD.
const registry: EntityRegistry = {
  entities: [
    // One-word aliases are never matched: "Ridge" and "Harbor" are ordinary words.
    { key: 'ridge', names: ['Northwind Ridge', 'Ridge'], urlMatchers: [{ host, pathPrefix: '/homes/northwind-ridge/' }] },
    { key: 'harbor', names: ['Northwind Harbor', 'Harbor'], urlMatchers: [{ host, pathPrefix: '/homes/northwind-harbor/' }] },
    { key: 'cedar', names: ['The Lofts at Cedar Point'], urlMatchers: [{ host, pathPrefix: '/homes/lofts-at-cedar-point' }] },
    { key: 'cottages', names: ['Cedar Cottages'], urlMatchers: [{ host, pathPrefix: '/homes/northwind-ridge/cottages/' }] },
    { key: 'hunters', names: ['Hunter’s Creek Flats'], urlMatchers: [{ host: 'WWW.Homes.Example.test', pathPrefix: '/Homes/Hunters-Creek' }] },
  ],
}

interface PageInput {
  title?: string
  h1s?: string[]
  faq?: Array<[question: string, answer: string]>
  body?: string
}

function pageHtml({ title = 'Apartments', h1s = [], faq = [], body = '' }: PageInput): string {
  const jsonLd = faq.length === 0 ? '' : `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map(([question, answer]) => ({ '@type': 'Question', name: question, acceptedAnswer: { '@type': 'Answer', text: answer } })),
  })}</script>`
  return `<!doctype html><html><head><title>${title}</title><meta name="description" content="Apartment homes with a pool, a fitness center, and room for pets, close to shops and parks.">${jsonLd}</head><body>${h1s.map((h1) => `<h1>${h1}</h1>`).join('')}${body}</body></html>`
}

function contextFor(url: string, input: PageInput): AuditContext {
  const html = pageHtml(input)
  const $ = load(html)
  return {
    $,
    html,
    url,
    headers: {},
    auxiliary: {
      llmsTxt: { state: 'missing', body: '' },
      llmsFullTxt: { state: 'missing', body: '' },
      robotsTxt: { state: 'missing', body: '' },
      sitemapXml: { state: 'missing', body: '' },
    },
    structuredData: parseJsonLdScripts($),
    textContent: getVisibleText($, html),
    pageTitle: $('title').first().text().trim(),
  }
}

/** `null` audits without a registry. */
function namesAnother(url: string, input: PageInput, entityRegistry: EntityRegistry | null = registry): CriticalDefect | undefined {
  return detectCriticalDefects(contextFor(url, input), { entityRegistry: entityRegistry ?? undefined })
    .find((defect) => defect.id === 'names-another-entity')
}

const ridgeUrl = `${site}/homes/northwind-ridge/`
const appliancesAnswer = 'Apartments are not required to have appliances, however, at Northwind Harbor residents can enjoy in-home washer and dryer sets.'

describe('names-another-entity', () => {
  it('flags FAQ questions and answers that name another registered entity, with evidence', () => {
    const defect = namesAnother(ridgeUrl, {
      title: 'Northwind Ridge Apartments',
      h1s: ['Northwind Ridge'],
      faq: [
        ['Do apartments come with appliances?', appliancesAnswer],
        ['What makes an apartment luxury?', 'The Lofts at Cedar Point offers a resort-style pool.'],
        ['How far is Northwind Harbor from here?', 'About two miles.'],
        // The page's own name, an unregistered place, and one-word aliases are not mentions.
        ['Is Northwind Ridge pet friendly?', "Yes, Northwind Ridge's community welcomes cats and dogs."],
        ['Where can I shop nearby?', 'Cedar Point Mall is two miles away, and the Harbor district is close.'],
      ],
      // Body text is not checked: a "nearby homes" list names siblings legitimately.
      body: '<section><h2>Nearby homes</h2><a href="/homes/northwind-harbor/">Northwind Harbor</a></section>',
    })
    expect(defect).toEqual({
      id: 'names-another-entity',
      severity: 'critical',
      detail: 'The FAQ names 2 other entities: Northwind Harbor and The Lofts at Cedar Point.',
      recommendation: "This page belongs to Northwind Ridge. Replace each mention with Northwind Ridge's own details, or remove it.",
      evidence: [
        { field: 'faq-answer', question: 'Do apartments come with appliances?', entityKey: 'harbor', entityName: 'Northwind Harbor', snippet: appliancesAnswer },
        { field: 'faq-answer', question: 'What makes an apartment luxury?', entityKey: 'cedar', entityName: 'The Lofts at Cedar Point', snippet: 'The Lofts at Cedar Point offers a resort-style pool.' },
        { field: 'faq-question', question: 'How far is Northwind Harbor from here?', entityKey: 'harbor', entityName: 'Northwind Harbor', snippet: 'How far is Northwind Harbor from here?' },
      ],
    })
  })

  it('flags a title or H1 that names another entity, and possessives still match', () => {
    const defect = namesAnother(ridgeUrl, {
      title: 'Northwind Harbor Apartments',
      h1s: ["Welcome to Northwind Harbor's newest homes"],
    })
    expect(defect?.detail).toBe('The title and H1 name another entity, Northwind Harbor.')
    expect(defect?.evidence?.map((item) => [item.field, item.entityKey])).toEqual([['title', 'harbor'], ['h1', 'harbor']])
  })

  it('treats names inside, or containing, one of the page entity\'s names as the page itself', () => {
    const shadowCreek: EntityRegistry = {
      entities: [
        { key: 'luxe', names: ['Northwind Luxe Shadow Creek'], urlMatchers: [{ host, pathPrefix: '/homes/luxe/' }] },
        { key: 'shadow', names: ['Shadow Creek'], urlMatchers: [{ host, pathPrefix: '/homes/shadow-creek/' }] },
        { key: 'luxe-lofts', names: ['Northwind Luxe Shadow Creek Lofts'], urlMatchers: [{ host, pathPrefix: '/homes/luxe-lofts/' }] },
        { key: 'avion', names: ['Northwind Avion Shadow Creek'], urlMatchers: [{ host, pathPrefix: '/homes/avion/' }] },
      ],
    }
    const defect = namesAnother(`${site}/homes/luxe/`, {
      faq: [['What is nearby?', 'Northwind Luxe Shadow Creek sits beside Shadow Creek park, next to Northwind Luxe Shadow Creek Lofts and its sister Northwind Avion Shadow Creek.']],
    }, shadowCreek)
    expect(defect?.evidence?.map((item) => item.entityKey)).toEqual(['avion'])
  })

  it('gives the page to the longest matching path prefix, ignoring host and path case', () => {
    // The cottages sit under the ridge's path, so their page belongs to the cottages.
    expect(namesAnother(`${site}/homes/northwind-ridge/cottages/`, {
      faq: [['Can I use the clubhouse?', "Yes, Cedar Cottages residents share Northwind Ridge's clubhouse."]],
    })?.evidence?.map((item) => item.entityKey)).toEqual(['ridge'])
    // Matcher host WWW.Homes.Example.test and prefix /Homes/Hunters-Creek cover this page; the
    // curly-apostrophe registry name matches the straight one in the text, so it is the page itself.
    expect(namesAnother(`https://www.homes.example.test/homes/hunters-creek`, {
      h1s: ["Hunter's Creek Flats"],
      faq: [['Is there a dog park?', 'Yes, like Northwind Ridge, we have a bark park.']],
    })?.evidence?.map((item) => [item.field, item.entityKey])).toEqual([['faq-answer', 'ridge']])
  })

  it('skips pages no entity owns and runs only with a registry that has page matchers', () => {
    const listing: PageInput = { faq: [['Which homes have pools?', 'Northwind Ridge and Northwind Harbor both do.']] }
    expect(namesAnother(`${site}/homes/`, listing)).toBeUndefined()
    expect(namesAnother(`${site}/homes/northwind-ridge-two/`, listing)).toBeUndefined()
    expect(namesAnother(ridgeUrl, { faq: [['Q?', appliancesAnswer]] }, null)).toBeUndefined()
    const noMatchers: EntityRegistry = { entities: registry.entities.map((entity) => ({ ...entity, urlMatchers: [] })) }
    expect(namesAnother(ridgeUrl, { faq: [['Q?', appliancesAnswer]] }, noMatchers)).toBeUndefined()
    // Other defects are unchanged by the registry.
    const withRegistry = detectCriticalDefects(contextFor(ridgeUrl, { title: 'Northwind Ridge' }), { entityRegistry: registry })
    expect(withRegistry).toEqual(detectCriticalDefects(contextFor(ridgeUrl, { title: 'Northwind Ridge' })))
  })

  it('lists at most 25 mentions and says how many it found', () => {
    const towers: EntityRegistry = {
      entities: [
        { key: 'home', names: ['Northwind Home Tower'], urlMatchers: [{ host, pathPrefix: '/homes/home/' }] },
        ...Array.from({ length: 30 }, (_, index) => ({ key: `tower-${index}`, names: [`Example Tower ${index}`], urlMatchers: [] })),
      ],
    }
    const defect = namesAnother(`${site}/homes/home/`, {
      faq: Array.from({ length: 30 }, (_, index): [string, string] => [`Question ${index}?`, `Residents of Example Tower ${index} share the pool.`]),
    }, towers)
    expect(defect?.evidence).toHaveLength(25)
    expect(defect?.detail).toBe('The FAQ names 30 other entities: Example Tower 0, Example Tower 1, Example Tower 2 and 27 more. 25 of 30 mentions are listed.')
  })

  it('carries the evidence into a rolled-up defect group', () => {
    const defect = namesAnother(ridgeUrl, { faq: [['Do apartments come with appliances?', appliancesAnswer]] })!
    const report = { finalUrl: ridgeUrl, criticalDefects: [defect] } as unknown as AuditReport
    const [group] = buildCriticalDefects([report])
    expect(group).toMatchObject({ id: 'names-another-entity', severity: 'critical', title: DEFECT_TITLES['names-another-entity'] })
    expect(group?.pages).toEqual([{ url: ridgeUrl, detail: defect.detail, isHomepage: false, priority: undefined, evidence: defect.evidence }])
  })
})

describe('names-another-entity in site audits', () => {
  afterEach(() => vi.unstubAllGlobals())

  const crawlRegistry: EntityRegistry = {
    entities: [
      { key: 'ridge', names: ['Northwind Ridge'], urlMatchers: [{ host: 'example.test', pathPrefix: '/homes/northwind-ridge/' }] },
      { key: 'harbor', names: ['Northwind Harbor'], urlMatchers: [{ host: 'example.test', pathPrefix: '/homes/northwind-harbor/' }] },
    ],
  }
  const pages: Record<string, PageInput> = {
    '/': { title: 'Northwind Living', h1s: ['Northwind Living'], body: '<a href="/homes/northwind-ridge/">Ridge</a> <a href="/homes/northwind-harbor/">Harbor</a>' },
    '/homes/northwind-ridge/': { title: 'Northwind Ridge', h1s: ['Northwind Ridge'], faq: [['Do apartments come with appliances?', appliancesAnswer]] },
    '/homes/northwind-harbor/': { title: 'Northwind Harbor', h1s: ['Northwind Harbor'], faq: [['Is Northwind Harbor pet friendly?', 'Yes.']] },
  }

  async function crawl(entityRegistry?: EntityRegistry): Promise<Map<string, CrawlPageObservation>> {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      const page = pages[url.pathname]
      if (!page) return new Response('', { status: 404 })
      return new Response(pageHtml(page), { headers: { 'content-type': 'text/html' } })
    }))
    const finalPages = new Map<string, CrawlPageObservation>()
    await runSiteCrawl('https://example.test', {
      allowPrivateHost: 'example.test', factors: ['technical-seo'], mode: 'summary',
      ...(entityRegistry ? { entityRegistry } : {}),
      onEvent: (event: CrawlEvent) => {
        if (event.type === 'pages') for (const row of event.rows) finalPages.set(new URL(row.requestedUrl).pathname, row)
      },
    })
    return finalPages
  }

  it('flags the crawled page that names a sibling, and leaves scores alone', async () => {
    const withRegistry = await crawl(crawlRegistry)
    const ridge = withRegistry.get('/homes/northwind-ridge/')?.audit?.criticalDefects.find((defect) => defect.id === 'names-another-entity')
    expect(ridge?.evidence).toEqual([{ field: 'faq-answer', question: 'Do apartments come with appliances?', entityKey: 'harbor', entityName: 'Northwind Harbor', snippet: appliancesAnswer }])
    for (const path of ['/', '/homes/northwind-harbor/']) {
      expect(withRegistry.get(path)?.audit?.criticalDefects.some((defect) => defect.id === 'names-another-entity')).toBe(false)
    }
    const withoutRegistry = await crawl()
    expect(withoutRegistry.get('/homes/northwind-ridge/')?.audit?.criticalDefects.some((defect) => defect.id === 'names-another-entity')).toBe(false)
    for (const [path, page] of withRegistry) expect(page.audit?.overallScore).toBe(withoutRegistry.get(path)?.audit?.overallScore)
  })

  it('rolls the defect up in a static audit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'entity-mentions-'))
    try {
      for (const [path, page] of Object.entries(pages)) {
        await mkdir(join(dir, path), { recursive: true })
        await writeFile(join(dir, path, 'index.html'), pageHtml(page))
      }
      const result = await runStaticAudit(dir, { baseUrl: 'https://example.test', factors: ['technical-seo'], entityRegistry: crawlRegistry })
      if (result.kind !== 'multi') throw new Error(`expected a multi-page static report, got ${result.kind}`)
      const group = result.report.criticalDefects.find((item) => item.id === 'names-another-entity')
      expect(group?.pages.map((page) => [new URL(page.url).pathname, page.evidence?.map((item) => item.entityKey)])).toEqual([['/homes/northwind-ridge/', ['harbor']]])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

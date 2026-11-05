import { describe, expect, it } from 'vitest'
import { load } from 'cheerio'
import { analyzeEntityConsistency } from '../../src/analyzers/entity-consistency.js'
import { getVisibleText, parseJsonLdScripts } from '../../src/analyzers/helpers.js'
import { resolveCountry } from '../../src/analyzers/schema-identity.js'
import { auditHtmlPage } from '../../src/index.js'
import type { AuditContext } from '../../src/types.js'

// Every business, place and host here is made up.
const PAGE_URL = 'https://stays.example.com/port-alder/juniper-cove-inn/'
const FILLER = `<p>${'Guests wake to a quiet harbor, walk the shoreline trail, and end the day by the fire with a book from the reading room. '.repeat(4)}</p>`
const OWN_FOOTER = '<footer><p>Juniper Cove Inn, 12 Harbor Road, Port Alder, ME 04001. Call (207) 555-0142.</p></footer>'

const ownInn = {
  '@context': 'https://schema.org',
  '@type': 'LodgingBusiness',
  name: 'Juniper Cove Inn',
  address: { '@type': 'PostalAddress', streetAddress: '12 Harbor Road', addressLocality: 'Port Alder', addressRegion: 'ME', postalCode: '04001', addressCountry: 'US' },
}
const abroad = { '@type': 'PostalAddress', addressLocality: 'Bahía Clara', addressRegion: 'Costa Norte', addressCountry: 'MX' }
const strayResort = { '@context': 'https://schema.org', '@type': 'LodgingBusiness', name: 'Hotel Mirador Azul', address: abroad }
const ownPage = { title: 'Juniper Cove Inn | Harbor Rooms in Port Alder', h1: 'Juniper Cove Inn' }

interface Page {
  url?: string
  title?: string
  h1?: string
  head?: string
  body?: string
  schema?: unknown
}

function html(page: Page): string {
  const title = page.title === undefined ? '' : `<title>${page.title}</title>`
  const schema = page.schema === undefined ? '' : `<script type="application/ld+json">${JSON.stringify(page.schema)}</script>`
  const h1 = page.h1 === undefined ? '' : `<h1>${page.h1}</h1>`
  return `<!doctype html><html><head>${title}${page.head ?? ''}${schema}</head><body>${h1}${page.body ?? `${FILLER}${OWN_FOOTER}`}</body></html>`
}

function analyze(page: Page) {
  const source = html(page)
  const $ = load(source)
  const context: AuditContext = {
    $, html: source, url: page.url ?? PAGE_URL, headers: {}, auxiliary: {},
    structuredData: parseJsonLdScripts($), textContent: getVisibleText($, source), pageTitle: $('title').first().text().trim(),
  }
  return analyzeEntityConsistency(context)
}

function identity(page: Page) {
  return analyze(page).findings.filter((finding) => finding.code.startsWith('entity-consistency.schema-identity.'))
}

const codes = (page: Page): string[] => identity(page).map((finding) => finding.code)

describe('schema identity', () => {
  it('flags lodging markup that names a resort in another country', () => {
    const result = analyze({ ...ownPage, schema: strayResort })
    const finding = result.findings.find((entry) => entry.code === 'entity-consistency.schema-identity.mismatch')
    expect(finding?.type).toBe('missing')
    expect(finding?.message).toBe(
      'JSON-LD LodgingBusiness "Hotel Mirador Azul" does not match this page.'
      + ' Name: not found in the title "Juniper Cove Inn | Harbor Rooms in Port Alder", the H1 "Juniper Cove Inn" or the page text.'
      + ' Address: Bahía Clara, Costa Norte, Mexico, but the page shows a US postal address and never mentions Bahía Clara, Costa Norte or Mexico.',
    )
    expect(result.recommendations[0]).toContain('business name and address describe the business the page shows')
  })

  it('reports the mismatch without changing the score', () => {
    const misplaced = analyze({ ...ownPage, schema: { ...ownInn, address: abroad } })
    const mismatch = misplaced.findings.find((entry) => entry.code === 'entity-consistency.schema-identity.mismatch')
    expect(mismatch?.message).not.toContain('Name:')
    expect(misplaced.score).toBe(analyze({ ...ownPage, schema: ownInn }).score)
  })

  it.each([
    ['The Example Resort', 'Example Resort & Spa'],
    ['Juniper Cove Inn, LLC', 'Juniper Cove | Port Alder'],
    ['Café Lumière', 'Cafe Lumiere: Pastries and Coffee'],
    ["Ollie's Harbor Grill", 'Ollies Harbor Grill - Port Alder'],
    ['JUNIPER COVE INN', 'juniper cove inn'],
  ])('treats "%s" and the title "%s" as one name', (name, title) => {
    const result = identity({ title, h1: 'Rooms and rates', body: FILLER, schema: { '@type': 'LocalBusiness', name } })
    expect(result).toEqual([expect.objectContaining({ type: 'found', code: 'entity-consistency.schema-identity.ok' })])
  })

  it.each<[string, Page]>([
    ['the H1', { h1: 'Juniper Cove Inn' }],
    ['og:site_name', { head: '<meta property="og:site_name" content="Juniper Cove Inn">' }],
    ['the host name', { url: 'https://www.junipercoveinn.example/rooms/deluxe-king/' }],
    ['the page text', { body: `${FILLER}<footer><p>© 2026 Juniper Cove Inn</p></footer>` }],
    ['an alternateName', { h1: 'Juniper Cove Inn', schema: { '@type': 'Hotel', name: 'Harborlight Holdings', alternateName: 'Juniper Cove Inn' } }],
  ])('accepts a name found only in %s', (_where, page) => {
    expect(codes({ title: 'Deluxe King Room', h1: 'Deluxe King Room', body: FILLER, schema: { '@type': 'Hotel', name: 'Juniper Cove Inn' }, ...page }))
      .toEqual(['entity-consistency.schema-identity.ok'])
  })

  it('flags a sister property that shares the brand but sits in another country', () => {
    const [finding, ...rest] = identity({
      title: 'Example Resort Port Alder', h1: 'Example Resort Port Alder',
      schema: { '@type': 'Resort', name: 'Example Resort Bahía Clara', address: abroad },
    })
    expect(rest).toEqual([])
    expect(finding?.code).toBe('entity-consistency.schema-identity.mismatch')
    expect(finding?.message).not.toContain('Name:')
    expect(finding?.message).toContain('Address: Bahía Clara, Costa Norte, Mexico, but the page shows a US postal address')
  })

  it('accepts a foreign address the page mentions, such as a resort with a sales office abroad', () => {
    expect(codes({
      title: 'Hotel Mirador Azul | Beachfront Rooms', h1: 'Hotel Mirador Azul',
      body: `${FILLER}<p>On the beach in Bahia Clara.</p><footer>Sales office: 400 Bay Street, Coral Point, FL 33101</footer>`,
      schema: strayResort,
    })).toEqual(['entity-consistency.schema-identity.ok'])
  })

  it('accepts a page that names the schema country', () => {
    expect(codes({ ...ownPage, body: `${FILLER}<p>Sister resorts in Mexico.</p>${OWN_FOOTER}`, schema: { ...ownInn, address: abroad } }))
      .toEqual(['entity-consistency.schema-identity.ok'])
  })

  it('needs evidence of where the page is before calling a country different', () => {
    expect(codes({ ...ownPage, body: FILLER, schema: { ...ownInn, address: abroad } })).toEqual(['entity-consistency.schema-identity.ok'])
  })

  it('reads where the page is from its geo.region tag', () => {
    const page = { ...ownPage, body: FILLER, head: '<meta name="geo.region" content="US-ME">' }
    const [finding] = identity({ ...page, schema: { ...ownInn, address: abroad } })
    expect(finding?.code).toBe('entity-consistency.schema-identity.mismatch')
    expect(finding?.message).toContain('but the page\'s geo.region tag is "US-ME" and never mentions')
    expect(codes({ ...page, schema: ownInn })).toEqual(['entity-consistency.schema-identity.ok'])
  })

  it('reads a US postal address split across elements', () => {
    const body = `${FILLER}<footer><span>Port Alder</span>, <span>ME</span> <span>04001</span></footer>`
    const [finding] = identity({ ...ownPage, body, schema: { ...ownInn, address: abroad } })
    expect(finding?.message).toContain('but the page shows a US postal address')
  })

  it('reads a Canadian postal address as the page location', () => {
    const body = `${FILLER}<footer>Juniper Cove Inn, 8 Wharf Lane, Port Alder, NS B0J 1A0</footer>`
    const [finding] = identity({ ...ownPage, body, schema: { ...ownInn, address: abroad } })
    expect(finding?.message).toContain('but the page shows a Canadian postal address')
  })

  it.each<[string, unknown]>([
    ['a country name', 'Mexico'],
    ['a Country node', { '@type': 'Country', name: 'MX' }],
  ])('resolves addressCountry given as %s', (_form, addressCountry) => {
    const [finding] = identity({ ...ownPage, schema: { ...ownInn, address: { ...abroad, addressCountry } } })
    expect(finding?.code).toBe('entity-consistency.schema-identity.mismatch')
  })

  it('ignores Organization markup, which usually names the publisher or parent brand', () => {
    expect(identity({ ...ownPage, schema: { '@type': 'Organization', name: 'Harborlight Hospitality Group', address: abroad } })).toEqual([])
  })

  it('stays silent when a name has nothing distinctive to look for', () => {
    expect(identity({ ...ownPage, schema: { '@type': 'Hotel', name: 'The Inn & Suites' } })).toEqual([])
  })

  it('does not call a name missing when the page has too little text or no title and H1 to judge', () => {
    const schema = { '@type': 'Hotel', name: 'Hotel Mirador Azul' }
    expect(identity({ title: 'Deluxe King Room', h1: 'Deluxe King Room', body: '<div id="app"></div>', schema })).toEqual([])
    expect(identity({ body: FILLER, schema })).toEqual([])
  })

  describe('pages with several businesses', () => {
    const listing = ['Juniper Cove Inn', 'Hotel Mirador Azul', 'Saltmarsh Lodge'].map((name) => ({ '@type': 'LodgingBusiness', name }))

    it('accepts a listing page that names each business', () => {
      const body = `${FILLER}<ul>${listing.map((business) => `<li>${business.name}</li>`).join('')}</ul>`
      expect(codes({ title: 'Our Inns', h1: 'Our Inns', body, schema: listing })).toEqual(['entity-consistency.schema-identity.ok'])
    })

    it('does not flag a listing page whose business names are not in the HTML', () => {
      expect(identity({ title: 'Our Inns', h1: 'Our Inns', body: FILLER, schema: listing })).toEqual([])
    })

    it('flags stray businesses beside the one the page names, in one finding', () => {
      const result = identity({ ...ownPage, schema: [ownInn, strayResort, { '@type': 'Restaurant', name: 'Cantina Faro Rojo' }] })
      expect(result).toHaveLength(1)
      expect(result[0]?.message).toContain('JSON-LD LodgingBusiness "Hotel Mirador Azul" does not match this page.')
      expect(result[0]?.message).toContain('1 more business entry on this page also does not match.')
    })
  })

  it('finds business markup in @graph, in a page mainEntity and under full type URLs', () => {
    const schema = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebSite', name: 'Juniper Cove Inn' },
        { '@type': 'WebPage', name: 'Rooms', mainEntity: { '@type': 'https://schema.org/Hotel', name: 'Hotel Mirador Azul' } },
      ],
    }
    const [finding] = identity({ ...ownPage, schema })
    expect(finding?.code).toBe('entity-consistency.schema-identity.mismatch')
    expect(finding?.message).toContain('JSON-LD Hotel "Hotel Mirador Azul"')
  })

  it('reaches the Entity Consistency factor of a full audit', async () => {
    const report = await auditHtmlPage({
      inputUrl: PAGE_URL, finalUrl: PAGE_URL, html: html({ ...ownPage, schema: strayResort }),
      headers: {}, redirectChain: [], fetchTimeMs: 0, auxiliary: {},
    }, { factors: ['entity-consistency'] })
    expect(report.factors[0]?.findings).toContainEqual(expect.objectContaining({ type: 'missing', code: 'entity-consistency.schema-identity.mismatch' }))
  })
})

describe('resolveCountry', () => {
  it.each([
    ['MX', 'MX'], ['mx', 'MX'], ['MX-SIN', 'MX'], ['Mexico', 'MX'], ['México', 'MX'], ['MEX', 'MX'],
    ['US', 'US'], ['USA', 'US'], ['U.S.A.', 'US'], ['United States', 'US'],
    ['UK', 'GB'], ['United Kingdom', 'GB'], ['Royaume-Uni', 'GB'],
  ])('reads %s as %s', (raw, code) => {
    expect(resolveCountry(raw)).toBe(code)
  })

  it.each(['EU', 'ZZ', 'Atlantis', ''])('does not read "%s" as a country', (raw) => {
    expect(resolveCountry(raw)).toBeUndefined()
  })
})

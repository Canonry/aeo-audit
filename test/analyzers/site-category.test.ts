import { describe, it, expect } from 'vitest'
import { load } from 'cheerio'

import { detectSiteCategory, getVisibleText, parseJsonLdScripts } from '../../src/analyzers/helpers.js'
import { analyzeStructuredData } from '../../src/analyzers/structured-data.js'
import { analyzeSchemaCompleteness } from '../../src/analyzers/schema-completeness.js'
import { defaultAuxiliary } from '../fixtures/pages.js'
import type { AuditContext } from '../../src/types.js'

function buildContext(html: string): AuditContext {
  const $ = load(html)
  return {
    $,
    html,
    url: 'https://example.com/',
    headers: {},
    auxiliary: defaultAuxiliary,
    structuredData: parseJsonLdScripts($),
    textContent: getVisibleText($, html),
    pageTitle: $('title').first().text().trim(),
  }
}

const wrap = (body: string) => `<!doctype html><html><head><title>T</title></head><body>${body}</body></html>`

describe('detectSiteCategory (issue #33)', () => {
  it('classifies a SaaS / dev-tools site as saas-devtools', () => {
    const html = wrap(`
      <h1>Hey API</h1>
      <p>Open source OpenAPI to TypeScript and Python SDK generator. Install with npm install @hey-api/openapi-ts.</p>
      <p>See the documentation and GitHub repo at <a href="https://github.com/hey-api/openapi-ts">hey-api/openapi-ts</a>.</p>
      <p>Pricing for enterprise customers available. Self-host or use our cloud platform.</p>
      <p>Built on a robust API with OAuth and webhook integration.</p>
    `)
    const detection = detectSiteCategory(buildContext(html))
    expect(detection.category).toBe('saas-devtools')
    expect(detection.recommendedSchemas).toContain('SoftwareApplication')
    expect(detection.recommendedSchemas).toContain('Organization')
    expect(detection.recommendedSchemas).not.toContain('LocalBusiness')
  })

  it('classifies an e-commerce site as ecommerce', () => {
    const html = wrap(`
      <h1>Acme Goods</h1>
      <p>Free shipping on orders over $50. View product details below.</p>
      <button>Add to cart</button>
      <button>Buy now</button>
      <p>SKU: 12345. In stock. 30-day returns.</p>
    `)
    const detection = detectSiteCategory(buildContext(html))
    expect(detection.category).toBe('ecommerce')
    expect(detection.recommendedSchemas).toContain('Product')
  })

  it('classifies a local business as local-business', () => {
    const html = wrap(`
      <h1>Joe's Pizza</h1>
      <p>Opening hours: Mon-Sun 11am-11pm. Walk-ins welcome. Visit us in the heart of Brooklyn.</p>
      <p>Get directions to our location.</p>
      <p>Reservations recommended. Book a table online.</p>
    `)
    const detection = detectSiteCategory(buildContext(html))
    expect(detection.category).toBe('local-business')
    expect(detection.recommendedSchemas).toContain('LocalBusiness')
  })

  it('classifies a service business as service-business', () => {
    const html = wrap(`
      <h1>Smith Consulting Group</h1>
      <p>Book a consultation today. Free consultation available.</p>
      <p>Our services include strategy and operations work for Fortune 500 clients.</p>
      <p>Read our case studies and testimonials from happy clients.</p>
      <p>Get a quote for your project.</p>
    `)
    const detection = detectSiteCategory(buildContext(html))
    expect(detection.category).toBe('service-business')
    expect(detection.recommendedSchemas).toContain('Service')
  })

  it('classifies a content/blog site as blog-or-content', () => {
    const html = wrap(`
      <h1>My Blog</h1>
      <p>Recent posts and latest articles below. Subscribe to newsletter for updates.</p>
      <p>Browse archives, categories, and tags.</p>
      <article>Published on Jan 1 by Jane Doe</article>
    `)
    const detection = detectSiteCategory(buildContext(html))
    expect(detection.category).toBe('blog-or-content')
    expect(detection.recommendedSchemas).toContain('Article')
  })

  it('returns unknown (safe default) when no strong signals are present', () => {
    const html = wrap(`<h1>Hello</h1><p>Welcome.</p>`)
    const detection = detectSiteCategory(buildContext(html))
    expect(detection.category).toBe('unknown')
    expect(detection.recommendedSchemas).toContain('Organization')
    expect(detection.recommendedSchemas).not.toContain('LocalBusiness')
  })

  it('uses existing JSON-LD type as the strongest signal even when text is ambiguous', () => {
    const html = wrap(`
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'X',
      })}</script>
      <p>Welcome.</p>
    `)
    const detection = detectSiteCategory(buildContext(html))
    expect(detection.category).toBe('saas-devtools')
  })
})

describe('analyzeStructuredData (issue #33)', () => {
  it('recommends SaaS-appropriate schemas for a dev tools site missing JSON-LD', () => {
    const html = wrap(`
      <h1>Dev tool</h1>
      <p>API documentation, SDK, npm install our package, GitHub repo at github.com/x/y.</p>
      <p>OAuth and webhook integration for enterprise customers.</p>
    `)
    const result = analyzeStructuredData(buildContext(html))
    const rec = result.recommendations.find((r) => r.startsWith('Add JSON-LD'))
    expect(rec).toBeDefined()
    expect(rec).toContain('SoftwareApplication')
    expect(rec).toContain('Organization')
    expect(rec).not.toContain('LocalBusiness')
  })

  it('still recommends LocalBusiness for an actual local business missing JSON-LD', () => {
    const html = wrap(`
      <h1>Joe's Pizza</h1>
      <p>Opening hours: Mon-Sun. Walk-ins welcome. Visit us in the heart of Brooklyn.</p>
      <p>Get directions. Reservations recommended. Book a table.</p>
    `)
    const result = analyzeStructuredData(buildContext(html))
    const rec = result.recommendations.find((r) => r.startsWith('Add JSON-LD'))
    expect(rec).toBeDefined()
    expect(rec).toContain('LocalBusiness')
  })

  it('falls back to Organization-only recommendation when category is unknown', () => {
    const html = wrap('<h1>Hi</h1>')
    const result = analyzeStructuredData(buildContext(html))
    const rec = result.recommendations.find((r) => r.startsWith('Add JSON-LD'))
    expect(rec).toBeDefined()
    expect(rec).toContain('Organization')
    expect(rec).not.toContain('LocalBusiness')
  })
})

describe('analyzeSchemaCompleteness (issue #33)', () => {
  it('uses domain-aware fallback recommendation when no recognized schema types exist', () => {
    const html = wrap(`
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        name: 'API SDK Generator',
        description: 'Generate TypeScript SDKs from OpenAPI specs',
        url: 'https://example.com',
        keywords: 'openapi, typescript, sdk, npm, github',
        inLanguage: 'en',
        author: 'X',
        datePublished: '2026-01-01',
        dateModified: '2026-02-01',
      })}</script>
      <p>npm install our package, see GitHub repo, API docs, SDK reference, OAuth, webhook, enterprise pricing.</p>
    `)
    const result = analyzeSchemaCompleteness(buildContext(html))
    const recs = result.recommendations.join('\n')
    expect(recs).toContain('SoftwareApplication')
    expect(recs).not.toMatch(/LocalBusiness/)
  })
})

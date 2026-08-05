import { describe, it, expect } from 'vitest'

import { buildCoverage, countTemplates, deriveTemplateKeys, deriveUrlShapes, routeKey, selectRepresentativeSample } from '../src/url-templates.js'

const propertyUrls = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `https://example.com/properties/city${i % 12}/building-${i}`)

describe('deriveTemplateKeys', () => {
  it('collapses identifier segments and keeps route segments', () => {
    const urls = propertyUrls(30)
    const keys = deriveTemplateKeys(urls)

    // `properties` is one value across the corpus; city and building slots vary.
    expect(new Set(keys.values())).toEqual(new Set(['/properties/*/*']))
  })

  it('keeps a small fixed route vocabulary distinct', () => {
    const urls = [
      ...propertyUrls(20).map((u) => `${u}/floorplans`),
      ...propertyUrls(20).map((u) => `${u}/amenities`),
    ]
    const keys = deriveTemplateKeys(urls)

    expect(new Set(keys.values())).toEqual(
      new Set(['/properties/*/*/floorplans', '/properties/*/*/amenities']),
    )
  })

  it('does not pool positions across different depths', () => {
    // /blog/<slug> and /blog/<year>/<slug> put unrelated things at position 1;
    // merging the depths would call both variable and erase the distinction.
    const urls = [
      ...Array.from({ length: 12 }, (_, i) => `https://example.com/blog/post-${i}`),
      ...Array.from({ length: 12 }, (_, i) => `https://example.com/blog/2026/post-${i}`),
    ]
    const keys = deriveTemplateKeys(urls)

    expect(keys.get('https://example.com/blog/post-3')).toBe('/blog/*')
    expect(keys.get('https://example.com/blog/2026/post-3')).toBe('/blog/2026/*')
  })

  it('gives the homepage its own key', () => {
    const keys = deriveTemplateKeys(['https://example.com/', ...propertyUrls(12)])
    expect(keys.get('https://example.com/')).toBe('/')
  })

  it('never merges URLs it cannot parse', () => {
    const keys = deriveTemplateKeys(['not a url', 'also not a url'])
    expect(keys.get('not a url')).toBe('not a url')
    expect(keys.get('also not a url')).toBe('also not a url')
  })

  it('is case-insensitive on the path', () => {
    const keys = deriveTemplateKeys(['https://example.com/Blog', 'https://example.com/blog'])
    expect(keys.get('https://example.com/Blog')).toBe(keys.get('https://example.com/blog'))
  })
})

describe('selectRepresentativeSample', () => {
  const key = (url: string): string => deriveTemplateKeys(corpus).get(url) ?? url
  const corpus = [
    ...Array.from({ length: 200 }, (_, i) => `https://example.com/properties/p-${i}`),
    ...Array.from({ length: 20 }, (_, i) => `https://example.com/blog/post-${i}`),
    'https://example.com/about',
  ]

  it('reaches every template instead of taking a prefix', () => {
    // The bug this replaces: `eligible.slice(0, limit)` in document order. With
    // no <priority> declared the sort above it was a no-op, so a 10-page budget
    // spent all 10 on whatever sorted first and never saw /blog or /about.
    const picked = selectRepresentativeSample(corpus, 10, { keyOf: key })
    const templates = new Set(picked.map(key))

    expect(picked).toHaveLength(10)
    expect(templates.size).toBe(countTemplates(corpus))
  })

  it('gives the larger template more of the budget once small ones exhaust', () => {
    const picked = selectRepresentativeSample(corpus, 60, { keyOf: key })
    const properties = picked.filter((u) => u.includes('/properties/')).length
    const blog = picked.filter((u) => u.includes('/blog/')).length

    expect(blog).toBe(20) // exhausted — only 20 exist
    expect(properties).toBeGreaterThan(blog)
  })

  it('always keeps a pinned page', () => {
    const withHome = ['https://example.com/', ...corpus]
    const picked = selectRepresentativeSample(withHome, 3, {
      keyOf: key,
      pin: (url) => url === 'https://example.com/',
    })
    expect(picked).toContain('https://example.com/')
  })

  it('orders within a group by rank', () => {
    const urls = Array.from({ length: 40 }, (_, i) => `https://example.com/p/${i}`)
    const priority = (url: string): number => (url.endsWith('/0') ? 1 : 0.1)
    const picked = selectRepresentativeSample(urls, 1, {
      keyOf: () => 'one-group',
      rank: (a, b) => priority(b) - priority(a),
    })
    expect(picked).toEqual(['https://example.com/p/0'])
  })

  it('is deterministic — the same input always picks the same pages', () => {
    const a = selectRepresentativeSample(corpus, 37, { keyOf: key })
    const b = selectRepresentativeSample(corpus, 37, { keyOf: key })
    expect(a).toEqual(b)
  })

  it('returns everything untouched when the limit does not bind', () => {
    const picked = selectRepresentativeSample(corpus, corpus.length + 5, { keyOf: key })
    expect(picked).toEqual(corpus)
  })

  it('preserves input order in the result', () => {
    const picked = selectRepresentativeSample(corpus, 25, { keyOf: key })
    expect(picked).toEqual(corpus.filter((url) => picked.includes(url)))
  })
})

describe('buildCoverage', () => {
  const discovered = [
    ...Array.from({ length: 200 }, (_, i) => `https://example.com/properties/p-${i}`),
    ...Array.from({ length: 20 }, (_, i) => `https://example.com/blog/post-${i}`),
  ]

  it('reports full coverage when nothing was sampled', () => {
    const coverage = buildCoverage(discovered, discovered)
    expect(coverage.sampled).toBe(false)
    expect(coverage.confidence).toBe('full')
    expect(coverage.selection).toBe('all')
    expect(coverage.coveragePct).toBe(100)
  })

  it('calls a small sample representative when it reached every template', () => {
    const keys = deriveTemplateKeys(discovered)
    const audited = selectRepresentativeSample(discovered, 12, { keyOf: (u) => keys.get(u) ?? u })
    const coverage = buildCoverage(discovered, audited)

    expect(coverage.coveragePct).toBe(5)
    expect(coverage.confidence).toBe('representative')
    expect(coverage.templatesRepresented).toBe(coverage.templatesDiscovered)
  })

  it('calls a prefix indicative even when it is much larger', () => {
    // 45% of the site, but every page from one template — the aggregate says
    // nothing about /blog. Raw percentage would have rated this the better sample.
    const coverage = buildCoverage(discovered, discovered.slice(0, 100))
    expect(coverage.coveragePct).toBe(45)
    expect(coverage.confidence).toBe('indicative')
    expect(coverage.templatesRepresented).toBeLessThan(coverage.templatesDiscovered)
  })

  it('resolves audited final URLs back to discovered templates across a redirect', () => {
    // Sampling audits each <loc>, but the report records the final URL — here
    // every audited page 301s http->https and gains a trailing slash. Matched by
    // raw string none would find a discovered template and coverage would read
    // 0 templates represented, mislabelling a full-reach sample as indicative.
    const keys = deriveTemplateKeys(discovered)
    const sample = selectRepresentativeSample(discovered, 12, { keyOf: (u) => keys.get(u) ?? u })
    const finalUrls = sample.map((u) => `${u.replace('https://', 'http://')}/`)

    const coverage = buildCoverage(discovered, finalUrls)

    expect(coverage.templatesRepresented).toBe(coverage.templatesDiscovered)
    expect(coverage.confidence).toBe('representative')
  })
})

describe('routeKey', () => {
  it('is stable across the URL differences a redirect introduces', () => {
    const canonical = routeKey('https://example.com/about')
    expect(routeKey('https://example.com/about/')).toBe(canonical) // trailing slash
    expect(routeKey('http://example.com/about')).toBe(canonical) // protocol
    expect(routeKey('https://www.example.com/about')).toBe(canonical) // host
  })

  it('keeps genuinely different routes distinct', () => {
    expect(routeKey('https://example.com/a')).not.toBe(routeKey('https://example.com/b'))
  })
})

describe('spreadBy — coverage inside a template', () => {
  // 120 property pages across 12 cities, listed city by city (the order a
  // directory walk or a generated sitemap produces).
  const cities = ['austin', 'boston', 'chicago', 'dallas', 'denver', 'houston',
    'miami', 'nashville', 'phoenix', 'raleigh', 'seattle', 'tampa']
  const corpus = cities.flatMap((city) =>
    Array.from({ length: 10 }, (_, i) => `https://example.com/properties/${city}/building-${i}`),
  )
  const shapes = deriveUrlShapes(corpus)
  const cityOf = (url: string): string => url.split('/')[4] as string

  it('spans every section instead of exhausting the first', () => {
    const picked = selectRepresentativeSample(corpus, 12, {
      keyOf: (u) => shapes.get(u)?.templateKey ?? u,
      spreadBy: (u) => shapes.get(u)?.identifiers[0] ?? '',
    })
    expect(new Set(picked.map(cityOf)).size).toBe(12)
  })

  it('without it, the same budget lands on the first section only', () => {
    // The residual of the original bug one level down: stratifying across
    // templates alone still leaves picks within a template in list order.
    const picked = selectRepresentativeSample(corpus, 12, {
      keyOf: (u) => shapes.get(u)?.templateKey ?? u,
    })
    expect(new Set(picked.map(cityOf)).size).toBe(2)
  })

  it('stays deterministic', () => {
    const opts = {
      keyOf: (u: string) => shapes.get(u)?.templateKey ?? u,
      spreadBy: (u: string) => shapes.get(u)?.identifiers[0] ?? '',
    }
    expect(selectRepresentativeSample(corpus, 25, opts)).toEqual(
      selectRepresentativeSample(corpus, 25, opts),
    )
  })

  it('still returns every item when the limit does not bind', () => {
    const picked = selectRepresentativeSample(corpus, corpus.length, {
      keyOf: (u) => shapes.get(u)?.templateKey ?? u,
      spreadBy: (u) => shapes.get(u)?.identifiers[0] ?? '',
    })
    expect(picked).toEqual(corpus)
  })
})

describe('deriveUrlShapes', () => {
  it('reports the values that filled the identifier slots', () => {
    const urls = Array.from({ length: 20 }, (_, i) => `https://example.com/properties/city${i}/b-${i}`)
    const shape = deriveUrlShapes(urls).get('https://example.com/properties/city3/b-3')
    expect(shape?.templateKey).toBe('/properties/*/*')
    expect(shape?.identifiers).toEqual(['city3', 'b-3'])
  })

  it('reports no identifiers for a fully structural path', () => {
    const shape = deriveUrlShapes(['https://example.com/about']).get('https://example.com/about')
    expect(shape?.templateKey).toBe('/about')
    expect(shape?.identifiers).toEqual([])
  })
})

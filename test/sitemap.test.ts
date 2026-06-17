import { test, expect } from 'vitest'

import { mapWithConcurrency, parseSitemapXml, shouldSkipUrl } from '../src/sitemap.js'

test('parseSitemapXml extracts loc and priority from url blocks', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/</loc>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://example.com/about</loc>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://example.com/blog</loc>
  </url>
</urlset>`

  const entries = parseSitemapXml(xml)
  expect(entries).toHaveLength(3)
  expect(entries[0].loc).toBe('https://example.com/')
  expect(entries[0].priority).toBe(1.0)
  expect(entries[1].loc).toBe('https://example.com/about')
  expect(entries[1].priority).toBe(0.8)
  expect(entries[2].loc).toBe('https://example.com/blog')
  expect(entries[2].priority).toBeUndefined()
})

test('parseSitemapXml handles sitemap index files', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sitemap-posts.xml</loc>
  </sitemap>
  <sitemap>
    <loc>https://example.com/sitemap-pages.xml</loc>
  </sitemap>
</sitemapindex>`

  const entries = parseSitemapXml(xml)
  expect(entries).toHaveLength(2)
  expect(entries[0].loc).toBe('https://example.com/sitemap-posts.xml')
  expect(entries[1].loc).toBe('https://example.com/sitemap-pages.xml')
})

test('parseSitemapXml decodes XML-escaped ampersands in urlset <loc> query params (issue #50)', () => {
  // Per sitemaps.org, `&` in a URL must be written `&amp;`. Without decoding, the
  // fetcher requests the literal `...&amp;...`, which the origin treats as a
  // different (usually empty) request, silently dropping the page.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/search?type=pages&amp;page=1&amp;lang=en</loc>
  </url>
</urlset>`

  const entries = parseSitemapXml(xml)
  expect(entries).toHaveLength(1)
  expect(entries[0].loc).toBe('https://example.com/search?type=pages&page=1&lang=en')
})

test('parseSitemapXml decodes XML-escaped ampersands in sitemapindex child <loc> (issue #50)', () => {
  // The BigCommerce repro: every child sitemap of the index carries `&amp;` query
  // params, so without decoding all child fetches fail and the audit returns zero
  // URLs ("No auditable URLs found in sitemap.").
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/xmlsitemap.php?type=pages&amp;page=1</loc>
  </sitemap>
  <sitemap>
    <loc>https://example.com/xmlsitemap.php?type=products&amp;page=1</loc>
  </sitemap>
</sitemapindex>`

  const entries = parseSitemapXml(xml)
  expect(entries).toHaveLength(2)
  expect(entries[0].loc).toBe('https://example.com/xmlsitemap.php?type=pages&page=1')
  expect(entries[1].loc).toBe('https://example.com/xmlsitemap.php?type=products&page=1')
})

test('parseSitemapXml decodes numeric and named character references, with &amp; applied last', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/q?a=1&amp;b=2&#38;c=3&#x26;d=4</loc>
  </url>
  <url>
    <loc>https://example.com/caf&#233;</loc>
  </url>
</urlset>`

  const entries = parseSitemapXml(xml)
  expect(entries).toHaveLength(2)
  // &amp;, &#38; (decimal) and &#x26; (hex) all resolve to a literal ampersand.
  expect(entries[0].loc).toBe('https://example.com/q?a=1&b=2&c=3&d=4')
  expect(entries[1].loc).toBe('https://example.com/café')
})

test('shouldSkipUrl filters non-HTML URLs', () => {
  expect(shouldSkipUrl('https://example.com/doc.pdf')).toBe(true)
  expect(shouldSkipUrl('https://example.com/image.png')).toBe(true)
  expect(shouldSkipUrl('https://example.com/data.xml')).toBe(true)
  expect(shouldSkipUrl('https://example.com/robots.txt')).toBe(true)
  expect(shouldSkipUrl('https://example.com/style.css')).toBe(true)
  expect(shouldSkipUrl('https://example.com/app.js')).toBe(true)
})

test('shouldSkipUrl allows HTML content pages', () => {
  expect(shouldSkipUrl('https://example.com/')).toBe(false)
  expect(shouldSkipUrl('https://example.com/about')).toBe(false)
  expect(shouldSkipUrl('https://example.com/blog/post-1')).toBe(false)
  expect(shouldSkipUrl('https://example.com/page.html')).toBe(false)
  expect(shouldSkipUrl('https://example.com/page.htm')).toBe(false)
})

test('mapWithConcurrency preserves input order and caps in-flight workers', async () => {
  const items = Array.from({ length: 20 }, (_, i) => i)
  let inFlight = 0
  let peakInFlight = 0

  const results = await mapWithConcurrency(items, 5, async (item) => {
    inFlight += 1
    peakInFlight = Math.max(peakInFlight, inFlight)
    // Yield to the event loop a few times so workers actually overlap.
    await new Promise((resolve) => setTimeout(resolve, 1))
    inFlight -= 1
    return item * 2
  })

  expect(results).toEqual(items.map((i) => i * 2))
  expect(peakInFlight).toBeLessThanOrEqual(5)
  expect(peakInFlight).toBeGreaterThan(1)
})

test('mapWithConcurrency handles empty input', async () => {
  const results = await mapWithConcurrency<number, number>([], 5, async (n) => n)
  expect(results).toEqual([])
})

test('mapWithConcurrency caps workers to item count when items < concurrency', async () => {
  let peakInFlight = 0
  let inFlight = 0
  const results = await mapWithConcurrency([1, 2], 10, async (n) => {
    inFlight += 1
    peakInFlight = Math.max(peakInFlight, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 1))
    inFlight -= 1
    return n
  })
  expect(results).toEqual([1, 2])
  expect(peakInFlight).toBeLessThanOrEqual(2)
})

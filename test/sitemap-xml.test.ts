import { expect, test } from 'vitest'

import { parseSitemapXmlDocument } from '../src/sitemap-xml.js'

test('parses page and child sitemap locations with numeric XML entities', () => {
  const pageDocument = parseSitemapXmlDocument(`<?xml version="1.0" encoding="UTF-8"?>
<urlset>
  <url><loc>https://example.com/products?type=detail&#38;page=2&#x26;lang=en</loc><priority>0.8</priority></url>
</urlset>`)
  const childDocument = parseSitemapXmlDocument(`<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex>
  <sitemap><loc>https://example.com/sitemap.xml?type=products&#38;page=2</loc></sitemap>
</sitemapindex>`)

  expect(pageDocument.pages).toEqual([
    { loc: 'https://example.com/products?type=detail&page=2&lang=en', priority: 0.8 },
  ])
  expect(childDocument.children).toEqual([
    { loc: 'https://example.com/sitemap.xml?type=products&page=2' },
  ])
})

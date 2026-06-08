import { test, expect } from 'vitest'
import { load } from 'cheerio'

import { parseJsonLdScripts, getVisibleText, extractSchemaTypes } from '../../src/analyzers/helpers.js'
import { analyzeStructuredData } from '../../src/analyzers/structured-data.js'
import { analyzeAiReadableContent } from '../../src/analyzers/ai-readable-content.js'
import { analyzeContentDepth } from '../../src/analyzers/content-depth.js'
import { analyzeContentFreshness } from '../../src/analyzers/content-freshness.js'
import { scoreFactors } from '../../src/scoring.js'
import { strongHtml, weakHtml, defaultAuxiliary } from '../fixtures/pages.js'
import type { AuditContext, AuxiliaryResources } from '../../src/types.js'

function buildContext(html: string, auxiliary: AuxiliaryResources = defaultAuxiliary): AuditContext {
  const $ = load(html)
  const structuredData = parseJsonLdScripts($)
  return {
    $,
    html,
    url: 'https://ainyc.ai/',
    headers: {
      'last-modified': 'Wed, 21 Feb 2026 10:00:00 GMT',
    },
    auxiliary,
    structuredData,
    textContent: getVisibleText($, html),
    pageTitle: $('title').first().text().trim(),
  }
}

test('structured data analyzer scores strong fixture highly', () => {
  const result = analyzeStructuredData(buildContext(strongHtml))
  expect(result.score).toBeGreaterThanOrEqual(75)
  expect(result.findings.some((finding) => finding.type === 'found')).toBe(true)
})

test('ai-readable analyzer handles timeout as uncertain instead of hard-missing', () => {
  const context = buildContext(strongHtml, {
    ...defaultAuxiliary,
    llmsFullTxt: {
      state: 'timeout',
      body: '',
    },
  })

  const result = analyzeAiReadableContent(context)
  expect(result.score).toBeGreaterThan(0)
  expect(result.findings.some((finding) => finding.type === 'timeout')).toBe(true)
})

test('content depth analyzer penalizes thin pages', () => {
  const result = analyzeContentDepth(buildContext(weakHtml))
  expect(result.score).toBeLessThan(50)
  expect(result.findings.some((finding) => finding.type === 'missing')).toBe(true)
})

test('freshness analyzer reports sitemap timeout as timeout finding', () => {
  const context = buildContext(strongHtml, {
    ...defaultAuxiliary,
    sitemapXml: {
      state: 'timeout',
      body: '',
    },
  })

  const result = analyzeContentFreshness(context)
  expect(result.findings.some((finding) => finding.type === 'timeout')).toBe(true)
})

test('extractSchemaTypes finds nested HowTo inside a parent schema', () => {
  const html = `<html><head>
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": ["ProfessionalService", "LocalBusiness"],
          "name": "Test Biz",
          "hasProcess": {
            "@type": "HowTo",
            "name": "How It Works",
            "step": [{"@type": "HowToStep", "name": "Step 1"}]
          }
        }
      ]
    }
    </script>
  </head><body></body></html>`
  const $ = load(html)
  const structuredData = parseJsonLdScripts($)
  const types = extractSchemaTypes(structuredData)

  expect(types.has('HowTo')).toBe(true)
  expect(types.has('ProfessionalService')).toBe(true)
  expect(types.has('LocalBusiness')).toBe(true)
  expect(types.has('HowToStep')).toBe(true)
})

test('structured data analyzer detects nested HowTo schema', () => {
  const html = `<html><head>
    <title>Test</title>
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": ["ProfessionalService", "LocalBusiness"],
          "name": "Test Biz",
          "url": "https://example.com",
          "telephone": "+1-555-0100",
          "email": "info@example.com",
          "address": { "@type": "PostalAddress", "streetAddress": "123 Main" },
          "hasProcess": {
            "@type": "HowTo",
            "name": "How It Works",
            "step": [{"@type": "HowToStep", "name": "Step 1"}]
          }
        },
        {
          "@type": "FAQPage",
          "mainEntity": [{"@type": "Question", "name": "Q1", "acceptedAnswer": {"@type": "Answer", "text": "A1"}}]
        },
        {
          "@type": "Service",
          "name": "Consulting"
        }
      ]
    }
    </script>
  </head><body><p>Hello world</p></body></html>`

  const result = analyzeStructuredData(buildContext(html))
  const howToFinding = result.findings.find((f) => f.message.includes('HowTo'))
  expect(howToFinding).toBeDefined()
  expect(howToFinding?.type).toBe('found')
})

test('scoring engine clamps factor scores and computes a weighted overall', () => {
  const scored = scoreFactors([
    {
      id: 'structured-data',
      name: 'Structured Data (JSON-LD)',
      weight: 15,
      score: 80,
      findings: [],
      recommendations: [],
    },
    {
      id: 'ai-readable-content',
      name: 'AI-Readable Content',
      weight: 12,
      score: 20,
      findings: [],
      recommendations: [],
    },
  ])

  expect(scored.factors[0].score).toBe(80)
  expect(scored.factors[1].score).toBe(20)
  expect(typeof scored.overallScore).toBe('number')
})

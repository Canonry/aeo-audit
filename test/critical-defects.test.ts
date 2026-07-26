import { describe, it, expect } from 'vitest'
import { load } from 'cheerio'

import { buildCriticalDefects, detectCriticalDefects, isHomepageUrl } from '../src/critical-defects.js'
import { buildPrioritizedFixes } from '../src/sitemap.js'
import { formatSitemapMarkdown } from '../src/formatters/markdown.js'
import { formatSitemapText } from '../src/formatters/text.js'
import { getVisibleText, parseJsonLdScripts } from '../src/analyzers/helpers.js'
import type {
  AuditContext,
  AuditReport,
  AuxiliaryResources,
  CriticalDefect,
  CriticalDefectGroup,
  CrossCuttingIssue,
  PrioritizedFix,
  SitemapAuditReport,
} from '../src/types.js'

function aux(): AuxiliaryResources {
  return {
    llmsTxt: { state: 'missing', body: '' },
    llmsFullTxt: { state: 'missing', body: '' },
    robotsTxt: { state: 'missing', body: '' },
    sitemapXml: { state: 'missing', body: '' },
  }
}

function buildContext(html: string): AuditContext {
  const $ = load(html)
  return {
    $,
    html,
    url: 'https://example.com/',
    headers: {},
    auxiliary: aux(),
    structuredData: parseJsonLdScripts($),
    textContent: getVisibleText($, html),
    pageTitle: $('title').first().text().trim(),
  }
}

const HEAD = '<title>Page</title><meta name="description" content="A clear and sufficiently long meta description for the page that explains what it is about.">'

function report(url: string, criticalDefects: CriticalDefect[]): AuditReport {
  return {
    schemaVersion: '1.1',
    url,
    finalUrl: url,
    auditedAt: '2026-04-18T00:00:00.000Z',
    overallScore: 75,
    summary: '',
    factors: [],
    criticalDefects,
    metadata: {
      fetchTimeMs: 0,
      pageTitle: '',
      wordCount: 0,
      metaDescription: null,
      internalLinks: [],
      auxiliary: { llmsTxt: 'missing', llmsFullTxt: 'missing', robotsTxt: 'missing', sitemapXml: 'missing' },
      redirectChain: [],
    },
  }
}

const MULTIPLE_H1: CriticalDefect = {
  id: 'multiple-h1',
  severity: 'critical',
  detail: '4 H1 tags found (expected exactly one).',
  recommendation: 'Consolidate to a single H1; 4 are present.',
}
const MISSING_H1: CriticalDefect = {
  id: 'missing-h1',
  severity: 'critical',
  detail: 'No H1 tag.',
  recommendation: 'Add exactly one H1.',
}
const MISSING_META: CriticalDefect = {
  id: 'missing-meta-description',
  severity: 'warning',
  detail: 'No meta description.',
  recommendation: 'Add a meta description.',
}

describe('detectCriticalDefects', () => {
  it('returns no defects for a structurally healthy page', () => {
    const html = `<!doctype html><html><head>${HEAD}</head><body><h1>Topic</h1></body></html>`
    expect(detectCriticalDefects(buildContext(html))).toEqual([])
  })

  it('flags a missing H1 as critical', () => {
    const html = `<!doctype html><html><head>${HEAD}</head><body><p>No heading.</p></body></html>`
    const defects = detectCriticalDefects(buildContext(html))
    const h1 = defects.find((d) => d.id === 'missing-h1')
    expect(h1).toBeDefined()
    expect(h1?.severity).toBe('critical')
  })

  it('flags multiple H1 tags as critical and reports the count', () => {
    const html = `<!doctype html><html><head>${HEAD}</head><body><h1>A</h1><h1>B</h1><h1>C</h1><h1>D</h1></body></html>`
    const defects = detectCriticalDefects(buildContext(html))
    const h1 = defects.find((d) => d.id === 'multiple-h1')
    expect(h1).toBeDefined()
    expect(h1?.severity).toBe('critical')
    expect(h1?.detail).toContain('4 H1 tags')
  })

  it('does not flag an H1 defect when exactly one H1 is present', () => {
    const html = `<!doctype html><html><head>${HEAD}</head><body><h1>Only one</h1></body></html>`
    const defects = detectCriticalDefects(buildContext(html))
    expect(defects.some((d) => d.id === 'missing-h1' || d.id === 'multiple-h1')).toBe(false)
  })

  it('flags a missing <title> as critical', () => {
    const html = `<!doctype html><html><head><meta name="description" content="${'x'.repeat(150)}"></head><body><h1>Topic</h1></body></html>`
    const defects = detectCriticalDefects(buildContext(html))
    const title = defects.find((d) => d.id === 'missing-title')
    expect(title).toBeDefined()
    expect(title?.severity).toBe('critical')
  })

  it('flags a missing meta description as a warning', () => {
    const html = `<!doctype html><html><head><title>Page</title></head><body><h1>Topic</h1></body></html>`
    const defects = detectCriticalDefects(buildContext(html))
    const meta = defects.find((d) => d.id === 'missing-meta-description')
    expect(meta).toBeDefined()
    expect(meta?.severity).toBe('warning')
  })

  it('detects several defects on one page', () => {
    const html = `<!doctype html><html><head></head><body><p>nothing</p></body></html>`
    const ids = detectCriticalDefects(buildContext(html)).map((d) => d.id).sort()
    expect(ids).toEqual(['missing-h1', 'missing-meta-description', 'missing-title'])
  })
})

describe('isHomepageUrl', () => {
  it('treats the bare origin as the homepage', () => {
    expect(isHomepageUrl('https://example.com/')).toBe(true)
    expect(isHomepageUrl('https://example.com')).toBe(true)
  })

  it('rejects sub-paths and query strings', () => {
    expect(isHomepageUrl('https://example.com/contact-us')).toBe(false)
    expect(isHomepageUrl('https://example.com/?utm=1')).toBe(false)
  })

  it('returns false for unparseable input', () => {
    expect(isHomepageUrl('not a url')).toBe(false)
  })
})

describe('buildCriticalDefects', () => {
  it('returns no groups when no page has a defect', () => {
    expect(buildCriticalDefects([report('https://example.com/', [])])).toEqual([])
  })

  it('groups the same defect across pages and names each page', () => {
    const pages = [
      report('https://example.com/a', [MISSING_H1]),
      report('https://example.com/b', [MISSING_H1]),
    ]
    const groups = buildCriticalDefects(pages)
    expect(groups).toHaveLength(1)
    expect(groups[0].id).toBe('missing-h1')
    expect(groups[0].pages.map((p) => p.url)).toEqual(['https://example.com/a', 'https://example.com/b'])
  })

  it('surfaces a single-page defect on the homepage (issue #42 scenario)', () => {
    // Homepage has 4 H1s; one deep page is missing its H1. Both are 1-of-N
    // prevalence yet must both appear, with the homepage defect ranked first.
    const pages = [
      report('https://example.com/contact-us', [MISSING_H1]),
      report('https://example.com/', [MULTIPLE_H1]),
      ...Array.from({ length: 23 }, (_, i) => report(`https://example.com/p${i}`, [])),
    ]
    const groups = buildCriticalDefects(pages)
    expect(groups.map((g) => g.id)).toEqual(['multiple-h1', 'missing-h1'])
    expect(groups[0].pages[0].url).toBe('https://example.com/')
    expect(groups[0].pages[0].isHomepage).toBe(true)
  })

  it('ranks the homepage first within a group regardless of input order', () => {
    const pages = [
      report('https://example.com/deep', [MISSING_H1]),
      report('https://example.com/', [MISSING_H1]),
    ]
    const groups = buildCriticalDefects(pages)
    expect(groups[0].pages[0].url).toBe('https://example.com/')
    expect(groups[0].pages[0].isHomepage).toBe(true)
  })

  it('orders pages within a group by sitemap priority when no homepage is involved', () => {
    const priorityByUrl = new Map<string, number | undefined>([
      ['https://example.com/low', 0.2],
      ['https://example.com/high', 0.9],
    ])
    const pages = [
      report('https://example.com/low', [MISSING_H1]),
      report('https://example.com/high', [MISSING_H1]),
    ]
    const groups = buildCriticalDefects(pages, priorityByUrl)
    expect(groups[0].pages.map((p) => p.url)).toEqual(['https://example.com/high', 'https://example.com/low'])
    expect(groups[0].pages[0].priority).toBe(0.9)
  })

  it('orders critical-severity groups ahead of warnings', () => {
    const pages = [
      report('https://example.com/a', [MISSING_META]),
      report('https://example.com/b', [MISSING_META, MISSING_H1]),
    ]
    const groups = buildCriticalDefects(pages)
    expect(groups.map((g) => g.severity)).toEqual(['critical', 'warning'])
    expect(groups[0].id).toBe('missing-h1')
  })
})

describe('buildPrioritizedFixes with critical defects', () => {
  // These fixtures exercise critical-defect promotion and the no-truncation
  // ranking, not the page-specific classification, so they are pinned to `sitewide`.
  function crossCutting(factorName = 'FAQ Content', affectedPages = 20): CrossCuttingIssue {
    const rec = `Improve ${factorName}.`
    return {
      factorId: factorName.toLowerCase().replace(/\s+/g, '-'),
      factorName,
      avgScore: 40,
      affectedPages,
      totalPages: 25,
      topRecommendations: [rec],
      topIssues: [{ recommendation: rec, affectedUrls: [] }],
      pageSpecific: false,
      status: 'sitewide',
      bestScore: 40,
      bestPageUrl: 'https://example.com/',
    }
  }

  it('reports every cross-cutting issue, not just the top five', () => {
    const issues = Array.from({ length: 8 }, (_, i) => crossCutting(`Factor ${i}`, 20 - i))
    const fixes = buildPrioritizedFixes(issues, 25, [])
    expect(fixes).toHaveLength(8)
    for (let i = 0; i < 8; i++) {
      expect(fixes.some((f) => f.title === `Factor ${i}`)).toBe(true)
    }
  })

  it('returns structured fixes with stable ids and a kind', () => {
    const fixes = buildPrioritizedFixes([crossCutting('Technical SEO')], 25, [])
    expect(fixes[0]).toMatchObject({
      kind: 'cross-cutting',
      id: 'technical-seo',
      title: 'Technical SEO',
      avgScore: 40,
    })
    expect(typeof fixes[0].summary).toBe('string')
    expect(typeof fixes[0].prevalencePct).toBe('number')
  })

  it('prepends critical-severity defects above the prevalence-ranked fixes', () => {
    const defects = buildCriticalDefects([
      report('https://example.com/', [MULTIPLE_H1]),
      report('https://example.com/contact-us', [MISSING_H1]),
    ])
    const fixes = buildPrioritizedFixes([crossCutting()], 25, defects)

    expect(fixes[0]).toMatchObject({ kind: 'critical-defect', id: 'multiple-h1', severity: 'critical', affectsHomepage: true })
    expect(fixes[0].affectedPages).toContain('https://example.com/')
    expect(fixes[1]).toMatchObject({ id: 'missing-h1', affectsHomepage: false })
    // The prevalence-ranked fix still follows the promoted defects.
    expect(fixes[fixes.length - 1]).toMatchObject({ kind: 'cross-cutting', title: 'FAQ Content' })
  })

  it('does not promote warning-severity defects into prioritized fixes', () => {
    const defects = buildCriticalDefects([report('https://example.com/a', [MISSING_META])])
    const fixes = buildPrioritizedFixes([crossCutting()], 25, defects)
    expect(fixes.every((f) => f.id !== 'missing-meta-description')).toBe(true)
  })

  it('spells out every affected page rather than truncating with a count', () => {
    const defects = buildCriticalDefects([
      report('https://example.com/', [MULTIPLE_H1]),
      report('https://example.com/x', [MULTIPLE_H1]),
      report('https://example.com/y', [MULTIPLE_H1]),
    ])
    const fixes = buildPrioritizedFixes([], 25, defects)
    expect(fixes[0].affectedPages).toEqual([
      'https://example.com/',
      'https://example.com/x',
      'https://example.com/y',
    ])
    expect(fixes[0].summary).not.toContain('more page')
  })
})

describe('formatters list every affected page (no truncation)', () => {
  function sitemapReport(
    criticalDefects: CriticalDefectGroup[],
    prioritizedFixes: PrioritizedFix[] = [],
  ): SitemapAuditReport {
    return {
      schemaVersion: '1.1',
      sitemapUrl: 'https://example.com/sitemap.xml',
      auditedAt: '2026-04-18T00:00:00.000Z',
      pagesDiscovered: 0,
      pagesAudited: 0,
      pagesSkipped: 0,
      pagesFiltered: 0,
      pagesTruncated: 0,
      effectiveLimit: 200,
      aggregateScore: 50,
      pages: [],
      criticalDefects,
      crossCuttingIssues: [],
      siteIssues: [],
      prioritizedFixes,
    }
  }

  // More pages than the old display cap (10) to prove the cap is gone.
  const manyPages = Array.from({ length: 14 }, (_, i) => ({
    url: `https://example.com/page-${i}`,
    detail: 'No H1 tag.',
    isHomepage: false,
  }))
  const group: CriticalDefectGroup = {
    id: 'missing-h1',
    severity: 'critical',
    title: 'Missing H1',
    recommendation: 'Add exactly one H1.',
    pages: manyPages,
  }

  it('renders all affected pages in text output without a "more pages" elision', () => {
    const text = formatSitemapText(sitemapReport([group]))
    for (const page of manyPages) expect(text).toContain(page.url)
    expect(text).not.toMatch(/more page/i)
  })

  it('renders all affected pages in markdown output without a "more pages" elision', () => {
    const md = formatSitemapMarkdown(sitemapReport([group]))
    for (const page of manyPages) expect(md).toContain(page.url)
    expect(md).not.toMatch(/more page/i)
  })

  const bigFix: PrioritizedFix = {
    kind: 'cross-cutting',
    id: 'technical-seo',
    title: 'Technical SEO',
    recommendation: 'Add a meta description.',
    affectedPages: manyPages.map((p) => p.url),
    affectsHomepage: false,
    prevalencePct: 100,
    summary: 'Technical SEO (avg 40/100) — 14 pages: Add a meta description.',
  }

  it('spells out every page of each prioritized fix in text output', () => {
    const text = formatSitemapText(sitemapReport([], [bigFix]))
    for (const page of manyPages) expect(text).toContain(page.url)
    expect(text).not.toMatch(/more page/i)
  })

  it('spells out every page of each prioritized fix in markdown output', () => {
    const md = formatSitemapMarkdown(sitemapReport([], [bigFix]))
    for (const page of manyPages) expect(md).toContain(page.url)
    expect(md).not.toMatch(/more page/i)
  })
})

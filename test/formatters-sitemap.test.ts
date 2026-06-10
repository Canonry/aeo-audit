import { describe, it, expect } from 'vitest'

import { formatSitemapMarkdown } from '../src/formatters/markdown.js'
import { formatSitemapText } from '../src/formatters/text.js'
import type { PrioritizedFix, SitemapAuditReport } from '../src/types.js'

function sitemapReport(prioritizedFixes: PrioritizedFix[]): SitemapAuditReport {
  return {
    schemaVersion: '2.1',
    sitemapUrl: 'https://example.com/sitemap.xml',
    auditedAt: '2026-01-01T00:00:00.000Z',
    pagesDiscovered: 2,
    pagesAudited: 2,
    pagesSkipped: 0,
    pagesFiltered: 0,
    pagesTruncated: 0,
    effectiveLimit: 200,
    aggregateScore: 50,
    pages: [],
    criticalDefects: [],
    crossCuttingIssues: [],
    prioritizedFixes,
  }
}

describe('sitemap formatters: opportunity fixes suppress best-page noise', () => {
  // A site-wide gap (best worth surfacing) and an opportunity (absent everywhere,
  // so "best 0/100 on /" is noise the Prioritized Fixes line must not print).
  const fixes: PrioritizedFix[] = [
    {
      kind: 'cross-cutting',
      id: 'structured-data',
      title: 'Structured Data',
      status: 'sitewide',
      recommendation: 'Add JSON-LD schema.',
      affectedPages: ['https://example.com/a'],
      affectsHomepage: false,
      prevalencePct: 50,
      avgScore: 40,
      bestScore: 100,
      bestPageUrl: 'https://example.com/',
      summary: 'Structured Data (avg 40/100) — 1 page: Add JSON-LD schema.',
    },
    {
      kind: 'cross-cutting',
      id: 'definition-blocks',
      title: 'Definition Blocks',
      status: 'opportunity',
      recommendation: 'Add definition blocks or HowTo schema for key terms.',
      affectedPages: [],
      affectsHomepage: false,
      prevalencePct: 0,
      avgScore: 5,
      bestScore: 0,
      bestPageUrl: 'https://example.com/',
      summary: 'Definition Blocks (optional — not present on any audited page): Add definition blocks.',
    },
  ]

  it('keeps best-page for site-wide but drops it for opportunity (text)', () => {
    const out = formatSitemapText(sitemapReport(fixes))
    expect(out).toContain('best 100/100')
    expect(out).not.toContain('best 0/100')
  })

  it('keeps best-page for site-wide but drops it for opportunity (markdown)', () => {
    const out = formatSitemapMarkdown(sitemapReport(fixes))
    expect(out).toContain('best 100/100')
    expect(out).not.toContain('best 0/100')
    // The opportunity fix still shows its honest coverage average, just without best.
    expect(out).toContain('(avg 5/100)')
  })
})

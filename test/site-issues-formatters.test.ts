import { describe, expect, it } from 'vitest'
import { agentSummaryFromSitemap } from '../src/agent-summary.js'
import { formatSitemapAgent } from '../src/formatters/agent.js'
import { formatSitemapMarkdown } from '../src/formatters/markdown.js'
import { formatSitemapText } from '../src/formatters/text.js'
import type { SitemapAuditReport } from '../src/types.js'

function report(): SitemapAuditReport {
  return {
    schemaVersion: '2.1', sitemapUrl: 'https://example.com/sitemap.xml',
    auditedAt: '2026-10-12T12:00:00.000Z',
    pagesDiscovered: 3, pagesAudited: 2, pagesSkipped: 0, pagesFiltered: 0,
    pagesTruncated: 1, effectiveLimit: 2, aggregateScore: 100, pages: [],
    criticalDefects: [], crossCuttingIssues: [], prioritizedFixes: [], templateGroups: [],
    coverage: {
      pagesAudited: 2, pagesDiscovered: 3, coveragePct: 67, sampled: true,
      selection: 'all', templatesDiscovered: 1, templatesRepresented: 1, confidence: 'indicative',
    },
    siteIssues: [{
      code: 'site.duplicate-title',
      message: '2 audited pages share the same title: "Owner checklist".',
      affectedUrls: ['https://example.com/a', 'https://example.com/b'],
    }],
  }
}

describe('cross-page evidence presentation', () => {
  it.each([
    ['text', formatSitemapText], ['markdown', formatSitemapMarkdown],
  ] as const)('shows positive duplicate evidence at a passing score in full and top-issues %s output', (_name, format) => {
    const input = report()
    for (const topIssuesOnly of [false, true]) {
      const output = format(input, topIssuesOnly)
      expect(output).toContain('Cross-page issues')
      expect(output).toContain('site.duplicate-title')
      expect(output).toContain('Owner checklist')
      for (const url of input.siteIssues[0].affectedUrls) expect(output).toContain(url)
      expect(output).toContain('Observed among the audited pages')
      expect(output).toContain('these findings do not change the score')
    }
    expect(input.aggregateScore).toBe(100)
    expect(input.prioritizedFixes).toEqual([])
  })

  it('retains the complete cross-page evidence separately from score-ranked issues for agents', () => {
    const input = report()
    const result = agentSummaryFromSitemap(input)
    expect(result).toMatchObject({ pass: true, score: 100, issues: [], siteIssues: input.siteIssues })
    expect(JSON.parse(formatSitemapAgent(input))).toMatchObject({ siteIssues: input.siteIssues })
  })

  it('distinguishes empty checked evidence from legacy reports that never supplied it', () => {
    const checked = { ...report(), siteIssues: [] }
    expect(agentSummaryFromSitemap(checked)).toHaveProperty('siteIssues', [])
    const { siteIssues: _omitted, ...old } = report()
    const legacy = old as SitemapAuditReport
    expect(agentSummaryFromSitemap(legacy)).not.toHaveProperty('siteIssues')
    for (const input of [checked, legacy]) {
      expect(formatSitemapText(input)).not.toContain('Cross-page issues')
      expect(formatSitemapMarkdown(input)).not.toContain('Cross-page issues')
    }
  })

  it('renders copied metadata literally instead of adding Markdown links, HTML or report lines', () => {
    const input = report()
    input.siteIssues[0].message = 'Same *title* [click](https://bad.example) <img src=x>\n## Surprise `code` & text'
    input.siteIssues[0].affectedUrls = ['https://example.com/a_[b]']
    const output = formatSitemapMarkdown(input)
    expect(output).toContain('Same \\*title\\* \\[click\\](https://bad.example) &lt;img src=x&gt; ## Surprise \\`code\\` &amp; text')
    expect(output).toContain('https://example.com/a\\_\\[b\\]')
    expect(output).not.toContain('\n## Surprise')
    expect(output).not.toContain('[click](')
    expect(output).not.toContain('<img')
  })

  it('does not let metadata add terminal control sequences', () => {
    const input = report()
    input.siteIssues[0].message = 'Same\u001b[2J title\nInjected row\u202e'
    const output = formatSitemapText(input)
    expect(output).toContain('Same [2J title Injected row')
    expect(output).not.toContain('\u001b[2J')
    expect(output).not.toContain('\u202e')
    expect(output).not.toContain('\nInjected row')
  })
})

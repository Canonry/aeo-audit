import { describe, expect, it } from 'vitest'
import { auditHtmlPage, agentSummaryFromAudit } from '../src/index.js'
import { buildCrossCuttingIssues, buildPrioritizedFixes } from '../src/sitemap.js'
import { formatText } from '../src/formatters/text.js'

const namingFix = 'Standardize brand/entity naming in HTML metadata and JSON-LD.'
const shortTitleAdvice = 'Review the short title for a clear, page-specific description. Expand it only if useful context is missing; short titles can be appropriate.'

async function audit(path: string, conflictingNames: boolean, canonical = true) {
  const url = `https://example.com${path}`
  const names = conflictingNames ? ['Alpha Brand', 'Beta Brand'] : ['Shop']
  const schema = names.map((name) => ({ '@type': 'Organization', name, email: 'hello@example.com' }))
  return auditHtmlPage({
    inputUrl: url, finalUrl: url,
    html: `<html><head><title>Shop</title>${canonical ? `<link rel="canonical" href="${url}">` : ''}<meta name="description" content="A shop."><script type="application/ld+json">${JSON.stringify(schema)}</script></head><body><h1>Shop</h1><p> hello@example.com </p></body></html>`,
    headers: {}, redirectChain: [], fetchTimeMs: 0,
    auxiliary: {},
  }, { factors: ['entity-consistency'] })
}

describe('advisories in agent recommendations', () => {
  it('keeps the naming fix ahead of optional title advice for a single page', async () => {
    const report = await audit('/', true)
    expect(report.factors[0].score).toBe(82)
    expect(report.factors[0].findings.map((finding) => finding.code)).toContain('entity-consistency.title.short')
    expect(report.factors[0].recommendations).toContain(shortTitleAdvice)
    const issue = agentSummaryFromAudit(report).issues.find((entry) => entry.id === 'entity-consistency')
    expect(issue?.recommendation).toBe(namingFix)
    expect(issue?.summary).toContain(namingFix)
  })

  it('keeps an actionable fix ahead of more widespread optional title advice across pages', async () => {
    const reports = await Promise.all([audit('/broken', true), audit('/a', false), audit('/b', false)])
    const issues = buildCrossCuttingIssues(reports)
    const entity = issues.find((entry) => entry.factorId === 'entity-consistency')!
    expect(entity.topIssues.map((issue) => issue.recommendation)).toEqual([namingFix, shortTitleAdvice])
    expect(entity.topIssues[1].affectedUrls).toHaveLength(3)
    const fix = buildPrioritizedFixes(issues, reports.length, [], reports).find((entry) => entry.id === 'entity-consistency')
    expect(fix?.recommendation).toBe(namingFix)
  })

  it('still surfaces title advice when there is no competing fix', async () => {
    const report = await audit('/', false)
    expect(report.factors[0].score).toBe(100)
    expect(agentSummaryFromAudit(report).issues.find((entry) => entry.id === 'entity-consistency')?.recommendation).toBe(shortTitleAdvice)
  })

  it('keeps later canonical fixes ahead of title advice in single-page text output', async () => {
    const report = await audit('/', false, false)
    const canonicalFix = 'Add a canonical link tag to declare the primary page URL.'
    expect(report.factors[0].recommendations).toEqual([canonicalFix, shortTitleAdvice])
    expect(formatText(report)).toContain(canonicalFix)
  })

  it('treats a recommendation as actionable if any page leaves it untagged', async () => {
    const tagged = await audit('/tagged', false)
    const legacy = await audit('/legacy', false)
    delete legacy.factors[0].advisoryRecommendations
    const broken = await audit('/broken', true)
    const issues = buildCrossCuttingIssues([tagged, legacy, broken])
    // Without an advisory declaration on the legacy page, both remain in
    // the existing priority tier and prevalence decides their order.
    expect(issues[0].topRecommendations[0]).toBe(shortTitleAdvice)
    expect(issues[0].topRecommendations).toContain(namingFix)
  })
})

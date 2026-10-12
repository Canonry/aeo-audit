import { describe, expect, it } from 'vitest'
import { auditHtmlPage } from '../src/index.js'

async function audit(head: string, body: string) {
  return auditHtmlPage({
    inputUrl: 'https://example.com/products/shirt',
    finalUrl: 'https://example.com/products/shirt',
    html: `<!doctype html><html><head>${head}</head><body>${body}</body></html>`,
    headers: {}, redirectChain: [], fetchTimeMs: 0,
    auxiliary: {
      llmsTxt: { state: 'missing', body: '' },
      llmsFullTxt: { state: 'missing', body: '' },
      robotsTxt: { state: 'missing', body: '' },
      sitemapXml: { state: 'missing', body: '' },
    },
  }, { factors: ['technical-seo', 'entity-consistency'] })
}

describe('technical issues exposed to audit consumers', () => {
  it('retains missing description, heading and alt findings alongside the title warning', async () => {
    const result = await audit('<title>Shop</title>', '<img src="shirt.jpg">')
    const findings = result.factors.flatMap((factor) => factor.findings)
    for (const code of [
      'entity-consistency.title.short',
      'technical-seo.meta-description.missing',
      'technical-seo.h1.missing',
      'technical-seo.alt-text.missing',
    ]) expect(findings).toContainEqual(expect.objectContaining({ code }))
    expect(result.criticalDefects.map((defect) => defect.id)).toEqual(expect.arrayContaining(['missing-h1', 'missing-meta-description']))
    expect(result.metadata.pageTitle).toBe('Shop')
  })

  it('distinguishes multiple headings, a short description and intentionally empty alt from missing attributes', async () => {
    const result = await audit(
      '<title>Cotton shirt collection</title><meta name="description" content="Shop cotton shirts.">',
      '<h1>Collection</h1><h1>Shirts</h1><img src="decoration.jpg" alt="">',
    )
    const findings = result.factors.flatMap((factor) => factor.findings)
    for (const code of ['technical-seo.h1.multiple', 'technical-seo.meta-description.short', 'technical-seo.alt-text.empty']) {
      expect(findings).toContainEqual(expect.objectContaining({ code, type: 'info' }))
    }
    expect(findings.some((finding) => finding.code === 'technical-seo.alt-text.missing')).toBe(false)
    expect(findings.find((finding) => finding.code === 'technical-seo.alt-text.empty')?.message).toContain('decorative')
  })

  it('keeps a missing title distinct from a short one', async () => {
    const result = await audit('', '<h1>Shirts</h1>')
    expect(result.criticalDefects.map((defect) => defect.id)).toContain('missing-title')
    expect(result.factors.flatMap((factor) => factor.findings).some((finding) => finding.code === 'entity-consistency.title.short')).toBe(false)
  })
})

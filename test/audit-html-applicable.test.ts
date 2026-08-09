import { describe, expect, test, vi } from 'vitest'

vi.mock('../src/analyzers/faq-content.js', () => ({
  analyzeFaqContent: () => ({
    score: 58,
    findings: [],
    recommendations: ['Expand the FAQ.'],
    applicable: true,
  }),
}))

import { auditHtmlPage } from '../src/audit-html.js'

describe('auditHtmlPage analyzer contract', () => {
  test('preserves analyzer-declared applicability in the public factor result', async () => {
    const report = await auditHtmlPage({
      inputUrl: 'https://example.test/faq',
      finalUrl: 'https://example.test/faq',
      html: '<html><head><title>FAQ</title></head><body><h1>FAQ</h1></body></html>',
      headers: {},
      redirectChain: [],
      auxiliary: {},
      fetchTimeMs: 0,
    }, { factors: ['faq-content'] })

    expect(report.factors).toEqual([
      expect.objectContaining({ id: 'faq-content', applicable: true }),
    ])
  })
})

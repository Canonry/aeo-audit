import { describe, expect, it } from 'vitest'
import { load } from 'cheerio'

import { analyzeContentFreshness } from '../../src/analyzers/content-freshness.js'
import { getVisibleText, parseJsonLdScripts } from '../../src/analyzers/helpers.js'
import type { AuditContext, AuditFinding } from '../../src/types.js'

const CURRENT_YEAR = new Date().getUTCFullYear()
const RECENT = `Recent copyright year detected (${CURRENT_YEAR}).`

function copyrightFinding(body: string): AuditFinding | undefined {
  const html = `<!doctype html><html><head><title>T</title></head><body>${body}</body></html>`
  const $ = load(html)
  const context: AuditContext = {
    $,
    html,
    url: 'https://example.com/faq',
    headers: {},
    auxiliary: {},
    structuredData: parseJsonLdScripts($),
    textContent: getVisibleText($, html),
    pageTitle: 'T',
  }
  return analyzeContentFreshness(context).findings.find((finding) => finding.code.startsWith('content-freshness.copyright.'))
}

describe('copyright year', () => {
  it('reads the footer notice, not an earlier year in the page copy', () => {
    const finding = copyrightFinding(`
      <main><h2>How long have you been around?</h2><p>We were founded in 2018.</p></main>
      <footer><p>© ${CURRENT_YEAR} Acme Inc. All rights reserved.</p></footer>`)
    expect(finding).toEqual({ type: 'found', code: 'content-freshness.copyright.recent', message: RECENT })
  })

  it.each([
    `Founded in 2018. See our ${CURRENT_YEAR} pricing.`,
    '© Acme Inc., Washington, DC 20001',
    '(c) Changes made after 2019 apply to new orders only.',
    'Our copyrighted guides were first published in 2019.',
  ])('takes no year from "%s"', (text) => {
    expect(copyrightFinding(`<main><p>${text}</p></main>`)?.code).toBe('content-freshness.copyright.missing')
  })

  it.each([
    `© 2018–${CURRENT_YEAR} Acme Inc.`,
    `Copyright © 2015 - ${CURRENT_YEAR}`,
    `© Acme Widgets, Inc. ${CURRENT_YEAR}. All rights reserved.`,
    `Copyright ${CURRENT_YEAR} Acme`,
    `${CURRENT_YEAR} © Acme Inc.`,
    `(c) ${CURRENT_YEAR} Acme`,
    `(C)${CURRENT_YEAR} Acme`,
    // Adjacent elements whose text cheerio joins without a space.
    `<span>©</span><span>${CURRENT_YEAR}</span> Acme`,
    `<span>Copyright</span><span>${CURRENT_YEAR}</span>`,
    `<a href="/terms">Terms</a>Copyright ${CURRENT_YEAR} Acme`,
  ])('reads the year from "%s"', (notice) => {
    expect(copyrightFinding(`<footer><p>${notice}</p></footer>`)?.message).toBe(RECENT)
  })

  it('prefers the footer notice over one elsewhere on the page', () => {
    const finding = copyrightFinding(`
      <main><figure><figcaption>Photo © ${CURRENT_YEAR} Example Wire</figcaption></figure></main>
      <footer><p>© 2019 Acme Inc.</p></footer>`)
    expect(finding?.message).toBe('Older copyright year detected (2019).')
  })

  it('falls back to a notice outside any footer element', () => {
    const finding = copyrightFinding(`<main><p>Founded in 2018.</p></main><div class="site-footer">© ${CURRENT_YEAR} Acme</div>`)
    expect(finding?.message).toBe(RECENT)
  })

  it("does not treat an article's own footer as the site footer", () => {
    const finding = copyrightFinding(`
      <article><p>Our story.</p><footer>Text © 2019 Jane Doe</footer></article>
      <div class="site-footer">© ${CURRENT_YEAR} Acme</div>`)
    expect(finding?.message).toBe(RECENT)
  })
})

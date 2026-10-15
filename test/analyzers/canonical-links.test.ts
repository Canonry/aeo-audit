import assert from 'node:assert/strict'
import { test } from 'vitest'
import { load } from 'cheerio'

import { analyzeCanonicalLinks, inspectCanonicalLinks } from '../../src/analyzers/canonical-links.js'
import { analyzeEntityConsistency } from '../../src/analyzers/entity-consistency.js'
import type { AuditContext, CanonicalTargetResult } from '../../src/types.js'

function context(head: string, canonicalTargets?: Record<string, CanonicalTargetResult>, body = ''): AuditContext {
  const html = `<html><head><title>Example</title>${head}</head><body>${body}</body></html>`
  return {
    $: load(html), html, url: 'https://example.com/pages/current', headers: {}, auxiliary: {},
    structuredData: [], textContent: '', pageTitle: 'Example', canonicalTargets,
  }
}

test('canonical validation flags missing, empty and malformed hrefs', () => {
  for (const head of ['', '<link rel="canonical">', '<link rel="canonical" href="">', '<link rel="canonical" href="   ">', '<link rel="canonical" href="https://[bad]">']) {
    const result = analyzeCanonicalLinks(context(head))
    assert.equal(result.score, 0)
    assert.ok(result.findings.some((finding) => finding.type === 'missing'))
  }
})

test('canonical validation rejects unsafe schemes, credentials and fragments', () => {
  for (const href of ['javascript:alert(1)', 'ftp://example.com/file', 'mailto:example@example.com', 'https://user:password@example.com/', 'https://example.com/page#section', '#', '#section']) {
    const result = inspectCanonicalLinks(context(`<link rel="canonical" href="${href}">`))
    assert.equal(result.score, 0, href)
    assert.deepEqual(result.urls, [])
    assert.ok(result.findings.some((finding) => finding.message.startsWith('Invalid canonical URL')))
  }
})

test('canonical rel uses case-insensitive whitespace-separated tokens', () => {
  const result = inspectCanonicalLinks(context('<link rel="alternate CANONICAL" href="https://example.com/primary">'))
  assert.equal(result.score, 20)
  assert.deepEqual(result.urls, ['https://example.com/primary'])
  assert.equal(inspectCanonicalLinks(context('<link rel="notcanonical" href="https://example.com/">')).score, 0)
})

test('canonical rel recognizes every HTML ASCII whitespace separator', () => {
  for (const separator of [' ', '\t', '\n', '\f', '\r']) {
    const result = inspectCanonicalLinks(context(`<link rel="alternate${separator}CANONICAL" href="/primary">`))
    assert.equal(result.score, 20)
    assert.deepEqual(result.urls, ['https://example.com/primary'])
  }
})

test('canonical rel does not split on non-HTML whitespace', () => {
  for (const separator of ['&nbsp;', '\u000b', '\u2003', '\u2028', '\u2029', '\ufeff']) {
    const result = inspectCanonicalLinks(context(`<link rel="canonical${separator}alternate" href="/primary">`))
    assert.equal(result.score, 0, JSON.stringify(separator))
    assert.deepEqual(result.urls, [])
    assert.ok(result.findings.some((finding) => finding.code === 'entity-consistency.canonical.missing'))
  }
})

test('canonical href preserves Unicode whitespace in URL identity and origin', () => {
  for (const [href, expected] of [
    ['/primary&nbsp;', 'https://example.com/primary%C2%A0'],
    ['/primary\u2003', 'https://example.com/primary%E2%80%83'],
    ['/primary\ufeff', 'https://example.com/primary%EF%BB%BF'],
    ['&nbsp;https://other.example/primary', 'https://example.com/pages/%C2%A0https://other.example/primary'],
    ['&nbsp;', 'https://example.com/pages/%C2%A0'],
  ]) {
    const result = inspectCanonicalLinks(context(`<link rel="canonical" href="${href}">`))
    assert.equal(result.score, 20, href)
    assert.deepEqual(result.urls, [expected])
  }
})

test('canonical conflicts retain Unicode whitespace differences', () => {
  const result = inspectCanonicalLinks(context('<link rel="canonical" href="/primary&nbsp;"><link rel="canonical" href="/primary">'))
  assert.equal(result.score, 0)
  assert.deepEqual(result.urls, ['https://example.com/primary%C2%A0', 'https://example.com/primary'])
  assert.ok(result.findings.some((finding) => finding.code === 'entity-consistency.canonical.conflicting'))
  assert.ok(!result.findings.some((finding) => finding.code === 'entity-consistency.canonical.duplicate'))
})

test('canonical href delegates C0 and ASCII space normalization to URL parsing', () => {
  const valid = inspectCanonicalLinks(context('<link rel="canonical" href="&#x1f; &#x09;https://example.com/primary &#x0d;&#x0a;">'))
  assert.equal(valid.score, 20)
  assert.deepEqual(valid.urls, ['https://example.com/primary'])
  const blank = inspectCanonicalLinks(context('<link rel="canonical" href="&#x1f; &#x09; &#x0d;&#x0a;">'))
  assert.equal(blank.score, 0)
  assert.deepEqual(blank.urls, [])
  assert.ok(blank.findings.some((finding) => finding.code === 'entity-consistency.canonical.invalid'))
})

test('canonical declarations in the body or templates do not conflict with an active head declaration', () => {
  const result = inspectCanonicalLinks(context(
    '<link rel="canonical" href="/primary"><template><template><link rel="canonical" href="/template"></template></template>',
    undefined,
    '<link rel="canonical" href="/body"><template><link rel="canonical" href="/body-template"></template>',
  ))

  assert.equal(result.score, 20)
  assert.deepEqual(result.urls, ['https://example.com/primary'])
  assert.equal(result.findings.filter((finding) => finding.type === 'info').length, 3)
  assert.ok(!result.findings.some((finding) => /Duplicate|Conflicting/.test(finding.message)))
  assert.ok(result.recommendations.some((recommendation) => recommendation.includes('document head')))
})

test('alternate-version attributes exclude canonical declarations even when the attribute is empty', () => {
  for (const attribute of ['media', 'hreflang', 'lang', 'type']) {
    for (const value of ['', 'alternate']) {
      const result = inspectCanonicalLinks(context(`<link rel="canonical" href="/primary"><link rel="canonical" href="/ignored" ${attribute}="${value}">`))
      assert.equal(result.score, 20, `${attribute}=${value}`)
      assert.deepEqual(result.urls, ['https://example.com/primary'])
      assert.ok(result.findings.some((finding) => finding.type === 'info' && finding.message.includes(attribute)))
      assert.ok(!result.findings.some((finding) => /Duplicate|Conflicting/.test(finding.message)))
      assert.ok(result.recommendations.some((recommendation) => recommendation.includes('attributes')))
    }
  }
})

test('pages with only ignored canonical declarations have no effective canonical or target URL', () => {
  const declarations = [
    { head: '', body: '<link rel="canonical" href="/body">' },
    { head: '<template><link rel="canonical" href="/template"></template>', body: '' },
    ...['media', 'hreflang', 'lang', 'type'].map((attribute) => ({ head: `<link rel="canonical" href="/ignored" ${attribute}>`, body: '' })),
  ]
  for (const { head, body } of declarations) {
    const result = inspectCanonicalLinks(context(head, undefined, body))
    assert.equal(result.score, 0)
    assert.deepEqual(result.urls, [])
    assert.ok(result.findings.some((finding) => finding.type === 'missing' && finding.message === 'Canonical URL tag is missing.'))
    assert.ok(result.findings.some((finding) => finding.type === 'info' && finding.message.includes('ignored')))
  }
})

test('relative canonical URLs resolve against the final page URL and first base href', () => {
  assert.deepEqual(inspectCanonicalLinks(context('<link rel="canonical" href="../primary?q=1">')).urls, ['https://example.com/primary?q=1'])
  assert.deepEqual(inspectCanonicalLinks(context('<base href="/other/"><base href="/ignored/"><link rel="canonical" href="primary">')).urls, ['https://example.com/other/primary'])
  assert.deepEqual(inspectCanonicalLinks(context('<link rel="canonical" href="//other.example/primary">')).urls, ['https://other.example/primary'])
  assert.deepEqual(inspectCanonicalLinks(context('<base href="http://[bad]"><link rel="canonical" href="../primary">')).urls, ['https://example.com/primary'])
  for (const href of ['javascript:void(0)', 'data:text/plain,base']) {
    assert.deepEqual(inspectCanonicalLinks(context(`<base href="${href}"><link rel="canonical" href="/primary">`)).urls, ['https://example.com/primary'])
  }
})

test('base URLs inside templates cannot change active canonical resolution', () => {
  assert.deepEqual(inspectCanonicalLinks(context('<template><base href="/ignored/"></template><link rel="canonical" href="primary">')).urls, ['https://example.com/pages/primary'])
  assert.deepEqual(inspectCanonicalLinks(context('<template><base href="/ignored/"></template><base href="/active/"><link rel="canonical" href="primary">')).urls, ['https://example.com/active/primary'])
})

test('SVG and MathML base elements cannot change active canonical resolution', () => {
  for (const tag of ['svg', 'math']) {
    const foreignBase = `<${tag}><base href="https://other.example/ignored/"></base></${tag}>`
    const head = '<link rel="canonical" href="primary">'
    assert.deepEqual(inspectCanonicalLinks(context(head, undefined, foreignBase)).urls, ['https://example.com/pages/primary'])
    assert.deepEqual(inspectCanonicalLinks(context(head, undefined, `${foreignBase}<base href="/active/">`)).urls, ['https://example.com/active/primary'])
  }
})

test('duplicate canonical tags normalize equivalent URLs and reduce credit', () => {
  const result = inspectCanonicalLinks(context('<link rel="canonical" href="https://EXAMPLE.com:443/primary"><link rel="canonical" href="/primary">'))
  assert.equal(result.score, 10)
  assert.deepEqual(result.urls, ['https://example.com/primary'])
  assert.ok(result.findings.some((finding) => finding.message.startsWith('Duplicate canonical tags')))
  assert.ok(!result.findings.some((finding) => finding.message.startsWith('Conflicting')))
})

test('conflicting canonical tags preserve path, query and trailing slash differences', () => {
  for (const alternate of ['/Primary', '/primary/', '/primary?q=1']) {
    const result = inspectCanonicalLinks(context(`<link rel="canonical" href="/primary"><link rel="canonical" href="${alternate}">`))
    assert.equal(result.score, 0)
    assert.ok(result.findings.some((finding) => finding.message.startsWith('Conflicting canonical tags')))
  }
})

test('an invalid first canonical cannot hide a later valid declaration', () => {
  const result = inspectCanonicalLinks(context('<link rel="canonical" href=""><link rel="canonical" href="/primary">'))
  assert.equal(result.score, 0)
  assert.deepEqual(result.urls, ['https://example.com/primary'])
  assert.ok(result.findings.some((finding) => finding.message.startsWith('Invalid')))
  assert.ok(result.findings.some((finding) => finding.message.startsWith('Duplicate')))
})

test('intentional cross-domain canonical targets remain valid', () => {
  const result = analyzeCanonicalLinks(context('<link rel="canonical" href="https://other.example/original">'))
  assert.equal(result.score, 20)
  assert.ok(!result.findings.some((finding) => finding.type === 'missing'))
})

test('canonical target evidence reports redirects, broken responses and uncertainty', () => {
  const url = 'https://example.com/primary'
  for (const statusCode of [404, 410, 500, 403, 429]) {
    const result = analyzeCanonicalLinks(context('<link rel="canonical" href="/primary">', {
      [url]: { state: 'unreachable', url, statusCode, redirectChain: [] },
    }))
    assert.equal(result.score, 0)
    assert.ok(result.findings.some((finding) => finding.type === 'unreachable' && finding.message.includes(`HTTP ${statusCode}`)))
  }
  const redirected = analyzeCanonicalLinks(context('<link rel="canonical" href="/primary">', {
    [url]: { state: 'ok', url: 'https://example.com/final', statusCode: 200, redirectChain: [{ status: 301, from: url, to: 'https://example.com/final' }] },
  }))
  assert.equal(redirected.score, 10)
  assert.ok(redirected.findings.some((finding) => finding.message.includes('redirects (1 hop)')))
  const timedOut = analyzeCanonicalLinks(context('<link rel="canonical" href="/primary">', {
    [url]: { state: 'timeout', url, redirectChain: [] },
  }))
  assert.equal(timedOut.score, 10)
  assert.ok(timedOut.findings.some((finding) => finding.type === 'timeout'))
  assert.ok(!timedOut.findings.some((finding) => finding.type === 'unreachable'))
})

test('failed redirect checks never recommend an unverified destination', () => {
  const url = 'https://example.com/primary'
  for (const state of ['unreachable', 'timeout'] as const) {
    const result = analyzeCanonicalLinks(context('<link rel="canonical" href="/primary">', {
      [url]: { state, url: 'http://127.0.0.1/private', redirectChain: [{ status: 302, from: url, to: 'http://127.0.0.1/private' }] },
    }))
    assert.ok(result.findings.some((finding) => finding.message.includes('checking stopped')))
    assert.ok(!result.recommendations.some((recommendation) => recommendation.includes('final destination')))
  }
})

test('entity consistency stays synchronous and incorporates canonical penalties', () => {
  const valid = analyzeEntityConsistency(context('<link rel="canonical" href="/primary">'))
  const invalid = analyzeEntityConsistency(context('<link rel="canonical" href="javascript:bad">'))
  const duplicate = analyzeEntityConsistency(context('<link rel="canonical" href="/primary"><link rel="canonical" href="/primary">'))
  assert.equal(typeof valid.score, 'number')
  assert.equal(valid.score - invalid.score, 20)
  assert.equal(valid.score - duplicate.score, 10)
})


test('canonical findings retain stable codes and title advisory ordering', () => {
  const valid = analyzeEntityConsistency(context('<link rel="canonical" href="/primary">'))
  assert.ok(valid.findings.some((finding) => finding.code === 'entity-consistency.canonical.present'))
  const invalid = analyzeEntityConsistency(context('<link rel="canonical" href="javascript:bad">'))
  assert.ok(invalid.findings.some((finding) => finding.code === 'entity-consistency.canonical.invalid'))
  assert.ok(invalid.findings.some((finding) => finding.code === 'entity-consistency.title.short'))
  assert.ok(invalid.advisoryRecommendations?.some((advice) => advice.includes('short title')))
  assert.ok(invalid.recommendations.indexOf('Use a nonempty HTTP or HTTPS canonical URL without credentials or a fragment.') < invalid.recommendations.findIndex((advice) => advice.includes('short title')))
  const missing = inspectCanonicalLinks(context(''))
  assert.equal(missing.findings[0]?.code, 'entity-consistency.canonical.missing')
  assert.ok([...valid.findings, ...invalid.findings, ...missing.findings].every((finding) => finding.code))
})

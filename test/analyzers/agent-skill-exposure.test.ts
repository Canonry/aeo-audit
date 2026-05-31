import { describe, it, expect } from 'vitest'
import { load } from 'cheerio'

import { parseJsonLdScripts, getVisibleText } from '../../src/analyzers/helpers.js'
import { analyzeAgentSkillExposure } from '../../src/analyzers/agent-skill-exposure.js'
import { defaultAuxiliary } from '../fixtures/pages.js'
import type { AuditContext } from '../../src/types.js'

function buildContext(html: string, headers: Record<string, string> = {}): AuditContext {
  const $ = load(html)
  return {
    $,
    html,
    url: 'https://example.com/',
    headers,
    auxiliary: defaultAuxiliary,
    structuredData: parseJsonLdScripts($),
    textContent: getVisibleText($, html),
    pageTitle: $('title').first().text().trim(),
  }
}

const wrap = (head: string, body: string = '') =>
  `<!doctype html><html><head><title>T</title>${head}</head><body>${body}</body></html>`
const ld = (obj: unknown) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`

// ─── Schema.org Action markup ─────────────────────────────────────────────────
describe('Schema.org Action markup', () => {
  it('credits +35 for a well-formed SearchAction with target and query-input', () => {
    const result = analyzeAgentSkillExposure(buildContext(wrap(ld({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      potentialAction: {
        '@type': 'SearchAction',
        target: { urlTemplate: 'https://example.com/search?q={query}' },
        'query-input': 'required name=query',
      },
    }))))
    expect(result.findings.some((f) => f.type === 'found' && f.message.includes('SearchAction'))).toBe(true)
  })

  it('detects Action nested at arbitrary depth under potentialAction', () => {
    const result = analyzeAgentSkillExposure(buildContext(wrap(ld({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'Organization',
          name: 'Acme',
          potentialAction: {
            '@type': 'OrderAction',
            target: { urlTemplate: 'https://example.com/order?sku={sku}' },
            object: { '@type': 'Product' },
          },
        },
      ],
    }))))
    expect(result.findings.some((f) => f.type === 'found' && f.message.includes('OrderAction'))).toBe(true)
  })

  it('credits +18 (not +35) when Action is declared but missing target or input shape', () => {
    const result = analyzeAgentSkillExposure(buildContext(wrap(ld({
      '@context': 'https://schema.org',
      '@type': 'SearchAction',
    }))))
    expect(result.findings.some((f) => f.type === 'info' && f.message.includes('missing target'))).toBe(true)
    expect(result.recommendations.some((r) => r.includes('target'))).toBe(true)
    // No other signals → only +18 from Action
    expect(result.score).toBe(18)
  })

  it('flags missing Action markup with a recommendation on a page with no schema', () => {
    const result = analyzeAgentSkillExposure(buildContext(wrap('')))
    expect(result.findings.some((f) => f.type === 'missing' && f.message.includes('Action'))).toBe(true)
    expect(result.recommendations.some((r) => r.includes('Schema.org Action markup'))).toBe(true)
  })

  it('reports all distinct Action types when multiple are present', () => {
    const result = analyzeAgentSkillExposure(buildContext(wrap(ld([
      {
        '@type': 'SearchAction',
        target: { urlTemplate: 'https://x/?q={q}' },
        'query-input': 'required name=q',
      },
      {
        '@type': 'SubscribeAction',
        target: { urlTemplate: 'https://x/sub' },
        object: {},
      },
    ]))))
    const found = result.findings.find((f) => f.type === 'found' && f.message.includes('Action'))
    expect(found?.message).toMatch(/SearchAction/)
    expect(found?.message).toMatch(/SubscribeAction/)
  })
})

// ─── MCP / WebMCP / ai-plugin discovery ──────────────────────────────────────
describe('MCP discovery', () => {
  it.each([
    ['mcp', '<link rel="mcp" href="/.well-known/mcp.json">'],
    ['webmcp', '<link rel="webmcp" href="/.well-known/webmcp.json">'],
    ['ai-plugin', '<link rel="ai-plugin" href="/.well-known/ai-plugin.json">'],
  ])('credits +20 for <link rel="%s">', (_, tag) => {
    const result = analyzeAgentSkillExposure(buildContext(wrap(tag)))
    expect(result.findings.some((f) => f.type === 'found' && f.message.includes('Agent protocol discovery'))).toBe(true)
    expect(result.findings.some((f) => f.type === 'found' && f.message.includes('<link'))).toBe(true)
  })

  it.each([
    'mcp-server',
    'mcp-server-url',
    'ai-plugin',
  ])('credits +20 for <meta name="%s">', (name) => {
    const result = analyzeAgentSkillExposure(buildContext(wrap(`<meta name="${name}" content="/.well-known/mcp.json">`)))
    expect(result.findings.some((f) => f.type === 'found' && f.message.includes('<meta'))).toBe(true)
  })

  it('credits +20 when MCP is advertised via the Link response header', () => {
    const result = analyzeAgentSkillExposure(buildContext(wrap(''), {
      link: '</.well-known/mcp.json>; rel="mcp"',
    }))
    expect(result.findings.some((f) => f.type === 'found' && f.message.includes('Link header'))).toBe(true)
  })

  it('flags MCP as missing when no discovery mechanism is present', () => {
    const result = analyzeAgentSkillExposure(buildContext(wrap('')))
    expect(result.findings.some((f) => f.type === 'missing' && f.message.includes('MCP'))).toBe(true)
    expect(result.recommendations.some((r) => r.includes('MCP server card'))).toBe(true)
  })
})

// ─── A2A agent card discovery ────────────────────────────────────────────────
describe('A2A agent card discovery', () => {
  it.each([
    ['agent-card link', '<link rel="agent-card" href="/.well-known/agent.json">'],
    ['well-known agent.json href', '<link rel="alternate" href="/.well-known/agent.json">'],
    ['agent-card.json href', '<link rel="alternate" href="/agent-card.json">'],
  ])('credits a found A2A finding for %s', (_, tag) => {
    const result = analyzeAgentSkillExposure(buildContext(wrap(tag)))
    expect(result.findings.some((f) => f.type === 'found' && f.message.includes('A2A agent card'))).toBe(true)
  })

  it('credits a found A2A finding for <meta name="agent-card">', () => {
    const result = analyzeAgentSkillExposure(buildContext(wrap('<meta name="agent-card" content="/.well-known/agent.json">')))
    expect(result.findings.some((f) => f.type === 'found' && f.message.includes('A2A agent card'))).toBe(true)
  })

  it('credits a found A2A finding when advertised via the Link response header', () => {
    const result = analyzeAgentSkillExposure(buildContext(wrap(''), {
      link: '</.well-known/agent.json>; rel="agent-card"',
    }))
    expect(result.findings.some((f) => f.type === 'found' && f.message.includes('A2A agent card'))).toBe(true)
  })

  it('flags info + a spec-cited recommendation when no agent card is discoverable', () => {
    const result = analyzeAgentSkillExposure(buildContext(wrap('')))
    expect(result.findings.some((f) => f.type === 'info' && f.message.includes('A2A agent card'))).toBe(true)
    expect(result.recommendations.some((r) => r.includes('agent card') && r.includes('specification.website'))).toBe(true)
  })
})

// ─── OpenAPI / service-description links ─────────────────────────────────────
describe('OpenAPI / service-description links', () => {
  it.each([
    ['describedby + openapi+json', '<link rel="describedby" type="application/openapi+json" href="/openapi.json">'],
    ['service-desc', '<link rel="service-desc" href="/openapi.json">'],
    ['describedby + yaml', '<link rel="describedby" type="application/yaml" href="/openapi.yaml">'],
  ])('credits +10 for %s', (_, tag) => {
    const result = analyzeAgentSkillExposure(buildContext(wrap(tag)))
    expect(result.findings.some((f) => f.type === 'found' && f.message.includes('Service description'))).toBe(true)
  })

  it('flags info when no service-description link is present', () => {
    const result = analyzeAgentSkillExposure(buildContext(wrap('')))
    expect(result.findings.some((f) => f.type === 'info' && f.message.includes('OpenAPI'))).toBe(true)
  })
})

// ─── Microdata typed fields ──────────────────────────────────────────────────
describe('microdata typed fields', () => {
  it('credits +10 when at least three itemprop attributes are present', () => {
    const body = '<span itemprop="name">N</span><span itemprop="email">e</span><span itemprop="telephone">t</span>'
    const result = analyzeAgentSkillExposure(buildContext(wrap('', body)))
    expect(result.findings.some((f) => f.type === 'found' && f.message.includes('Microdata present'))).toBe(true)
  })

  it('credits +10 when an itemtype is declared even with few itemprop attributes', () => {
    const body = '<div itemscope itemtype="https://schema.org/Person"><span itemprop="name">N</span></div>'
    const result = analyzeAgentSkillExposure(buildContext(wrap('', body)))
    expect(result.findings.some((f) => f.type === 'found' && f.message.includes('Microdata present'))).toBe(true)
  })

  it('flags info when microdata is sparse or absent', () => {
    const result = analyzeAgentSkillExposure(buildContext(wrap('', '<span itemprop="name">N</span>')))
    expect(result.findings.some((f) => f.type === 'info' && f.message.includes('Little or no microdata'))).toBe(true)
  })
})

// ─── Form structural fallback ────────────────────────────────────────────────
describe('form structural fallback', () => {
  it('flags no-form pages with an informational finding (no penalty)', () => {
    const result = analyzeAgentSkillExposure(buildContext(wrap('')))
    expect(result.findings.some((f) => f.type === 'info' && f.message.includes('No interactive forms'))).toBe(true)
  })

  it('ignores forms that only contain hidden inputs', () => {
    const body = '<form><input type="hidden" name="csrf" value="abc"><button type="submit">Go</button></form>'
    const result = analyzeAgentSkillExposure(buildContext(wrap('', body)))
    expect(result.findings.some((f) => f.type === 'info' && f.message.includes('No interactive forms'))).toBe(true)
  })

  it('rewards a form with labels, autocomplete tokens and semantic input types', () => {
    const body = `
      <form aria-label="Sign up">
        <label for="email">Email</label>
        <input id="email" type="email" name="email" autocomplete="email" required>
        <label for="phone">Phone</label>
        <input id="phone" type="tel" name="phone" autocomplete="tel">
        <label for="zip">ZIP</label>
        <input id="zip" type="text" name="postal-code" autocomplete="postal-code">
        <button type="submit">Sign up</button>
      </form>`
    const result = analyzeAgentSkillExposure(buildContext(wrap('', body)))
    expect(result.findings.some((f) => f.type === 'found' && f.message.includes('strong agent-usable structure'))).toBe(true)
  })

  it('penalizes a form with no labels, no autocomplete, and placeholder-only names', () => {
    const body = `
      <form>
        <input type="text" name="field_1">
        <input type="text" name="field_2">
        <input type="text" name="field_3">
        <button>Go</button>
      </form>`
    const result = analyzeAgentSkillExposure(buildContext(wrap('', body)))
    expect(result.findings.some((f) => f.type === 'missing' && f.message.includes('weak structure'))).toBe(true)
    expect(result.recommendations.some((r) => r.includes('autocomplete'))).toBe(true)
  })

  it('reports partial (info) when a form is labeled but lacks autocomplete and semantic types', () => {
    const body = `
      <form>
        <label for="a">A</label>
        <input id="a" type="text" name="first-name">
        <label for="b">B</label>
        <input id="b" type="text" name="last-name">
        <button type="submit">Go</button>
      </form>`
    const result = analyzeAgentSkillExposure(buildContext(wrap('', body)))
    expect(result.findings.some((f) => f.type === 'info' && f.message.includes('partially agent-usable'))).toBe(true)
  })

  it('averages across multiple forms — mixing a strong and a weak form yields a partial finding', () => {
    const body = `
      <form aria-label="Good">
        <label for="a">A</label>
        <input id="a" type="email" name="email" autocomplete="email">
        <button type="submit">Send</button>
      </form>
      <form>
        <input type="text" name="field_1">
        <input type="text" name="field_2">
        <button>Go</button>
      </form>`
    const result = analyzeAgentSkillExposure(buildContext(wrap('', body)))
    const formFinding = result.findings.find((f) =>
      f.message.includes('form(s)') && !f.message.includes('No interactive forms'),
    )
    expect(formFinding?.message).toMatch(/2 form/)
    // 2 forms; avg should land in the partial band
    expect(['info', 'missing']).toContain(formFinding?.type)
  })
})

// ─── Additive / end-to-end scenarios ─────────────────────────────────────────
describe('end-to-end score composition', () => {
  it('returns 0 on a bare page with no affordances', () => {
    const result = analyzeAgentSkillExposure(buildContext(wrap('')))
    expect(result.score).toBe(0)
  })

  it('stacks all signals for a maximum-signal page', () => {
    const head = [
      ld({
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        potentialAction: {
          '@type': 'SearchAction',
          target: { urlTemplate: 'https://example.com/?q={q}' },
          'query-input': 'required name=q',
        },
      }),
      '<link rel="mcp" href="/.well-known/mcp.json">',
      '<link rel="describedby" type="application/openapi+json" href="/openapi.json">',
    ].join('\n')

    const body = `
      <div itemscope itemtype="https://schema.org/Organization">
        <span itemprop="name">N</span>
        <span itemprop="email">e</span>
        <span itemprop="telephone">t</span>
      </div>
      <form aria-label="Sign up">
        <label for="email">Email</label>
        <input id="email" type="email" name="email" autocomplete="email" required>
        <label for="phone">Phone</label>
        <input id="phone" type="tel" name="phone" autocomplete="tel">
        <button type="submit">Sign up</button>
      </form>`

    const result = analyzeAgentSkillExposure(buildContext(wrap(head, body)))
    // 35 (Action) + 20 (MCP) + 10 (OpenAPI) + 10 (microdata) + form bonus → ≥85
    expect(result.score).toBeGreaterThanOrEqual(85)
  })
})

import { clampScore } from './helpers.js'
import { specCitation } from '../spec-references.js'
import type { AnalysisResult, AuditContext, StructuredDataEntry } from '../types.js'

interface ActionMatch {
  type: string
  hasTarget: boolean
  hasInputShape: boolean
}

function collectActions(structuredData: StructuredDataEntry[]): ActionMatch[] {
  const matches: ActionMatch[] = []
  const seen = new WeakSet<object>()

  function visit(node: unknown): void {
    if (!node || typeof node !== 'object') return
    if (seen.has(node as object)) return
    seen.add(node as object)

    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }

    const record = node as Record<string, unknown>
    const rawType = record['@type']
    const typeValues = Array.isArray(rawType) ? rawType : [rawType]

    for (const t of typeValues) {
      if (typeof t === 'string' && t.endsWith('Action')) {
        matches.push({
          type: t,
          hasTarget: typeof record.target !== 'undefined',
          hasInputShape: typeof record['query-input'] !== 'undefined'
            || typeof record.object !== 'undefined'
            || typeof record.result !== 'undefined',
        })
      }
    }

    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') visit(value)
    }
  }

  for (const entry of structuredData) visit(entry)
  return matches
}

function scoreForm($: AuditContext['$'], form: ReturnType<AuditContext['$']>): number {
  const inputs = form.find('input, textarea, select').filter((_, el) => {
    const type = $(el).attr('type')
    return type !== 'hidden' && type !== 'submit' && type !== 'button'
  })

  if (inputs.length === 0) return 0

  let labeled = 0
  let semanticType = 0
  let autocomplete = 0
  let meaningfulName = 0

  inputs.each((_, el) => {
    const $el = $(el)
    const id = $el.attr('id')
    const hasExplicitLabel = Boolean(id && form.find(`label[for="${id}"]`).length)
    const hasAria = Boolean($el.attr('aria-label') || $el.attr('aria-labelledby'))
    const isWrapped = $el.parents('label').length > 0
    if (hasExplicitLabel || hasAria || isWrapped) labeled += 1

    const type = ($el.attr('type') || '').toLowerCase()
    const tag = (el as { tagName?: string }).tagName?.toLowerCase()
    if (tag === 'select' || tag === 'textarea') {
      semanticType += 1
    } else if (type && type !== 'text') {
      semanticType += 1
    }

    if ($el.attr('autocomplete')) autocomplete += 1

    const name = $el.attr('name') || ''
    if (name && !/^field[_-]?\d+$/i.test(name) && name.length >= 2) meaningfulName += 1
  })

  const total = inputs.length
  const labelRatio = labeled / total
  const typeRatio = semanticType / total
  const autoRatio = autocomplete / total
  const nameRatio = meaningfulName / total

  const formAccessibleName = Boolean(
    form.attr('aria-label')
    || form.attr('aria-labelledby')
    || form.attr('name')
    || form.attr('title'),
  )
  const submit = form.find('button[type="submit"], input[type="submit"], button:not([type])')
  const submitText = submit.map((_, el) => $(el).text().trim() || $(el).attr('value') || '').get().join(' ').trim()
  const hasSubmitText = submitText.length > 0

  const perForm = Math.round(
    labelRatio * 35
    + autoRatio * 25
    + typeRatio * 15
    + nameRatio * 10
    + (formAccessibleName ? 10 : 0)
    + (hasSubmitText ? 5 : 0),
  )

  return perForm
}

export function analyzeAgentSkillExposure(context: AuditContext): AnalysisResult {
  const findings: AnalysisResult['findings'] = []
  const recommendations: string[] = []
  let score = 0

  const { $ } = context

  // ── Schema.org Action markup (up to 35) ─────────────────────────────────
  const actions = collectActions(context.structuredData)
  if (actions.length > 0) {
    const wellFormed = actions.filter((a) => a.hasTarget && a.hasInputShape)
    if (wellFormed.length > 0) {
      score += 35
      const types = [...new Set(wellFormed.map((a) => a.type))].slice(0, 3).join(', ')
      findings.push({ type: 'found', message: `Schema.org Action markup declared with target and inputs: ${types}.` })
    } else {
      score += 18
      const types = [...new Set(actions.map((a) => a.type))].slice(0, 3).join(', ')
      findings.push({ type: 'info', message: `Schema.org Action types present (${types}) but missing target/urlTemplate or query-input/object shape.` })
      recommendations.push('Add target (with urlTemplate) and query-input/object to Action schema so agents know how to invoke it.')
    }
  } else {
    findings.push({ type: 'missing', message: 'No Schema.org Action markup detected (PotentialAction / SearchAction / OrderAction / etc.).' })
    recommendations.push('Declare interactive affordances with Schema.org Action markup (e.g. SearchAction with urlTemplate and query-input) so agents can invoke them as tools.')
  }

  // ── MCP / WebMCP / ai-plugin discovery (up to 20) ───────────────────────
  const mcpLink = $('link[rel~="mcp"], link[rel~="webmcp"], link[rel~="ai-plugin"]').first()
  const mcpMeta = $('meta[name="mcp-server"], meta[name="mcp-server-url"], meta[name="ai-plugin"]').first()
  const linkHeader = context.headers['link'] || context.headers['Link'] || ''
  const headerMcp = /rel="?(mcp|webmcp|ai-plugin)"?/i.test(linkHeader)

  if (mcpLink.length || mcpMeta.length || headerMcp) {
    score += 20
    const src = mcpLink.length
      ? `<link rel="${mcpLink.attr('rel')}">`
      : mcpMeta.length
        ? `<meta name="${mcpMeta.attr('name')}">`
        : 'Link header'
    findings.push({ type: 'found', message: `Agent protocol discovery present (${src}).` })
  } else {
    findings.push({ type: 'missing', message: 'No MCP / WebMCP / ai-plugin discovery link or header.' })
    recommendations.push('Expose an MCP server card via <link rel="mcp" href="/.well-known/mcp.json"> or a Link header so agents can discover your tools.')
  }

  // ── A2A agent card discovery (up to 12) ─────────────────────────────────
  // An Agent2Agent (A2A) card lets agents negotiate capabilities before invoking
  // tools. Discoverable via a link/meta tag, a Link header, or a well-known path
  // (specification.website: a2a-agent-cards).
  const agentCardLink = $(
    'link[rel~="agent-card"], link[rel~="a2a"], link[href*="/.well-known/agent.json"], link[href*="agent-card.json"]',
  ).first()
  const agentCardMeta = $('meta[name="agent-card"], meta[name="a2a-agent-card"]').first()
  const agentCardHeader = /rel="?(agent-card|a2a)"?/i.test(linkHeader)
  if (agentCardLink.length || agentCardMeta.length || agentCardHeader) {
    score += 12
    findings.push({ type: 'found', message: 'A2A agent card discovery present — agents can fetch an agent card to negotiate capabilities.' })
  } else {
    findings.push({ type: 'info', message: 'No A2A agent card discovery (no link/meta/Link header pointing to an agent card).' })
    recommendations.push(
      `Publish an A2A agent card and advertise it via <link rel="agent-card" href="/.well-known/agent.json"> or a Link header. ${specCitation('a2a-agent-cards')}`,
    )
  }

  // ── OpenAPI / service-description links (up to 10) ──────────────────────
  const openapiLink = $(
    'link[rel~="describedby"][type*="openapi"], link[rel~="service-desc"], link[rel~="describedby"][type*="yaml"]',
  ).first()
  if (openapiLink.length) {
    score += 10
    findings.push({ type: 'found', message: `Service description link found (type="${openapiLink.attr('type') || 'unspecified'}").` })
  } else {
    findings.push({ type: 'info', message: 'No OpenAPI / service-description link found.' })
    recommendations.push('Link to an OpenAPI document via <link rel="describedby" type="application/openapi+json"> so agents can see the underlying endpoint shape.')
  }

  // ── Microdata typed fields (up to 10) ───────────────────────────────────
  const itempropCount = $('[itemprop]').length
  const itemtypeCount = $('[itemtype]').length
  if (itempropCount >= 3 || itemtypeCount >= 1) {
    score += 10
    findings.push({ type: 'found', message: `Microdata present (${itempropCount} itemprop, ${itemtypeCount} itemtype) — helps agents map semantic meaning.` })
  } else {
    findings.push({ type: 'info', message: 'Little or no microdata (itemprop / itemtype) found on the page.' })
  }

  // ── Form structural fallback (up to 25) ─────────────────────────────────
  const forms = $('form')
  const candidateForms = forms.filter((_, el) => {
    const visibleInputs = $(el).find('input, textarea, select').filter((_, child) => {
      const t = $(child).attr('type')
      return t !== 'hidden' && t !== 'submit' && t !== 'button'
    })
    return visibleInputs.length > 0
  })

  if (candidateForms.length === 0) {
    findings.push({ type: 'info', message: 'No interactive forms detected on this page.' })
  } else {
    const perFormScores: number[] = []
    candidateForms.each((_, el) => {
      perFormScores.push(scoreForm($, $(el)))
    })
    const avg = perFormScores.reduce((a, b) => a + b, 0) / perFormScores.length
    const formContribution = Math.round((avg / 100) * 25)
    score += formContribution

    if (avg >= 80) {
      findings.push({ type: 'found', message: `${candidateForms.length} form(s) with strong agent-usable structure (labels, autocomplete, semantic types).` })
    } else if (avg >= 40) {
      findings.push({ type: 'info', message: `${candidateForms.length} form(s) partially agent-usable. Average structure score ${Math.round(avg)}/100.` })
      recommendations.push('Strengthen forms with aria-label / <label for>, autocomplete tokens (email, tel, street-address…), and semantic input types (email, tel, number, date).')
    } else {
      findings.push({ type: 'missing', message: `${candidateForms.length} form(s) have weak structure for agent use (avg ${Math.round(avg)}/100). Inputs lack labels, autocomplete, or semantic types.` })
      recommendations.push('Add <label for> or aria-label to every input, set autocomplete tokens, and use semantic input types so agents can identify each field without guessing.')
    }
  }

  return {
    score: clampScore(score),
    findings,
    recommendations,
  }
}

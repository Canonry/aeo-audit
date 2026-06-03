// Scoring policy follows Google's "AI features and your website" guide:
// https://developers.google.com/search/docs/fundamentals/ai-optimization-guide
// — "a page must be indexed and eligible to be shown in Google Search with a snippet"
//   to appear in AI Overviews and AI Mode.

import { clampScore } from './helpers.js'
import type { AnalysisResult, AuditContext } from '../types.js'

interface ParsedDirectives {
  noindex: boolean
  nosnippet: boolean
  maxSnippet: number | null
  none: boolean
  noarchive: boolean
  noimageindex: boolean
  raw: string
}

function emptyDirectives(): ParsedDirectives {
  return {
    noindex: false,
    nosnippet: false,
    maxSnippet: null,
    none: false,
    noarchive: false,
    noimageindex: false,
    raw: '',
  }
}

function parseDirectiveString(raw: string): ParsedDirectives {
  const result = emptyDirectives()
  result.raw = raw

  for (const part of raw.split(',')) {
    const token = part.trim().toLowerCase()
    if (!token) continue

    if (token === 'noindex') {
      result.noindex = true
    } else if (token === 'none') {
      result.none = true
      result.noindex = true
    } else if (token === 'nosnippet') {
      result.nosnippet = true
    } else if (token === 'noarchive') {
      result.noarchive = true
    } else if (token === 'noimageindex') {
      result.noimageindex = true
    } else if (token.startsWith('max-snippet:')) {
      const value = parseInt(token.slice('max-snippet:'.length), 10)
      if (Number.isFinite(value)) {
        result.maxSnippet = value
      }
    }
  }

  return result
}

// X-Robots-Tag may carry an agent prefix: "googlebot: noindex" or "otherbot: noindex".
// Apply if the prefix is absent (general directive) or targets googlebot. Skip other agents.
function parseXRobotsHeader(headerValue: string): ParsedDirectives[] {
  const sources: ParsedDirectives[] = []
  // Multiple X-Robots-Tag headers may be combined by the fetch API into one comma-separated value.
  // We split on commas but only if they aren't inside a max-snippet: value (no comma in that token).
  // A safer approach: split by newline first (in case headers were preserved), then evaluate each.
  const lines = headerValue.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)

  for (const line of lines) {
    const agentMatch = line.match(/^([a-zA-Z][a-zA-Z0-9-]*)\s*:\s*(.+)$/)
    if (agentMatch) {
      const agent = agentMatch[1].toLowerCase()
      // Only apply to general directives (no agent prefix) or Google's bots.
      // Skip directives targeted at other bots (e.g., Bingbot, AhrefsBot).
      if (agent === 'googlebot' || agent.startsWith('googlebot-')) {
        sources.push(parseDirectiveString(agentMatch[2]))
      }
      continue
    }
    sources.push(parseDirectiveString(line))
  }

  return sources
}

function mergeDirectives(sources: ParsedDirectives[]): ParsedDirectives {
  const merged = emptyDirectives()
  const rawParts: string[] = []

  for (const src of sources) {
    if (src.raw) rawParts.push(src.raw)
    if (src.noindex) merged.noindex = true
    if (src.none) merged.none = true
    if (src.nosnippet) merged.nosnippet = true
    if (src.noarchive) merged.noarchive = true
    if (src.noimageindex) merged.noimageindex = true
    if (src.maxSnippet !== null) {
      // Take the most restrictive limit. -1 means unlimited and never beats a numeric cap.
      if (merged.maxSnippet === null) {
        merged.maxSnippet = src.maxSnippet
      } else if (src.maxSnippet === -1) {
        // Unlimited never overrides an existing cap.
      } else if (merged.maxSnippet === -1) {
        merged.maxSnippet = src.maxSnippet
      } else {
        merged.maxSnippet = Math.min(merged.maxSnippet, src.maxSnippet)
      }
    }
  }

  merged.raw = rawParts.join(' | ')
  return merged
}

export function analyzeSnippetEligibility(context: AuditContext): AnalysisResult {
  const findings: AnalysisResult['findings'] = []
  const recommendations: string[] = []

  const sources: ParsedDirectives[] = []

  context.$('meta').each((_, el) => {
    const name = (context.$(el).attr('name') || '').toLowerCase()
    if (name !== 'robots' && name !== 'googlebot') return
    const content = context.$(el).attr('content') || ''
    if (content.trim()) {
      sources.push(parseDirectiveString(content))
    }
  })

  const xRobotsHeader = context.headers?.['x-robots-tag'] || ''
  if (xRobotsHeader.trim()) {
    for (const parsed of parseXRobotsHeader(xRobotsHeader)) {
      sources.push(parsed)
    }
  }

  if (sources.length === 0) {
    findings.push({
      type: 'found',
      code: 'snippet-eligibility.directives.none',
      message: 'No restrictive indexing directives found. Page is eligible for indexing and AI snippet features per Google.',
    })
    return { score: 100, findings, recommendations }
  }

  const directives = mergeDirectives(sources)
  let score = 100

  if (directives.noindex) {
    score = 0
    const label = directives.none ? '"none" (implies noindex, nofollow)' : '"noindex"'
    findings.push({
      type: 'missing',
      code: 'snippet-eligibility.noindex.present',
      message: `Page declares ${label} (${directives.raw}). Google explicitly requires a page to be indexed to appear in AI Overviews and AI Mode.`,
    })
    recommendations.push(
      'Remove the noindex/none directive from <meta name="robots">, <meta name="googlebot">, or the X-Robots-Tag header so the page becomes eligible for indexing and AI features.',
    )
  }

  if (directives.nosnippet) {
    score = 0
    findings.push({
      type: 'missing',
      code: 'snippet-eligibility.nosnippet.present',
      message: `Page declares "nosnippet" (${directives.raw}). Per Google's AI optimization guide, "a page must be indexed and eligible to be shown in Google Search with a snippet" to appear in AI features — nosnippet makes the page ineligible.`,
    })
    recommendations.push(
      'Remove the nosnippet directive to allow Google AI features to cite this page. If you used it to opt out of AI training, note that it also blocks AI Overviews and AI Mode citations.',
    )
  }

  if (directives.maxSnippet === 0) {
    score = 0
    findings.push({
      type: 'missing',
      code: 'snippet-eligibility.max-snippet.zero',
      message: `Page declares "max-snippet:0" (${directives.raw}), which is equivalent to nosnippet and blocks Google's AI features.`,
    })
    recommendations.push(
      'Remove "max-snippet:0" or replace it with "max-snippet:-1" (unlimited) so the page is eligible for AI features.',
    )
  } else if (directives.maxSnippet !== null && directives.maxSnippet > 0 && directives.maxSnippet < 50) {
    score = Math.min(score, 60)
    findings.push({
      type: 'info',
      code: 'snippet-eligibility.max-snippet.low',
      message: `Page declares "max-snippet:${directives.maxSnippet}" — Google can use at most ${directives.maxSnippet} characters of preview text, which heavily constrains AI snippets.`,
    })
    recommendations.push(
      `The max-snippet:${directives.maxSnippet} cap is very restrictive. Consider removing the cap or using "max-snippet:-1" (unlimited) for full AI feature eligibility.`,
    )
  }

  if (score === 100) {
    if (directives.noarchive) {
      findings.push({
        type: 'info',
        code: 'snippet-eligibility.noarchive.present',
        message: 'Page declares "noarchive" — Google won\'t show a cached copy, but this does not block AI features. Safe to keep if intentional.',
      })
    }
    if (directives.noimageindex) {
      findings.push({
        type: 'info',
        code: 'snippet-eligibility.noimageindex.present',
        message: 'Page declares "noimageindex" — images on this page won\'t be indexed. This does not block AI text features.',
      })
    }
    if (findings.length === 0) {
      findings.push({
        type: 'found',
        code: 'snippet-eligibility.directives.not-restrictive',
        message: `Indexing directives present but not restrictive: "${directives.raw}".`,
      })
    }
  }

  return { score: clampScore(score), findings, recommendations }
}

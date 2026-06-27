import { clampScore } from './helpers.js'
import { specCitation } from '../spec-references.js'
import type { AnalysisResult, AuditContext } from '../types.js'

interface RobotRule {
  type: 'allow' | 'disallow'
  path: string
}

/**
 * Content Signals (Cloudflare, https://contentsignals.org) — per-User-agent AI-usage
 * preferences expressed in robots.txt via a `Content-Signal:` directive. Each signal is
 * `yes` (use permitted), `no` (use denied), or absent (no preference expressed):
 *   - search    — building a search index / returning hyperlinks and excerpts
 *   - ai-input  — real-time use as AI input (RAG, grounding) — the AEO-decisive signal
 *   - ai-train  — training or fine-tuning AI models
 */
type ContentSignalKey = 'search' | 'ai-input' | 'ai-train'
type ContentSignals = Partial<Record<ContentSignalKey, 'yes' | 'no'>>
const CONTENT_SIGNAL_KEYS: ContentSignalKey[] = ['search', 'ai-input', 'ai-train']

interface RobotGroup {
  agents: string[]
  rules: RobotRule[]
  signals: ContentSignals
}

const AI_CRAWLERS = [
  { name: 'GPTBot', points: 18 },
  { name: 'ClaudeBot', points: 18 },
  { name: 'PerplexityBot', points: 18 },
  { name: 'OAI-SearchBot', points: 14 },
  { name: 'Google-Extended', points: 14 },
]

function parseRobotsTxt(robotsTxt: string): RobotGroup[] {
  const lines = robotsTxt
    .split(/\r?\n/)
    .map((line) => line.split('#')[0].trim())
    .filter(Boolean)

  const groups: RobotGroup[] = []
  let currentGroup: RobotGroup | null = null

  for (const line of lines) {
    const colonIndex = line.indexOf(':')
    if (colonIndex === -1) {
      continue
    }

    const key = line.slice(0, colonIndex).trim().toLowerCase()
    const value = line.slice(colonIndex + 1).trim()

    if (key === 'user-agent') {
      // Consecutive User-agent lines share one block until a rule or signal fills it
      if (currentGroup && currentGroup.rules.length === 0 && Object.keys(currentGroup.signals).length === 0) {
        currentGroup.agents.push(value.toLowerCase())
      } else {
        currentGroup = { agents: [value.toLowerCase()], rules: [], signals: {} }
        groups.push(currentGroup)
      }
      continue
    }

    if (!currentGroup) {
      continue
    }

    if (key === 'allow' || key === 'disallow') {
      currentGroup.rules.push({ type: key, path: value })
    } else if (key === 'content-signal') {
      Object.assign(currentGroup.signals, parseContentSignalValue(value))
    }
  }

  return groups
}

function isContentSignalKey(key: string): key is ContentSignalKey {
  return key === 'search' || key === 'ai-input' || key === 'ai-train'
}

/** Parse a `Content-Signal:` value (e.g. `search=yes, ai-train=no`) into known signals. */
function parseContentSignalValue(raw: string): ContentSignals {
  const signals: ContentSignals = {}
  for (const token of raw.split(',')) {
    const eq = token.indexOf('=')
    if (eq === -1) continue
    const key = token.slice(0, eq).trim().toLowerCase()
    const value = token.slice(eq + 1).trim().toLowerCase()
    if (isContentSignalKey(key) && (value === 'yes' || value === 'no')) {
      signals[key] = value
    }
  }
  return signals
}

/**
 * The site-wide content-signal policy: the directive under `User-agent: *` (how the
 * Content Signals spec and Cloudflare's managed robots.txt express it), falling back to
 * the first group that declares one so a bot-scoped restriction is still surfaced.
 */
function effectiveContentSignals(groups: RobotGroup[]): ContentSignals {
  const declaring = groups.filter((group) => Object.keys(group.signals).length > 0)
  const wildcard = declaring.find((group) => group.agents.includes('*'))
  return (wildcard ?? declaring[0])?.signals ?? {}
}

function contentSignalSummary(signals: ContentSignals): string {
  const declared = CONTENT_SIGNAL_KEYS.filter((key) => signals[key]).map((key) => `${key}=${signals[key]}`)
  return declared.length > 0
    ? `robots.txt declares a Content-Signal policy (${declared.join(', ')}) — AI usage preferences are machine-readable.`
    : 'robots.txt includes a Content-Signal directive but declares no recognized signals (search, ai-input, ai-train).'
}

function isBotAllowedForPath(groups: RobotGroup[], botName: string, urlPath: string): boolean {
  const botLower = botName.toLowerCase()
  const path = urlPath || '/'

  // Find the most specific matching group (exact bot name > wildcard)
  const exactGroup = groups.find((group) =>
    group.agents.some((agent) => agent === botLower),
  )

  const wildcardGroup = groups.find((group) =>
    group.agents.some((agent) => agent === '*'),
  )

  const matchingGroup = exactGroup || wildcardGroup

  if (!matchingGroup) {
    return true // No matching rules means allowed
  }

  // Evaluate rules: longest matching path wins. On tie, Allow beats Disallow.
  let bestMatch: RobotRule | null = null

  for (const rule of matchingGroup.rules) {
    const rulePath = rule.path || ''

    // Empty disallow means allow everything
    if (rule.type === 'disallow' && rulePath === '') {
      continue
    }

    // Check if the rule path matches the URL path
    if (path.startsWith(rulePath)) {
      if (!bestMatch || rulePath.length > bestMatch.path.length || (rulePath.length === bestMatch.path.length && rule.type === 'allow')) {
        bestMatch = rule
      }
    }
  }

  if (!bestMatch) {
    return true // No matching rule means allowed
  }

  return bestMatch.type === 'allow'
}

export function analyzeAiCrawlerAccess(context: AuditContext): AnalysisResult {
  const findings: AnalysisResult['findings'] = []
  const recommendations: string[] = []
  let score = 0

  const robotsState = context.auxiliary?.robotsTxt?.state
  if (robotsState !== 'ok') {
    if (robotsState === 'missing') {
      // No robots.txt means everything is allowed
      score += 80
      findings.push({ type: 'info', code: 'ai-crawler-access.robots-txt.missing', message: 'No robots.txt found — AI crawlers are implicitly allowed.' })
      recommendations.push('Add a robots.txt that explicitly allows AI crawlers for clarity.')
    } else {
      score += 30
      findings.push({ type: robotsState === 'timeout' ? 'timeout' : 'unreachable', code: 'ai-crawler-access.robots-txt.unreachable', message: 'Could not reliably fetch robots.txt.' })
    }

    return { score: clampScore(score), findings, recommendations }
  }

  const robotsTxt = context.auxiliary.robotsTxt?.body || ''
  const groups = parseRobotsTxt(robotsTxt)

  // Determine the path of the audited URL
  let auditedPath = '/'
  try {
    auditedPath = new URL(context.url).pathname || '/'
  } catch {
    // Use default /
  }

  let _allowedCount = 0
  const blockedBots: string[] = []

  for (const crawler of AI_CRAWLERS) {
    const allowed = isBotAllowedForPath(groups, crawler.name, auditedPath)

    if (allowed) {
      _allowedCount += 1
      score += crawler.points
      findings.push({ type: 'found', code: 'ai-crawler-access.crawler.allowed', message: `${crawler.name} is allowed by robots.txt.` })
    } else {
      blockedBots.push(crawler.name)
      findings.push({ type: 'missing', code: 'ai-crawler-access.crawler.blocked', message: `${crawler.name} is blocked by robots.txt.` })
    }
  }

  if (blockedBots.length > 0) {
    recommendations.push(`Consider allowing these AI crawlers in robots.txt: ${blockedBots.join(', ')}.`)
  }

  // Bonus for explicit sitemap directive
  if (robotsTxt.toLowerCase().includes('sitemap:')) {
    score += 18
    findings.push({ type: 'found', code: 'ai-crawler-access.sitemap.found', message: 'Sitemap directive found in robots.txt.' })
  }

  // Content Signals — machine-readable AI usage preferences in robots.txt (Cloudflare /
  // contentsignals.org; specification.website: content-signals). Score the *values*, not
  // mere presence: `ai-input=no` asks answer engines not to use the page for AI answers
  // (RAG/grounding), so it actively works against AEO and must not be rewarded.
  if (!/^\s*content-signal\s*:/im.test(robotsTxt)) {
    recommendations.push(
      `Declare AI usage preferences with a Content-Signal directive in robots.txt (e.g. "Content-Signal: search=yes, ai-input=yes, ai-train=no"). ${specCitation('content-signals')}`,
    )
  } else {
    const signals = effectiveContentSignals(groups)
    findings.push({ type: 'found', code: 'ai-crawler-access.content-signal.found', message: contentSignalSummary(signals) })

    // ai-input — real-time use as AI input (RAG, grounding): the AEO-decisive signal.
    if (signals['ai-input'] === 'yes') {
      score += 6
      findings.push({ type: 'found', code: 'ai-crawler-access.content-signal.ai-input-allowed', message: 'Content-Signal sets ai-input=yes — answer engines are explicitly permitted to use this page for AI answers (RAG, grounding).' })
    } else if (signals['ai-input'] === 'no') {
      score -= 12
      findings.push({ type: 'missing', code: 'ai-crawler-access.content-signal.ai-input-blocked', message: 'Content-Signal sets ai-input=no — this asks answer engines not to use this page for AI answers (RAG, grounding), which directly works against AEO.' })
      recommendations.push(
        `robots.txt Content-Signal sets ai-input=no, opting out of the real-time AI use that AEO depends on; set ai-input=yes (or drop the restriction) to let answer engines cite this content. ${specCitation('content-signals')}`,
      )
    }

    // search — search-index use, which several answer engines draw on.
    if (signals['search'] === 'yes') {
      score += 2
      findings.push({ type: 'found', code: 'ai-crawler-access.content-signal.search-allowed', message: 'Content-Signal sets search=yes — search engines may index this page and surface it in results.' })
    } else if (signals['search'] === 'no') {
      score -= 6
      findings.push({ type: 'missing', code: 'ai-crawler-access.content-signal.search-blocked', message: 'Content-Signal sets search=no — this opts the page out of search-index use, which several answer engines draw on.' })
      recommendations.push(
        `robots.txt Content-Signal sets search=no, opting out of the search indexing that feeds many AI answers; set search=yes unless you intend to be excluded from search. ${specCitation('content-signals')}`,
      )
    }

    // ai-train — model training. Neutral for AEO citation (a page can be cited without
    // being trained on) and the Cloudflare default is ai-train=no, so it is never penalized.
    if (signals['ai-train'] === 'no') {
      findings.push({ type: 'info', code: 'ai-crawler-access.content-signal.ai-train-blocked', message: 'Content-Signal sets ai-train=no — this blocks model training but not AI answers, so it does not affect AEO citation.' })
    }
  }

  return {
    score: clampScore(score),
    findings,
    recommendations,
  }
}

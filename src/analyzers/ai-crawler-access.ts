import { clampScore } from './helpers.js'
import { specCitation } from '../spec-references.js'
import type { AnalysisResult, AuditContext } from '../types.js'

interface RobotRule {
  type: 'allow' | 'disallow'
  path: string
}

interface RobotGroup {
  agents: string[]
  rules: RobotRule[]
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
      // Consecutive User-agent lines share the same rule block
      if (currentGroup && currentGroup.rules.length === 0) {
        currentGroup.agents.push(value.toLowerCase())
      } else {
        currentGroup = { agents: [value.toLowerCase()], rules: [] }
        groups.push(currentGroup)
      }
      continue
    }

    if (!currentGroup) {
      continue
    }

    if (key === 'allow' || key === 'disallow') {
      currentGroup.rules.push({ type: key, path: value })
    }
  }

  return groups
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
      findings.push({ type: 'info', message: 'No robots.txt found — AI crawlers are implicitly allowed.' })
      recommendations.push('Add a robots.txt that explicitly allows AI crawlers for clarity.')
    } else {
      score += 30
      findings.push({ type: robotsState === 'timeout' ? 'timeout' : 'unreachable', message: 'Could not reliably fetch robots.txt.' })
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
      findings.push({ type: 'found', message: `${crawler.name} is allowed by robots.txt.` })
    } else {
      blockedBots.push(crawler.name)
      findings.push({ type: 'missing', message: `${crawler.name} is blocked by robots.txt.` })
    }
  }

  if (blockedBots.length > 0) {
    recommendations.push(`Consider allowing these AI crawlers in robots.txt: ${blockedBots.join(', ')}.`)
  }

  // Bonus for explicit sitemap directive
  if (robotsTxt.toLowerCase().includes('sitemap:')) {
    score += 18
    findings.push({ type: 'found', message: 'Sitemap directive found in robots.txt.' })
  }

  // Content Signals — machine-readable AI usage preferences in robots.txt
  // (specification.website: content-signals).
  if (/^\s*content-signal\s*:/im.test(robotsTxt)) {
    score += 8
    findings.push({ type: 'found', message: 'robots.txt declares Content-Signal directives — AI search/input/train preferences are machine-readable.' })
  } else {
    recommendations.push(
      `Declare AI usage preferences with a Content-Signal directive in robots.txt (e.g. "Content-Signal: search=yes, ai-input=yes, ai-train=no"). ${specCitation('content-signals')}`,
    )
  }

  return {
    score: clampScore(score),
    findings,
    recommendations,
  }
}

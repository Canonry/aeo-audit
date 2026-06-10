// Cross-references from aeo-audit factors to the relevant rules in the
// platform-agnostic web specification at https://specification.website
// (Joost de Valk). The spec's "Agent readiness" category is the closest
// authoritative analogue to what this tool measures, so we cite the exact rule
// pages in recommendations and expose a factor → rule map so API consumers can
// report conformance (e.g. "fails 'Structured data for agents' (recommended)").
//
// Titles and statuses were verified against the published spec in 2026-05.

export type SpecStatus = 'required' | 'recommended' | 'optional' | 'avoid'

export interface SpecRule {
  /** Slug under /spec/agent-readiness/ on specification.website. */
  slug: string
  /** Rule title exactly as published. */
  title: string
  /** Conformance status the spec assigns the rule. */
  status: SpecStatus
  /** Canonical URL of the rule page. */
  url: string
}

export const SPEC_SITE = 'https://specification.website'

const AGENT_READINESS_BASE = `${SPEC_SITE}/spec/agent-readiness`

function agentReadinessRule(slug: string, title: string, status: SpecStatus): SpecRule {
  return { slug, title, status, url: `${AGENT_READINESS_BASE}/${slug}/` }
}

/**
 * The agent-readiness rules from specification.website that aeo-audit factors map
 * onto. Keys are the spec slugs; `satisfies` preserves the literal keys so
 * `SpecRuleId` is the exact union of valid slugs.
 */
export const SPEC_RULES = {
  'llms-txt': agentReadinessRule('llms-txt', '/llms.txt', 'recommended'),
  'llms-full-txt': agentReadinessRule('llms-full-txt', '/llms-full.txt', 'optional'),
  'markdown-source-endpoints': agentReadinessRule('markdown-source-endpoints', 'Per-page Markdown source endpoints', 'recommended'),
  'link-headers': agentReadinessRule('link-headers', 'HTTP Link headers for discovery', 'recommended'),
  'robots-for-ai-crawlers': agentReadinessRule('robots-for-ai-crawlers', 'robots.txt for AI crawlers', 'recommended'),
  'content-signals': agentReadinessRule('content-signals', 'Content Signals in robots.txt', 'optional'),
  'structured-data-for-agents': agentReadinessRule('structured-data-for-agents', 'Structured data for agents', 'recommended'),
  'mcp-and-tool-discovery': agentReadinessRule('mcp-and-tool-discovery', 'MCP and tool discovery', 'optional'),
  'agent-skills-discovery': agentReadinessRule('agent-skills-discovery', 'Agent Skills discovery', 'recommended'),
  'a2a-agent-cards': agentReadinessRule('a2a-agent-cards', 'A2A agent cards', 'optional'),
  'web-bot-auth': agentReadinessRule('web-bot-auth', 'Web Bot Auth — verifiable bot identity', 'optional'),
} satisfies Record<string, SpecRule>

export type SpecRuleId = keyof typeof SPEC_RULES

/**
 * Maps aeo-audit factor IDs to the specification.website agent-readiness rules they
 * evaluate. This positions aeo-audit as the automated conformance checker for the
 * spec's agent-readiness category. The explicit type narrows each slug to a valid
 * `SpecRuleId`, so a typo'd slug fails the build.
 */
export const FACTOR_SPEC_RULES: Record<string, SpecRuleId[]> = {
  'structured-data': ['structured-data-for-agents'],
  'ai-access-files': ['llms-txt', 'llms-full-txt', 'markdown-source-endpoints', 'link-headers'],
  'ai-crawler-access': ['robots-for-ai-crawlers', 'content-signals'],
  'agent-skill-exposure': ['mcp-and-tool-discovery', 'agent-skills-discovery', 'a2a-agent-cards', 'web-bot-auth'],
}

/**
 * Citation suffix appended to a recommendation, e.g.
 * `See specification.website — "Per-page Markdown source endpoints" (recommended): https://…`.
 */
export function specCitation(id: SpecRuleId): string {
  const rule = SPEC_RULES[id]
  return `See specification.website — "${rule.title}" (${rule.status}): ${rule.url}`
}

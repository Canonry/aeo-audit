import type {
  AuditContext,
  AuditReport,
  CriticalDefect,
  CriticalDefectGroup,
  CriticalDefectId,
  CriticalDefectSeverity,
} from './types.js'

/** Human-readable labels for each defect, used in rollups and formatters. */
export const DEFECT_TITLES: Record<CriticalDefectId, string> = {
  'missing-h1': 'Missing H1',
  'multiple-h1': 'Multiple H1 tags',
  'missing-title': 'Missing <title>',
  'missing-meta-description': 'Missing meta description',
}

const SEVERITY_RANK: Record<CriticalDefectSeverity, number> = {
  critical: 0,
  warning: 1,
}

/**
 * Detect binary structural defects on a single page straight from the DOM.
 *
 * These are deliberately independent of the weighted factor scores. The technical
 * factors already fold an H1-count or meta-description check into a bundled score
 * that can read "healthy" (issue #42) even when one sub-check fails; here each
 * defect is an unambiguous, one-line-fixable yes/no, so it can be surfaced on its
 * own merits regardless of how the surrounding factor happened to average out.
 */
export function detectCriticalDefects(context: AuditContext): CriticalDefect[] {
  const defects: CriticalDefect[] = []

  const h1Count = context.$('h1').length
  if (h1Count === 0) {
    defects.push({
      id: 'missing-h1',
      severity: 'critical',
      detail: 'No H1 tag — AI models use the H1 as the primary page-topic signal.',
      recommendation: 'Add exactly one H1 that clearly states the page topic.',
    })
  } else if (h1Count > 1) {
    defects.push({
      id: 'multiple-h1',
      severity: 'critical',
      detail: `${h1Count} H1 tags found (expected exactly one).`,
      recommendation: `Consolidate to a single H1; ${h1Count} are present.`,
    })
  }

  if (!context.pageTitle) {
    defects.push({
      id: 'missing-title',
      severity: 'critical',
      detail: 'No <title> element — search and AI snippets have no canonical page name to use.',
      recommendation: 'Add a concise <title> that names the page.',
    })
  }

  const metaDesc = context.$('meta[name="description"]').attr('content')?.trim() ?? ''
  if (!metaDesc) {
    defects.push({
      id: 'missing-meta-description',
      severity: 'warning',
      detail: 'No meta description.',
      recommendation: 'Add a meta description (150–160 characters) summarising the page.',
    })
  }

  return defects
}

/** A URL is the homepage when its path is the site root and it carries no query. */
export function isHomepageUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (parsed.pathname === '/' || parsed.pathname === '') && parsed.search === ''
  } catch {
    return false
  }
}

// Sitemaps without an explicit <priority> default to 0.5 per the protocol, so we
// treat an absent priority the same way when ranking.
const effectivePriority = (priority: number | undefined): number => priority ?? 0.5

/**
 * Roll per-page critical defects up across a sitemap/static run, grouped by
 * defect. Pages within a group are ordered by importance (homepage first, then
 * sitemap priority); groups are ordered by severity, then by whether they hit an
 * important page — so the homepage's broken H1 leads even at 1-of-25 prevalence,
 * which is exactly the case the prevalence-based ranking buries.
 *
 * `priorityByUrl` maps a page's final URL to its sitemap `<priority>`. It is
 * optional: static-output mode has no sitemap priorities, and homepage detection
 * (from the URL path) still works without it.
 */
export function buildCriticalDefects(
  successPages: AuditReport[],
  priorityByUrl: Map<string, number | undefined> = new Map(),
): CriticalDefectGroup[] {
  const groups = new Map<CriticalDefectId, CriticalDefectGroup>()

  for (const page of successPages) {
    for (const defect of page.criticalDefects ?? []) {
      let group = groups.get(defect.id)
      if (!group) {
        group = {
          id: defect.id,
          severity: defect.severity,
          title: DEFECT_TITLES[defect.id],
          recommendation: defect.recommendation,
          pages: [],
        }
        groups.set(defect.id, group)
      }
      group.pages.push({
        url: page.finalUrl,
        detail: defect.detail,
        isHomepage: isHomepageUrl(page.finalUrl),
        priority: priorityByUrl.get(page.finalUrl),
      })
    }
  }

  for (const group of groups.values()) {
    group.pages.sort(
      (a, b) =>
        Number(b.isHomepage) - Number(a.isHomepage) ||
        effectivePriority(b.priority) - effectivePriority(a.priority) ||
        a.url.localeCompare(b.url),
    )
  }

  const hasHomepage = (g: CriticalDefectGroup): number => (g.pages.some((p) => p.isHomepage) ? 1 : 0)
  const maxPriority = (g: CriticalDefectGroup): number =>
    g.pages.reduce((max, p) => Math.max(max, effectivePriority(p.priority)), 0)

  return [...groups.values()].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      hasHomepage(b) - hasHomepage(a) ||
      maxPriority(b) - maxPriority(a) ||
      b.pages.length - a.pages.length ||
      a.title.localeCompare(b.title),
  )
}

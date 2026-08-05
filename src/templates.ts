import { isHomepageUrl } from './critical-defects.js'
import { deriveTemplateKeys, routeKey } from './url-templates.js'
import type { ScoredFactor, SitemapPageResult, TemplateGroup } from './types.js'

/**
 * One template rendered N times, recognised as such.
 *
 * A crawl of a templated site reports the same fault once per instance: 194
 * property pages missing schema read as 194 pieces of work when they are one
 * change to one template. Every effort estimate a report produces is wrong by
 * that factor, and on a large site the difference is an impossible backlog
 * versus an afternoon.
 *
 * The signature is two signals that must agree:
 *
 *   1. URL shape — the pages sit at the same route (see `deriveTemplateKeys`).
 *   2. Score vector — they score the same on every factor, within tolerance.
 *
 * Neither alone is enough. Identical scores by themselves would collapse 194
 * unrelated pages that happen to be equally bad into a fictitious template, and
 * URL shape by itself would collapse a route whose instances genuinely differ.
 * Requiring both means the claim "this is one template" is structural as well as
 * statistical.
 */

/**
 * Largest per-factor difference two pages may have and still be called the same
 * template.
 *
 * Exact equality is too brittle to use: one property description a few words
 * longer crosses a content-depth bucket and scores 57 where its siblings score
 * 58, and a rule keyed on exact match would call that a separate template and
 * report the work twice. 2 absorbs boundary noise of that kind while staying far
 * below the gap between a page that has a feature and one that doesn't.
 */
const SCORE_TOLERANCE = 2

/**
 * Instances needed before a shape is called a template. Two pages that resemble
 * each other are a coincidence worth nothing; three is a pattern, and below that
 * the "one change fixes N" framing doesn't earn its place in the report.
 */
const MIN_TEMPLATE_INSTANCES = 3

/** Factor ids present, in a stable order — pages with different sets can't be compared. */
function factorSignature(factors: ScoredFactor[]): string {
  return factors.map((factor) => factor.id).sort().join(',')
}

/** Scores in factor-id order, zero-padded so lexical sort is numeric sort. */
function scoreVector(factors: ScoredFactor[]): number[] {
  return [...factors]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((factor) => factor.score)
}

function vectorSortKey(vector: number[]): string {
  return vector.map((score) => String(score).padStart(3, '0')).join('|')
}

function withinTolerance(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  return a.every((score, i) => Math.abs(score - (b[i] as number)) <= SCORE_TOLERANCE)
}

interface Candidate {
  url: string
  overallScore: number
  vector: number[]
}

function buildGroup(templateKey: string, members: Candidate[]): TemplateGroup {
  const scores = members.map((member) => member.overallScore)
  // The page to show the fix on: the strongest instance, since that's the one
  // closest to what the others should look like. Lexical last, for determinism
  // under the concurrent page ordering the crawl produces.
  //
  // The homepage check ahead of score is defensive rather than load-bearing: a
  // homepage is always path `/`, so it sits alone at depth 0 and in a
  // single-origin crawl never shares a group with anything.
  const representative = [...members].sort(
    (a, b) =>
      Number(isHomepageUrl(b.url)) - Number(isHomepageUrl(a.url)) ||
      b.overallScore - a.overallScore ||
      a.url.localeCompare(b.url),
  )[0] as Candidate

  return {
    templateKey,
    representativeUrl: representative.url,
    urls: members.map((member) => member.url).sort(),
    pageCount: members.length,
    avgScore: Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length),
    scoreRange: Math.max(...scores) - Math.min(...scores),
  }
}

/**
 * Collapse audited pages into templates.
 *
 * Pages that don't join a template are simply absent from the result — they are
 * one-offs, and the report already covers them page by page. This is an overlay
 * on the per-page findings, never a replacement: no URL a report would otherwise
 * have listed disappears because of grouping.
 */
export function buildTemplateGroups(
  pages: SitemapPageResult[],
  /**
   * Template keys derived over the whole discovered corpus. Pass them whenever
   * the crawl sampled: whether a path position holds a route or an identifier is
   * a fact about the site, and a 20-page sample of a 218-page site has too few
   * distinct values to see it — the same URLs that read as one template across
   * the full corpus read as 20 separate ones within the sample. Sharing the map
   * also keeps this and the `coverage` block quoting the same template count.
   */
  templateKeysForCorpus?: ReadonlyMap<string, string>,
): TemplateGroup[] {
  const usable = pages.filter(
    (page): page is SitemapPageResult & { factors: ScoredFactor[] } =>
      page.status === 'success' && Array.isArray(page.factors) && page.factors.length > 0,
  )
  if (usable.length < MIN_TEMPLATE_INSTANCES) return []

  const templateKeys = templateKeysForCorpus ?? deriveTemplateKeys(usable.map((page) => page.url))

  // Re-index the corpus keys by route. The map is keyed by sitemap <loc>, but a
  // page carries the final URL it was fetched at, which often differs from its
  // loc by a redirect (trailing slash, http->https, host case). routeKey
  // collapses exactly those differences, so a redirected page still resolves to
  // its template instead of landing in a singleton group of its own.
  const keysByRoute = new Map<string, string>()
  for (const [url, key] of templateKeys) {
    const route = routeKey(url)
    if (!keysByRoute.has(route)) keysByRoute.set(route, key)
  }

  // Bucket on the two things that must match exactly before scores are compared
  // at all: the route shape, and which factors even ran on the page.
  const buckets = new Map<string, { templateKey: string; candidates: Candidate[] }>()
  for (const page of usable) {
    const templateKey = keysByRoute.get(routeKey(page.url)) ?? page.url
    const bucketKey = `${templateKey} ${factorSignature(page.factors)}`
    const bucket = buckets.get(bucketKey)
    const candidate: Candidate = {
      url: page.url,
      overallScore: page.overallScore,
      vector: scoreVector(page.factors),
    }
    if (bucket) bucket.candidates.push(candidate)
    else buckets.set(bucketKey, { templateKey, candidates: [candidate] })
  }

  const groups: TemplateGroup[] = []
  for (const { templateKey, candidates } of buckets.values()) {
    if (candidates.length < MIN_TEMPLATE_INSTANCES) continue

    // Sort by score vector so near-identical pages sit next to each other, then
    // walk once, opening a new cluster whenever a page drifts out of tolerance
    // from the one that opened the current cluster. Comparing against the head
    // rather than the previous member stops a long chain of 2-point steps from
    // drifting arbitrarily far and still calling itself one template.
    const sorted = [...candidates].sort(
      (a, b) => vectorSortKey(a.vector).localeCompare(vectorSortKey(b.vector)) || a.url.localeCompare(b.url),
    )

    let cluster: Candidate[] = []
    const flush = (): void => {
      if (cluster.length >= MIN_TEMPLATE_INSTANCES) groups.push(buildGroup(templateKey, cluster))
      cluster = []
    }
    for (const candidate of sorted) {
      const head = cluster[0]
      if (head && !withinTolerance(head.vector, candidate.vector)) flush()
      cluster.push(candidate)
    }
    flush()
  }

  // Biggest first: that's the order of leverage, and the order a reader wants.
  groups.sort((a, b) => b.pageCount - a.pageCount || a.templateKey.localeCompare(b.templateKey))
  return groups
}

/**
 * How a fix's affected pages distribute over templates.
 *
 * `instances` is the honest page count and `templates` is the honest amount of
 * work; a report that only carries the first overstates the job every time the
 * site is templated. `templates` counts one-off pages individually, so a fix
 * spanning a 194-page template and 2 stray pages reports 3 templates, not 1.
 */
export function summarizeFixReach(
  affectedPages: readonly string[],
  groups: readonly TemplateGroup[],
): { templates: number; instances: number } {
  if (affectedPages.length === 0) return { templates: 0, instances: 0 }

  // Map each grouped URL to its group *object*, not its template key. One
  // template key can back several groups — buildTemplateGroups emits one per
  // score cluster, so a `/*/*` route split into unit pages (40) and metro pages
  // (90) is two groups sharing that key — and each is a separate edit. Keying the
  // dedup on the key would collapse them and undercount the very work this
  // reports, the failure the doc above rules out.
  const groupByUrl = new Map<string, TemplateGroup>()
  for (const group of groups) {
    for (const url of group.urls) groupByUrl.set(url, group)
  }

  const distinct = new Set<TemplateGroup | string>()
  for (const url of affectedPages) {
    // A page in no template is its own unit of work, keyed by URL so two
    // one-offs never collapse into each other.
    distinct.add(groupByUrl.get(url) ?? ` ${url}`)
  }

  return { templates: distinct.size, instances: affectedPages.length }
}

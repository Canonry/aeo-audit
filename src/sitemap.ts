import { AeoAuditError } from './errors.js'
import { buildCriticalDefects, isHomepageUrl } from './critical-defects.js'
import {
  FetchBudgetController,
  fetchWithValidatedRedirects,
  isCallerAbort,
  isFetchBudgetExceededError,
  normalizeTargetUrl,
  throwIfAborted,
} from './fetch-page.js'
import { runAeoAudit } from './index.js'
import { SCHEMA_VERSION, engineVersion } from './schema.js'
import { PAGE_SPECIFIC_FACTOR_IDS, PAGE_SPECIFIC_PRESENT_THRESHOLD } from './scoring.js'
import type {
  AuditReport,
  CriticalDefectGroup,
  CrossCuttingIssue,
  CrossCuttingStatus,
  PrioritizedFix,
  RunAeoAuditOptions,
  SitemapAuditOptions,
  SitemapAuditReport,
  SitemapAuditBudgetMetadata,
  SitemapAuditMetadata,
  SitemapPageResult,
  SiteIssue,
} from './types.js'

const SITEMAP_TIMEOUT_MS = 10_000
const SITEMAP_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_LIMIT = 200
const DEFAULT_CONCURRENCY = 5
// Safety ceiling on how many child sitemaps a single index may fan out to. A
// malicious or misconfigured index can list tens of thousands of <loc>s; without a
// cap every one is fetched (see resolveSitemapUrls), exhausting the shared runner.
// 1000 children × 50k URLs each is far more than any audit consumes, so a legitimate
// site never notices, while the pathological case stays bounded.
const MAX_CHILD_SITEMAPS = 1000

const SKIP_EXTENSIONS = new Set(['.pdf', '.txt', '.xml', '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.mp4', '.mp3', '.zip', '.gz', '.css', '.js'])

function shouldSkipUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase()
    return SKIP_EXTENSIONS.has(pathname.slice(pathname.lastIndexOf('.')))
  } catch {
    return true
  }
}

function normalizePathForFilter(value: string): string | null {
  try {
    const parsed = new URL(value)
    return normalizeRoutePath(parsed.pathname)
  } catch {
    if (!value.trim()) return null
    return normalizeRoutePath(value)
  }
}

function normalizeRoutePath(routePath: string): string {
  if (!routePath || routePath === '/') return '/'
  const withoutTrailingSlash = routePath.replace(/\/+$/, '')
  return withoutTrailingSlash.startsWith('/') ? withoutTrailingSlash : `/${withoutTrailingSlash}`
}

function buildPathFilter(paths: string[] | undefined): Set<string> | null {
  if (!paths || paths.length === 0) return null
  const normalized = paths
    .map((path) => normalizePathForFilter(path))
    .filter((path): path is string => Boolean(path))
  return normalized.length ? new Set(normalized) : null
}

/**
 * Re-home a sitemap `<loc>` onto `targetOrigin`, preserving its path, query, and
 * fragment. Used by `--rewrite-sitemap-origin` so a sitemap that hardcodes the
 * canonical/prod domain can be crawled against the origin the user actually named
 * (a staging host, or a local dev server). Unparseable locs are returned
 * unchanged so they fall through to the normal skip/error handling.
 */
export function rewriteLocOrigin(loc: string, targetOrigin: string): string {
  try {
    const locUrl = new URL(loc)
    const rewritten = new URL(targetOrigin)
    rewritten.pathname = locUrl.pathname
    rewritten.search = locUrl.search
    rewritten.hash = locUrl.hash
    return rewritten.toString()
  } catch {
    return loc
  }
}

interface SitemapEntry {
  loc: string
  priority?: number
}

/**
 * Decode the five predefined XML entities plus numeric character references in a
 * `<loc>` value. Per the sitemaps.org spec (#escaping), a `&` inside a URL MUST be
 * written `&amp;`, so a spec-compliant `<loc>` with a multi-param query string
 * (`?type=pages&amp;page=1`) arrives entity-escaped. Without decoding, the fetcher
 * requests the literal `...&amp;...`, which the origin treats as a different
 * request — on a sitemap index every child fetch then fails and the audit returns
 * zero URLs (issue #50). `&amp;` is replaced LAST so `&amp;lt;` decodes to the
 * literal `&lt;`, not `<`. Out-of-range numeric refs are left untouched rather than
 * throwing, so a malformed sitemap never aborts the whole audit.
 */
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (match, dec) => codePointToChar(Number(dec), match))
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => codePointToChar(parseInt(hex, 16), match))
    .replace(/&amp;/g, '&')
}

function codePointToChar(codePoint: number, original: string): string {
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : original
}

function parseSitemapXml(xml: string): SitemapEntry[] {
  const entries: SitemapEntry[] = []

  // Extract <loc> elements and optional <priority> from <url> blocks
  const urlBlockRe = /<url\b[^>]*>([\s\S]*?)<\/url>/gi
  let urlMatch
  while ((urlMatch = urlBlockRe.exec(xml)) !== null) {
    const block = urlMatch[1]
    const locMatch = block.match(/<loc\b[^>]*>([\s\S]*?)<\/loc>/i)
    if (!locMatch) continue

    const loc = decodeXmlEntities(locMatch[1].trim())
    if (!loc) continue

    const priorityMatch = block.match(/<priority\b[^>]*>([\s\S]*?)<\/priority>/i)
    const priority = priorityMatch ? parseFloat(priorityMatch[1].trim()) : undefined

    entries.push({ loc, priority: Number.isFinite(priority) ? priority : undefined })
  }

  // Handle sitemap index files — extract nested sitemap URLs
  if (entries.length === 0) {
    const sitemapLocRe = /<sitemap\b[^>]*>[\s\S]*?<loc\b[^>]*>([\s\S]*?)<\/loc>[\s\S]*?<\/sitemap>/gi
    let sitemapMatch
    while ((sitemapMatch = sitemapLocRe.exec(xml)) !== null) {
      entries.push({ loc: decodeXmlEntities(sitemapMatch[1].trim()) })
    }
  }

  return entries
}

interface SitemapFetchResult {
  body: string
  status: number
}

interface SitemapFetchOptions {
  allowPrivateHost?: string
  signal?: AbortSignal
  onOutboundAttempt?: RunAeoAuditOptions['onOutboundAttempt']
  budget?: FetchBudgetController
  kind?: 'sitemap' | 'robots'
}

function normalizeSitemapFetchOptions(options?: string | SitemapFetchOptions): SitemapFetchOptions {
  if (typeof options === 'string') {
    return { allowPrivateHost: options }
  }

  return options ?? {}
}

/**
 * Fetch a sitemap / robots / child-`<loc>` URL through the SSRF guard.
 *
 * Sitemap mode fetches URLs the *target* controls — the discovery origin, a
 * `Sitemap:` directive, and (crucially) every child `<loc>` of a sitemap index, any
 * of which a malicious target can point at an internal host (cloud metadata at
 * 169.254.169.254, internal services). Routing through `fetchWithValidatedRedirects`
 * validates the host against the private-IP blocklist on EVERY hop and follows
 * redirects manually, so a public target that 302s to an internal host — or a child
 * `<loc>` pointing internally — is blocked before any internal request is made.
 *
 * `allowPrivateHost` (from `--allow-local`) names the single host permitted to resolve
 * privately; the match is host-only and per-hop, so a redirect or `<loc>` to any OTHER
 * private host stays blocked even when it is set.
 */
async function fetchSitemapResponse(url: string, fetchOptions?: string | SitemapFetchOptions): Promise<SitemapFetchResult> {
  const options = normalizeSitemapFetchOptions(fetchOptions)
  const { allowPrivateHost, signal, onOutboundAttempt, budget, kind = 'sitemap' } = options
  throwIfAborted(signal)

  let response: Response
  try {
    const result = await fetchWithValidatedRedirects(url, {
      timeoutMs: SITEMAP_TIMEOUT_MS,
      allowPrivateHost,
      signal,
      onOutboundAttempt,
      budget,
      outboundAttemptKind: kind,
    })
    response = result.response
  } catch (error) {
    if (isCallerAbort(error, signal) || isFetchBudgetExceededError(error)) throw error
    if (error instanceof AeoAuditError) throw error
    throw new AeoAuditError('UNREACHABLE', 'Could not fetch sitemap.', { cause: error })
  }

  if (!response.ok) {
    // Drain the body so the socket can be released.
    try {
      await response.body?.cancel()
    } catch {
      /* ignore */
    }
    return { body: '', status: response.status }
  }

  const reader = response.body?.getReader()
  if (!reader) return { body: '', status: response.status }

  const chunks: Buffer[] = []
  let totalBytes = 0
  try {
    for (;;) {
      throwIfAborted(signal)
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      totalBytes += chunk.length
      if (totalBytes > SITEMAP_MAX_BYTES) {
        await reader.cancel()
        throw new AeoAuditError('BODY_TOO_LARGE', `Sitemap exceeded ${SITEMAP_MAX_BYTES} bytes.`)
      }
      chunks.push(chunk)
    }
  } catch (error) {
    if (isCallerAbort(error, signal) || isFetchBudgetExceededError(error)) throw error
    if (error instanceof AeoAuditError) throw error
    throw new AeoAuditError('UNREACHABLE', 'Could not read sitemap response.', { cause: error })
  }

  return { body: Buffer.concat(chunks).toString('utf8'), status: response.status }
}

async function fetchSitemapBody(url: string, options?: string | SitemapFetchOptions): Promise<string> {
  const result = await fetchSitemapResponse(url, options)
  if (result.status < 200 || result.status >= 300) {
    throw new AeoAuditError('UNREACHABLE', `Sitemap returned HTTP ${result.status}.`)
  }
  return result.body
}

function looksLikeSitemap(body: string): boolean {
  const lower = body.slice(0, 4096).toLowerCase()
  return lower.includes('<urlset') || lower.includes('<sitemapindex')
}

/**
 * Issue #32: try the documented sitemap paths in order, then fall back to
 * Sitemap: directives in /robots.txt. Returns the first URL that 200s.
 */
export async function discoverSitemapUrl(origin: string, fetchOptions?: string | SitemapFetchOptions): Promise<string | null> {
  const options = normalizeSitemapFetchOptions(fetchOptions)
  const candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap-index.xml`]

  for (const candidate of candidates) {
    try {
      const result = await fetchSitemapResponse(candidate, { ...options, kind: 'sitemap' })
      // Require an actual sitemap marker — many SPAs serve the HTML shell for
      // unknown routes, returning 200 with `<!doctype html>` for /sitemap.xml.
      if (result.status >= 200 && result.status < 300 && looksLikeSitemap(result.body)) {
        return candidate
      }
    } catch (error) {
      if (isCallerAbort(error, options.signal) || isFetchBudgetExceededError(error)) throw error
      // Network/timeout errors fall through to the next candidate so we don't
      // give up on the whole discovery just because one path was flaky.
    }
  }

  // robots.txt fallback — many sites declare a non-standard sitemap location there.
  try {
    const robots = await fetchSitemapResponse(`${origin}/robots.txt`, { ...options, kind: 'robots' })
    if (robots.status >= 200 && robots.status < 300 && robots.body) {
      const sitemapDirective = parseRobotsSitemap(robots.body, origin)
      if (sitemapDirective) {
        return sitemapDirective
      }
    }
  } catch (error) {
    if (isCallerAbort(error, options.signal) || isFetchBudgetExceededError(error)) throw error
    /* ignore — discovery failure surfaces as null */
  }

  return null
}

export function parseRobotsSitemap(robotsBody: string, origin: string): string | null {
  let originUrl: URL
  try {
    originUrl = new URL(origin)
  } catch {
    return null
  }

  for (const rawLine of robotsBody.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    // robots.txt directives are case-insensitive per RFC.
    const match = line.match(/^sitemap\s*:\s*(\S+)\s*$/i)
    if (!match) continue
    try {
      const resolved = new URL(match[1], origin)
      // Only honor same-origin directives. The fetch layer now SSRF-validates every
      // hop, so a cross-origin directive at a private host is blocked regardless;
      // restricting to same-origin here is defense-in-depth plus scope control —
      // a target should not steer the auditor onto an unrelated public host either.
      if (resolved.origin !== originUrl.origin) continue
      return resolved.toString()
    } catch {
      // Malformed entry — keep scanning in case a later line is valid.
    }
  }
  return null
}

interface ResolvedSitemap {
  entries: SitemapEntry[]
  /** Child sitemaps dropped by the MAX_CHILD_SITEMAPS safety cap (0 when none). */
  childSitemapsSkipped: number
}

async function resolveSitemapUrls(sitemapUrl: string, fetchOptions?: string | SitemapFetchOptions): Promise<ResolvedSitemap> {
  const options = normalizeSitemapFetchOptions(fetchOptions)
  const body = await fetchSitemapBody(sitemapUrl, { ...options, kind: 'sitemap' })
  const entries = parseSitemapXml(body)

  // If it's a sitemap index, fetch child sitemaps. Each child <loc> is fully
  // target-controlled, so it goes through the same SSRF guard as every other fetch;
  // a child pointing at a private host is blocked and contributes no URLs.
  const isSitemapIndex = body.includes('<sitemapindex')
  if (isSitemapIndex) {
    // Cap the fan-out and fetch with bounded concurrency. Without this an index can
    // steer the runner into tens of thousands of simultaneous fetches (a DoS) and
    // accumulate millions of entries before the later --limit slice ever applies.
    const children = entries.slice(0, MAX_CHILD_SITEMAPS)
    const childSitemapsSkipped = entries.length - children.length
    const childResults = await mapWithConcurrency(children, DEFAULT_CONCURRENCY, async (entry) => {
      try {
        if (options.budget?.isExhausted()) {
          return []
        }

        const childBody = await fetchSitemapBody(entry.loc, { ...options, kind: 'sitemap' })
        return parseSitemapXml(childBody)
      } catch (error) {
        if (isCallerAbort(error, options.signal)) throw error
        if (isFetchBudgetExceededError(error)) return []
        return []
      }
    })
    return { entries: childResults.flat(), childSitemapsSkipped }
  }

  return { entries, childSitemapsSkipped: 0 }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workerCount = Math.max(1, Math.min(concurrency, items.length))
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const i = nextIndex++
        if (i >= items.length) return
        results[i] = await worker(items[i], i)
      }
    }),
  )
  return results
}

/**
 * Faults that only exist in the comparison between pages.
 *
 * An analyzer is handed one page and can never see a second, so nothing inside
 * the scoring layer can answer "do two pages say the same thing" or "does
 * anything link here". Both questions become answerable once the crawl is done,
 * and both are cheap: the data is already on every page result.
 */
export function buildSiteIssues(
  pages: SitemapPageResult[],
  truncated: number,
  filtered: number,
): SiteIssue[] {
  const issues: SiteIssue[] = []

  // Two pages describing themselves with the same sentence tell a reader, and a
  // model, that they are the same page. Exact match after trimming: a near-match
  // is an editorial judgement and this layer does not make those.
  const byDescription = new Map<string, string[]>()
  for (const page of pages) {
    const description = page.metadata?.metaDescription?.trim()
    if (!description) continue
    byDescription.set(description, [...(byDescription.get(description) ?? []), page.url])
  }
  for (const [description, urls] of byDescription) {
    if (urls.length < 2) continue
    issues.push({
      code: 'site.duplicate-meta-description',
      message: `${urls.length} pages share the same meta description word for word: "${description.slice(0, 120)}"`,
      affectedUrls: [...urls].sort(),
    })
  }

  // A page nothing links to can only be arrived at through the sitemap.
  //
  // ONLY WHEN THE CRAWL SAW THE WHOLE SITE. Inbound links from a page that was
  // never fetched are never observed, so on a site whose sitemap was truncated or
  // filtered this would report orphans on the strength of not having looked.
  // Silence is the honest answer there; a hedged "possible orphan" on an
  // automated to-do board is worse than none at all.
  if (truncated === 0 && filtered === 0 && pages.length >= MIN_PAGES_FOR_ORPHANS) {
    const linked = new Set<string>()
    for (const page of pages) {
      for (const href of page.metadata?.internalLinks ?? []) linked.add(normalizePageUrl(href))
    }
    const first = pages[0]
    const homepage = first === undefined ? '' : normalizePageUrl(new URL(first.url).origin)
    for (const page of pages) {
      const self = normalizePageUrl(page.url)
      // The homepage is arrived at directly; nothing linking to it is not a fault.
      if (self === homepage || linked.has(self)) continue
      issues.push({
        code: 'site.orphan-page',
        message: `Nothing on the site links to ${new URL(page.url).pathname}, so it can only be found through the sitemap.`,
        affectedUrls: [page.url],
      })
    }
  }
  return issues
}

/** Compare URLs the way a reader would: no fragment, no query, no trailing slash. */
function normalizePageUrl(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    u.search = ''
    return u.toString().replace(/\/$/, '') || u.origin
  } catch {
    return url
  }
}

/** Below this a link graph is too sparse for "nothing links here" to mean much. */
const MIN_PAGES_FOR_ORPHANS = 5

function buildCrossCuttingIssues(successPages: AuditReport[]): CrossCuttingIssue[] {
  if (successPages.length === 0) return []

  // Per factor: every (url, score) pair plus a recommendation→URLs map. The scored
  // pairs drive the average, the best-page surfacing, and the page-specific
  // presence classification; the map drives the per-issue breakdown.
  const factorScores = new Map<
    string,
    { name: string; scored: { url: string; score: number }[]; recommendations: Map<string, string[]> }
  >()

  for (const page of successPages) {
    for (const factor of page.factors) {
      let entry = factorScores.get(factor.id)
      if (!entry) {
        entry = { name: factor.name, scored: [], recommendations: new Map() }
        factorScores.set(factor.id, entry)
      }
      entry.scored.push({ url: page.finalUrl, score: factor.score })

      for (const rec of factor.recommendations) {
        const urls = entry.recommendations.get(rec)
        if (urls) {
          urls.push(page.finalUrl)
        } else {
          entry.recommendations.set(rec, [page.finalUrl])
        }
      }
    }
  }

  const issues: CrossCuttingIssue[] = []

  for (const [factorId, entry] of factorScores) {
    const scores = entry.scored.map((s) => s.score)
    const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
    const affectedPages = scores.filter((s) => s < 70).length

    if (affectedPages === 0 && entry.recommendations.size === 0) continue

    // Best single page for this factor. Homepage wins ties — it makes the most
    // recognizable "propagate this template to the rest" instruction — then lexical
    // for determinism under concurrent page ordering.
    const best = [...entry.scored].sort(
      (a, b) =>
        b.score - a.score ||
        Number(isHomepageUrl(b.url)) - Number(isHomepageUrl(a.url)) ||
        a.url.localeCompare(b.url),
    )[0]

    // Classify. Site-wide factors keep prevalence-based ranking. A page-specific
    // factor present somewhere (best clears the threshold) is a `limited` tune-up;
    // otherwise it is an `opportunity` (not yet present on any audited page).
    const pageSpecific = PAGE_SPECIFIC_FACTOR_IDS.has(factorId)
    const status: CrossCuttingStatus = !pageSpecific
      ? 'sitewide'
      : best.score >= PAGE_SPECIFIC_PRESENT_THRESHOLD
        ? 'limited'
        : 'opportunity'

    // Sort recommendations by how many URLs they affect (desc), then alphabetically for stability
    const sortedIssues = [...entry.recommendations.entries()]
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([recommendation, affectedUrls]) => ({ recommendation, affectedUrls }))

    issues.push({
      factorId,
      factorName: entry.name,
      avgScore,
      affectedPages,
      totalPages: successPages.length,
      topRecommendations: sortedIssues.slice(0, 3).map((i) => i.recommendation),
      topIssues: sortedIssues,
      pageSpecific,
      status,
      bestScore: best.score,
      bestPageUrl: best.url,
    })
  }

  // Genuine site-wide gaps first, ranked by prevalence then avg. Page-specific
  // factors sink below them: their near-total "affected" count is structural (a
  // product page correctly has no FAQ), so prevalence would otherwise float them to
  // the top and read as a site-wide failure. Among page-specific factors, present-
  // but-isolated (`limited`) leads not-yet-present (`opportunity`), then best score.
  issues.sort((a, b) => {
    if (a.pageSpecific !== b.pageSpecific) return a.pageSpecific ? 1 : -1
    if (a.pageSpecific) {
      const rank = (s: CrossCuttingStatus): number => (s === 'limited' ? 0 : 1)
      return rank(a.status) - rank(b.status) || b.bestScore - a.bestScore || a.factorName.localeCompare(b.factorName)
    }
    return b.affectedPages - a.affectedPages || a.avgScore - b.avgScore
  })

  return issues
}

function buildPrioritizedFixes(
  issues: CrossCuttingIssue[],
  totalPages: number,
  criticalDefects: CriticalDefectGroup[] = [],
  successPages: AuditReport[] = [],
): PrioritizedFix[] {
  const pct = (n: number): number => (totalPages > 0 ? Math.round((n / totalPages) * 100) : 0)
  const homepageFirst = (a: string, b: string): number =>
    Number(isHomepageUrl(b)) - Number(isHomepageUrl(a)) || a.localeCompare(b)

  // Per-factor page rows (url, score, recommendations) — consulted only for the
  // page-specific (`limited`/`opportunity`) rewrite below, to scope the fix to the
  // pages that actually carry the factor and to source its tune-up recommendation.
  const rowsByFactor = new Map<string, { url: string; score: number; recommendations: string[] }[]>()
  for (const page of successPages) {
    for (const factor of page.factors) {
      const rows = rowsByFactor.get(factor.id) ?? []
      rows.push({ url: page.finalUrl, score: factor.score, recommendations: factor.recommendations })
      rowsByFactor.set(factor.id, rows)
    }
  }

  // Lead with high-impact binary defects (issue #42). These are excluded from the
  // prevalence ranking below because they typically hit only one or two pages, but
  // they're unambiguous and one-line-fixable, so they belong at the top. Only
  // critical-severity defects are promoted; warnings (e.g. a missing meta
  // description) already flow into the prevalence ranking via factor recommendations.
  const criticalFixes: PrioritizedFix[] = criticalDefects
    .filter((group) => group.severity === 'critical')
    .map((group): PrioritizedFix => {
      const affectedPages = group.pages.map((p) => p.url)
      const affectsHomepage = group.pages.some((p) => p.isHomepage)
      const count = affectedPages.length
      return {
        kind: 'critical-defect',
        id: group.id,
        title: group.title,
        recommendation: group.recommendation,
        severity: group.severity,
        affectedPages,
        affectsHomepage,
        prevalencePct: pct(count),
        summary: `${group.title} (${group.severity}) — ${count} page${count === 1 ? '' : 's'}${affectsHomepage ? ', incl. homepage' : ''}: ${group.recommendation}`,
      }
    })

  // Report every cross-cutting issue, ordered by the rank from buildCrossCuttingIssues
  // (site-wide by prevalence, page-specific demoted) — not a top-N slice. A fix the
  // report computed must reach the report; truncating the tail silently drops real
  // issues a consumer reading only this section would never see.
  const crossCuttingFixes: PrioritizedFix[] = issues.map((issue): PrioritizedFix => {
    // Best-page context on every fix: "Schema is 100 on the homepage — propagate
    // that template to the 393 portfolio pages" beats a bare "add schema".
    const base = {
      kind: 'cross-cutting' as const,
      id: issue.factorId,
      title: issue.factorName,
      status: issue.status,
      bestScore: issue.bestScore,
      bestPageUrl: issue.bestPageUrl,
      avgScore: issue.avgScore,
    }

    if (issue.status === 'limited') {
      // Present but isolated. The fix is a tune-up where the factor already lives —
      // the pages that correctly lack it are not "affected". Scope to the present-
      // but-imperfect pages and source the recommendation from the strongest of them.
      const rows = rowsByFactor.get(issue.factorId) ?? []
      const presentImperfect = rows
        .filter((r) => r.score >= PAGE_SPECIFIC_PRESENT_THRESHOLD && r.score < 70)
        .sort((a, b) => b.score - a.score)
      const affectedPages = presentImperfect.map((r) => r.url).sort(homepageFirst)
      const presentCount = rows.filter((r) => r.score >= PAGE_SPECIFIC_PRESENT_THRESHOLD).length
      const where = presentCount === 1 ? '1 page' : `${presentCount} pages`
      const recommendation =
        presentImperfect.find((r) => r.recommendations.length > 0)?.recommendations[0] ??
        `${issue.factorName} is well-structured on ${issue.bestPageUrl} — extend it to other relevant pages where it fits.`
      return {
        ...base,
        recommendation,
        affectedPages,
        affectsHomepage: affectedPages.some(isHomepageUrl),
        prevalencePct: pct(affectedPages.length),
        summary: `${issue.factorName} (limited — present on ${where}, best ${issue.bestScore}/100 on ${issue.bestPageUrl}): ${recommendation}`,
      }
    }

    if (issue.status === 'opportunity') {
      // Page-specific and absent everywhere: a single optional suggestion, not a
      // per-page defect. No pages are "affected" — adding it is discretionary.
      const recommendation = issue.topRecommendations[0] ?? `Consider adding ${issue.factorName} where it fits.`
      return {
        ...base,
        recommendation,
        affectedPages: [],
        affectsHomepage: false,
        prevalencePct: 0,
        summary: `${issue.factorName} (optional — not present on any audited page): ${recommendation}`,
      }
    }

    // Site-wide: unchanged ranking, rec, and reach — now annotated with best-page.
    const top = issue.topIssues[0]
    const recommendation = issue.topRecommendations[0] ?? top?.recommendation ?? 'Review and improve this factor.'
    // Union every recommendation's pages — not just the top one's — so reach,
    // prevalence, and the homepage flag describe the whole factor, which is what
    // the entry is identified by (factorId / factorName). Sorted homepage-first.
    const affectedPages = [...new Set(issue.topIssues.flatMap((d) => d.affectedUrls))].sort(homepageFirst)
    const count = affectedPages.length
    return {
      ...base,
      recommendation,
      affectedPages,
      affectsHomepage: affectedPages.some(isHomepageUrl),
      prevalencePct: pct(count),
      summary: `${issue.factorName} (avg ${issue.avgScore}/100) — ${count} page${count === 1 ? '' : 's'}: ${recommendation}`,
    }
  })

  return [...criticalFixes, ...crossCuttingFixes]
}

function assertPositiveIntegerOption(name: string, value: number | undefined): void {
  if (value === undefined) return
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AeoAuditError('BAD_INPUT', `${name} must be a positive integer.`)
  }
}

function createFetchBudget(options: SitemapAuditOptions): FetchBudgetController | undefined {
  assertPositiveIntegerOption('maxFetches', options.maxFetches)
  assertPositiveIntegerOption('maxDurationMs', options.maxDurationMs)

  if (options.maxFetches === undefined && options.maxDurationMs === undefined) {
    return undefined
  }

  return new FetchBudgetController({
    maxFetches: options.maxFetches,
    maxDurationMs: options.maxDurationMs,
  })
}

function sitemapMetadata(
  budget: FetchBudgetController | undefined,
  pagesQueued: number,
  pagesCompleted: number,
): SitemapAuditMetadata {
  if (!budget) {
    return { partial: false }
  }

  const snapshot = budget.snapshot()
  const budgetMetadata: SitemapAuditBudgetMetadata = {
    maxFetches: snapshot.maxFetches,
    fetchesStarted: snapshot.fetchesStarted,
    maxDurationMs: snapshot.maxDurationMs,
    elapsedMs: snapshot.elapsedMs,
    pagesQueued,
    pagesCompleted,
    pagesRemaining: Math.max(0, pagesQueued - pagesCompleted),
    exhaustedReason: snapshot.exhaustedReason,
  }

  return {
    partial: snapshot.exhaustedReason !== undefined,
    budget: budgetMetadata,
  }
}

export async function runSitemapAudit(rawUrl: string, options: SitemapAuditOptions = {}): Promise<SitemapAuditReport> {
  throwIfAborted(options.signal)
  const budget = createFetchBudget(options)
  const normalizedUrl = normalizeTargetUrl(rawUrl)
  const origin = normalizedUrl.origin

  // Determine sitemap URL. When the user passes one explicitly we honor it
  // verbatim. Otherwise we try /sitemap.xml first, then /sitemap-index.xml,
  // then the Sitemap: directive in robots.txt (issue #32).
  let sitemapUrl: string
  if (options.sitemapUrl) {
    sitemapUrl = options.sitemapUrl
  } else {
    const discovered = await discoverSitemapUrl(origin, {
      allowPrivateHost: options.allowPrivateHost,
      signal: options.signal,
      onOutboundAttempt: options.onOutboundAttempt,
      budget,
    })
    if (!discovered) {
      throw new AeoAuditError(
        'UNREACHABLE',
        'No sitemap found. Tried /sitemap.xml, /sitemap-index.xml, and the Sitemap: directive in /robots.txt. Pass --sitemap <url> with an explicit URL if your sitemap lives elsewhere.',
      )
    }
    sitemapUrl = discovered
  }

  // Fetch and parse sitemap
  const { entries: resolvedEntries, childSitemapsSkipped } = await resolveSitemapUrls(sitemapUrl, {
    allowPrivateHost: options.allowPrivateHost,
    signal: options.signal,
    onOutboundAttempt: options.onOutboundAttempt,
    budget,
  })
  let allEntries = resolvedEntries

  // Opt-in origin rewriting (issue from field feedback): re-home every <loc> onto
  // the origin the user named so a sitemap hardcoding the prod/canonical domain can
  // be audited against a staging host or local dev server. Rewriting can collapse
  // http/https or www variants onto the same URL, so dedupe afterward.
  if (options.rewriteOrigin) {
    const seen = new Set<string>()
    allEntries = allEntries
      .map((e) => ({ ...e, loc: rewriteLocOrigin(e.loc, origin) }))
      .filter((e) => {
        if (seen.has(e.loc)) return false
        seen.add(e.loc)
        return true
      })
  }

  const discovered = allEntries.length

  // Filter to HTML content pages, then optionally to changed/critical paths.
  const pathFilter = buildPathFilter(options.includePaths)
  const eligible = allEntries.filter((e) => (
    !shouldSkipUrl(e.loc)
    && (!pathFilter || pathFilter.has(normalizePathForFilter(e.loc) || ''))
  ))
  const filtered = discovered - eligible.length

  // Sort by priority (highest first) if priorities exist
  eligible.sort((a, b) => (b.priority ?? 0.5) - (a.priority ?? 0.5))

  // Apply limit (default 200 when not specified — large sitemaps are common and
  // a full sweep is rarely what the user wants).
  const effectiveLimit = options.limit && options.limit > 0 ? options.limit : DEFAULT_LIMIT
  const entries = eligible.slice(0, effectiveLimit)
  const truncated = eligible.length - entries.length

  if (entries.length === 0) {
    if (budget?.exhaustedReason) {
      return {
        schemaVersion: SCHEMA_VERSION,
        compareMeta: {
          engineVersion: engineVersion(),
          factorIds: [],
        },
        sitemapUrl,
        auditedAt: new Date().toISOString(),
        pagesDiscovered: discovered,
        pagesAudited: 0,
        pagesSkipped: filtered + truncated,
        pagesFiltered: filtered,
        pagesTruncated: truncated,
        effectiveLimit,
        aggregateScore: 0,
        pages: [],
        criticalDefects: [],
        crossCuttingIssues: [],
        siteIssues: [],
        prioritizedFixes: [],
        metadata: sitemapMetadata(budget, 0, 0),
      }
    }

    throw new AeoAuditError(
      'BAD_INPUT',
      pathFilter
        ? 'No auditable URLs found in sitemap after applying the changed-page path filter.'
        : 'No auditable URLs found in sitemap.',
    )
  }

  options.onPlan?.({
    discovered,
    filtered,
    truncated,
    willAudit: entries.length,
    effectiveLimit,
    childSitemapsSkipped,
  })

  // Forward the in-process optional factors so opt-in flags behave the same as in
  // single-URL mode. includeLighthouse is deliberately NOT forwarded: each
  // PageSpeed Insights call takes 15-30s, so running it across a sitemap would be
  // pathological — the CLI rejects --lighthouse + --sitemap for the same reason.
  const auditOptions: RunAeoAuditOptions & { budget?: FetchBudgetController } = {
    factors: options.factors,
    includeGeo: options.includeGeo,
    includeAgentSkills: options.includeAgentSkills,
    signal: options.signal,
    onOutboundAttempt: options.onOutboundAttempt,
    // Forward the target-scoped private-host allowance so `--allow-local` reaches
    // per-page fetches. It only ever matches the single host the user named, so a
    // <loc> on any other private host stays blocked even with this set. With
    // --rewrite-sitemap-origin, every <loc> is on that named host, so a local dev
    // server's whole sitemap becomes auditable.
    allowPrivateHost: options.allowPrivateHost,
    budget,
  }

  // Audit pages with bounded concurrency: 5 workers is a polite ceiling for one
  // origin while giving a meaningful speedup over fully sequential.
  const settled = new Array<{ pageResult: SitemapPageResult; report: AuditReport | null } | undefined>(entries.length)
  let nextIndex = 0
  const workerCount = Math.max(1, Math.min(DEFAULT_CONCURRENCY, entries.length))
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        throwIfAborted(options.signal)
        if (budget?.isExhausted()) return

        const i = nextIndex++
        if (i >= entries.length) return
        const entry = entries[i]

        try {
          const report = await runAeoAudit(entry.loc, auditOptions)
          settled[i] = {
            pageResult: {
              url: report.finalUrl,
              overallScore: report.overallScore,
              status: 'success',
              factors: report.factors,
              metadata: report.metadata,
              priority: entry.priority,
            },
            report,
          }
        } catch (error) {
          if (isCallerAbort(error, options.signal)) throw error
          if (isFetchBudgetExceededError(error)) return

          const message = error instanceof Error ? error.message : String(error)
          settled[i] = {
            pageResult: {
              url: entry.loc,
              overallScore: 0,
              status: 'error',
              error: message,
              priority: entry.priority,
            },
            report: null,
          }
        }
      }
    }),
  )

  const completed = settled.filter((s): s is { pageResult: SitemapPageResult; report: AuditReport | null } => Boolean(s))
  const pageResults: SitemapPageResult[] = completed.map((s) => s.pageResult)
  const successReports: AuditReport[] = settled
    .map((s) => s?.report)
    .filter((r): r is AuditReport => Boolean(r))

  // Calculate aggregate score from successful audits
  const successScores = pageResults.filter((p) => p.status === 'success').map((p) => p.overallScore)
  const aggregateScore = successScores.length > 0
    ? Math.round(successScores.reduce((a, b) => a + b, 0) / successScores.length)
    : 0

  // Map each successful page's final URL to its sitemap priority so the critical
  // defect rollup can rank affected pages by importance (issue #42).
  const priorityByUrl = new Map<string, number | undefined>()
  for (const page of pageResults) {
    if (page.status === 'success') priorityByUrl.set(page.url, page.priority)
  }

  const criticalDefects = buildCriticalDefects(successReports, priorityByUrl)
  const crossCuttingIssues = buildCrossCuttingIssues(successReports)
  const siteIssues = buildSiteIssues(pageResults, truncated, filtered)
  const prioritizedFixes = buildPrioritizedFixes(crossCuttingIssues, successReports.length, criticalDefects, successReports)

  return {
    schemaVersion: SCHEMA_VERSION,
    compareMeta: {
      engineVersion: engineVersion(),
      factorIds: unionFactorIds(successReports),
    },
    sitemapUrl,
    auditedAt: new Date().toISOString(),
    pagesDiscovered: discovered,
    pagesAudited: pageResults.length,
    pagesSkipped: filtered + truncated + Math.max(0, entries.length - pageResults.length),
    pagesFiltered: filtered,
    pagesTruncated: truncated,
    effectiveLimit,
    aggregateScore,
    pages: pageResults,
    criticalDefects,
    crossCuttingIssues,
    siteIssues,
    prioritizedFixes,
    metadata: sitemapMetadata(budget, entries.length, pageResults.length),
  }
}

/**
 * Sorted union of factor ids across the successfully-audited pages. Embedded in a
 * multi-page report's `compareMeta` so `compare` can detect when a baseline and a
 * current run used a different factor set (`--factors`/`--include-*`), which makes
 * their weight-renormalized scores incomparable.
 */
export function unionFactorIds(successReports: AuditReport[]): string[] {
  const ids = new Set<string>()
  for (const report of successReports) {
    for (const factor of report.factors) ids.add(factor.id)
  }
  return [...ids].sort()
}

export {
  buildCrossCuttingIssues,
  buildPrioritizedFixes,
  mapWithConcurrency,
  parseSitemapXml,
  shouldSkipUrl,
}

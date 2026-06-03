import { AeoAuditError } from './errors.js'
import { buildCriticalDefects, isHomepageUrl } from './critical-defects.js'
import { normalizeTargetUrl } from './fetch-page.js'
import { runAeoAudit } from './index.js'
import { SCHEMA_VERSION } from './schema.js'
import { scoreToGrade } from './scoring.js'
import type {
  AuditReport,
  CriticalDefectGroup,
  CrossCuttingIssue,
  PrioritizedFix,
  RunAeoAuditOptions,
  SitemapAuditOptions,
  SitemapAuditReport,
  SitemapPageResult,
} from './types.js'

const USER_AGENT = 'AINYC-AEO-Audit/1.0'
const SITEMAP_TIMEOUT_MS = 10_000
const SITEMAP_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_LIMIT = 200
const DEFAULT_CONCURRENCY = 5

const SKIP_EXTENSIONS = new Set(['.pdf', '.txt', '.xml', '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.mp4', '.mp3', '.zip', '.gz', '.css', '.js'])

function shouldSkipUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase()
    return SKIP_EXTENSIONS.has(pathname.slice(pathname.lastIndexOf('.')))
  } catch {
    return true
  }
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

function parseSitemapXml(xml: string): SitemapEntry[] {
  const entries: SitemapEntry[] = []

  // Extract <loc> elements and optional <priority> from <url> blocks
  const urlBlockRe = /<url\b[^>]*>([\s\S]*?)<\/url>/gi
  let urlMatch
  while ((urlMatch = urlBlockRe.exec(xml)) !== null) {
    const block = urlMatch[1]
    const locMatch = block.match(/<loc\b[^>]*>([\s\S]*?)<\/loc>/i)
    if (!locMatch) continue

    const loc = locMatch[1].trim()
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
      entries.push({ loc: sitemapMatch[1].trim() })
    }
  }

  return entries
}

interface SitemapFetchResult {
  body: string
  status: number
}

async function fetchSitemapResponse(url: string): Promise<SitemapFetchResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SITEMAP_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
    })

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

    for (;;) {
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

    return { body: Buffer.concat(chunks).toString('utf8'), status: response.status }
  } catch (error) {
    if (error instanceof AeoAuditError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AeoAuditError('TIMEOUT', `Sitemap fetch timed out after ${SITEMAP_TIMEOUT_MS}ms.`)
    }
    throw new AeoAuditError('UNREACHABLE', 'Could not fetch sitemap.', { cause: error })
  } finally {
    clearTimeout(timer)
  }
}

async function fetchSitemapBody(url: string): Promise<string> {
  const result = await fetchSitemapResponse(url)
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
export async function discoverSitemapUrl(origin: string): Promise<string | null> {
  const candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap-index.xml`]

  for (const candidate of candidates) {
    try {
      const result = await fetchSitemapResponse(candidate)
      // Require an actual sitemap marker — many SPAs serve the HTML shell for
      // unknown routes, returning 200 with `<!doctype html>` for /sitemap.xml.
      if (result.status >= 200 && result.status < 300 && looksLikeSitemap(result.body)) {
        return candidate
      }
    } catch {
      // Network/timeout errors fall through to the next candidate so we don't
      // give up on the whole discovery just because one path was flaky.
    }
  }

  // robots.txt fallback — many sites declare a non-standard sitemap location there.
  try {
    const robots = await fetchSitemapResponse(`${origin}/robots.txt`)
    if (robots.status >= 200 && robots.status < 300 && robots.body) {
      const sitemapDirective = parseRobotsSitemap(robots.body, origin)
      if (sitemapDirective) {
        return sitemapDirective
      }
    }
  } catch {
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
      // Only honor same-origin directives. fetchSitemapBody has no SSRF guard,
      // so accepting an absolute URL at an arbitrary host would let a target
      // steer requests from the auditing host to internal endpoints.
      if (resolved.origin !== originUrl.origin) continue
      return resolved.toString()
    } catch {
      // Malformed entry — keep scanning in case a later line is valid.
    }
  }
  return null
}

async function resolveSitemapUrls(sitemapUrl: string): Promise<SitemapEntry[]> {
  const body = await fetchSitemapBody(sitemapUrl)
  const entries = parseSitemapXml(body)

  // If it's a sitemap index, fetch child sitemaps
  const isSitemapIndex = body.includes('<sitemapindex')
  if (isSitemapIndex) {
    const childResults = await Promise.all(
      entries.map(async (entry) => {
        try {
          const childBody = await fetchSitemapBody(entry.loc)
          return parseSitemapXml(childBody)
        } catch {
          return []
        }
      }),
    )
    return childResults.flat()
  }

  return entries
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

function buildCrossCuttingIssues(successPages: AuditReport[]): CrossCuttingIssue[] {
  if (successPages.length === 0) return []

  // Collect scores per factor across all pages. For each recommendation, track the URLs that produced it.
  const factorScores = new Map<
    string,
    { name: string; scores: number[]; recommendations: Map<string, string[]> }
  >()

  for (const page of successPages) {
    for (const factor of page.factors) {
      let entry = factorScores.get(factor.id)
      if (!entry) {
        entry = { name: factor.name, scores: [], recommendations: new Map() }
        factorScores.set(factor.id, entry)
      }
      entry.scores.push(factor.score)

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
    const avgScore = Math.round(entry.scores.reduce((a, b) => a + b, 0) / entry.scores.length)
    const affectedPages = entry.scores.filter((s) => s < 70).length

    if (affectedPages === 0 && entry.recommendations.size === 0) continue

    // Sort recommendations by how many URLs they affect (desc), then alphabetically for stability
    const sortedIssues = [...entry.recommendations.entries()]
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([recommendation, affectedUrls]) => ({ recommendation, affectedUrls }))

    issues.push({
      factorId,
      factorName: entry.name,
      avgScore,
      avgGrade: scoreToGrade(avgScore),
      affectedPages,
      totalPages: successPages.length,
      topRecommendations: sortedIssues.slice(0, 3).map((i) => i.recommendation),
      topIssues: sortedIssues,
    })
  }

  // Sort by impact: most affected pages first, then lowest avg score
  issues.sort((a, b) => b.affectedPages - a.affectedPages || a.avgScore - b.avgScore)

  return issues
}

function buildPrioritizedFixes(
  issues: CrossCuttingIssue[],
  totalPages: number,
  criticalDefects: CriticalDefectGroup[] = [],
): PrioritizedFix[] {
  const pct = (n: number): number => (totalPages > 0 ? Math.round((n / totalPages) * 100) : 0)

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

  // Report every cross-cutting issue, ordered by prevalence — not a top-N slice.
  // A fix the report computed must reach the report; truncating the tail silently
  // drops real issues a consumer reading only this section would never see.
  const crossCuttingFixes: PrioritizedFix[] = issues.map((issue): PrioritizedFix => {
    const top = issue.topIssues[0]
    const recommendation = issue.topRecommendations[0] ?? top?.recommendation ?? 'Review and improve this factor.'
    // Union every recommendation's pages — not just the top one's — so reach,
    // prevalence, and the homepage flag describe the whole factor, which is what
    // the entry is identified by (factorId / factorName). Sorted homepage-first.
    const affectedPages = [...new Set(issue.topIssues.flatMap((d) => d.affectedUrls))].sort(
      (a, b) => Number(isHomepageUrl(b)) - Number(isHomepageUrl(a)) || a.localeCompare(b),
    )
    const affectsHomepage = affectedPages.some(isHomepageUrl)
    const count = affectedPages.length
    return {
      kind: 'cross-cutting',
      id: issue.factorId,
      title: issue.factorName,
      recommendation,
      affectedPages,
      affectsHomepage,
      prevalencePct: pct(count),
      avgGrade: issue.avgGrade,
      summary: `${issue.factorName} (avg ${issue.avgGrade}) — ${count} page${count === 1 ? '' : 's'}: ${recommendation}`,
    }
  })

  return [...criticalFixes, ...crossCuttingFixes]
}

export async function runSitemapAudit(rawUrl: string, options: SitemapAuditOptions = {}): Promise<SitemapAuditReport> {
  const normalizedUrl = normalizeTargetUrl(rawUrl)
  const origin = normalizedUrl.origin

  // Determine sitemap URL. When the user passes one explicitly we honor it
  // verbatim. Otherwise we try /sitemap.xml first, then /sitemap-index.xml,
  // then the Sitemap: directive in robots.txt (issue #32).
  let sitemapUrl: string
  if (options.sitemapUrl) {
    sitemapUrl = options.sitemapUrl
  } else {
    const discovered = await discoverSitemapUrl(origin)
    if (!discovered) {
      throw new AeoAuditError(
        'UNREACHABLE',
        'No sitemap found. Tried /sitemap.xml, /sitemap-index.xml, and the Sitemap: directive in /robots.txt. Pass --sitemap <url> with an explicit URL if your sitemap lives elsewhere.',
      )
    }
    sitemapUrl = discovered
  }

  // Fetch and parse sitemap
  let allEntries = await resolveSitemapUrls(sitemapUrl)

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

  // Filter to HTML content pages
  const eligible = allEntries.filter((e) => !shouldSkipUrl(e.loc))
  const filtered = discovered - eligible.length

  // Sort by priority (highest first) if priorities exist
  eligible.sort((a, b) => (b.priority ?? 0.5) - (a.priority ?? 0.5))

  // Apply limit (default 200 when not specified — large sitemaps are common and
  // a full sweep is rarely what the user wants).
  const effectiveLimit = options.limit && options.limit > 0 ? options.limit : DEFAULT_LIMIT
  const entries = eligible.slice(0, effectiveLimit)
  const truncated = eligible.length - entries.length

  if (entries.length === 0) {
    throw new AeoAuditError('BAD_INPUT', 'No auditable URLs found in sitemap.')
  }

  options.onPlan?.({
    discovered,
    filtered,
    truncated,
    willAudit: entries.length,
    effectiveLimit,
  })

  // Forward the in-process optional factors so opt-in flags behave the same as in
  // single-URL mode. includeLighthouse is deliberately NOT forwarded: each
  // PageSpeed Insights call takes 15-30s, so running it across a sitemap would be
  // pathological — the CLI rejects --lighthouse + --sitemap for the same reason.
  const auditOptions: RunAeoAuditOptions = {
    factors: options.factors,
    includeGeo: options.includeGeo,
    includeAgentSkills: options.includeAgentSkills,
    // Forward the target-scoped private-host allowance so `--allow-local` reaches
    // per-page fetches. It only ever matches the single host the user named, so a
    // <loc> on any other private host stays blocked even with this set. With
    // --rewrite-sitemap-origin, every <loc> is on that named host, so a local dev
    // server's whole sitemap becomes auditable.
    allowPrivateHost: options.allowPrivateHost,
  }

  // Audit pages with bounded concurrency: 5 workers is a polite ceiling for one
  // origin while giving a meaningful speedup over fully sequential.
  const settled = await mapWithConcurrency(
    entries,
    DEFAULT_CONCURRENCY,
    async (entry): Promise<{ pageResult: SitemapPageResult; report: AuditReport | null }> => {
      try {
        const report = await runAeoAudit(entry.loc, auditOptions)
        return {
          pageResult: {
            url: report.finalUrl,
            overallScore: report.overallScore,
            overallGrade: report.overallGrade,
            status: 'success',
            factors: report.factors,
            metadata: report.metadata,
            priority: entry.priority,
          },
          report,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          pageResult: {
            url: entry.loc,
            overallScore: 0,
            overallGrade: 'F',
            status: 'error',
            error: message,
            priority: entry.priority,
          },
          report: null,
        }
      }
    },
  )

  const pageResults: SitemapPageResult[] = settled.map((s) => s.pageResult)
  const successReports: AuditReport[] = settled
    .map((s) => s.report)
    .filter((r): r is AuditReport => r !== null)

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
  const prioritizedFixes = buildPrioritizedFixes(crossCuttingIssues, successReports.length, criticalDefects)

  return {
    schemaVersion: SCHEMA_VERSION,
    sitemapUrl,
    auditedAt: new Date().toISOString(),
    pagesDiscovered: discovered,
    pagesAudited: entries.length,
    pagesSkipped: filtered + truncated,
    pagesFiltered: filtered,
    pagesTruncated: truncated,
    effectiveLimit,
    aggregateScore,
    aggregateGrade: scoreToGrade(aggregateScore),
    pages: pageResults,
    criticalDefects,
    crossCuttingIssues,
    prioritizedFixes,
  }
}

export {
  buildCrossCuttingIssues,
  buildPrioritizedFixes,
  mapWithConcurrency,
  parseSitemapXml,
  shouldSkipUrl,
}

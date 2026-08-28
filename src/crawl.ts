import { createHash } from 'node:crypto'
import { load } from 'cheerio'
import { AeoAuditError, getAeoAuditErrorCode, isAeoAuditError } from './errors.js'
import { fetchWithValidatedRedirects, isCallerAbort, isHtmlResponse, normalizeTargetUrl, readResponseBodyAsText, throwIfAborted } from './fetch-page.js'
import { assertValidFactorIds, auditHtmlPage } from './audit-html.js'
import { RequestPacer } from './request-pacer.js'
import { engineVersion } from './schema.js'
import { deepFreeze } from './immutable.js'
import { parseSitemapXmlDocument } from './sitemap-xml.js'
import type { FetchBudget } from './fetch-page.js'
import type {
  CrawlAnchorSummary,
  CrawlDeadLinkFinding,
  CrawlDeadLinkResult,
  CrawlDiscoveryProvenance,
  CrawlEdgeClassification,
  CrawlEdgeObservation,
  CrawlEdgeType,
  CrawlEvent,
  CrawlIndexabilityState,
  CrawlLinkPlacement,
  CrawlPageMetrics,
  CrawlPageObservation,
  CrawlPlacementOccurrences,
  CrawlProgress,
  CrawlSummary,
  CrawlTerminationReason,
  CrawlUnverifiedLinkFinding,
  CrawlUnverifiedReason,
  CrawlWarning,
  FullSiteCrawlReport,
  RedirectHop,
  AuxiliaryResource,
  AuxiliaryResources,
  SiteCrawlLimits,
  SiteCrawlOptions,
  SiteCrawlReport,
} from './types.js'
import {
  CRAWL_ENGINE_VERSION,
  CRAWL_INDEXABILITY_RULESET_VERSION,
  CRAWL_LINK_PLACEMENT_RULESET_VERSION,
  CRAWL_LINK_SCORE_ALGORITHM_VERSION,
  CRAWL_SCHEMA_VERSION,
  CRAWL_URL_NORMALIZATION_VERSION,
  DEFAULT_SITE_CRAWL_LIMITS,
} from './types.js'

const CRAWL_FETCH_TIMEOUT_MS = 10_000
const FETCH_RETRY_BASE_DELAY_MS = 500
/** Longest we will honour a `Retry-After` for; the crawl deadline still clips it. */
const MAX_RETRY_AFTER_MS = 10_000
/**
 * "Too Many Requests" is the server describing OUR request rate, not the
 * resource. It is the one 4xx that is never evidence about the link.
 */
const RATE_LIMITED_STATUS = 429
const MAX_ANCHOR_SUMMARIES = 5
const TRACKING_PARAM = /^(?:utm_[^=]*|gclid|dclid|fbclid|msclkid|_ga(?:_.+)?|mc_[ce]id)$/i

interface FrontierItem {
  url: string
  depth: number
}

interface CrawlFetchResult {
  requestedUrl: string
  finalUrl: string
  response: Response
  redirectChain: RedirectHop[]
  headers: Record<string, string>
  body: string
  contentType: string
  responseDeadlineAt: number
}

interface RobotsRules {
  rules: Array<{ allow: boolean; value: string }>
  sitemaps: string[]
  crawlDelayMs: number | null
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function keyFor(prefix: string, value: string): string {
  return `${prefix}:${hash(value).slice(0, 24)}`
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}

/** Exclude wall-clock fields so a replayed logical batch keeps its checksum. */
function stableCheckpointValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableCheckpointValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !['auditedAt', 'startedAt', 'completedAt', 'elapsedMs', 'fetchTimeMs'].includes(key))
      .map(([key, child]) => [key, stableCheckpointValue(child)]))
  }
  return value
}

function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function hostBoundary(url: URL): string {
  return url.host.toLowerCase().replace(/\.$/, '')
}

/**
 * Canonical crawl identity. It intentionally preserves scheme, path case,
 * trailing slashes and non-tracking query variants because those can route to
 * materially different pages.
 */
export function normalizeCrawlUrl(rawUrl: string, baseUrl?: string): string {
  const parsed = baseUrl ? new URL(rawUrl, baseUrl) : normalizeTargetUrl(rawUrl)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`Unsupported crawl URL protocol: ${parsed.protocol}`)
  }
  parsed.hash = ''

  const kept: Array<[string, string]> = []
  for (const [key, value] of parsed.searchParams.entries()) {
    if (!TRACKING_PARAM.test(key)) kept.push([key, value])
  }
  kept.sort(([leftKey, leftValue], [rightKey, rightValue]) => (
    leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey)
  ))
  parsed.search = ''
  for (const [key, value] of kept) parsed.searchParams.append(key, value)
  return parsed.toString()
}

/**
 * Bytes of decompressed HTML to allow per page when scaling an unset byte
 * budget. Deliberately generous: media-heavy marketing sites routinely serve
 * ~750 KB, and the cost of over-provisioning is nothing (the budget is a
 * ceiling, not an allocation) while the cost of under-provisioning is a
 * silently truncated crawl.
 */
const SCALED_BYTES_PER_PAGE = 1_500_000
/**
 * Requests a single page can cost before retries: the page itself, plus the one
 * a site that redirects `/p` to `/p/` spends before the body is read.
 *
 * The retry multiplier is NOT folded in here, because `maxFetchRetries` is a
 * caller knob: at the default 2 a page can cost 6 requests, and a flat constant
 * chosen for one retry setting silently under-budgets every larger one. At 1.5
 * fetches per page a 10,000-page request derived 15,000 where ~24,400 were
 * needed, so the crawl stopped at ~74% and blamed a budget the caller never set:
 * the same defect this scaling exists to remove, moved from bytes to fetches.
 */
const SCALED_REQUESTS_PER_PAGE = 2
/** Pages per second at the default concurrency, halved for slow origins. */
const SCALED_PAGES_PER_SECOND = 2.5

/**
 * Internal-link edges to allow per page when scaling an unset edge budget.
 * Measured on a production property-portfolio site: 41.8 recorded edges per
 * page, dominated by navigation and footer templates that repeat on every
 * page. 50 gives honest headroom; the flat default stays the floor, so a
 * small crawl keeps the budget it always had.
 */
const SCALED_EDGES_PER_PAGE = 50

/**
 * Ceilings every resolved budget is clamped to.
 *
 * `setTimeout` truncates a delay past 2^31-1 ms and fires it immediately, so a
 * duration budget above that would not be a long budget, it would be no budget
 * at all. The count ceiling keeps arithmetic exact and the report serialisable:
 * `maxPages: Number.MAX_VALUE` used to derive `Infinity` for all three fetch-side
 * budgets, which `JSON.stringify` writes as `null`, so a report could state that
 * a crawl ran under no byte budget whatsoever.
 */
const MAX_DURATION_MS = 2_147_483_647
const MAX_COUNT = Number.MAX_SAFE_INTEGER

/**
 * Resolve the budgets a crawl will actually run under.
 *
 * Exported because the limits are DERIVED, not the options passed in: a caller
 * that needs to know what it is about to spend (or to report which budget
 * stopped a run) has to be able to ask, rather than recompute the derivation
 * and drift from it.
 */
export function resolveSiteCrawlLimits(options: SiteCrawlOptions): SiteCrawlLimits {
  const integer = (value: number | undefined, fallback: number, minimum = 1, cap = MAX_COUNT): number => (
    // Math.min last so a non-finite or absurd input lands on the ceiling rather
    // than propagating Infinity into the report.
    Number.isFinite(value) ? Math.min(cap, Math.max(minimum, Math.floor(value!))) : fallback
  )
  const maxPages = integer(options.maxPages, DEFAULT_SITE_CRAWL_LIMITS.maxPages)
  // Both feed the derivation below, so they have to resolve before it runs.
  const requestDelayMs = integer(options.requestDelayMs, DEFAULT_SITE_CRAWL_LIMITS.requestDelayMs, 0)
  const maxFetchRetries = integer(options.maxFetchRetries, DEFAULT_SITE_CRAWL_LIMITS.maxFetchRetries, 0)

  /**
   * A caller who asks for N pages should get N pages.
   *
   * Every limit used to resolve independently against a flat default, so
   * `maxPages` and `maxBytes` were set by different people with no relationship
   * between them and the smaller silently won. Asking for 1,000 pages of a site
   * serving ~745 KB each returned 140, because the 100 MB byte default ran out
   * first, with no error, no warning, and a `partial` flag that named the
   * wrong budget.
   *
   * So the fetch-side budgets now SCALE to the page budget when the caller has
   * not set them. A caller who sets a budget explicitly still gets exactly what
   * they set: this raises unset ceilings, it never lowers a stated one, and the
   * flat defaults are the floor rather than the answer.
   *
   * The scaling keys off the RESOLVED page count, not off whether the caller
   * spelled `maxPages` out. Keying off presence made the default path the one
   * case the fix did not reach: `runSiteCrawl(url)` resolves to the documented
   * 1,000 pages but kept the flat 100 MB, so it still returned ~140 pages of a
   * media-heavy site, while `runSiteCrawl(url, {maxPages: 1_000})` — the same
   * request, written out — got a 1.5 GB ceiling. Identical work, budgets 14x
   * apart, decided by whether a key was present.
   */
  const scaled = (explicit: number | undefined, derived: number, flat: number, cap = MAX_COUNT): number => (
    Number.isFinite(explicit)
      ? Math.min(cap, Math.max(1, Math.floor(explicit!)))
      : Math.min(cap, Math.max(flat, Math.ceil(derived)))
  )

  return {
    maxPages,
    maxEdges: scaled(
      options.maxEdges,
      // Left flat in 7.0.0 while the other fetch-side budgets learned to
      // scale, which recreated the original defect one budget over: a
      // 5,000-page request stopped admitting pages near 2,400 when the
      // 100,000-edge default ran out at ~42 template edges per page.
      maxPages * SCALED_EDGES_PER_PAGE,
      DEFAULT_SITE_CRAWL_LIMITS.maxEdges,
    ),
    maxFetches: scaled(
      options.maxFetches,
      // A retry is a real request against this budget, so the ceiling has to
      // cover the worst case the caller's own retry setting allows.
      maxPages * SCALED_REQUESTS_PER_PAGE * (1 + maxFetchRetries),
      DEFAULT_SITE_CRAWL_LIMITS.maxFetches,
    ),
    maxDurationMs: scaled(
      options.maxDurationMs,
      // Pacing is time the crawl is required to spend NOT fetching. Ignoring it
      // budgeted 5,000 politely-paced pages 2,000s for work that cannot finish
      // in under 5,000s, so the politeness knob caused the truncation.
      maxPages * (1_000 / SCALED_PAGES_PER_SECOND + requestDelayMs),
      DEFAULT_SITE_CRAWL_LIMITS.maxDurationMs,
      MAX_DURATION_MS,
    ),
    maxBytes: scaled(
      options.maxBytes,
      maxPages * SCALED_BYTES_PER_PAGE,
      DEFAULT_SITE_CRAWL_LIMITS.maxBytes,
    ),
    maxPageBytes: integer(options.maxPageBytes, DEFAULT_SITE_CRAWL_LIMITS.maxPageBytes),
    maxDepth: integer(options.maxDepth, DEFAULT_SITE_CRAWL_LIMITS.maxDepth, 0),
    maxLinksPerPage: integer(options.maxLinksPerPage, DEFAULT_SITE_CRAWL_LIMITS.maxLinksPerPage),
    maxQueryVariants: integer(options.maxQueryVariants, DEFAULT_SITE_CRAWL_LIMITS.maxQueryVariants),
    maxSitemapFanout: integer(options.maxSitemapFanout, DEFAULT_SITE_CRAWL_LIMITS.maxSitemapFanout),
    maxSitemapUrls: integer(options.maxSitemapUrls, DEFAULT_SITE_CRAWL_LIMITS.maxSitemapUrls),
    concurrency: integer(options.concurrency, DEFAULT_SITE_CRAWL_LIMITS.concurrency),
    requestDelayMs,
    maxFetchRetries,
  }
}

class CrawlBudget implements FetchBudget {
  readonly startedAt = Date.now()
  fetchesStarted = 0
  bytesRead = 0

  /**
   * Hard and soft stops are latched SEPARATELY, and a hard one always wins.
   *
   * They answer different questions. A soft stop means "stop admitting URLs":
   * the frontier is full, the depth is reached, this many query variants is
   * enough. A hard stop means "stop fetching, now": the bytes, the clock or
   * the fetch count is spent.
   *
   * Sharing one first-write-wins field conflated them, and the failure was not
   * cosmetic. Seeding a large sitemap latches a soft `max-query-variants`
   * early; when the byte budget is later exhausted the hard stop is discarded,
   * `isHardFetchStop()` reads the soft reason and answers false, and
   * `drainFrontier()` keeps issuing real requests at the audited site and
   * throwing every response away until the duration cap ends the run.
   *
   * That means the crawler was at its LEAST polite toward the site being
   * audited exactly when it had already given up on collecting anything, and
   * the run then reported the soft reason, sending anyone diagnosing it to the
   * wrong budget entirely.
   */
  private hardStop: CrawlTerminationReason | null = null
  private softStop: CrawlTerminationReason | null = null

  constructor(readonly limits: SiteCrawlLimits) {}

  /** The reason to report: a hard stop if one occurred, else the soft one. */
  get terminationReason(): CrawlTerminationReason | null {
    return this.hardStop ?? this.softStop
  }

  /** Milliseconds left on the crawl's own deadline; negative once it is spent. */
  remainingMs(): number {
    return this.limits.maxDurationMs - (Date.now() - this.startedAt)
  }

  assertWithinDuration(): void {
    if (Date.now() - this.startedAt >= this.limits.maxDurationMs) {
      throw this.durationExceededError()
    }
  }

  durationExceededError(): AeoAuditError {
    this.stop('max-duration')
    return this.exhaustedError()
  }

  consumeFetch(): void {
    this.assertWithinDuration()
    if (this.fetchesStarted >= this.limits.maxFetches) {
      this.stop('max-fetches')
      throw this.exhaustedError()
    }
    this.fetchesStarted += 1
  }

  consumeBytes(bytes: number): void {
    this.bytesRead += bytes
    if (this.bytesRead > this.limits.maxBytes) {
      this.stop('max-bytes')
      throw this.exhaustedError()
    }
  }

  stop(reason: CrawlTerminationReason): void {
    // First-write-wins WITHIN a class, never across them: a later hard stop
    // must be able to override an earlier soft one.
    if (isHardFetchStop(reason)) {
      if (!this.hardStop) this.hardStop = reason
      return
    }
    if (!this.softStop) this.softStop = reason
  }

  private exhaustedError(): AeoAuditError {
    return new AeoAuditError('BUDGET_EXCEEDED', `Site crawl stopped: ${this.terminationReason ?? 'budget exhausted'}.`)
  }
}

function isBudgetError(error: unknown): boolean {
  return isAeoAuditError(error) && error.code === 'BUDGET_EXCEEDED'
}

/**
 * Failures that say nothing about the URL. A timeout or a refused/reset socket
 * is a property of this attempt — of the network, of the moment, of how hard
 * the crawler is leaning on the host — and the site can serve the same URL
 * perfectly on the next one. Everything else (blocked host, redirect limit,
 * oversized body, budget) reproduces on a retry, so retrying it only costs
 * budget. `timedFetch` funnels every unrecognized transport failure into
 * `UNREACHABLE`, so these two codes cover the transient set.
 */
function isTransientFetchError(error: unknown): boolean {
  const code = getAeoAuditErrorCode(error)
  return code === 'TIMEOUT' || code === 'UNREACHABLE'
}

/**
 * A request may not outlive the crawl that owns it. Clipped to the remaining
 * deadline, floored at 1ms so an exhausted budget produces an immediate timeout
 * rather than a non-positive one the fetch layer would read as "no timeout".
 */
function fetchTimeoutMs(budget: CrawlBudget): number {
  return Math.max(1, Math.min(CRAWL_FETCH_TIMEOUT_MS, budget.remainingMs()))
}

/** Backoff between fetch attempts, doubling per retry. */
function fetchRetryDelayMs(retry: number): number {
  return FETCH_RETRY_BASE_DELAY_MS * 2 ** (retry - 1)
}

/**
 * A throttled server usually says how long to wait. Prefer that over our own
 * backoff, bounded so a hostile or mistaken header cannot stall the crawl.
 * Only the delta-seconds form is read; the HTTP-date form is rare here and
 * misparsing one would be worse than falling back to the default backoff.
 */
function retryAfterMs(response: Response, fallbackMs: number): number {
  const header = response.headers.get('retry-after')
  if (!header) return fallbackMs
  const seconds = Number(header.trim())
  if (!Number.isFinite(seconds) || seconds < 0) return fallbackMs
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
}

/**
 * Abortable, duration-budgeted sleep. Waiting past the crawl's own deadline
 * would let a backoff outlive the budget it is supposed to respect, so the wait
 * is clipped to whatever remains and the caller re-checks the budget after.
 */
async function backoffDelay(ms: number, signal: AbortSignal | undefined, budget: CrawlBudget): Promise<void> {
  const remaining = budget.startedAt + budget.limits.maxDurationMs - Date.now()
  const wait = Math.min(ms, remaining)
  if (wait > 0) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, wait)
      function finish(): void {
        clearTimeout(timer)
        signal?.removeEventListener('abort', finish)
        resolve()
      }
      signal?.addEventListener('abort', finish, { once: true })
      if (signal?.aborted) finish()
    })
  }
  throwIfAborted(signal)
  budget.assertWithinDuration()
}

function isHardFetchStop(reason: CrawlTerminationReason | null): boolean {
  return reason === 'max-fetches' || reason === 'max-duration' || reason === 'max-bytes' || reason === 'root-host-redirect'
}

function emptyMetrics(): CrawlPageMetrics {
  return {
    inbound: { totalOccurrences: 0, uniqueEdges: 0 },
    outbound: { totalOccurrences: 0, uniqueEdges: 0 },
    shortestFollowableAnchorDepth: null,
    linkScoreRaw: 0,
    linkScore: 0,
  }
}

function pathFields(url: string | null): { path: string | null; directory: string | null } {
  if (!url) return { path: null, directory: null }
  try {
    const pathname = new URL(url).pathname
    const directory = pathname.endsWith('/') ? pathname : pathname.slice(0, pathname.lastIndexOf('/') + 1) || '/'
    return { path: pathname, directory }
  } catch {
    return { path: null, directory: null }
  }
}

function normalizeRobotsTokens(value: string | null): string[] {
  return (value ?? '')
    .split(',')
    .flatMap((part) => part.trim().toLowerCase().split(/\s+/))
    .filter(Boolean)
    .sort()
}

function deriveIndexability(input: {
  state: CrawlPageObservation['state']
  metaRobots: string[]
  xRobots: string[]
  pageUrl?: string
  canonicalUrl?: string | null
}): { state: CrawlIndexabilityState; reasons: string[]; rulesetVersion: string } {
  const directives = new Set([...input.metaRobots, ...input.xRobots])
  if (input.state === 'robots-blocked') {
    return { state: 'blocked', reasons: ['robots-disallow'], rulesetVersion: CRAWL_INDEXABILITY_RULESET_VERSION }
  }
  if (input.state === 'redirect') {
    return { state: 'unknown', reasons: ['redirect-terminal'], rulesetVersion: CRAWL_INDEXABILITY_RULESET_VERSION }
  }
  if (directives.has('noindex') || directives.has('none')) {
    const reasons = [
      ...(input.metaRobots.includes('noindex') || input.metaRobots.includes('none') ? ['meta-robots-noindex'] : []),
      ...(input.xRobots.includes('noindex') || input.xRobots.includes('none') ? ['x-robots-noindex'] : []),
    ]
    return { state: 'noindex', reasons, rulesetVersion: CRAWL_INDEXABILITY_RULESET_VERSION }
  }
  if (input.state === 'html' && input.pageUrl && input.canonicalUrl && input.canonicalUrl !== input.pageUrl) {
    return { state: 'unknown', reasons: ['canonical-to-other'], rulesetVersion: CRAWL_INDEXABILITY_RULESET_VERSION }
  }
  if (input.state === 'html') {
    return { state: 'indexable', reasons: [], rulesetVersion: CRAWL_INDEXABILITY_RULESET_VERSION }
  }
  return { state: 'unknown', reasons: ['not-html-or-unavailable'], rulesetVersion: CRAWL_INDEXABILITY_RULESET_VERSION }
}

// Match the stable network identity used by fetch-page.ts. Package branding is
// intentionally separate so existing robots.txt policies keep applying.
function parseRobots(body: string, userAgent = 'ainyc-aeo-audit'): RobotsRules {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; value: string }>; crawlDelaysMs: number[] }> = []
  let current: { agents: string[]; rules: Array<{ allow: boolean; value: string }>; crawlDelaysMs: number[] } | null = null
  const sitemaps: string[] = []
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim()
    if (!line) continue
    const separator = line.indexOf(':')
    if (separator === -1) continue
    const name = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()
    if (name === 'sitemap' && value) {
      sitemaps.push(value)
      continue
    }
    if (name === 'user-agent') {
      if (!current || current.rules.length > 0 || current.crawlDelaysMs.length > 0) {
        current = { agents: [], rules: [], crawlDelaysMs: [] }
        groups.push(current)
      }
      current.agents.push(value.toLowerCase())
      continue
    }
    if ((name === 'allow' || name === 'disallow') && current && value) {
      current.rules.push({ allow: name === 'allow', value })
      continue
    }
    if (name === 'crawl-delay' && current) {
      const seconds = Number(value)
      const milliseconds = seconds * 1_000
      if (Number.isFinite(milliseconds) && milliseconds >= 0) current.crawlDelaysMs.push(Math.ceil(milliseconds))
    }
  }
  const needle = userAgent.toLowerCase()
  const exact = groups.filter((group) => group.agents.some((agent) => agent && needle.includes(agent) && agent !== '*'))
  const wildcard = groups.filter((group) => group.agents.includes('*'))
  const selected = exact.length ? exact : wildcard
  const crawlDelaysMs = selected.flatMap((group) => group.crawlDelaysMs)
  return {
    rules: selected.flatMap((group) => group.rules),
    sitemaps,
    crawlDelayMs: crawlDelaysMs.length ? Math.max(...crawlDelaysMs) : null,
  }
}

function robotsAllows(url: string, robots: RobotsRules): boolean {
  const target = new URL(url)
  const path = `${target.pathname}${target.search}`
  let best: { allow: boolean; length: number } | null = null
  for (const rule of robots.rules) {
    const endAnchored = rule.value.endsWith('$')
    const pattern = endAnchored ? rule.value.slice(0, -1) : rule.value
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    const regex = new RegExp(`^${escaped}${endAnchored ? '$' : ''}`)
    if (!regex.test(path)) continue
    if (!best || rule.value.length > best.length || (rule.value.length === best.length && rule.allow)) {
      best = { allow: rule.allow, length: rule.value.length }
    }
  }
  return best?.allow ?? true
}

/**
 * Every role an author may write that a user agent will recognize, across all
 * three W3C role modules. The enumeration is COMPLETE, not merely large:
 *
 *  - ARIA 1.2 concrete roles      https://www.w3.org/TR/wai-aria-1.2/
 *  - DPUB-ARIA 1.1 (`doc-*`)      https://www.w3.org/TR/dpub-aria-1.1/
 *  - Graphics-ARIA 1.0 (`graphics-*`)  https://www.w3.org/TR/graphics-aria-1.0/
 *
 * A new W3C role module is the only thing that can extend it, and it goes here.
 *
 * Role resolution needs the whole enumeration, not just the landmarks: `role` is
 * an ordered fallback list and the FIRST RECOGNIZED role wins whether or not it
 * carries a placement, so `role="button navigation"` is a button and the element
 * is not a landmark at all. An omitted module silently breaks that ordering by
 * making a valid role look unrecognized.
 *
 * Abstract roles are excluded because authors must not use them and user agents
 * ignore them when computing the role.
 */
const CORE_ARIA_ROLES = [
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption',
  'cell', 'checkbox', 'code', 'columnheader', 'combobox', 'comment', 'complementary', 'contentinfo',
  'definition', 'deletion', 'dialog', 'directory', 'document', 'emphasis', 'feed', 'figure', 'form',
  'generic', 'grid', 'gridcell', 'group', 'heading', 'image', 'img', 'insertion', 'link', 'list',
  'listbox', 'listitem', 'log', 'main', 'mark', 'marquee', 'math', 'menu', 'menubar', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'meter', 'navigation', 'none', 'note', 'option', 'paragraph',
  'presentation', 'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup', 'rowheader',
  'scrollbar', 'search', 'searchbox', 'separator', 'slider', 'spinbutton', 'status', 'strong',
  'subscript', 'suggestion', 'superscript', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term',
  'textbox', 'time', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem',
] as const

/**
 * DPUB-ARIA 1.1 roles. They are recognized, so `<footer role="doc-footnote">`
 * is a footnote and NOT contentinfo: the author role overrides the native tag
 * even though no `doc-*` role carries a placement of its own.
 */
const DPUB_ARIA_ROLES = [
  'doc-abstract', 'doc-acknowledgments', 'doc-afterword', 'doc-appendix', 'doc-backlink',
  'doc-biblioentry', 'doc-bibliography', 'doc-biblioref', 'doc-chapter', 'doc-colophon',
  'doc-conclusion', 'doc-cover', 'doc-credit', 'doc-credits', 'doc-dedication', 'doc-endnote',
  'doc-endnotes', 'doc-epigraph', 'doc-epilogue', 'doc-errata', 'doc-example', 'doc-footnote',
  'doc-foreword', 'doc-glossary', 'doc-glossref', 'doc-index', 'doc-introduction', 'doc-noteref',
  'doc-notice', 'doc-pagebreak', 'doc-pagefooter', 'doc-pageheader', 'doc-pagelist', 'doc-part',
  'doc-preface', 'doc-prologue', 'doc-pullquote', 'doc-qna', 'doc-subtitle', 'doc-tip', 'doc-toc',
] as const

/** Graphics-ARIA 1.0 roles. Recognized, and none carries a placement. */
const GRAPHICS_ARIA_ROLES = ['graphics-document', 'graphics-object', 'graphics-symbol'] as const

/**
 * The lookup the resolver uses. Private on purpose: a `Set` cannot be made
 * immutable by freezing it, and an exported live instance would let a consumer
 * `.add()` a role and silently change every later placement while
 * `linkPlacementRulesetVersion` still reported the published ruleset.
 */
const RECOGNIZED_ROLE_LOOKUP: ReadonlySet<string> = new Set<string>([
  ...CORE_ARIA_ROLES,
  ...DPUB_ARIA_ROLES,
  ...GRAPHICS_ARIA_ROLES,
])

/** Whether a single role token is one a user agent recognizes. Case-insensitive. */
export function isRecognizedAriaRole(token: string): boolean {
  return RECOGNIZED_ROLE_LOOKUP.has(token.trim().toLowerCase())
}

/**
 * The recognized roles, sorted, as a frozen array so a consumer can enumerate
 * or pin the published set without being able to widen what the crawler
 * accepts. Use `isRecognizedAriaRole` for membership tests.
 */
export const RECOGNIZED_ARIA_ROLES: readonly string[] = deepFreeze([...RECOGNIZED_ROLE_LOOKUP].sort())

/**
 * A landmark and everything placement needs to know about it, in ONE row.
 *
 * Two earlier rounds of spec bugs were all the same shape: a rule added to the
 * tag path and forgotten on the role path, or to the placement path and
 * forgotten on the scoping path. Every derived lookup below is generated from
 * this table, so those paths cannot disagree.
 */
interface LandmarkRule {
  /** The HTML element that carries this landmark natively. */
  tag: string
  /** The ARIA role an author writes to mean the same thing. */
  role: string
  /**
   * Placement it contributes, or null when it is a landmark that says nothing
   * about chrome versus content and the walk should continue past it.
   */
  placement: CrawlLinkPlacement | null
  /**
   * Whether it scopes a descendant `header` / `footer` out of its
   * banner / contentinfo mapping. HTML-AAM scopes on both the element and the
   * matching role, which is exactly the tag and role of this same row.
   */
  scopesChrome: boolean
  /** Whether its OWN landmark status is conditional on not being scoped. */
  scopedByAncestors: boolean
}

/**
 * Placement's landmark table. Sourced from HTML-AAM element mappings.
 *
 * `section` / `region` is a landmark that carries no placement: a generic
 * sectioning container says nothing about chrome versus content, so the walk
 * continues past it to whatever encloses it. It still scopes a `header`.
 *
 * Landmarks NOT in this table (`form`, `search`) are recognized roles but carry
 * no placement and no scope, so the walk passes through them. HTML-AAM does not
 * list them as scoping either.
 */
const LANDMARK_RULES: readonly LandmarkRule[] = [
  { tag: 'nav', role: 'navigation', placement: 'navigation', scopesChrome: true, scopedByAncestors: false },
  { tag: 'aside', role: 'complementary', placement: 'navigation', scopesChrome: true, scopedByAncestors: false },
  { tag: 'main', role: 'main', placement: 'content', scopesChrome: true, scopedByAncestors: false },
  { tag: 'article', role: 'article', placement: 'content', scopesChrome: true, scopedByAncestors: false },
  { tag: 'section', role: 'region', placement: null, scopesChrome: true, scopedByAncestors: false },
  { tag: 'header', role: 'banner', placement: 'navigation', scopesChrome: false, scopedByAncestors: true },
  { tag: 'footer', role: 'contentinfo', placement: 'navigation', scopesChrome: false, scopedByAncestors: true },
]

const placedRules = LANDMARK_RULES.filter((rule): rule is LandmarkRule & { placement: CrawlLinkPlacement } => rule.placement !== null)
const TAG_PLACEMENT = new Map(placedRules.map((rule) => [rule.tag, rule.placement]))
const ROLE_PLACEMENT = new Map(placedRules.map((rule) => [rule.role, rule.placement]))
const SCOPING_TAGS = new Set(LANDMARK_RULES.filter((rule) => rule.scopesChrome).map((rule) => rule.tag))
const SCOPING_ROLES = new Set(LANDMARK_RULES.filter((rule) => rule.scopesChrome).map((rule) => rule.role))
const SCOPED_BY_ANCESTORS_TAGS = new Set(LANDMARK_RULES.filter((rule) => rule.scopedByAncestors).map((rule) => rule.tag))

/** The subset of a parsed DOM node that placement reads. */
interface PlacementNode {
  type: string
  name?: string
  attribs?: Record<string, string>
  parent: PlacementNode | null
}

function tagNameOf(node: PlacementNode): string {
  return node.type === 'tag' ? (node.name ?? '').toLowerCase() : ''
}

/**
 * First recognized role on an element, or null when it declares none.
 *
 * `role` is an ordered list of fallbacks. A user agent takes the first token it
 * recognizes and ignores the rest, so `role="doc-chapter main"` is a chapter,
 * not a main landmark, and `role="button navigation"` is a button.
 */
function firstRecognizedRole(node: PlacementNode): string | null {
  for (const token of (node.attribs?.role ?? '').toLowerCase().trim().split(/\s+/)) {
    if (RECOGNIZED_ROLE_LOOKUP.has(token)) return token
  }
  return null
}

/**
 * Whether an ancestor scopes a descendant `header` / `footer`.
 *
 * The condition is the UNION of tag and role. HTML-ARIA words it as "not a
 * descendant of an `article`, `aside`, `main`, `nav` or `section` ELEMENT, or an
 * element WITH `role=article | complementary | main | navigation | region`", so
 * either alone is enough. A `<section>` is a sectioning element whatever role an
 * author puts on it, and `<section role="doc-chapter"><header>` still scopes.
 *
 * NOTE the deliberate asymmetry with `landmarkOf`, where an author role
 * OVERRIDES the tag instead of adding to it. The two answer different questions.
 * Placement asks what this element IS, and a role is exactly how an author
 * answers that, so it wins. Scoping asks whether a sectioning container encloses
 * the header, and an element's sectioning nature does not disappear because the
 * author labelled it something else. One table, two rules, both intentional.
 */
function scopesChrome(node: PlacementNode): boolean {
  if (node.type !== 'tag') return false
  if (SCOPING_TAGS.has(tagNameOf(node))) return true
  const role = firstRecognizedRole(node)
  return role !== null && SCOPING_ROLES.has(role)
}

/**
 * Whether a `header` or `footer` element is site chrome.
 *
 * Per HTML-AAM a `header` maps to `banner` and a `footer` to `contentinfo` ONLY
 * when the element is not a descendant of `article`, `aside`, `main`, `nav`, or
 * `section`, OR of an element whose role is `article`, `complementary`, `main`,
 * `navigation`, or `region`. A role-based ancestor scopes exactly as the native
 * element does, so `<div role="main"><header>` is content. A blog post's own
 * `header` (title, byline) and `footer` (author bio, tags) are therefore NOT
 * page chrome, and treating them as chrome would hide exactly the editorial
 * links this feature exists to surface.
 *
 * Memoized per element, and headers and footers are few, so the extra upward
 * scan does not change the per-page cost in practice.
 */
function isUnscopedChrome(node: PlacementNode, scopeMemo: Map<PlacementNode, boolean>): boolean {
  const cached = scopeMemo.get(node)
  if (cached !== undefined) return cached
  let ancestor = node.parent
  let unscoped = true
  while (ancestor) {
    if (scopesChrome(ancestor)) {
      unscoped = false
      break
    }
    ancestor = ancestor.parent
  }
  scopeMemo.set(node, unscoped)
  return unscoped
}

/**
 * Landmark contribution of a single element, or null when it is not a landmark.
 *
 * Precedence within one element:
 *  1. An explicit `role` decides, if any token is a recognized role. A role in
 *     the landmark table gives its placement; any other recognized role means
 *     the element is NOT a landmark and its tag name is NOT consulted, because
 *     an author role overrides native semantics.
 *  2. Otherwise the tag name decides, through the same table. `header` and
 *     `footer` are chrome only when unscoped (see `isUnscopedChrome`).
 *
 * Because both branches read one table, an author role always produces the same
 * placement as the native element it mirrors: `<div role="article">` is content
 * exactly as `<article>` is.
 *
 * `aside` is deliberately chrome at every depth. HTML-AAM makes a scoped aside's
 * `complementary` mapping conditional on the author having given it an
 * accessible name; placement does not follow that, because whether a pull-quote
 * is furniture should not depend on whether someone wrote an `aria-label`.
 *
 * Class names and ids are never consulted: `<div class="footer">` is exactly the
 * unreliable signal this function exists to replace, so it stays unresolved.
 */
function landmarkOf(node: PlacementNode, scopeMemo: Map<PlacementNode, boolean>): CrawlLinkPlacement | null {
  if (node.type !== 'tag') return null
  const role = firstRecognizedRole(node)
  if (role !== null) return ROLE_PLACEMENT.get(role) ?? null
  const name = tagNameOf(node)
  const placement = TAG_PLACEMENT.get(name)
  if (placement === undefined) return null
  if (SCOPED_BY_ANCESTORS_TAGS.has(name) && !isUnscopedChrome(node, scopeMemo)) return null
  return placement
}

/**
 * Resolve where link occurrences sit, from the NEAREST landmark ancestor.
 *
 * Nearest wins in both directions, because nesting is how real templates are
 * built: a `nav` inside `main` is `navigation`, and an `article` inside an
 * `aside` is `content`. A link with no landmark ancestor at all is `unknown` —
 * an absence of evidence the consumer decides what to do with, never a guess.
 *
 * One upward walk per link, memoized per ancestor node, so a page costs a single
 * visit per node on any link's ancestor path however many links share a
 * container. Returns a resolver bound to one parsed document.
 */
function placementResolver(): (start: PlacementNode) => CrawlLinkPlacement {
  const memo = new Map<PlacementNode, CrawlLinkPlacement>()
  const scopeMemo = new Map<PlacementNode, boolean>()
  return (start) => {
    const pending: PlacementNode[] = []
    let node = start.parent
    let resolved: CrawlLinkPlacement | null = null
    while (node) {
      const cached = memo.get(node)
      if (cached) {
        resolved = cached
        break
      }
      const own = landmarkOf(node, scopeMemo)
      if (own) {
        memo.set(node, own)
        resolved = own
        break
      }
      pending.push(node)
      node = node.parent
    }
    const placement = resolved ?? 'unknown'
    for (const visited of pending) memo.set(visited, placement)
    return placement
  }
}

function emptyPlacementOccurrences(): CrawlPlacementOccurrences {
  return { navigation: 0, content: 0, unknown: 0 }
}

function collectLinks(html: string, from: string, limit: number): {
  links: Array<{ to: string; text: string; nofollow: boolean; placement: CrawlLinkPlacement }>
  canonicalUrl: string | null
  metaRobots: string[]
  truncated: boolean
} {
  const $ = load(html)
  const links: Array<{ to: string; text: string; nofollow: boolean; placement: CrawlLinkPlacement }> = []
  const placementOf = placementResolver()
  let total = 0
  $('a[href]').each((_, element) => {
    total += 1
    if (links.length >= limit) return
    const href = $(element).attr('href')
    if (!href) return
    try {
      links.push({
        to: normalizeCrawlUrl(href, from),
        text: $(element).text().replace(/\s+/g, ' ').trim().slice(0, 200),
        nofollow: (($(element).attr('rel') ?? '').toLowerCase().split(/\s+/)).includes('nofollow'),
        placement: placementOf(element),
      })
    } catch {
      // A malformed href has no usable crawl identity.
    }
  })
  const canonical = $('link[rel]').toArray().find((element) => (($(element).attr('rel') ?? '').toLowerCase().split(/\s+/)).includes('canonical'))
  let canonicalUrl: string | null = null
  const href = canonical ? $(canonical).attr('href') : undefined
  if (href) {
    try {
      canonicalUrl = normalizeCrawlUrl(href, from)
    } catch {
      // Keep a malformed canonical out of graph aggregation.
    }
  }
  return {
    links,
    canonicalUrl,
    metaRobots: normalizeRobotsTokens($('meta[name="robots" i]').first().attr('content') ?? null),
    truncated: total > limit,
  }
}

async function readResponse(
  response: Response,
  responseDeadlineAt: number,
  budget: CrawlBudget,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const crawlDeadlineAt = budget.startedAt + budget.limits.maxDurationMs
  const crawlDeadlineWins = crawlDeadlineAt <= responseDeadlineAt
  try {
    return await readResponseBodyAsText(response, {
      maxBytes,
      signal,
      deadlineAt: Math.min(responseDeadlineAt, crawlDeadlineAt),
      deadlineError: crawlDeadlineWins
        ? () => budget.durationExceededError()
        : () => new AeoAuditError('TIMEOUT', `Request timed out after ${CRAWL_FETCH_TIMEOUT_MS}ms.`),
      beforeRead: () => budget.assertWithinDuration(),
      onChunk: (bytes) => budget.consumeBytes(bytes),
      onTooLarge: () => budget.stop('max-page-bytes'),
      tooLargeMessage: `Crawl response exceeded ${maxBytes} bytes.`,
    })
  } catch (error) {
    if (isCallerAbort(error, signal) || isBudgetError(error) || isAeoAuditError(error)) throw error
    throw new AeoAuditError('UNREACHABLE', 'Could not read crawl response.', { cause: error })
  }
}

async function fetchCrawlUrl(
  requestedUrl: string,
  options: SiteCrawlOptions,
  budget: CrawlBudget,
  shouldFollowRedirect: (url: URL) => boolean,
  beforeOutboundAttempt: () => Promise<void>,
): Promise<CrawlFetchResult> {
  const result = await fetchWithValidatedRedirects(requestedUrl, {
    // Bounded by whatever is LEFT of the crawl deadline, not just by the
    // per-request ceiling. A 10s socket timeout inside a 3s crawl budget lets
    // one hung request overrun the whole crawl by 7s — and with retries, by a
    // multiple of that. The budget checks around this call cannot help: they
    // run before the request starts and after it ends, never during.
    timeoutMs: fetchTimeoutMs(budget),
    allowPrivateHost: options.allowPrivateHost,
    signal: options.signal,
    onOutboundAttempt: options.onOutboundAttempt,
    outboundAttemptKind: 'page',
    budget,
    shouldFollowRedirect,
    beforeOutboundAttempt,
  })
  const contentType = result.response.headers.get('content-type') ?? ''
  const body = result.response.status >= 400 || (result.response.status >= 300 && result.response.status < 400)
    ? ''
    : await readResponse(result.response, result.responseDeadlineAt, budget, budget.limits.maxPageBytes, options.signal)
  if (result.response.status >= 300) {
    if (result.response.body) void result.response.body.cancel().catch(() => {})
  }
  return {
    requestedUrl,
    finalUrl: normalizeCrawlUrl(result.finalUrl),
    response: result.response,
    redirectChain: result.redirectChain,
    headers: Object.fromEntries(result.response.headers.entries()),
    body,
    contentType,
    responseDeadlineAt: result.responseDeadlineAt,
  }
}

function anchorKey(from: string, to: string, type: CrawlEdgeType): string {
  return keyFor('edge', `${type}\u0000${from}\u0000${to}`)
}

function edgeSort(left: CrawlEdgeObservation, right: CrawlEdgeObservation): number {
  return left.key.localeCompare(right.key)
}

function pageSort(left: CrawlPageObservation, right: CrawlPageObservation): number {
  return left.key.localeCompare(right.key)
}

/**
 * Crawl a public site with a bounded, SSRF-safe, host-scoped BFS. This is a
 * separate graph contract from the legacy sitemap report and does not alter it.
 */
export async function runSiteCrawl(rawUrl: string, options: SiteCrawlOptions = {}): Promise<SiteCrawlReport> {
  throwIfAborted(options.signal)
  assertValidFactorIds(options.factors ?? [])
  const limits = resolveSiteCrawlLimits(options)
  const mode = options.summaryOnly ? 'summary' : options.mode ?? 'full'
  const startedAt = new Date().toISOString()
  const budget = new CrawlBudget(limits)
  const pacer = new RequestPacer({ delayMs: limits.requestDelayMs })
  const rootUrl = normalizeCrawlUrl(rawUrl)
  const root = new URL(rootUrl)
  const allowedHost = hostBoundary(root)
  const pages = new Map<string, CrawlPageObservation>()
  const pageByUrl = new Map<string, CrawlPageObservation>()
  const pendingPages = new Map<string, CrawlPageObservation>()
  const edges = new Map<string, CrawlEdgeObservation>()
  const pendingEdges = new Map<string, CrawlEdgeObservation>()
  const discoveries = new Map<string, CrawlDiscoveryProvenance>()
  // One slot per persisted URL identity. Redirect targets and depth-truncated
  // discoveries must use the same cap as ordinary frontier entries.
  const admittedPageUrls = new Set<string>()
  const frontier: FrontierItem[] = []
  const queued = new Set<string>()
  const processed = new Set<string>()
  const queryVariants = new Map<string, Set<string>>()
  const warnings: CrawlWarning[] = []
  let robotsCrawlDelayMs: number | null = null
  let deferredLinkDiscoveries: Array<{
    url: string
    depth: number
    source: { from?: string; sitemap?: string; root?: boolean }
  }> | null = null
  let deferredRedirectTerminals: Array<{
    item: FrontierItem
    fetched: CrawlFetchResult
    provenance: CrawlDiscoveryProvenance
  }> | null = null
  let sequence = 0
  let finalRootUrl: string | null = null
  let fetchRetriesAttempted = 0
  let fetchRetriesRecovered = 0

  const isAllowed = (url: URL): boolean => hostBoundary(url) === allowedHost
  const paceRequest = async (): Promise<void> => {
    await pacer.wait({
      signal: options.signal,
      deadlineAt: budget.startedAt + limits.maxDurationMs,
      deadlineError: () => budget.durationExceededError(),
    })
  }
  /**
   * Retry a page fetch that failed transiently, BEFORE anything reads the
   * observation. A single refused connection under crawl concurrency used to
   * become a `fetch-error` page, and a `fetch-error` page used to become a
   * reported dead link — so one flaky moment fabricated a broken link on a site
   * that was serving the URL fine. Retrying here means the classifier only ever
   * sees a failure the crawler could not shake off.
   */
  const fetchWithRetries = async (url: string): Promise<CrawlFetchResult> => {
    // Waits out a backoff and reports whether a retry may actually be
    // dispatched. Returning false rather than throwing is what keeps the
    // ORIGINAL failure alive: if the crawl deadline expires mid-backoff, the
    // caller still has the transient error to record an observation from,
    // instead of a budget error that would drop the page silently.
    const waitToRetry = async (delayMs: number): Promise<boolean> => {
      try {
        await backoffDelay(delayMs, options.signal, budget)
        return true
      } catch (backoffError) {
        if (isCallerAbort(backoffError, options.signal)) throw backoffError
        return false
      }
    }

    for (let retry = 0; ; retry += 1) {
      let fetched: CrawlFetchResult
      try {
        fetched = await fetchCrawlUrl(url, options, budget, isAllowed, paceRequest)
      } catch (error) {
        // An abort is the caller leaving and a budget error is the crawl's own
        // ceiling; retrying either would spend a resource that is already gone.
        if (isCallerAbort(error, options.signal)) throw error
        if (isBudgetError(error)) throw error
        if (retry >= limits.maxFetchRetries || !isTransientFetchError(error)) throw error
        if (!await waitToRetry(fetchRetryDelayMs(retry + 1))) throw error
        // Counted only once the retry can actually be dispatched, so the
        // number never claims a request that was never sent.
        fetchRetriesAttempted += 1
        continue
      }

      // A 429 is the one error STATUS worth retrying: the server is describing
      // our request rate, so backing off is exactly the corrective action, and
      // the response we already hold is not evidence about the link.
      if (fetched.response.status === RATE_LIMITED_STATUS && retry < limits.maxFetchRetries) {
        if (await waitToRetry(retryAfterMs(fetched.response, fetchRetryDelayMs(retry + 1)))) {
          fetchRetriesAttempted += 1
          continue
        }
        return fetched
      }
      if (retry > 0) fetchRetriesRecovered += 1
      return fetched
    }
  }
  const addWarning = (warning: CrawlWarning): void => {
    if (warnings.some((existing) => existing.code === warning.code && existing.from === warning.from && existing.to === warning.to)) return
    warnings.push(warning)
  }
  const provenanceFor = (url: string): CrawlDiscoveryProvenance => {
    const existing = discoveries.get(url)
    if (existing) return existing
    const created: CrawlDiscoveryProvenance = { discoveredFrom: [], sitemapSources: [], root: false }
    discoveries.set(url, created)
    return created
  }
  const progress = (): CrawlProgress => ({
    pagesDiscovered: discoveries.size,
    pagesFetched: [...pages.values()].filter((page) => ['html', 'redirect', 'non-html', 'fetch-error'].includes(page.state)).length,
    pagesObserved: pages.size,
    edgesObserved: edges.size,
    fetchesStarted: budget.fetchesStarted,
    bytesRead: budget.bytesRead,
  })
  const emit = async (type: CrawlEvent['type'], payload: Omit<CrawlEvent, 'sequence' | 'batchId' | 'checksum' | 'type'>): Promise<void> => {
    if (!options.onEvent) return
    sequence += 1
    const stablePayload = snapshot(payload)
    const keys = 'rows' in stablePayload
      ? (stablePayload.rows as Array<{ key: string }>).map((row) => row.key).sort().join(',')
      : stableJson(stableCheckpointValue(stablePayload))
    const checksum = hash(`${type}:${stableJson(stableCheckpointValue(stablePayload))}`)
    const event = {
      type,
      sequence,
      batchId: `crawl:${type}:${hash(`${keys}:${checksum}`).slice(0, 24)}`,
      checksum,
      ...stablePayload,
    } as CrawlEvent
    await options.onEvent(event)
  }
  const recordPage = async (page: CrawlPageObservation): Promise<CrawlPageObservation> => {
    const existing = pages.get(page.key)
    if (existing) return existing
    pages.set(page.key, page)
    pageByUrl.set(page.requestedUrl, page)
    if (page.finalUrl && page.state !== 'redirect' && !pageByUrl.has(page.finalUrl)) {
      pageByUrl.set(page.finalUrl, page)
    }
    pendingPages.set(page.key, page)
    return page
  }
  const flushPages = async (): Promise<void> => {
    const rows = [...pendingPages.values()].sort(pageSort)
    pendingPages.clear()
    for (let index = 0; index < rows.length; index += 250) {
      await emit('pages', { rows: rows.slice(index, index + 250) })
    }
    if (rows.length > 0) await emit('progress', { progress: progress() })
  }
  // Anchor-only detail is carried on the anchor variant so a call site cannot
  // omit the text, nofollow, or placement of an occurrence it just observed.
  const recordEdge = async (input:
    | {
      from: string
      to: string
      type: 'anchor'
      classification: CrawlEdgeClassification
      nofollow: boolean
      text: string
      placement: CrawlLinkPlacement
    }
    | {
      from: string
      to: string
      type: Exclude<CrawlEdgeType, 'anchor'>
      classification: CrawlEdgeClassification
    },
  ): Promise<void> => {
    const key = anchorKey(input.from, input.to, input.type)
    const current = edges.get(key)
    if (current) {
      current.totalOccurrences += 1
      if (input.type === 'anchor') {
        if (input.nofollow) current.nofollowOccurrences += 1
        else current.followableOccurrences += 1
        const counts = current.placementOccurrences ?? (current.placementOccurrences = emptyPlacementOccurrences())
        counts[input.placement] += 1
        const existing = current.anchorSummaries.find((summary) => summary.text === input.text)
        if (existing) existing.occurrences += 1
        else if (current.anchorSummaries.length < MAX_ANCHOR_SUMMARIES) current.anchorSummaries.push({ text: input.text, occurrences: 1 })
        current.anchorSummaries.sort((left, right) => left.text.localeCompare(right.text))
      }
      pendingEdges.set(key, current)
      return
    }
    if (edges.size >= limits.maxEdges) {
      budget.stop('max-edges')
      return
    }
    const placementOccurrences = emptyPlacementOccurrences()
    if (input.type === 'anchor') placementOccurrences[input.placement] = 1
    const edge: CrawlEdgeObservation = {
      key,
      from: input.from,
      to: input.to,
      type: input.type,
      classification: input.classification,
      totalOccurrences: 1,
      followableOccurrences: input.type === 'anchor' && !input.nofollow ? 1 : 0,
      nofollowOccurrences: input.type === 'anchor' && input.nofollow ? 1 : 0,
      anchorSummaries: input.type === 'anchor' ? [{ text: input.text, occurrences: 1 }] : [],
      placementOccurrences,
    }
    edges.set(key, edge)
    pendingEdges.set(key, edge)
  }
  const flushEdges = async (): Promise<void> => {
    const rows = [...pendingEdges.values()].sort(edgeSort)
    pendingEdges.clear()
    for (let index = 0; index < rows.length; index += 250) {
      await emit('edges', { rows: rows.slice(index, index + 250) })
    }
  }
  const createObservation = (input: Omit<CrawlPageObservation, 'key' | 'metrics'>): CrawlPageObservation => ({
    ...input,
    key: keyFor('page', input.requestedUrl),
    metrics: emptyMetrics(),
  })
  const mergeProvenance = (
    url: string,
    update: Partial<CrawlDiscoveryProvenance>,
  ): CrawlDiscoveryProvenance => {
    const provenance = provenanceFor(url)
    let changed = false
    for (const from of update.discoveredFrom ?? []) {
      if (!provenance.discoveredFrom.includes(from)) {
        provenance.discoveredFrom.push(from)
        changed = true
      }
    }
    for (const sitemap of update.sitemapSources ?? []) {
      if (!provenance.sitemapSources.includes(sitemap)) {
        provenance.sitemapSources.push(sitemap)
        changed = true
      }
    }
    if (update.root && !provenance.root) {
      provenance.root = true
      changed = true
    }
    if (changed) {
      provenance.discoveredFrom.sort()
      provenance.sitemapSources.sort()
      const observed = pages.get(keyFor('page', url))
      if (observed) pendingPages.set(observed.key, observed)
    }
    return provenance
  }
  const markDiscovered = async (url: string, depth: number, source?: { from?: string; sitemap?: string; root?: boolean }): Promise<void> => {
    // Network work within one breadth layer may finish in any order. Defer
    // link-frontier admission until the whole batch completes so caps and
    // checkpoint identities remain deterministic across retries.
    if (deferredLinkDiscoveries && source?.from) {
      deferredLinkDiscoveries.push({ url, depth, source })
      return
    }
    const provenanceUpdate = {
      discoveredFrom: source?.from ? [source.from] : [],
      sitemapSources: source?.sitemap ? [source.sitemap] : [],
      root: source?.root,
    }
    if (processed.has(url) || queued.has(url) || admittedPageUrls.has(url)) {
      mergeProvenance(url, provenanceUpdate)
      return
    }
    if (admittedPageUrls.size >= limits.maxPages) {
      budget.stop('max-pages')
      return
    }
    const provenance = mergeProvenance(url, provenanceUpdate)
    if (depth > limits.maxDepth) {
      admittedPageUrls.add(url)
      budget.stop('max-depth')
      await recordPage(createObservation({
        requestedUrl: url,
        finalUrl: null,
        state: 'discovered',
        depth,
        provenance,
        statusCode: null,
        contentType: null,
        redirectChain: [],
        canonicalUrl: null,
        metaRobots: [],
        xRobots: [],
        ...pathFields(url),
        indexability: deriveIndexability({ state: 'discovered', metaRobots: [], xRobots: [] }),
        audit: null,
        error: null,
        errorCode: null,
      }))
      return
    }
    const parsed = new URL(url)
    const queryIdentity = `${parsed.origin}${parsed.pathname}`
    const variants = queryVariants.get(queryIdentity) ?? new Set<string>()
    if (!variants.has(parsed.search) && variants.size >= limits.maxQueryVariants) {
      budget.stop('max-query-variants')
      return
    }
    variants.add(parsed.search)
    queryVariants.set(queryIdentity, variants)
    admittedPageUrls.add(url)
    queued.add(url)
    frontier.push({ url, depth })
  }

  const safeAuxFetch = async (url: string, kind: 'robots' | 'sitemap' | 'auxiliary'): Promise<CrawlFetchResult | null> => {
    // Site-global discovery files are optional. Preserve one outbound slot for
    // the caller's explicit root until that page has been fetched.
    if (!processed.has(rootUrl) && budget.fetchesStarted >= limits.maxFetches - 1) return null
    try {
      const result = await fetchWithValidatedRedirects(url, {
        timeoutMs: fetchTimeoutMs(budget),
        allowPrivateHost: options.allowPrivateHost,
        signal: options.signal,
        onOutboundAttempt: options.onOutboundAttempt,
        outboundAttemptKind: kind,
        budget,
        shouldFollowRedirect: isAllowed,
        beforeOutboundAttempt: paceRequest,
      })
      const contentType = result.response.headers.get('content-type') ?? ''
      const body = result.response.ok
        ? await readResponse(result.response, result.responseDeadlineAt, budget, limits.maxPageBytes, options.signal)
        : ''
      if (!result.response.ok) {
        if (result.response.body) void result.response.body.cancel().catch(() => {})
      }
      return {
        requestedUrl: url,
        finalUrl: normalizeCrawlUrl(result.finalUrl),
        response: result.response,
        redirectChain: result.redirectChain,
        headers: Object.fromEntries(result.response.headers.entries()),
        body,
        contentType,
        responseDeadlineAt: result.responseDeadlineAt,
      }
    } catch (error) {
      if (isCallerAbort(error, options.signal) || isBudgetError(error)) throw error
      return null
    }
  }

  const auxiliaryResource = (result: CrawlFetchResult | null, fallbackUrl: string): AuxiliaryResource => {
    if (!result) return { state: 'unreachable', url: fallbackUrl, statusCode: null, contentType: '', body: '' }
    const state = result.response.ok ? 'ok' : result.response.status === 404 ? 'missing' : 'unreachable'
    return {
      state,
      url: result.finalUrl,
      statusCode: result.response.status,
      contentType: result.contentType,
      body: result.body,
      redirectChain: result.redirectChain,
    }
  }
  const globalAuxiliary: AuxiliaryResources = {}
  let robots: RobotsRules = { rules: [], sitemaps: [], crawlDelayMs: null }
  const robotsUrl = new URL('/robots.txt', root).toString()
  try {
    const robotsResult = await safeAuxFetch(robotsUrl, 'robots')
    globalAuxiliary.robotsTxt = auxiliaryResource(robotsResult, robotsUrl)
    if (robotsResult?.response.ok) {
      robots = parseRobots(robotsResult.body)
      robotsCrawlDelayMs = robots.crawlDelayMs
      if (options.respectRobots !== false && robotsCrawlDelayMs !== null) {
        pacer.delayMs = Math.max(limits.requestDelayMs, robotsCrawlDelayMs)
        pacer.applyDelaySinceLastGrant()
      }
    } else if (robotsResult?.redirectChain.length) {
      const lastHop = robotsResult.redirectChain.at(-1)!
      if (!isAllowed(new URL(lastHop.to))) {
        addWarning({
          code: 'robots-host-redirect',
          message: 'robots.txt redirected outside the exact crawl host; its rules were not followed or applied.',
          from: normalizeCrawlUrl(lastHop.from),
          to: normalizeCrawlUrl(lastHop.to),
        })
      }
    }
  } catch (error) {
    if (isCallerAbort(error, options.signal)) throw error
    if (!isBudgetError(error)) throw error
  }
  if (!globalAuxiliary.robotsTxt) globalAuxiliary.robotsTxt = auxiliaryResource(null, robotsUrl)
  for (const [key, path] of [['llmsTxt', '/llms.txt'], ['llmsFullTxt', '/llms-full.txt']] as const) {
    const url = new URL(path, root).toString()
    try {
      globalAuxiliary[key] = auxiliaryResource(await safeAuxFetch(url, 'auxiliary'), url)
    } catch (error) {
      if (isCallerAbort(error, options.signal)) throw error
      if (!isBudgetError(error)) throw error
      globalAuxiliary[key] = auxiliaryResource(null, url)
    }
  }

  // Root is intentionally queued before sitemap locations so a sitemap cannot
  // consume the page cap and suppress the caller's explicit target.
  await markDiscovered(rootUrl, 0, { root: true })

  const sitemapQueue = new Set<string>()
  const addSitemap = (candidate: string, base = rootUrl): void => {
    try {
      const normalized = normalizeCrawlUrl(candidate, base)
      if (isAllowed(new URL(normalized))) sitemapQueue.add(normalized)
    } catch {
      // Ignore malformed sitemap directives.
    }
  }
  const explicitSitemaps = [options.sitemapUrl, ...(options.sitemapUrls ?? [])].filter((value): value is string => Boolean(value))
  if (explicitSitemaps.length) {
    for (const sitemap of explicitSitemaps) addSitemap(sitemap)
  } else {
    addSitemap('/sitemap.xml')
    addSitemap('/sitemap-index.xml')
  }
  for (const sitemap of robots.sitemaps) addSitemap(sitemap, rootUrl)

  let sitemapPageUrls = 0
  const uniqueSitemapPageUrls = new Set<string>()
  const sitemapPageSeeds: Array<{ url: string; sitemap: string }> = []
  const handledSitemaps = new Set<string>()
  while (sitemapQueue.size > 0 && !budget.terminationReason) {
    const sitemapUrl = [...sitemapQueue].sort()[0]!
    sitemapQueue.delete(sitemapUrl)
    if (handledSitemaps.has(sitemapUrl)) continue
    handledSitemaps.add(sitemapUrl)
    let sitemap: CrawlFetchResult | null
    try {
      sitemap = await safeAuxFetch(sitemapUrl, 'sitemap')
    } catch (error) {
      if (isCallerAbort(error, options.signal)) throw error
      if (isBudgetError(error)) break
      throw error
    }
    if (!sitemap?.response.ok) continue
    if (!globalAuxiliary.sitemapXml || globalAuxiliary.sitemapXml.state !== 'ok') {
      globalAuxiliary.sitemapXml = auxiliaryResource(sitemap, sitemapUrl)
    }
    const document = parseSitemapXmlDocument(sitemap.body)
    if (document.children.length > limits.maxSitemapFanout) budget.stop('max-sitemap-fanout')
    for (const child of document.children
      .slice(0, limits.maxSitemapFanout)
      .sort((left, right) => left.loc.localeCompare(right.loc))) addSitemap(child.loc, sitemap.finalUrl)
    for (const page of document.pages.sort((left, right) => left.loc.localeCompare(right.loc))) {
      const pageUrl = page.loc
      try {
        const normalized = normalizeCrawlUrl(pageUrl, sitemap.finalUrl)
        if (isAllowed(new URL(normalized))) {
          if (!uniqueSitemapPageUrls.has(normalized)) {
            if (sitemapPageUrls >= limits.maxSitemapUrls) {
              budget.stop('max-sitemap-urls')
              break
            }
            uniqueSitemapPageUrls.add(normalized)
            sitemapPageUrls += 1
          }
          sitemapPageSeeds.push({ url: normalized, sitemap: sitemapUrl })
        }
      } catch {
        // Ignore malformed sitemap locations.
      }
    }
  }

  if (!globalAuxiliary.sitemapXml) {
    globalAuxiliary.sitemapXml = auxiliaryResource(null, new URL('/sitemap.xml', root).toString())
  }

  const processTerminal = async (
    item: FrontierItem,
    fetched: CrawlFetchResult,
    provenance: CrawlDiscoveryProvenance,
  ): Promise<void> => {
    const requestedFinal = fetched.finalUrl
    const terminalAlreadyScheduled = requestedFinal !== item.url
      && (processed.has(requestedFinal) || queued.has(requestedFinal) || admittedPageUrls.has(requestedFinal))
    // Prefer the target's exact frontier item when it already exists. The alias
    // request necessarily fetched the terminal body to resolve its redirect, but
    // parsing it again would duplicate every target edge and analyzer result.
    if (terminalAlreadyScheduled) {
      mergeProvenance(requestedFinal, provenance)
      return
    }
    if (requestedFinal !== item.url && admittedPageUrls.size >= limits.maxPages) {
      budget.stop('max-pages')
      return
    }
    const finalProvenance = mergeProvenance(requestedFinal, provenance)
    admittedPageUrls.add(requestedFinal)
    processed.add(requestedFinal)
    queued.delete(requestedFinal)

    const headersRobots = normalizeRobotsTokens(fetched.headers['x-robots-tag'] ?? null)
    if (fetched.response.status >= 400) {
      await recordPage(createObservation({
        requestedUrl: requestedFinal,
        finalUrl: requestedFinal,
        state: 'fetch-error',
        depth: item.depth,
        provenance: finalProvenance,
        statusCode: fetched.response.status,
        contentType: fetched.contentType || null,
        redirectChain: fetched.redirectChain,
        canonicalUrl: null,
        metaRobots: [],
        xRobots: headersRobots,
        ...pathFields(requestedFinal),
        indexability: deriveIndexability({ state: 'fetch-error', metaRobots: [], xRobots: headersRobots }),
        audit: null,
        error: `HTTP ${fetched.response.status}`,
        errorCode: null,
      }))
      return
    }
    if (!isHtmlResponse(fetched.contentType, fetched.body)) {
      await recordPage(createObservation({
        requestedUrl: requestedFinal,
        finalUrl: requestedFinal,
        state: 'non-html',
        depth: item.depth,
        provenance: finalProvenance,
        statusCode: fetched.response.status,
        contentType: fetched.contentType || null,
        redirectChain: fetched.redirectChain,
        canonicalUrl: null,
        metaRobots: [],
        xRobots: headersRobots,
        ...pathFields(requestedFinal),
        indexability: deriveIndexability({ state: 'non-html', metaRobots: [], xRobots: headersRobots }),
        audit: null,
        error: null,
        errorCode: null,
      }))
      return
    }

    const parsed = collectLinks(fetched.body, requestedFinal, limits.maxLinksPerPage)
    if (parsed.truncated) budget.stop('max-links-per-page')
    let audit = null
    let analyzerError: string | null = null
    try {
      audit = await auditHtmlPage({
        inputUrl: requestedFinal,
        finalUrl: requestedFinal,
        html: fetched.body,
        headers: fetched.headers,
        redirectChain: fetched.redirectChain,
        auxiliary: globalAuxiliary,
        fetchTimeMs: 0,
      }, {
        factors: options.factors,
        includeGeo: options.includeGeo,
        includeAgentSkills: options.includeAgentSkills,
        includeLighthouse: options.includeLighthouse,
      })
    } catch (error) {
      // An analyzer failure must not discard the fetched crawl observation.
      if (isCallerAbort(error, options.signal)) throw error
      const message = error instanceof Error ? error.message : String(error)
      analyzerError = `Analyzer failed: ${message}`
    }
    const page = await recordPage(createObservation({
      requestedUrl: requestedFinal,
      finalUrl: requestedFinal,
      state: 'html',
      depth: item.depth,
      provenance: finalProvenance,
      statusCode: fetched.response.status,
      contentType: fetched.contentType || null,
      redirectChain: fetched.redirectChain,
      canonicalUrl: parsed.canonicalUrl,
      metaRobots: parsed.metaRobots,
      xRobots: headersRobots,
      ...pathFields(requestedFinal),
      indexability: deriveIndexability({
        state: 'html',
        metaRobots: parsed.metaRobots,
        xRobots: headersRobots,
        pageUrl: requestedFinal,
        canonicalUrl: parsed.canonicalUrl,
      }),
      audit,
      error: analyzerError,
      // An analyzer failure is not a fetch failure: the page was retrieved.
      errorCode: null,
    }))
    const pageNofollow = parsed.metaRobots.includes('nofollow')
      || parsed.metaRobots.includes('none')
      || headersRobots.includes('nofollow')
      || headersRobots.includes('none')

    if (parsed.canonicalUrl) {
      await recordEdge({
        from: page.finalUrl!,
        to: parsed.canonicalUrl,
        type: 'canonical',
        classification: isAllowed(new URL(parsed.canonicalUrl)) ? 'internal' : 'external',
      })
    }
    for (const link of parsed.links) {
      const classification: CrawlEdgeClassification = isAllowed(new URL(link.to)) ? 'internal' : 'external'
      await recordEdge({
        from: page.finalUrl!,
        to: link.to,
        type: 'anchor',
        classification,
        nofollow: link.nofollow || pageNofollow,
        text: link.text,
        placement: link.placement,
      })
      if (classification === 'internal') {
        await markDiscovered(link.to, item.depth + 1, { from: page.finalUrl! })
      }
    }
  }

  const processItem = async (item: FrontierItem): Promise<void> => {
    throwIfAborted(options.signal)
    if (processed.has(item.url)) return
    processed.add(item.url)
    const provenance = provenanceFor(item.url)
    if (options.respectRobots !== false && !robotsAllows(item.url, robots)) {
      await recordPage(createObservation({
        requestedUrl: item.url,
        finalUrl: null,
        state: 'robots-blocked',
        depth: item.depth,
        provenance,
        statusCode: null,
        contentType: null,
        redirectChain: [],
        canonicalUrl: null,
        metaRobots: [],
        xRobots: [],
        ...pathFields(item.url),
        indexability: deriveIndexability({ state: 'robots-blocked', metaRobots: [], xRobots: [] }),
        audit: null,
        error: null,
        errorCode: null,
      }))
      return
    }

    let fetched: CrawlFetchResult
    try {
      fetched = await fetchWithRetries(item.url)
    } catch (error) {
      if (isCallerAbort(error, options.signal)) throw error
      if (isBudgetError(error)) return
      const message = error instanceof Error ? error.message : String(error)
      const failureCode = getAeoAuditErrorCode(error)
      await recordPage(createObservation({
        requestedUrl: item.url,
        finalUrl: null,
        state: 'fetch-error',
        depth: item.depth,
        provenance,
        statusCode: null,
        contentType: null,
        redirectChain: [],
        canonicalUrl: null,
        metaRobots: [],
        xRobots: [],
        ...pathFields(item.url),
        indexability: deriveIndexability({ state: 'fetch-error', metaRobots: [], xRobots: [] }),
        audit: null,
        error: message,
        errorCode: failureCode,
      }))
      return
    }

    for (const hop of fetched.redirectChain) {
      const from = normalizeCrawlUrl(hop.from)
      const to = normalizeCrawlUrl(hop.to)
      await recordEdge({ from, to, type: 'redirect', classification: isAllowed(new URL(to)) ? 'internal' : 'external' })
    }
    if (fetched.redirectChain.length > 0) {
      await recordPage(createObservation({
        requestedUrl: item.url,
        finalUrl: fetched.finalUrl,
        state: 'redirect',
        depth: item.depth,
        provenance,
        statusCode: fetched.redirectChain[0]!.status,
        contentType: null,
        redirectChain: fetched.redirectChain,
        canonicalUrl: null,
        metaRobots: [],
        xRobots: [],
        ...pathFields(item.url),
        indexability: deriveIndexability({ state: 'redirect', metaRobots: [], xRobots: [] }),
        audit: null,
        error: null,
        errorCode: null,
      }))
      if (item.url === rootUrl) {
        const lastHop = fetched.redirectChain.at(-1)!
        if (!isAllowed(new URL(lastHop.to))) {
          const from = normalizeCrawlUrl(lastHop.from)
          const to = normalizeCrawlUrl(lastHop.to)
          finalRootUrl = to
          addWarning({
            code: 'root-host-redirect',
            message: 'The root redirected outside the exact crawl host; the target was recorded but not followed.',
            from,
            to,
          })
          budget.stop('root-host-redirect')
        } else {
          finalRootUrl = fetched.finalUrl
        }
      }
      if (fetched.response.status >= 300 && fetched.response.status < 400) {
        return
      }
    }

    const requestedFinal = fetched.finalUrl
    if (item.url === rootUrl) finalRootUrl = requestedFinal
    if (requestedFinal !== item.url && deferredRedirectTerminals) {
      deferredRedirectTerminals.push({ item, fetched, provenance })
      return
    }
    await processTerminal(item, fetched, provenance)
  }

  const drainFrontier = async (): Promise<void> => {
    const hasQueuedRoot = (): boolean => frontier.some((item) => provenanceFor(item.url).root)
    while (frontier.length > 0 && (!isHardFetchStop(budget.terminationReason) || hasQueuedRoot())) {
      throwIfAborted(options.signal)
      const batch = isHardFetchStop(budget.terminationReason)
        ? [frontier.splice(frontier.findIndex((item) => provenanceFor(item.url).root), 1)[0]!]
        : frontier.splice(0, limits.concurrency).sort((left, right) => left.url.localeCompare(right.url))
      for (const item of batch) queued.delete(item.url)
      deferredLinkDiscoveries = []
      deferredRedirectTerminals = []
      await Promise.all(batch.map(processItem))
      const terminalsInBatch = deferredRedirectTerminals
      deferredRedirectTerminals = null
      terminalsInBatch.sort((left, right) => (
        left.fetched.finalUrl.localeCompare(right.fetched.finalUrl)
        || left.item.url.localeCompare(right.item.url)
      ))
      for (const terminal of terminalsInBatch) {
        await processTerminal(terminal.item, terminal.fetched, terminal.provenance)
      }
      const discoveredInBatch = deferredLinkDiscoveries
      deferredLinkDiscoveries = null
      discoveredInBatch.sort((left, right) => (
        left.depth - right.depth
        || left.url.localeCompare(right.url)
        || (left.source.from ?? '').localeCompare(right.source.from ?? '')
      ))
      for (const discovery of discoveredInBatch) {
        await markDiscovered(discovery.url, discovery.depth, discovery.source)
      }
      await flushPages()
      await flushEdges()
      frontier.sort((left, right) => left.depth - right.depth || left.url.localeCompare(right.url))
    }
  }

  for (const seed of sitemapPageSeeds) {
    await markDiscovered(seed.url, 0, { sitemap: seed.sitemap })
    if (admittedPageUrls.size >= limits.maxPages) break
  }
  await drainFrontier()

  await flushPages()
  await flushEdges()

  const pageRows = [...pages.values()].sort(pageSort)
  const edgeRows = [...edges.values()].sort(edgeSort)
  deriveMetrics(pageRows, edgeRows, finalRootUrl)
  const metricRows = pageRows.map((page) => ({ key: page.key, metrics: page.metrics }))
  for (let index = 0; index < metricRows.length; index += 250) {
    await emit('metrics', { rows: metricRows.slice(index, index + 250) })
  }
  const complete = budget.terminationReason === null && frontier.length === 0
  const deadLinks = deriveDeadLinks(options.checkDeadLinks === true, complete, edgeRows, pageByUrl)
  const auditedPages = pageRows.filter((page) => page.audit !== null)
  const factorRollup = new Map<string, { id: string; name: string; count: number; total: number }>()
  for (const page of auditedPages) {
    for (const factor of page.audit!.factors) {
      const current = factorRollup.get(factor.id) ?? { id: factor.id, name: factor.name, count: 0, total: 0 }
      current.count += 1
      current.total += factor.score
      factorRollup.set(factor.id, current)
    }
  }
  const summary: CrawlSummary = {
    crawlSchemaVersion: CRAWL_SCHEMA_VERSION,
    engineVersion: engineVersion(),
    crawlEngineVersion: CRAWL_ENGINE_VERSION,
    urlNormalizationVersion: CRAWL_URL_NORMALIZATION_VERSION,
    indexabilityRulesetVersion: CRAWL_INDEXABILITY_RULESET_VERSION,
    linkScoreAlgorithmVersion: CRAWL_LINK_SCORE_ALGORITHM_VERSION,
    linkPlacementRulesetVersion: CRAWL_LINK_PLACEMENT_RULESET_VERSION,
    rootUrl,
    finalRootUrl,
    startedAt,
    completedAt: new Date().toISOString(),
    complete,
    terminationReason: complete ? null : budget.terminationReason ?? 'max-pages',
    pagesDiscovered: discoveries.size,
    pagesFetched: progress().pagesFetched,
    pagesObserved: pageRows.length,
    edgesObserved: edgeRows.length,
    bytesRead: budget.bytesRead,
    fetchesStarted: budget.fetchesStarted,
    elapsedMs: Date.now() - budget.startedAt,
    limits,
    warnings: [...warnings].sort((left, right) => (
      left.code.localeCompare(right.code) || left.from.localeCompare(right.from) || left.to.localeCompare(right.to)
    )),
    pacing: {
      requestedDelayMs: limits.requestDelayMs,
      robotsCrawlDelayMs,
      effectiveDelayMs: pacer.delayMs,
    },
    auditRollup: {
      auditedPages: auditedPages.length,
      aggregateScore: auditedPages.length
        ? Math.round(auditedPages.reduce((total, page) => total + page.audit!.overallScore, 0) / auditedPages.length)
        : null,
      factors: [...factorRollup.values()]
        .map((factor) => ({
          id: factor.id,
          name: factor.name,
          count: factor.count,
          averageScore: Number((factor.total / factor.count).toFixed(2)),
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    },
    fetchRetries: {
      attempted: fetchRetriesAttempted,
      recovered: fetchRetriesRecovered,
    },
  }
  await emit('summary', { summary })
  if (mode === 'summary') return { mode, summary, deadLinks }
  const report: FullSiteCrawlReport = { mode, summary, pages: pageRows, edges: edgeRows, deadLinks }
  return report
}

function deriveMetrics(pages: CrawlPageObservation[], edges: CrawlEdgeObservation[], finalRootUrl: string | null): void {
  const pagesByUrl = new Map<string, CrawlPageObservation>()
  for (const page of pages) {
    pagesByUrl.set(page.requestedUrl, page)
    page.metrics = emptyMetrics()
  }
  for (const page of pages) {
    if (page.finalUrl && page.state !== 'redirect' && !pagesByUrl.has(page.finalUrl)) {
      pagesByUrl.set(page.finalUrl, page)
    }
  }
  const followable = edges.filter((edge) => edge.type === 'anchor' && edge.classification === 'internal' && edge.followableOccurrences > 0)
  const followableByFrom = new Map<string, CrawlEdgeObservation[]>()
  for (const edge of followable) {
    const outgoing = followableByFrom.get(edge.from)
    if (outgoing) outgoing.push(edge)
    else followableByFrom.set(edge.from, [edge])
  }
  for (const outgoing of followableByFrom.values()) outgoing.sort(edgeSort)
  for (const edge of edges.filter((entry) => entry.type === 'anchor' && entry.classification === 'internal')) {
    const from = pagesByUrl.get(edge.from)
    const to = pagesByUrl.get(edge.to)
    if (from) {
      from.metrics.outbound.totalOccurrences += edge.totalOccurrences
      from.metrics.outbound.uniqueEdges += 1
    }
    if (to) {
      to.metrics.inbound.totalOccurrences += edge.totalOccurrences
      to.metrics.inbound.uniqueEdges += 1
    }
  }
  if (finalRootUrl && pagesByUrl.has(finalRootUrl)) {
    const distances = new Map<string, number>([[finalRootUrl, 0]])
    const queue = [finalRootUrl]
    let queueIndex = 0
    while (queueIndex < queue.length) {
      const from = queue[queueIndex++]!
      const depth = distances.get(from)!
      for (const edge of followableByFrom.get(from) ?? []) {
        if (!distances.has(edge.to)) {
          distances.set(edge.to, depth + 1)
          queue.push(edge.to)
        }
      }
    }
    for (const [url, depth] of distances) {
      const page = pagesByUrl.get(url)
      if (page) page.metrics.shortestFollowableAnchorDepth = depth
    }
  }

  const nodes = pages.filter((page) => page.state === 'html').sort(pageSort)
  if (!nodes.length) return
  const ids = nodes.map((page) => page.finalUrl!).sort()
  const position = new Map(ids.map((url, index) => [url, index]))
  const outgoing = new Map<string, string[]>()
  for (const id of ids) outgoing.set(id, [])
  for (const edge of followable) {
    if (position.has(edge.from) && position.has(edge.to)) outgoing.get(edge.from)!.push(edge.to)
  }
  for (const targets of outgoing.values()) targets.sort()
  const damping = 0.85
  let values = Array.from({ length: ids.length }, () => 1 / ids.length)
  for (let iteration = 0; iteration < 50; iteration += 1) {
    const next = Array.from({ length: ids.length }, () => (1 - damping) / ids.length)
    let dangling = 0
    for (const id of ids) {
      const index = position.get(id)!
      const targets = outgoing.get(id)!
      if (!targets.length) dangling += values[index]!
      else for (const target of targets) next[position.get(target)!] += damping * values[index]! / targets.length
    }
    if (dangling) for (let index = 0; index < next.length; index += 1) next[index] += damping * dangling / ids.length
    values = next
  }
  const maximum = Math.max(...values)
  for (const id of ids) {
    const page = pagesByUrl.get(id)
    if (!page) continue
    const value = values[position.get(id)!]!
    page.metrics.linkScoreRaw = Number(value.toFixed(12))
    page.metrics.linkScore = Number((maximum ? value / maximum * 100 : 0).toFixed(2))
  }
}

/**
 * Whether this target failed in a way that says nothing about the LINK, and if
 * so which way. Returns null for a target the crawl could actually judge —
 * whether it answered fine or answered with a real error status.
 *
 * The 429 case is the reason this runs before the 4xx/5xx test: it is an error
 * status, but it describes our request rate rather than the resource, so
 * reporting it as a broken link blames the site for how hard we crawled it.
 */
function unverifiedLinkReason(target: CrawlPageObservation): CrawlUnverifiedReason | null {
  if (target.statusCode === RATE_LIMITED_STATUS) return 'throttled'
  if (target.state !== 'fetch-error' || target.statusCode !== null) return null
  switch (target.errorCode) {
    case 'REDIRECT_LIMIT': return 'redirect-limit'
    case 'BODY_TOO_LARGE': return 'body-too-large'
    case 'TIMEOUT':
    case 'UNREACHABLE': return 'unreachable'
    // A code the engine does not classify, or a pre-2.0 observation that
    // recorded no code at all. Saying `unknown` is honest; picking the most
    // common cause would invent a diagnosis.
    default: return 'unknown'
  }
}

function deriveDeadLinks(
  enabled: boolean,
  complete: boolean,
  edges: CrawlEdgeObservation[],
  pageByUrl: Map<string, CrawlPageObservation>,
): CrawlDeadLinkResult {
  if (!enabled) return { state: 'disabled', findings: [], unverified: [] }
  const resolveTarget = (url: string): CrawlPageObservation | undefined => {
    let target = pageByUrl.get(url)
    const visited = new Set<string>()
    while (target?.state === 'redirect' && target.finalUrl && target.finalUrl !== target.requestedUrl) {
      if (visited.has(target.requestedUrl)) return target
      visited.add(target.requestedUrl)
      target = pageByUrl.get(target.finalUrl)
    }
    return target
  }
  const findings: CrawlDeadLinkFinding[] = []
  const unverified: CrawlUnverifiedLinkFinding[] = []
  for (const edge of edges) {
    if (edge.type !== 'anchor' || edge.classification !== 'internal') continue
    const target = resolveTarget(edge.to)
    if (!target) continue
    const identity = `${edge.from}\u0000${edge.to}`
    const unverifiedReason = unverifiedLinkReason(target)
    if (unverifiedReason) {
      // Keyed under its own prefix so a consumer storing findings by key
      // cannot mix the buckets back together.
      unverified.push({
        key: keyFor('unverified-link', identity),
        from: edge.from,
        to: edge.to,
        reason: unverifiedReason,
        error: target.error,
        statusCode: target.statusCode,
      })
      continue
    }
    // A status code is the whole evidence for calling a link dead. This reads
    // the CODE, not `state === 'fetch-error'`, which the traversal also uses
    // for a page that answered 4xx/5xx. Checked AFTER the unverified test, so
    // the one error status that is not about the link (429) never lands here.
    if (target.statusCode !== null && target.statusCode >= 400) {
      findings.push({
        key: keyFor('dead-link', identity),
        from: edge.from,
        to: edge.to,
        statusCode: target.statusCode,
        reason: 'http-error',
      })
    }
  }
  findings.sort((left, right) => left.key.localeCompare(right.key))
  unverified.sort((left, right) => left.key.localeCompare(right.key))
  return complete ? { state: 'complete', findings, unverified } : { state: 'partial', findings, unverified }
}

export const SITE_CRAWL_SCHEMA_VERSION = CRAWL_SCHEMA_VERSION
export const SITE_CRAWL_ENGINE_VERSION = CRAWL_ENGINE_VERSION
export const URL_NORMALIZATION_VERSION = CRAWL_URL_NORMALIZATION_VERSION
export const INDEXABILITY_RULESET_VERSION = CRAWL_INDEXABILITY_RULESET_VERSION
export const LINK_SCORE_ALGORITHM_VERSION = CRAWL_LINK_SCORE_ALGORITHM_VERSION
export const LINK_PLACEMENT_RULESET_VERSION = CRAWL_LINK_PLACEMENT_RULESET_VERSION

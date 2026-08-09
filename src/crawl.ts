import { createHash } from 'node:crypto'
import { load } from 'cheerio'
import { AeoAuditError, isAeoAuditError } from './errors.js'
import { fetchWithValidatedRedirects, isCallerAbort, isHtmlResponse, normalizeTargetUrl, readResponseBodyAsText, throwIfAborted } from './fetch-page.js'
import { assertValidFactorIds, auditHtmlPage } from './audit-html.js'
import { RequestPacer } from './request-pacer.js'
import { engineVersion } from './schema.js'
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
  CrawlPageMetrics,
  CrawlPageObservation,
  CrawlProgress,
  CrawlSummary,
  CrawlTerminationReason,
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
  CRAWL_LINK_SCORE_ALGORITHM_VERSION,
  CRAWL_SCHEMA_VERSION,
  CRAWL_URL_NORMALIZATION_VERSION,
  DEFAULT_SITE_CRAWL_LIMITS,
} from './types.js'

const CRAWL_FETCH_TIMEOUT_MS = 10_000
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

function defaults(options: SiteCrawlOptions): SiteCrawlLimits {
  const integer = (value: number | undefined, fallback: number, minimum = 1): number => (
    Number.isFinite(value) ? Math.max(minimum, Math.floor(value!)) : fallback
  )
  return {
    maxPages: integer(options.maxPages, DEFAULT_SITE_CRAWL_LIMITS.maxPages),
    maxEdges: integer(options.maxEdges, DEFAULT_SITE_CRAWL_LIMITS.maxEdges),
    maxFetches: integer(options.maxFetches, DEFAULT_SITE_CRAWL_LIMITS.maxFetches),
    maxDurationMs: integer(options.maxDurationMs, DEFAULT_SITE_CRAWL_LIMITS.maxDurationMs),
    maxBytes: integer(options.maxBytes, DEFAULT_SITE_CRAWL_LIMITS.maxBytes),
    maxPageBytes: integer(options.maxPageBytes, DEFAULT_SITE_CRAWL_LIMITS.maxPageBytes),
    maxDepth: integer(options.maxDepth, DEFAULT_SITE_CRAWL_LIMITS.maxDepth, 0),
    maxLinksPerPage: integer(options.maxLinksPerPage, DEFAULT_SITE_CRAWL_LIMITS.maxLinksPerPage),
    maxQueryVariants: integer(options.maxQueryVariants, DEFAULT_SITE_CRAWL_LIMITS.maxQueryVariants),
    maxSitemapFanout: integer(options.maxSitemapFanout, DEFAULT_SITE_CRAWL_LIMITS.maxSitemapFanout),
    maxSitemapUrls: integer(options.maxSitemapUrls, DEFAULT_SITE_CRAWL_LIMITS.maxSitemapUrls),
    concurrency: integer(options.concurrency, DEFAULT_SITE_CRAWL_LIMITS.concurrency),
    requestDelayMs: integer(options.requestDelayMs, DEFAULT_SITE_CRAWL_LIMITS.requestDelayMs, 0),
  }
}

class CrawlBudget implements FetchBudget {
  readonly startedAt = Date.now()
  fetchesStarted = 0
  bytesRead = 0
  terminationReason: CrawlTerminationReason | null = null

  constructor(readonly limits: SiteCrawlLimits) {}

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
    if (!this.terminationReason) this.terminationReason = reason
  }

  private exhaustedError(): AeoAuditError {
    return new AeoAuditError('BUDGET_EXCEEDED', `Site crawl stopped: ${this.terminationReason ?? 'budget exhausted'}.`)
  }
}

function isBudgetError(error: unknown): boolean {
  return isAeoAuditError(error) && error.code === 'BUDGET_EXCEEDED'
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

function collectLinks(html: string, from: string, limit: number): {
  links: Array<{ to: string; text: string; nofollow: boolean }>
  canonicalUrl: string | null
  metaRobots: string[]
  truncated: boolean
} {
  const $ = load(html)
  const links: Array<{ to: string; text: string; nofollow: boolean }> = []
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
    timeoutMs: CRAWL_FETCH_TIMEOUT_MS,
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
  const limits = defaults(options)
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

  const isAllowed = (url: URL): boolean => hostBoundary(url) === allowedHost
  const paceRequest = async (): Promise<void> => {
    await pacer.wait({
      signal: options.signal,
      deadlineAt: budget.startedAt + limits.maxDurationMs,
      deadlineError: () => budget.durationExceededError(),
    })
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
  const recordEdge = async (input: {
    from: string
    to: string
    type: CrawlEdgeType
    classification: CrawlEdgeClassification
    nofollow?: boolean
    text?: string
  }): Promise<void> => {
    const key = anchorKey(input.from, input.to, input.type)
    const current = edges.get(key)
    if (current) {
      current.totalOccurrences += 1
      if (input.type === 'anchor') {
        if (input.nofollow) current.nofollowOccurrences += 1
        else current.followableOccurrences += 1
        const existing = current.anchorSummaries.find((summary) => summary.text === (input.text ?? ''))
        if (existing) existing.occurrences += 1
        else if (current.anchorSummaries.length < MAX_ANCHOR_SUMMARIES) current.anchorSummaries.push({ text: input.text ?? '', occurrences: 1 })
        current.anchorSummaries.sort((left, right) => left.text.localeCompare(right.text))
      }
      pendingEdges.set(key, current)
      return
    }
    if (edges.size >= limits.maxEdges) {
      budget.stop('max-edges')
      return
    }
    const edge: CrawlEdgeObservation = {
      key,
      from: input.from,
      to: input.to,
      type: input.type,
      classification: input.classification,
      totalOccurrences: 1,
      followableOccurrences: input.type === 'anchor' && !input.nofollow ? 1 : 0,
      nofollowOccurrences: input.type === 'anchor' && input.nofollow ? 1 : 0,
      anchorSummaries: input.type === 'anchor' ? [{ text: input.text ?? '', occurrences: 1 }] : [],
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
        timeoutMs: CRAWL_FETCH_TIMEOUT_MS,
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
      await recordEdge({ from: page.finalUrl!, to: link.to, type: 'anchor', classification, nofollow: link.nofollow || pageNofollow, text: link.text })
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
      }))
      return
    }

    let fetched: CrawlFetchResult
    try {
      fetched = await fetchCrawlUrl(item.url, options, budget, isAllowed, paceRequest)
    } catch (error) {
      if (isCallerAbort(error, options.signal)) throw error
      if (isBudgetError(error)) return
      const message = error instanceof Error ? error.message : String(error)
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

function deriveDeadLinks(
  enabled: boolean,
  complete: boolean,
  edges: CrawlEdgeObservation[],
  pageByUrl: Map<string, CrawlPageObservation>,
): CrawlDeadLinkResult {
  if (!enabled) return { state: 'disabled', findings: [] }
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
  for (const edge of edges) {
    if (edge.type !== 'anchor' || edge.classification !== 'internal') continue
    const target = resolveTarget(edge.to)
    if (!target) continue
    const httpFailure = target.statusCode !== null && target.statusCode >= 400
    const fetchFailure = target.state === 'fetch-error' && target.statusCode === null
    if (!httpFailure && !fetchFailure) continue
    findings.push({
      key: keyFor('dead-link', `${edge.from}\u0000${edge.to}`),
      from: edge.from,
      to: edge.to,
      statusCode: target.statusCode,
      reason: httpFailure ? 'http-error' : 'fetch-error',
    })
  }
  findings.sort((left, right) => left.key.localeCompare(right.key))
  return complete ? { state: 'complete', findings } : { state: 'partial', findings }
}

export const SITE_CRAWL_SCHEMA_VERSION = CRAWL_SCHEMA_VERSION
export const SITE_CRAWL_ENGINE_VERSION = CRAWL_ENGINE_VERSION
export const URL_NORMALIZATION_VERSION = CRAWL_URL_NORMALIZATION_VERSION
export const INDEXABILITY_RULESET_VERSION = CRAWL_INDEXABILITY_RULESET_VERSION
export const LINK_SCORE_ALGORITHM_VERSION = CRAWL_LINK_SCORE_ALGORITHM_VERSION

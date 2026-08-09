import dns from 'node:dns/promises'
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import type { LookupFunction } from 'node:net'
import ipaddr from 'ipaddr.js'
import { fetch as undiciFetch, Agent } from 'undici'
import { AeoAuditError, isAeoAuditError } from './errors.js'
import type {
  AeoAuditOutboundAttemptKind,
  AeoAuditOutboundAttemptObserver,
  AuxiliaryDiagnostics,
  AuxiliaryResource,
  AuxiliaryResourceState,
  AuxiliaryResources,
  FetchedPage,
  RedirectHop,
  SitemapAuditPartialReason,
} from './types.js'

interface AuxiliarySpec {
  key: keyof AuxiliaryResources
  /** Primary path checked first. */
  path: string
  /** Optional fallback paths tried when the primary path returns 404 (e.g. sitemap-index.xml). */
  fallbackPaths?: string[]
  kind: 'text' | 'xml'
}

interface TimedFetchOptions {
  timeoutMs: number
  headers?: HeadersInit
  redirect?: RequestRedirect
  /** Single host allowed to resolve privately; when it matches, DNS pinning is skipped. */
  allowPrivateHost?: string
  signal?: AbortSignal
}

interface ReadBodyOptions {
  maxBytes: number
  requireHtmlSniff?: boolean
  signal?: AbortSignal
  deadlineAt?: number
  timeoutMs?: number
}

export interface FetchWithRedirectOptions {
  timeoutMs: number
  maxRedirects?: number
  allowPrivateHost?: string
  signal?: AbortSignal
  onOutboundAttempt?: AeoAuditOutboundAttemptObserver
  outboundAttemptKind?: AeoAuditOutboundAttemptKind
  budget?: FetchBudget
  /** Awaited after per-hop SSRF validation and immediately before a request starts. */
  beforeOutboundAttempt?: () => void | Promise<void>
  /**
   * Optional caller-owned redirect boundary. Returning false records the redirect
   * hop but leaves its response unread, so host-scoped callers never fetch a
   * redirect target outside their own crawl boundary.
   */
  shouldFollowRedirect?: (nextUrl: URL) => boolean
}

export interface RedirectFetchResult {
  response: Response
  finalUrl: string
  redirectChain: RedirectHop[]
  /** Absolute deadline inherited by response-body consumption. */
  responseDeadlineAt: number
}

export interface ReadResponseBodyOptions {
  maxBytes: number
  /** Reject an ambiguous response as soon as its first 512 bytes are not HTML. */
  requireHtmlSniff?: boolean
  signal?: AbortSignal
  deadlineAt?: number
  deadlineError?: () => unknown
  beforeRead?: () => void
  onChunk?: (bytes: number) => void
  onTooLarge?: () => void
  tooLargeMessage?: string
}

// Stable network identity retained across the @ainyc and @canonry package names.
// Changing it would silently bypass existing site-specific robots rules.
const USER_AGENT = 'AINYC-AEO-Audit/1.0'
// Accept header used to probe for content-negotiation redirects (some sites
// 307 .txt → non-existent .md when this header is present).
const MARKDOWN_PROBE_ACCEPT = 'text/markdown, text/html;q=0.9, */*;q=0.1'

const MAIN_TIMEOUT_MS = 10_000
const AUX_TIMEOUT_MS = 5_000
const DIAGNOSTIC_TIMEOUT_MS = 4_000
const MAIN_MAX_BYTES = 5 * 1024 * 1024
const AUX_MAX_BYTES = 1024 * 1024
const MAX_REDIRECTS = 5
const HTML_SNIFF_MIN_BYTES = 512

const AUXILIARY_SPECS: AuxiliarySpec[] = [
  { key: 'llmsTxt', path: '/llms.txt', kind: 'text' },
  { key: 'llmsFullTxt', path: '/llms-full.txt', kind: 'text' },
  { key: 'robotsTxt', path: '/robots.txt', kind: 'text' },
  // Astro/Next.js sometimes publish only /sitemap-index.xml. Try it as a
  // fallback so we don't false-report "no sitemap" on those stacks.
  { key: 'sitemapXml', path: '/sitemap.xml', fallbackPaths: ['/sitemap-index.xml'], kind: 'xml' },
]

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home', '.lan']

const HTML_CONTENT_TYPES = ['text/html', 'application/xhtml+xml']
const TEXT_LIKE_CONTENT_TYPES = ['text/', 'application/json', 'application/xml', 'text/xml', 'application/xhtml+xml']
const AMBIGUOUS_CONTENT_TYPES = ['text/plain', 'application/octet-stream']

export interface FetchBudgetSnapshot {
  maxFetches?: number
  fetchesStarted: number
  maxDurationMs?: number
  elapsedMs: number
  exhaustedReason?: SitemapAuditPartialReason
}

export interface FetchBudget {
  consumeFetch(): void
  assertWithinDuration(): void
}

export class FetchBudgetController implements FetchBudget {
  readonly startedAt: number
  readonly maxFetches?: number
  readonly maxDurationMs?: number
  fetchesStarted = 0
  exhaustedReason?: SitemapAuditPartialReason

  constructor(options: { maxFetches?: number; maxDurationMs?: number; startedAt?: number }) {
    this.startedAt = options.startedAt ?? Date.now()
    this.maxFetches = options.maxFetches
    this.maxDurationMs = options.maxDurationMs
  }

  consumeFetch(): void {
    this.assertWithinDuration()

    if (this.maxFetches !== undefined && this.fetchesStarted >= this.maxFetches) {
      this.exhaustedReason = 'fetch-budget-exceeded'
      throw new AeoAuditError('BUDGET_EXCEEDED', `Sitemap audit exceeded the maxFetches budget of ${this.maxFetches}.`, {
        details: { reason: this.exhaustedReason, maxFetches: this.maxFetches },
      })
    }

    this.fetchesStarted += 1
  }

  assertWithinDuration(): void {
    if (this.maxDurationMs !== undefined && Date.now() - this.startedAt >= this.maxDurationMs) {
      this.exhaustedReason = 'duration-budget-exceeded'
      throw new AeoAuditError('BUDGET_EXCEEDED', `Sitemap audit exceeded the maxDurationMs budget of ${this.maxDurationMs}.`, {
        details: { reason: this.exhaustedReason, maxDurationMs: this.maxDurationMs },
      })
    }
  }

  isExhausted(): boolean {
    if (this.maxFetches !== undefined && this.fetchesStarted >= this.maxFetches) {
      this.exhaustedReason = 'fetch-budget-exceeded'
      return true
    }

    try {
      this.assertWithinDuration()
    } catch (error) {
      if (isFetchBudgetExceededError(error)) return true
      throw error
    }
    return this.exhaustedReason !== undefined
  }

  snapshot(): FetchBudgetSnapshot {
    return {
      maxFetches: this.maxFetches,
      fetchesStarted: this.fetchesStarted,
      maxDurationMs: this.maxDurationMs,
      elapsedMs: Date.now() - this.startedAt,
      exhaustedReason: this.exhaustedReason,
    }
  }
}

export function isFetchBudgetExceededError(error: unknown): error is AeoAuditError & {
  details: { reason?: SitemapAuditPartialReason }
} {
  return isAeoAuditError(error) && error.code === 'BUDGET_EXCEEDED'
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted.', 'AbortError')
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortReason(signal)
  }
}

export function isCallerAbort(error: unknown, signal?: AbortSignal): boolean {
  if (!signal?.aborted) {
    return false
  }

  const reason = signal.reason
  return error === reason || (
    reason === undefined
    && error instanceof DOMException
    && error.name === 'AbortError'
  )
}

function findAeoAuditError(error: unknown): AeoAuditError | null {
  if (isAeoAuditError(error)) {
    return error
  }

  if (typeof error === 'object' && error !== null && 'cause' in error) {
    return findAeoAuditError((error as { cause?: unknown }).cause)
  }

  return null
}

function stripPort(hostname = ''): string {
  const closingBracketIndex = hostname.indexOf(']')
  if (hostname.startsWith('[') && closingBracketIndex !== -1) {
    return hostname.slice(1, closingBracketIndex)
  }

  const segments = hostname.split(':')
  return segments.length > 2 ? hostname : segments[0]
}

function normalizeHostname(hostname = ''): string {
  return stripPort(hostname).toLowerCase().replace(/\.$/, '')
}

/**
 * True when `hostname` is the exact host the caller opted out of the private-target
 * guard via `allowPrivateHost`. Comparison is host-only (port-insensitive) and
 * normalized for case and trailing dots. Returns false when no allow-host is set,
 * so the guard stays on by default and only ever relaxes for one named host.
 */
export function isHostExplicitlyAllowed(hostname: string, allowPrivateHost?: string): boolean {
  if (!allowPrivateHost) {
    return false
  }

  const normalized = normalizeHostname(hostname)
  return normalized !== '' && normalized === normalizeHostname(allowPrivateHost)
}

export function normalizeTargetUrl(rawUrl: unknown): URL {
  if (typeof rawUrl !== 'string') {
    throw new AeoAuditError('BAD_INPUT', 'A target URL is required.')
  }

  const trimmed = rawUrl.trim()
  if (!trimmed) {
    throw new AeoAuditError('BAD_INPUT', 'A target URL is required.')
  }

  const withProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`

  let parsed
  try {
    parsed = new URL(withProtocol)
  } catch {
    throw new AeoAuditError('INVALID_URL', 'Enter a valid URL.')
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new AeoAuditError('UNSUPPORTED_PROTOCOL', 'Only HTTP and HTTPS URLs are supported.')
  }

  parsed.hash = ''

  return parsed
}

export function isHostnameBlocked(hostname: string): boolean {
  const normalized = normalizeHostname(hostname)

  if (!normalized) {
    return true
  }

  if (normalized === 'localhost' || normalized.endsWith('.localhost')) {
    return true
  }

  if (BLOCKED_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
    return true
  }

  const isIpLiteral = ipaddr.isValid(normalized)
  if (!isIpLiteral && !normalized.includes('.')) {
    return true
  }

  return false
}

export function isPublicIpAddress(ip: string): boolean {
  if (!ipaddr.isValid(ip)) {
    return false
  }

  const parsed = ipaddr.parse(ip)

  if (parsed.kind() === 'ipv6') {
    const ipv6 = parsed as { isIPv4MappedAddress(): boolean; toIPv4Address(): { toString(): string } }
    if (ipv6.isIPv4MappedAddress()) {
      return isPublicIpAddress(ipv6.toIPv4Address().toString())
    }
  }

  return parsed.range() === 'unicast'
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }

  return undefined
}

function getErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message
  }

  return undefined
}

function isDnsNotFoundError(error: unknown): boolean {
  return ['ENODATA', 'ENOTFOUND', 'EAI_AGAIN', 'SERVFAIL', 'ETIMEOUT'].includes(getErrorCode(error) || '')
}

async function resolveHostAddresses(hostname: string): Promise<string[]> {
  if (ipaddr.isValid(hostname)) {
    return [hostname]
  }

  const results = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)])

  const ips = []
  for (const result of results) {
    if (result.status === 'fulfilled') {
      ips.push(...result.value)
    } else if (!isDnsNotFoundError(result.reason)) {
      throw new AeoAuditError('UNREACHABLE', `Could not resolve host "${hostname}".`, {
        details: { reason: getErrorMessage(result.reason) },
      })
    }
  }

  if (!ips.length) {
    throw new AeoAuditError('UNREACHABLE', `Could not resolve host "${hostname}".`)
  }

  return ips
}

interface ValidateTargetOptions {
  /** Single host permitted to resolve to a private/loopback IP. See RunAeoAuditOptions.allowPrivateHost. */
  allowPrivateHost?: string
}

async function validatePublicRequestTarget(targetUrl: URL, options: ValidateTargetOptions = {}): Promise<void> {
  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    throw new AeoAuditError('UNSUPPORTED_PROTOCOL', 'Only HTTP and HTTPS URLs are supported.')
  }

  // Narrowly-scoped escape hatch (CLI --allow-local): when the caller named this
  // exact host, skip BOTH the hostname blocklist and the DNS/IP check. We must not
  // resolve here — `localhost` lives in /etc/hosts and is not answerable via
  // dns.resolve4, so a resolution attempt would spuriously fail UNREACHABLE; the
  // subsequent fetch() uses the OS resolver instead. The match is per-hop, so a
  // redirect or sitemap <loc> to any OTHER private host still hits the guard below.
  if (isHostExplicitlyAllowed(targetUrl.hostname, options.allowPrivateHost)) {
    return
  }

  if (isHostnameBlocked(targetUrl.hostname)) {
    throw new AeoAuditError('BLOCKED_HOST', 'URL points to a blocked or private hostname.')
  }

  const ips = await resolveHostAddresses(targetUrl.hostname)
  const privateIp = ips.find((ip) => !isPublicIpAddress(ip))

  if (privateIp) {
    throw new AeoAuditError('BLOCKED_IP', 'URL resolves to a blocked or private IP address.', {
      details: { ip: privateIp },
    })
  }
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400
}

/**
 * Connect-time DNS lookup for the pinning dispatcher: resolve the host and hand the
 * socket ONLY public IPs. Because undici connects to exactly the address this returns,
 * a low-TTL record that passed the pre-fetch `validatePublicRequestTarget` check but
 * rebinds to a private IP at connect time is rejected here — closing the validate-then-
 * connect (TOCTOU) gap that per-hop re-validation alone cannot.
 */
export const validatingLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true, family: options.family ?? 0, verbatim: true }, (error, addresses) => {
    if (error) {
      callback(error, '')
      return
    }

    const publicAddresses = (addresses as LookupAddress[]).filter((entry) => isPublicIpAddress(entry.address))
    if (publicAddresses.length === 0) {
      callback(new AeoAuditError('BLOCKED_IP', 'URL resolves to a blocked or private IP address.'), '')
      return
    }

    if (options.all) {
      callback(null, publicAddresses)
      return
    }

    callback(null, publicAddresses[0].address, publicAddresses[0].family)
  })
}

// One process-wide dispatcher (no per-request allocation or socket leak). Every fetch
// to a host NOT named by --allow-local goes through it; the allowed host keeps the
// default resolver so a deliberately-private target (localhost, a dev server) still works.
const pinnedDispatcher = new Agent({ connect: { lookup: validatingLookup } })

// Node's global fetch rejects a userland-undici dispatcher, so real requests go through
// undici's own fetch with the pinning dispatcher attached. Tests replace globalThis.fetch
// with canned responses; pinning is a socket-layer concern those mocks never reach, so
// when the global has been stubbed we defer to it. The dedicated pin tests use real sockets.
const builtinFetch = globalThis.fetch
async function pinnedHostFetch(url: string, init: RequestInit, pin: boolean): Promise<Response> {
  if (globalThis.fetch !== builtinFetch) {
    return globalThis.fetch(url, init)
  }
  const undiciInit = (pin ? { ...init, dispatcher: pinnedDispatcher } : init) as unknown as Parameters<typeof undiciFetch>[1]
  const response = await undiciFetch(url, undiciInit)
  return response as unknown as Response
}

async function timedFetch(url: URL | string, options: TimedFetchOptions): Promise<Response> {
  const { timeoutMs, headers, redirect = 'manual', allowPrivateHost, signal } = options
  throwIfAborted(signal)

  const controller = new AbortController()
  const timeoutError = new AeoAuditError('TIMEOUT', `Request timed out after ${timeoutMs}ms.`)
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs)
  const abortListener = signal
    ? (): void => controller.abort(abortReason(signal))
    : null

  if (abortListener) {
    signal?.addEventListener('abort', abortListener, { once: true })
  }

  // Skip pinning only for the single host the caller opted out via --allow-local; that
  // host legitimately resolves to a private IP and the pinning lookup would block it.
  const pin = !isHostExplicitlyAllowed(new URL(url.toString()).hostname, allowPrivateHost)

  try {
    return await pinnedHostFetch(url.toString(), {
      method: 'GET',
      redirect,
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        ...(headers || {}),
      },
    }, pin)
  } catch (error) {
    if (controller.signal.aborted) {
      throw controller.signal.reason ?? error
    }

    const knownError = findAeoAuditError(error)
    if (knownError) {
      throw knownError
    }

    throw new AeoAuditError('UNREACHABLE', 'Target URL could not be reached.', { cause: error })
  } finally {
    clearTimeout(timer)
    if (abortListener) signal?.removeEventListener('abort', abortListener)
  }
}

/**
 * Fetch `startUrl`, following redirects manually and re-validating EVERY hop through
 * `validatePublicRequestTarget` (hostname blocklist + DNS→private-IP check). This is
 * the single SSRF-safe entry point for any outbound request to a URL the caller does
 * not fully control — the main page fetch, the auxiliary-file probes, and (since the
 * sitemap runner) every sitemap / robots / child-`<loc>` fetch route through it. The
 * caller gets a not-yet-read `Response` plus the final URL and redirect chain.
 */
export async function fetchWithValidatedRedirects(startUrl: URL | string, options: FetchWithRedirectOptions): Promise<RedirectFetchResult> {
  const {
    timeoutMs,
    maxRedirects = MAX_REDIRECTS,
    allowPrivateHost,
    signal,
    onOutboundAttempt,
    outboundAttemptKind = 'page',
    budget,
    shouldFollowRedirect,
    beforeOutboundAttempt,
  } = options

  let currentUrl = new URL(startUrl.toString())
  const redirectChain: RedirectHop[] = []

  for (;;) {
    throwIfAborted(signal)
    budget?.assertWithinDuration()
    await validatePublicRequestTarget(currentUrl, { allowPrivateHost })
    throwIfAborted(signal)
    await beforeOutboundAttempt?.()
    throwIfAborted(signal)
    budget?.consumeFetch()
    await onOutboundAttempt?.({
      kind: outboundAttemptKind,
      method: 'GET',
      url: currentUrl.toString(),
      redirectDepth: redirectChain.length,
    })

    const responseDeadlineAt = Date.now() + timeoutMs
    const response = await timedFetch(currentUrl, { timeoutMs, redirect: 'manual', allowPrivateHost, signal })

    if (!isRedirectStatus(response.status)) {
      return {
        response,
        finalUrl: currentUrl.toString(),
        redirectChain,
        responseDeadlineAt,
      }
    }

    const location = response.headers.get('location')
    if (!location) {
      return {
        response,
        finalUrl: currentUrl.toString(),
        redirectChain,
        responseDeadlineAt,
      }
    }

    if (redirectChain.length >= maxRedirects) {
      throw new AeoAuditError('REDIRECT_LIMIT', `Too many redirects (>${maxRedirects}).`)
    }

    let nextUrl
    try {
      nextUrl = new URL(location, currentUrl)
    } catch {
      throw new AeoAuditError('UNREACHABLE', 'Redirect location is invalid.')
    }

    redirectChain.push({
      status: response.status,
      from: currentUrl.toString(),
      to: nextUrl.toString(),
    })

    if (shouldFollowRedirect && !shouldFollowRedirect(nextUrl)) {
      return {
        response,
        finalUrl: currentUrl.toString(),
        redirectChain,
        responseDeadlineAt,
      }
    }

    if (response.body) void response.body.cancel().catch(() => {})
    currentUrl = nextUrl
  }
}

function looksLikeHtml(sample: string): boolean {
  const normalized = sample.trim().slice(0, 4096).toLowerCase()
  if (!normalized) {
    return false
  }

  return (
    normalized.includes('<!doctype html')
    || normalized.includes('<html')
    || normalized.includes('<head')
    || normalized.includes('<body')
  )
}

function isHtmlContentType(contentType = ''): boolean {
  const normalized = contentType.toLowerCase()
  return HTML_CONTENT_TYPES.some((type) => normalized.includes(type))
}

function isAmbiguousContentType(contentType = ''): boolean {
  const normalized = contentType.toLowerCase()
  return !normalized || AMBIGUOUS_CONTENT_TYPES.some((type) => normalized.includes(type))
}

/**
 * Shared acceptance policy for fetched HTML. Crawls preserve the historical
 * behavior of trusting an explicit HTML content type, while the single-page
 * audit can additionally require a document marker.
 */
export function isHtmlResponse(contentType = '', body = '', requireMarker = false): boolean {
  const htmlByHeader = isHtmlContentType(contentType)
  if (requireMarker) return (htmlByHeader || isAmbiguousContentType(contentType)) && looksLikeHtml(body)
  return htmlByHeader || (isAmbiguousContentType(contentType) && looksLikeHtml(body))
}

function isLikelyTextContent(contentType = '', body = ''): boolean {
  const normalized = contentType.toLowerCase()
  if (!normalized) {
    return !hasDisallowedControlChars(body.slice(0, 2048))
  }

  if (TEXT_LIKE_CONTENT_TYPES.some((type) => normalized.includes(type))) {
    return true
  }

  return false
}

function hasDisallowedControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 9 || code === 10 || code === 13) {
      continue
    }

    if (code < 32) {
      return true
    }
  }

  return false
}

export async function readResponseBodyAsText(response: Response, options: ReadResponseBodyOptions): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) {
    if (options.requireHtmlSniff) {
      throw new AeoAuditError('NOT_HTML', 'Target URL did not return HTML.')
    }
    return ''
  }

  const chunks: Buffer[] = []
  let totalBytes = 0
  let sniffBytes = 0
  let sniffSample = ''
  let sniffed = false
  let completed = false
  let interrupted = false
  let rejectInterruption: (reason: unknown) => void = () => {}
  const interruption = new Promise<never>((_, reject) => { rejectInterruption = reject })
  // A signal may already be aborted before the first reader race is installed.
  // Keep that early rejection handled while preserving it for every Promise.race.
  void interruption.catch(() => {})
  const interrupt = (reason: unknown): void => {
    if (interrupted) return
    interrupted = true
    rejectInterruption(reason)
    try {
      void reader.cancel(reason).catch(() => {})
    } catch {
      // A hostile/custom stream may throw synchronously during best-effort cancellation.
    }
  }
  const abortListener = options.signal ? (): void => interrupt(abortReason(options.signal!)) : null
  if (abortListener) options.signal!.addEventListener('abort', abortListener, { once: true })
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  const expireDeadline = (): void => {
    let reason: unknown
    try {
      reason = options.deadlineError?.() ?? new AeoAuditError('TIMEOUT', 'Response body timed out.')
    } catch (error) {
      reason = error
    }
    interrupt(reason)
  }
  if (options.deadlineAt !== undefined) {
    const remaining = options.deadlineAt - Date.now()
    if (remaining <= 0) expireDeadline()
    else deadlineTimer = setTimeout(expireDeadline, remaining)
  }
  if (options.signal?.aborted) abortListener?.()

  try {
    for (;;) {
      throwIfAborted(options.signal)
      options.beforeRead?.()
      const { done, value } = await Promise.race([reader.read(), interruption])
      if (done) break
      const chunk = Buffer.from(value)
      totalBytes += chunk.length
      if (totalBytes > options.maxBytes) {
        options.onTooLarge?.()
        throw new AeoAuditError(
          'BODY_TOO_LARGE',
          options.tooLargeMessage ?? `Response exceeded ${options.maxBytes} bytes.`,
        )
      }
      options.onChunk?.(chunk.length)
      if (options.requireHtmlSniff && !sniffed) {
        sniffBytes += chunk.length
        if (sniffSample.length < 4096) sniffSample += chunk.toString('utf8')
        if (sniffBytes >= HTML_SNIFF_MIN_BYTES) {
          sniffed = true
          if (!looksLikeHtml(sniffSample)) {
            throw new AeoAuditError('NOT_HTML', 'Target URL did not return HTML.')
          }
        }
      }
      chunks.push(chunk)
    }
    if (options.requireHtmlSniff && !sniffed && !looksLikeHtml(sniffSample)) {
      throw new AeoAuditError('NOT_HTML', 'Target URL did not return HTML.')
    }
    completed = true
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer)
    if (abortListener) options.signal!.removeEventListener('abort', abortListener)
    if (!completed && !interrupted) {
      try {
        void reader.cancel().catch(() => {})
      } catch {
        // Best effort only; cancellation must not become another blocking surface.
      }
    }
  }
}

async function readBodyAsText(response: Response, options: ReadBodyOptions): Promise<string> {
  const { maxBytes, requireHtmlSniff = false, signal, deadlineAt, timeoutMs } = options
  const text = await readResponseBodyAsText(response, {
    maxBytes,
    requireHtmlSniff,
    signal,
    deadlineAt,
    deadlineError: timeoutMs === undefined
      ? undefined
      : () => new AeoAuditError('TIMEOUT', `Request timed out after ${timeoutMs}ms.`),
  })
  return text
}

function classifyAuxiliaryState(spec: AuxiliarySpec, response: Response, bodyText: string): AuxiliaryResourceState {
  const contentType = response.headers.get('content-type') || ''

  if (!response.ok) {
    if (response.status === 404) {
      return 'missing'
    }

    return 'unreachable'
  }

  if (spec.kind === 'text') {
    return isLikelyTextContent(contentType, bodyText) ? 'ok' : 'not-html'
  }

  if (spec.kind === 'xml') {
    if (contentType.toLowerCase().includes('xml')) {
      return 'ok'
    }

    return bodyText.trim().startsWith('<') ? 'ok' : 'not-html'
  }

  return 'ok'
}

interface AuxiliaryFetchAttempt {
  resource: AuxiliaryResource
  /** True when the primary fetch returned 404 — used to decide whether to try fallback paths. */
  wasMissing: boolean
}

async function attemptAuxiliaryFetch(
  origin: string,
  path: string,
  spec: AuxiliarySpec,
  options: FetchPageOptions = {},
): Promise<AuxiliaryFetchAttempt> {
  const startedAt = Date.now()
  const targetUrl = new URL(path, origin)
  const { allowPrivateHost, signal, onOutboundAttempt, budget } = options

  try {
    const { response, finalUrl, redirectChain, responseDeadlineAt } = await fetchWithValidatedRedirects(targetUrl, {
      timeoutMs: AUX_TIMEOUT_MS,
      maxRedirects: MAX_REDIRECTS,
      allowPrivateHost,
      signal,
      onOutboundAttempt,
      budget,
      outboundAttemptKind: 'auxiliary',
    })

    const body = response.ok
      ? await readBodyAsText(response, {
          maxBytes: AUX_MAX_BYTES,
          requireHtmlSniff: false,
          signal,
          deadlineAt: responseDeadlineAt,
          timeoutMs: AUX_TIMEOUT_MS,
        })
      : ''

    const state = classifyAuxiliaryState(spec, response, body)

    return {
      resource: {
        state,
        url: finalUrl,
        statusCode: response.status,
        contentType: response.headers.get('content-type') || '',
        body,
        redirectChain,
        timingMs: Date.now() - startedAt,
      },
      wasMissing: response.status === 404,
    }
  } catch (error) {
    if (isCallerAbort(error, signal) || isFetchBudgetExceededError(error)) {
      throw error
    }

    const knownError = isAeoAuditError(error)
      ? error
      : new AeoAuditError('UNREACHABLE', 'Failed to fetch auxiliary file.', { cause: error })

    if (knownError.code === 'TIMEOUT') {
      return {
        resource: {
          state: 'timeout',
          url: targetUrl.toString(),
          statusCode: null,
          contentType: '',
          body: '',
          redirectChain: [],
          timingMs: Date.now() - startedAt,
        },
        wasMissing: false,
      }
    }

    return {
      resource: {
        state: 'unreachable',
        url: targetUrl.toString(),
        statusCode: null,
        contentType: '',
        body: '',
        redirectChain: [],
        timingMs: Date.now() - startedAt,
        errorCode: knownError.code,
      },
      wasMissing: false,
    }
  }
}

async function probeStatusWithHeaders(
  url: URL | string,
  headers: Record<string, string>,
  options: FetchPageOptions = {},
): Promise<number | null> {
  const startUrl = typeof url === 'string' ? new URL(url) : new URL(url.toString())
  const { allowPrivateHost, signal, onOutboundAttempt, budget } = options
  let currentUrl = startUrl
  let redirects = 0

  for (;;) {
    let response: Response
    try {
      throwIfAborted(signal)
      budget?.assertWithinDuration()
      await validatePublicRequestTarget(currentUrl, { allowPrivateHost })
      throwIfAborted(signal)
      budget?.consumeFetch()
      await onOutboundAttempt?.({
        kind: 'diagnostic',
        method: 'GET',
        url: currentUrl.toString(),
        redirectDepth: redirects,
      })
      response = await timedFetch(currentUrl, {
        timeoutMs: DIAGNOSTIC_TIMEOUT_MS,
        headers,
        redirect: 'manual',
        allowPrivateHost,
        signal,
      })
    } catch (error) {
      if (isCallerAbort(error, signal) || isFetchBudgetExceededError(error)) {
        throw error
      }
      return null
    }

    if (!isRedirectStatus(response.status)) {
      try {
        await response.body?.cancel()
      } catch {
        /* ignore */
      }
      return response.status
    }

    const location = response.headers.get('location')
    if (!location || redirects >= MAX_REDIRECTS) {
      return response.status
    }

    try {
      currentUrl = new URL(location, currentUrl)
    } catch {
      return null
    }
    redirects += 1
  }
}

async function fetchAuxiliaryFile(origin: string, spec: AuxiliarySpec, options: FetchPageOptions = {}): Promise<AuxiliaryResource> {
  let attempt = await attemptAuxiliaryFetch(origin, spec.path, spec, options)

  // Issue #32: if the primary path 404s, try the documented fallbacks (e.g.
  // /sitemap-index.xml). The first successful fallback wins.
  if (attempt.wasMissing && spec.fallbackPaths?.length) {
    for (const fallback of spec.fallbackPaths) {
      const fallbackAttempt = await attemptAuxiliaryFetch(origin, fallback, spec, options)
      if (!fallbackAttempt.wasMissing && fallbackAttempt.resource.state === 'ok') {
        attempt = fallbackAttempt
        break
      }
    }
  }

  const diagnostics: AuxiliaryDiagnostics = {}

  // Issues #34/#35: when the file responds OK, probe once with `Accept: text/markdown`
  // to detect content-negotiation 404 traps that hide the file from AI tools.
  // Some Vercel/Astro/Starlight stacks 307 .txt → non-existent .md when the
  // request prefers markdown — the file is "missing" only to clients that
  // advertise a markdown preference. The probe surfaces this so users can fix
  // the negotiation rule, not the file.
  if (attempt.resource.state === 'ok' && attempt.resource.url) {
    const probeStatus = await probeStatusWithHeaders(attempt.resource.url, {
      'User-Agent': USER_AGENT,
      Accept: MARKDOWN_PROBE_ACCEPT,
    }, options)
    if (probeStatus !== null && (probeStatus < 200 || probeStatus >= 400)) {
      diagnostics.contentNegotiation = true
    }
  }

  if (diagnostics.contentNegotiation) {
    attempt.resource.diagnostics = diagnostics
  }

  return attempt.resource
}

export interface FetchPageOptions {
  skipAuxiliary?: boolean
  /** Permit this single host to resolve to a private/loopback IP. See RunAeoAuditOptions.allowPrivateHost. */
  allowPrivateHost?: string
  signal?: AbortSignal
  onOutboundAttempt?: AeoAuditOutboundAttemptObserver
  budget?: FetchBudgetController
}

export async function fetchPage(rawUrl: string, options: FetchPageOptions = {}): Promise<FetchedPage> {
  const startedAt = Date.now()
  throwIfAborted(options.signal)
  const normalizedUrl = normalizeTargetUrl(rawUrl)
  const { allowPrivateHost, signal, onOutboundAttempt, budget } = options

  const { response, finalUrl, redirectChain, responseDeadlineAt } = await fetchWithValidatedRedirects(normalizedUrl, {
    timeoutMs: MAIN_TIMEOUT_MS,
    maxRedirects: MAX_REDIRECTS,
    allowPrivateHost,
    signal,
    onOutboundAttempt,
    budget,
    outboundAttemptKind: 'page',
  })

  const contentType = response.headers.get('content-type') || ''
  const htmlByHeader = isHtmlContentType(contentType)
  const requireHtmlSniff = !htmlByHeader || isAmbiguousContentType(contentType)

  if (!htmlByHeader && !isAmbiguousContentType(contentType)) {
    if (response.body) {
      try {
        void response.body.cancel().catch(() => {})
      } catch {
        // Best effort only; preserve the stable NOT_HTML error below.
      }
    }
    throw new AeoAuditError('NOT_HTML', 'Target URL did not return HTML.', {
      details: { contentType },
    })
  }

  const html = await readBodyAsText(response, {
    maxBytes: MAIN_MAX_BYTES,
    requireHtmlSniff,
    signal,
    deadlineAt: responseDeadlineAt,
    timeoutMs: MAIN_TIMEOUT_MS,
  })

  if (!isHtmlResponse(contentType, html, true)) {
    throw new AeoAuditError('NOT_HTML', 'Target URL did not return HTML.', {
      details: { contentType },
    })
  }

  const auxiliaryFetchStartedAt = Date.now()
  let auxiliary: Record<string, AuxiliaryResource> = {}
  if (!options.skipAuxiliary) {
    const origin = new URL(finalUrl).origin
    const auxiliaryEntries = await Promise.all(
      AUXILIARY_SPECS.map(async (spec): Promise<[keyof AuxiliaryResources, AuxiliaryResource]> => {
        const result = await fetchAuxiliaryFile(origin, spec, options)
        return [spec.key, result]
      }),
    )
    auxiliary = Object.fromEntries(auxiliaryEntries) as Record<string, AuxiliaryResource>
  }

  return {
    inputUrl: normalizedUrl.toString(),
    finalUrl,
    html,
    headers: Object.fromEntries(response.headers.entries()),
    redirectChain,
    auxiliary,
    timings: {
      fetchTimeMs: Date.now() - startedAt,
      mainFetchMs: auxiliaryFetchStartedAt - startedAt,
      auxiliaryFetchMs: Date.now() - auxiliaryFetchStartedAt,
    },
  }
}

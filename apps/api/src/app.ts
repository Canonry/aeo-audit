import { join } from 'node:path'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { runAeoAudit, runSitemapAudit, type AuditReport, type SitemapAuditReport } from '@ainyc/aeo-audit'
import { extractAuditKey } from './auth/bearer.js'
import { AuditKeyBridge, hashAuditKey, type ActiveAuditKey, type BridgeResult } from './auth/bridge.js'
import { ClientAbortError, RequestContainment, SaturatedError } from './service/containment.js'
import type { AuditApiConfig } from './service/config.js'
import { mapEngineError } from './service/error-map.js'
import { auditRequestSchema, buildAuditOptions, buildSitemapOptions, sitemapRequestSchema } from './service/options.js'
import { UsageStore, type AuditEndpoint, type UsageSnapshot } from './service/quota.js'

interface BridgeValidator {
  validateHash(keyHash: string): Promise<BridgeResult>
}

interface UsageRepository {
  reserve(agencyId: string, endpoint: AuditEndpoint): ReturnType<UsageStore['reserve']>
  refundEndpoint(agencyId: string, endpoint: AuditEndpoint): UsageSnapshot
  getUsage(agencyId: string): UsageSnapshot
  close?(): void
}

interface Containment {
  acquire(keyHash: string, weight: number, signal?: AbortSignal): Promise<() => void>
}

interface AuditEngine {
  audit(url: string, options: Parameters<typeof runAeoAudit>[1]): Promise<AuditReport>
  sitemap(url: string, options: Parameters<typeof runSitemapAudit>[1]): Promise<SitemapAuditReport>
}

export interface BuildAppOptions {
  config: AuditApiConfig
  bridge?: BridgeValidator
  usage?: UsageRepository
  containment?: Containment
  engine?: AuditEngine
  logger?: boolean
}

interface AuthContext {
  keyHash: string
  key: ActiveAuditKey
}

class RequestDeadlineError extends Error {
  constructor() {
    super('The audit deadline elapsed.')
    this.name = 'RequestDeadlineError'
  }
}

const ERROR_MESSAGES: Record<string, string> = {
  INVALID_REQUEST: 'Invalid request body.',
  UNKNOWN_KEY: 'The audit API key is unknown.',
  REVOKED_KEY: 'The audit API key has been revoked.',
  AUTH_RATE_LIMITED: 'Too many new API keys are being validated. Try again shortly.',
  VALIDATION_UNAVAILABLE: 'API key validation is temporarily unavailable.',
  QUOTA_EXCEEDED: 'The agency daily audit allowance has been reached.',
  SATURATED: 'Audit capacity is temporarily saturated.',
  INVALID_URL: 'Enter a valid HTTP or HTTPS URL.',
  TARGET_BLOCKED: 'The target resolves to a blocked or private address.',
  TARGET_UNREACHABLE: 'The target could not be reached.',
  TARGET_TIMEOUT: 'The target audit timed out.',
  TARGET_TOO_LARGE: 'The target response is too large.',
  TARGET_NOT_HTML: 'The target did not return HTML.',
  TOO_MANY_REDIRECTS: 'The target exceeded the redirect limit.',
  SITEMAP_INVALID: 'No valid sitemap could be audited.',
  INTERNAL: 'An internal error occurred.',
}

function sendError(reply: FastifyReply, status: number, code: string): FastifyReply {
  return reply.code(status).send({ error: ERROR_MESSAGES[code] ?? ERROR_MESSAGES.INTERNAL, code })
}

function setQuotaHeaders(reply: FastifyReply, snapshot: UsageSnapshot, endpoint: AuditEndpoint): void {
  const endpointUsage = endpoint === 'audit' ? snapshot.audit : snapshot.sitemapAudit
  reply.header('X-RateLimit-Limit', endpointUsage.limit)
  reply.header('X-RateLimit-Remaining', endpointUsage.remaining)
  reply.header('X-RateLimit-Reset', snapshot.resetEpochSeconds)
  reply.header('X-RateLimit-Attempt-Limit', snapshot.requests.limit)
  reply.header('X-RateLimit-Attempt-Remaining', snapshot.requests.remaining)
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const { config } = options
  const ownedUsage = options.usage ? null : new UsageStore(join(config.dataDir, 'usage.db'), {
    requests: config.requestDailyLimit,
    audit: config.auditDailyLimit,
    sitemap: config.sitemapDailyLimit,
  })
  const usage = options.usage ?? ownedUsage!
  const bridge = options.bridge ?? new AuditKeyBridge({
    baseUrl: config.bridgeUrl,
    secret: config.bridgeSecret,
    timeoutMs: config.bridgeTimeoutMs,
    cacheCapacity: config.bridgeCacheCapacity,
    activeTtlMs: config.bridgeActiveTtlMs,
    unknownTtlMs: config.bridgeUnknownTtlMs,
    admissionPerMinute: config.bridgeAdmissionPerMinute,
  })
  const containment = options.containment ?? new RequestContainment({
    capacity: config.globalCapacity,
    queueSize: config.queueSize,
    queueWaitMs: config.queueWaitMs,
    perKeyConcurrency: config.perKeyConcurrency,
  })
  const engine = options.engine ?? {
    audit: runAeoAudit,
    sitemap: runSitemapAudit,
  }

  const app = Fastify({
    logger: options.logger === false ? false : {
      redact: {
        paths: ['req.headers.authorization', 'request.headers.authorization', 'headers.authorization'],
        censor: '[REDACTED]',
      },
    },
  })

  if (ownedUsage) app.addHook('onClose', async () => ownedUsage.close())

  app.get('/health', async () => ({ status: 'ok' as const }))

  async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<AuthContext | null> {
    const rawKey = extractAuditKey(request)
    if (!rawKey) {
      sendError(reply, 401, 'UNKNOWN_KEY')
      return null
    }
    const keyHash = hashAuditKey(rawKey)
    const result = await bridge.validateHash(keyHash)
    switch (result.status) {
      case 'active':
        return { keyHash, key: result }
      case 'revoked':
        sendError(reply, 403, 'REVOKED_KEY')
        return null
      case 'unknown':
        sendError(reply, 401, 'UNKNOWN_KEY')
        return null
      case 'rate_limited':
        sendError(reply, 429, 'AUTH_RATE_LIMITED')
        return null
      case 'unavailable':
        sendError(reply, 503, 'VALIDATION_UNAVAILABLE')
        return null
    }
  }

  app.get('/v1/me', async (request, reply) => {
    const auth = await authenticate(request, reply)
    if (!auth) return reply
    const snapshot = usage.getUsage(auth.key.agencyId)
    return reply.send({
      key: {
        id: auth.key.keyId,
        name: auth.key.name,
        prefix: auth.key.keyPrefix,
        createdAt: auth.key.createdAt,
        lastUsedAt: auth.key.lastUsedAt,
      },
      agency: { id: auth.key.agencyId },
      usage: {
        date: snapshot.date,
        resetsAt: snapshot.resetsAt,
        requests: snapshot.requests,
        audit: snapshot.audit,
        sitemapAudit: snapshot.sitemapAudit,
      },
    })
  })

  async function runPost(
    request: FastifyRequest,
    reply: FastifyReply,
    endpoint: AuditEndpoint,
  ): Promise<FastifyReply> {
    const auth = await authenticate(request, reply)
    if (!auth) return reply

    const parsed = endpoint === 'audit'
      ? auditRequestSchema.safeParse(request.body)
      : sitemapRequestSchema.safeParse(request.body)
    if (!parsed.success) return sendError(reply, 400, 'INVALID_REQUEST')

    const caller = new AbortController()
    const onAborted = () => caller.abort(new ClientAbortError())
    request.raw.once('aborted', onAborted)
    let release: (() => void) | null = null
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null
    let deadlineExceeded = false
    let snapshot: UsageSnapshot | null = null
    let httpAttemptsStarted = 0
    try {
      const weight = endpoint === 'audit' ? config.singleWeight : config.sitemapWeight
      release = await containment.acquire(auth.keyHash, weight, caller.signal)
      const reservation = usage.reserve(auth.key.agencyId, endpoint)
      snapshot = reservation.snapshot
      if (!reservation.ok) {
        setQuotaHeaders(reply, snapshot, endpoint)
        const retryAfter = Math.max(1, snapshot.resetEpochSeconds - Math.floor(Date.now() / 1_000))
        reply.header('Retry-After', retryAfter)
        return sendError(reply, 429, 'QUOTA_EXCEEDED')
      }

      let signal = caller.signal
      if (endpoint === 'audit') {
        const deadline = new AbortController()
        deadlineTimer = setTimeout(() => {
          deadlineExceeded = true
          deadline.abort(new RequestDeadlineError())
        }, config.singleMaxDurationMs)
        signal = AbortSignal.any([caller.signal, deadline.signal])
      }
      const runtime = {
        signal,
        onOutboundAttempt: () => { httpAttemptsStarted += 1 },
      }

      const report = endpoint === 'audit'
        ? await engine.audit(parsed.data.url, buildAuditOptions(runtime))
        : await engine.sitemap(parsed.data.url, buildSitemapOptions(
          parsed.data,
          runtime,
          { maxTotalFetches: config.sitemapMaxFetches, maxDurationMs: config.sitemapMaxDurationMs },
        ))
      setQuotaHeaders(reply, snapshot, endpoint)
      return reply.code(200).send(report)
    } catch (error) {
      if (snapshot && httpAttemptsStarted === 0) {
        try {
          snapshot = usage.refundEndpoint(auth.key.agencyId, endpoint)
        } catch (refundError) {
          request.log.error({ err: refundError }, 'quota endpoint refund failed')
        }
      }
      if (snapshot) setQuotaHeaders(reply, snapshot, endpoint)
      if (error instanceof SaturatedError) return sendError(reply, 503, 'SATURATED')
      if (deadlineExceeded || error instanceof RequestDeadlineError) return sendError(reply, 504, 'TARGET_TIMEOUT')
      if (caller.signal.aborted || error instanceof ClientAbortError) return reply
      const mapped = mapEngineError(error)
      if (mapped.code === 'INTERNAL') request.log.error({ err: error }, 'audit execution failed')
      return sendError(reply, mapped.status, mapped.code)
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer)
      release?.()
      request.raw.removeListener('aborted', onAborted)
    }
  }

  app.post('/v1/audit', async (request, reply) => runPost(request, reply, 'audit'))
  app.post('/v1/sitemap-audit', async (request, reply) => runPost(request, reply, 'sitemap'))

  app.setErrorHandler((error, _request, reply) => {
    if (typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 400) {
      sendError(reply, 400, 'INVALID_REQUEST')
      return
    }
    sendError(reply, 500, 'INTERNAL')
  })

  return app
}

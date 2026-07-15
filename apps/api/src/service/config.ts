import { accessSync, constants, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'

const DEFAULTS = {
  port: 8080,
  bridgeTimeoutMs: 3_000,
  bridgeCacheCapacity: 10_000,
  bridgeActiveTtlMs: 60_000,
  bridgeUnknownTtlMs: 10_000,
  bridgeAdmissionPerMinute: 60,
  auditDailyLimit: 100,
  sitemapDailyLimit: 10,
  requestDailyLimit: 500,
  globalCapacity: 8,
  singleWeight: 1,
  sitemapWeight: 4,
  perKeyConcurrency: 2,
  queueSize: 32,
  queueWaitMs: 10_000,
  sitemapMaxFetches: 256,
  sitemapMaxDurationMs: 240_000,
  singleMaxDurationMs: 30_000,
  hostRequestTimeoutMs: 300_000,
} as const

const positiveInteger = z.number().int().positive()

const configSchema = z.object({
  port: positiveInteger.max(65_535),
  bindHost: z.enum(['0.0.0.0', '127.0.0.1']),
  bridgeUrl: z.string().url(),
  bridgeSecret: z.string().min(32),
  dataDir: z.string().min(1),
  bridgeTimeoutMs: positiveInteger.max(30_000),
  bridgeCacheCapacity: positiveInteger.max(100_000),
  bridgeActiveTtlMs: positiveInteger.max(300_000),
  bridgeUnknownTtlMs: positiveInteger.max(60_000),
  bridgeAdmissionPerMinute: positiveInteger.max(10_000),
  auditDailyLimit: positiveInteger,
  sitemapDailyLimit: positiveInteger,
  requestDailyLimit: positiveInteger,
  globalCapacity: positiveInteger.max(128),
  singleWeight: positiveInteger,
  sitemapWeight: positiveInteger,
  perKeyConcurrency: positiveInteger.max(100),
  queueSize: positiveInteger.max(10_000),
  queueWaitMs: positiveInteger.max(60_000),
  sitemapMaxFetches: positiveInteger.max(10_000),
  sitemapMaxDurationMs: positiveInteger.max(600_000),
  singleMaxDurationMs: positiveInteger.max(120_000),
  hostRequestTimeoutMs: positiveInteger.max(900_000),
}).strict().superRefine((value, ctx) => {
  if (value.singleWeight > value.globalCapacity) {
    ctx.addIssue({ code: 'custom', path: ['singleWeight'], message: 'must not exceed global capacity' })
  }
  if (value.sitemapWeight > value.globalCapacity) {
    ctx.addIssue({ code: 'custom', path: ['sitemapWeight'], message: 'must not exceed global capacity' })
  }
  if (value.requestDailyLimit < Math.max(value.auditDailyLimit, value.sitemapDailyLimit)) {
    ctx.addIssue({ code: 'custom', path: ['requestDailyLimit'], message: 'must cover each endpoint limit' })
  }
  if (value.queueWaitMs + value.sitemapMaxDurationMs >= value.hostRequestTimeoutMs) {
    ctx.addIssue({ code: 'custom', path: ['hostRequestTimeoutMs'], message: 'must exceed queue wait plus sitemap deadline' })
  }
  if (value.queueWaitMs + value.singleMaxDurationMs >= value.hostRequestTimeoutMs) {
    ctx.addIssue({ code: 'custom', path: ['hostRequestTimeoutMs'], message: 'must exceed queue wait plus single deadline' })
  }
})

export type AuditApiConfig = z.infer<typeof configSchema>

function readInteger(source: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = source[name]
  if (raw === undefined || raw === '') return fallback
  if (!/^[0-9]+$/.test(raw)) return Number.NaN
  return Number(raw)
}

function assertBridgeUrlAllowed(value: string, source: NodeJS.ProcessEnv): void {
  const url = new URL(value)
  if (url.protocol === 'https:') return

  const localMode = source.NODE_ENV === 'test'
    || source.NODE_ENV === 'development'
    || source.AEO_AUDIT_AGENT_NODE === '1'
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname)
  if (url.protocol !== 'http:' || !localMode || !loopback) {
    throw new Error('FLEET_AUDIT_BRIDGE_URL must use HTTPS outside loopback agent-node/development/test mode')
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AuditApiConfig {
  const dataDir = resolve(source.AEO_AUDIT_DATA_DIR || './data')
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  accessSync(dataDir, constants.R_OK | constants.W_OK)

  const bridgeUrl = source.FLEET_AUDIT_BRIDGE_URL || ''
  assertBridgeUrlAllowed(bridgeUrl, source)

  return configSchema.parse({
    port: readInteger(source, 'PORT', readInteger(source, 'API_PORT', DEFAULTS.port)),
    bindHost: source.AEO_AUDIT_BIND || '0.0.0.0',
    bridgeUrl,
    bridgeSecret: source.FLEET_AUDIT_SVC_SECRET || '',
    dataDir,
    bridgeTimeoutMs: readInteger(source, 'AUDIT_BRIDGE_TIMEOUT_MS', DEFAULTS.bridgeTimeoutMs),
    bridgeCacheCapacity: readInteger(source, 'AUDIT_BRIDGE_CACHE_CAPACITY', DEFAULTS.bridgeCacheCapacity),
    bridgeActiveTtlMs: readInteger(source, 'AUDIT_BRIDGE_ACTIVE_TTL_MS', DEFAULTS.bridgeActiveTtlMs),
    bridgeUnknownTtlMs: readInteger(source, 'AUDIT_BRIDGE_UNKNOWN_TTL_MS', DEFAULTS.bridgeUnknownTtlMs),
    bridgeAdmissionPerMinute: readInteger(source, 'AUDIT_BRIDGE_ADMISSION_PER_MINUTE', DEFAULTS.bridgeAdmissionPerMinute),
    auditDailyLimit: readInteger(source, 'AUDIT_SINGLE_DAILY_LIMIT', DEFAULTS.auditDailyLimit),
    sitemapDailyLimit: readInteger(source, 'AUDIT_SITEMAP_DAILY_LIMIT', DEFAULTS.sitemapDailyLimit),
    requestDailyLimit: readInteger(source, 'AUDIT_REQUEST_DAILY_LIMIT', DEFAULTS.requestDailyLimit),
    globalCapacity: readInteger(source, 'AUDIT_GLOBAL_CAPACITY', DEFAULTS.globalCapacity),
    singleWeight: readInteger(source, 'AUDIT_SINGLE_WEIGHT', DEFAULTS.singleWeight),
    sitemapWeight: readInteger(source, 'AUDIT_SITEMAP_WEIGHT', DEFAULTS.sitemapWeight),
    perKeyConcurrency: readInteger(source, 'AUDIT_PER_KEY_CONCURRENCY', DEFAULTS.perKeyConcurrency),
    queueSize: readInteger(source, 'AUDIT_QUEUE_SIZE', DEFAULTS.queueSize),
    queueWaitMs: readInteger(source, 'AUDIT_QUEUE_WAIT_MS', DEFAULTS.queueWaitMs),
    sitemapMaxFetches: readInteger(source, 'AUDIT_SITEMAP_MAX_FETCHES', DEFAULTS.sitemapMaxFetches),
    sitemapMaxDurationMs: readInteger(source, 'AUDIT_SITEMAP_MAX_DURATION_MS', DEFAULTS.sitemapMaxDurationMs),
    singleMaxDurationMs: readInteger(source, 'AUDIT_SINGLE_MAX_DURATION_MS', DEFAULTS.singleMaxDurationMs),
    hostRequestTimeoutMs: readInteger(source, 'AUDIT_HOST_REQUEST_TIMEOUT_MS', DEFAULTS.hostRequestTimeoutMs),
  })
}

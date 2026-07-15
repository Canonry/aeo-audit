import { createHash } from 'node:crypto'
import { z } from 'zod'

const timestampSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => !Number.isNaN(Date.parse(value)))

const activeSchema = z.object({
  status: z.literal('active'),
  keyId: z.string().min(1),
  agencyId: z.string().min(1),
  name: z.string().min(1),
  keyPrefix: z.string().regex(/^aak_[0-9a-f]{4}$/),
  createdAt: timestampSchema,
  lastUsedAt: timestampSchema.nullable(),
}).strict()

const revokedSchema = z.object({
  status: z.literal('revoked'),
  keyId: z.string().min(1),
}).strict()

const unknownSchema = z.object({ status: z.literal('unknown') }).strict()
const bridgeSchema = z.discriminatedUnion('status', [activeSchema, revokedSchema, unknownSchema])

export type ActiveAuditKey = z.infer<typeof activeSchema>
export type BridgeValidation = z.infer<typeof bridgeSchema>
export type BridgeResult = BridgeValidation | { status: 'unavailable' } | { status: 'rate_limited' }

export interface BridgeClientOptions {
  baseUrl: string
  secret: string
  timeoutMs: number
  cacheCapacity: number
  activeTtlMs: number
  unknownTtlMs: number
  admissionPerMinute: number
  fetch?: typeof globalThis.fetch
  now?: () => number
}

interface CacheEntry {
  expiresAt: number
  value: BridgeValidation
}

export function hashAuditKey(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex')
}

export class AuditKeyBridge {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inFlight = new Map<string, Promise<BridgeResult>>()
  private readonly admissionTimes: number[] = []
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly now: () => number

  constructor(private readonly options: BridgeClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
  }

  async validate(rawKey: string): Promise<BridgeResult> {
    return this.validateHash(hashAuditKey(rawKey))
  }

  async validateHash(keyHash: string): Promise<BridgeResult> {
    const cached = this.getCached(keyHash)
    if (cached) return cached

    const existing = this.inFlight.get(keyHash)
    if (existing) return existing

    if (!this.reserveAdmission()) return { status: 'rate_limited' }

    const request = this.requestValidation(keyHash)
    this.inFlight.set(keyHash, request)
    try {
      return await request
    } finally {
      this.inFlight.delete(keyHash)
    }
  }

  private getCached(keyHash: string): BridgeValidation | null {
    const entry = this.cache.get(keyHash)
    if (!entry) return null
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(keyHash)
      return null
    }
    this.cache.delete(keyHash)
    this.cache.set(keyHash, entry)
    return entry.value
  }

  private reserveAdmission(): boolean {
    const cutoff = this.now() - 60_000
    while (this.admissionTimes.length > 0 && this.admissionTimes[0] <= cutoff) {
      this.admissionTimes.shift()
    }
    if (this.admissionTimes.length >= this.options.admissionPerMinute) return false
    this.admissionTimes.push(this.now())
    return true
  }

  private async requestValidation(keyHash: string): Promise<BridgeResult> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs)
    try {
      const response = await this.fetchImpl(new URL('/api/audit-keys/validate', this.options.baseUrl), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.options.secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ keyHash }),
      })
      if (!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
        return { status: 'unavailable' }
      }

      const parsed = bridgeSchema.safeParse(await response.json())
      if (!parsed.success) return { status: 'unavailable' }
      this.putCache(keyHash, parsed.data)
      return parsed.data
    } catch {
      return { status: 'unavailable' }
    } finally {
      clearTimeout(timeout)
    }
  }

  private putCache(keyHash: string, value: BridgeValidation): void {
    const ttl = value.status === 'unknown' ? this.options.unknownTtlMs : this.options.activeTtlMs
    this.cache.set(keyHash, { value, expiresAt: this.now() + ttl })
    while (this.cache.size > this.options.cacheCapacity) {
      const oldest = this.cache.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }
}

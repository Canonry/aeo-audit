import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { AuditKeyBridge, hashAuditKey } from '../src/auth/bridge.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/audit-key-bridge-contract.json', import.meta.url), 'utf8')) as {
  active: Record<string, unknown>
}
const rawKey = `aak_${'01'.repeat(32)}`

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function client(fetchImpl: typeof fetch, extras: Partial<ConstructorParameters<typeof AuditKeyBridge>[0]> = {}) {
  return new AuditKeyBridge({
    baseUrl: 'https://platform.example.com',
    secret: 's'.repeat(32),
    timeoutMs: 1_000,
    cacheCapacity: 2,
    activeTtlMs: 60_000,
    unknownTtlMs: 10_000,
    admissionPerMinute: 10,
    fetch: fetchImpl,
    ...extras,
  })
}

describe('platform key bridge', () => {
  it('hashes locally, sends only the frozen wire request, and caches active metadata', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response(fixture.active))
    const bridge = client(fetchImpl)

    await expect(bridge.validate(rawKey)).resolves.toMatchObject({ status: 'active', agencyId: 'agency_01' })
    await expect(bridge.validate(rawKey)).resolves.toMatchObject({ status: 'active' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('https://platform.example.com/api/audit-keys/validate')
    expect(init?.headers).toEqual({ Authorization: `Bearer ${'s'.repeat(32)}`, 'Content-Type': 'application/json' })
    expect(JSON.parse(String(init?.body))).toEqual({ keyHash: hashAuditKey(rawKey) })
    expect(hashAuditKey(rawKey)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('single-flights misses and fails closed on malformed success responses', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      await gate
      return response({ ...fixture.active, extra: true })
    })
    const bridge = client(fetchImpl)
    const first = bridge.validate(rawKey)
    const second = bridge.validate(rawKey)
    release()

    await expect(first).resolves.toEqual({ status: 'unavailable' })
    await expect(second).resolves.toEqual({ status: 'unavailable' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('bounds distinct cache misses before making bridge calls', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response({ status: 'unknown' }))
    const bridge = client(fetchImpl, { admissionPerMinute: 1 })

    await expect(bridge.validate(`aak_${'01'.repeat(32)}`)).resolves.toEqual({ status: 'unknown' })
    await expect(bridge.validate(`aak_${'02'.repeat(32)}`)).resolves.toEqual({ status: 'rate_limited' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

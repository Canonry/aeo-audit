import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { UsageStore } from '../src/service/quota.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function store() {
  const dir = mkdtempSync(join(tmpdir(), 'aeo-audit-quota-'))
  dirs.push(dir)
  return new UsageStore(join(dir, 'usage.db'), { requests: 3, audit: 2, sitemap: 1 }, () => new Date('2026-07-15T12:00:00.000Z'))
}

describe('agency quota', () => {
  it('atomically reserves request and endpoint counters for the whole agency', () => {
    const usage = store()
    expect(usage.reserve('agency-1', 'audit')).toMatchObject({ ok: true, snapshot: { requests: { used: 1 }, audit: { used: 1 } } })
    expect(usage.reserve('agency-1', 'audit')).toMatchObject({ ok: true, snapshot: { requests: { used: 2 }, audit: { used: 2 } } })
    expect(usage.reserve('agency-1', 'audit')).toMatchObject({ ok: false, reason: 'audit', snapshot: { requests: { used: 2 } } })
    expect(usage.reserve('agency-1', 'sitemap')).toMatchObject({ ok: true, snapshot: { requests: { used: 3 }, sitemapAudit: { used: 1 } } })
    expect(usage.reserve('agency-1', 'sitemap')).toMatchObject({ ok: false, reason: 'requests' })
    usage.close()
  })

  it('refunds only the endpoint unit while retaining the attempt', () => {
    const usage = store()
    usage.reserve('agency-1', 'audit')
    const snapshot = usage.refundEndpoint('agency-1', 'audit')
    expect(snapshot.audit.used).toBe(0)
    expect(snapshot.requests.used).toBe(1)
    expect(snapshot.date).toBe('2026-07-15')
    expect(snapshot.resetsAt).toBe('2026-07-16T00:00:00.000Z')
    usage.close()
  })
})

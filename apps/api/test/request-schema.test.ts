import { describe, expect, it } from 'vitest'
import { auditRequestSchema, buildAuditOptions, buildSitemapOptions, sitemapRequestSchema } from '../src/service/options.js'

describe('public request projection', () => {
  it('rejects unknown engine knobs and validates sitemap limits', () => {
    expect(auditRequestSchema.safeParse({ url: 'https://example.com', includeLighthouse: true }).success).toBe(false)
    expect(sitemapRequestSchema.safeParse({ url: 'https://example.com', limit: 0 }).success).toBe(false)
    expect(sitemapRequestSchema.safeParse({ url: 'https://example.com', limit: 1.5 }).success).toBe(false)
    expect(sitemapRequestSchema.safeParse({ url: 'https://example.com', limit: '2' }).success).toBe(false)
  })

  it('constructs only server-owned engine options and clamps the public maximum to 25', () => {
    const runtime = { signal: new AbortController().signal, onOutboundAttempt: () => undefined }
    expect(Object.keys(buildAuditOptions(runtime)).sort()).toEqual(['onOutboundAttempt', 'signal'])
    expect(buildSitemapOptions({ url: 'https://example.com', limit: 50 }, runtime, {
      maxTotalFetches: 100,
      maxDurationMs: 1_000,
    })).toMatchObject({ limit: 25, maxTotalFetches: 100, maxDurationMs: 1_000 })
  })
})

import { z } from 'zod'
import type { RunAeoAuditOptions, SitemapAuditOptions } from '@ainyc/aeo-audit'

export const auditRequestSchema = z.object({
  url: z.string(),
}).strict()

export const sitemapRequestSchema = z.object({
  url: z.string(),
  limit: z.number().int().positive().optional(),
}).strict()

export type AuditRequest = z.infer<typeof auditRequestSchema>
export type SitemapRequest = z.infer<typeof sitemapRequestSchema>

export interface AuditRuntime {
  signal: AbortSignal
  onOutboundAttempt: () => void
}

export interface SitemapCeilings {
  maxTotalFetches: number
  maxDurationMs: number
}

export function buildAuditOptions(runtime: AuditRuntime): RunAeoAuditOptions {
  return {
    signal: runtime.signal,
    onOutboundAttempt: runtime.onOutboundAttempt,
  }
}

export function buildSitemapOptions(
  request: SitemapRequest,
  runtime: AuditRuntime,
  ceilings: SitemapCeilings,
): SitemapAuditOptions {
  return {
    limit: Math.min(request.limit ?? 25, 25),
    maxTotalFetches: ceilings.maxTotalFetches,
    maxDurationMs: ceilings.maxDurationMs,
    signal: runtime.signal,
    onOutboundAttempt: runtime.onOutboundAttempt,
  }
}

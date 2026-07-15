import Database from 'better-sqlite3'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'

export type AuditEndpoint = 'audit' | 'sitemap'

export interface QuotaLimits {
  requests: number
  audit: number
  sitemap: number
}

export interface UsageSnapshot {
  agencyId: string
  date: string
  resetsAt: string
  resetEpochSeconds: number
  requests: { used: number; limit: number; remaining: number }
  audit: { used: number; limit: number; remaining: number }
  sitemapAudit: { used: number; limit: number; remaining: number }
  version: number
}

export type ReserveResult =
  | { ok: true; snapshot: UsageSnapshot }
  | { ok: false; reason: 'requests' | AuditEndpoint; snapshot: UsageSnapshot }

interface UsageRow {
  agency_id: string
  utc_date: string
  request_attempts: number
  audit_count: number
  sitemap_count: number
  version: number
}

export function utcDateKey(now: Date): string {
  return now.toISOString().slice(0, 10)
}

export function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
}

export class UsageStore {
  private readonly db: Database.Database

  constructor(
    filename: string,
    private readonly limits: QuotaLimits,
    private readonly clock: () => Date = () => new Date(),
  ) {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 })
    this.db = new Database(filename)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_api_usage (
        agency_id TEXT NOT NULL,
        utc_date TEXT NOT NULL,
        request_attempts INTEGER NOT NULL DEFAULT 0 CHECK (request_attempts >= 0),
        audit_count INTEGER NOT NULL DEFAULT 0 CHECK (audit_count >= 0),
        sitemap_count INTEGER NOT NULL DEFAULT 0 CHECK (sitemap_count >= 0),
        version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
        PRIMARY KEY (agency_id, utc_date)
      )
    `)
  }

  reserve(agencyId: string, endpoint: AuditEndpoint): ReserveResult {
    const now = this.clock()
    const date = utcDateKey(now)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.readRow(agencyId, date) ?? this.emptyRow(agencyId, date)
      const endpointUsed = endpoint === 'audit' ? row.audit_count : row.sitemap_count
      const endpointLimit = endpoint === 'audit' ? this.limits.audit : this.limits.sitemap
      if (row.request_attempts >= this.limits.requests) {
        this.db.exec('COMMIT')
        return { ok: false, reason: 'requests', snapshot: this.toSnapshot(row, now) }
      }
      if (endpointUsed >= endpointLimit) {
        this.db.exec('COMMIT')
        return { ok: false, reason: endpoint, snapshot: this.toSnapshot(row, now) }
      }

      const auditIncrement = endpoint === 'audit' ? 1 : 0
      const sitemapIncrement = endpoint === 'sitemap' ? 1 : 0
      this.db.prepare(`
        INSERT INTO audit_api_usage (
          agency_id, utc_date, request_attempts, audit_count, sitemap_count, version
        ) VALUES (?, ?, 1, ?, ?, 1)
        ON CONFLICT (agency_id, utc_date) DO UPDATE SET
          request_attempts = request_attempts + 1,
          audit_count = audit_count + excluded.audit_count,
          sitemap_count = sitemap_count + excluded.sitemap_count,
          version = version + 1
      `).run(agencyId, date, auditIncrement, sitemapIncrement)
      const updated = this.readRow(agencyId, date)
      if (!updated) throw new Error('usage reservation disappeared')
      this.db.exec('COMMIT')
      return { ok: true, snapshot: this.toSnapshot(updated, now) }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  refundEndpoint(agencyId: string, endpoint: AuditEndpoint): UsageSnapshot {
    const now = this.clock()
    const date = utcDateKey(now)
    const column = endpoint === 'audit' ? 'audit_count' : 'sitemap_count'
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        UPDATE audit_api_usage
        SET ${column} = CASE WHEN ${column} > 0 THEN ${column} - 1 ELSE 0 END,
            version = version + 1
        WHERE agency_id = ? AND utc_date = ?
      `).run(agencyId, date)
      const row = this.readRow(agencyId, date) ?? this.emptyRow(agencyId, date)
      this.db.exec('COMMIT')
      return this.toSnapshot(row, now)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getUsage(agencyId: string): UsageSnapshot {
    const now = this.clock()
    const date = utcDateKey(now)
    return this.toSnapshot(this.readRow(agencyId, date) ?? this.emptyRow(agencyId, date), now)
  }

  close(): void {
    this.db.close()
  }

  private readRow(agencyId: string, date: string): UsageRow | undefined {
    return this.db.prepare(`
      SELECT agency_id, utc_date, request_attempts, audit_count, sitemap_count, version
      FROM audit_api_usage WHERE agency_id = ? AND utc_date = ?
    `).get(agencyId, date) as UsageRow | undefined
  }

  private emptyRow(agencyId: string, date: string): UsageRow {
    return {
      agency_id: agencyId,
      utc_date: date,
      request_attempts: 0,
      audit_count: 0,
      sitemap_count: 0,
      version: 0,
    }
  }

  private toSnapshot(row: UsageRow, now: Date): UsageSnapshot {
    const reset = nextUtcMidnight(now)
    const value = (used: number, limit: number) => ({ used, limit, remaining: Math.max(0, limit - used) })
    return {
      agencyId: row.agency_id,
      date: row.utc_date,
      resetsAt: reset.toISOString(),
      resetEpochSeconds: Math.floor(reset.getTime() / 1_000),
      requests: value(row.request_attempts, this.limits.requests),
      audit: value(row.audit_count, this.limits.audit),
      sitemapAudit: value(row.sitemap_count, this.limits.sitemap),
      version: row.version,
    }
  }
}

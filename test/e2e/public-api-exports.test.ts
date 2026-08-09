import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const fixturePath = fileURLToPath(new URL('../../.context/public-api-consumer.ts', import.meta.url))
const tscPath = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url))

test('public root import compiles every hosted-engine export', () => {
  mkdirSync(fileURLToPath(new URL('../../.context', import.meta.url)), { recursive: true })
  writeFileSync(fixturePath, `
import {
  AeoAuditError,
  engineVersion,
  getAeoAuditErrorCode,
  isAeoAuditError,
  isAeoAuditErrorCode,
  runAeoAudit,
  runSiteCrawl,
  runSitemapAudit,
  CRAWL_SCHEMA_VERSION,
  type AeoAuditErrorCode,
  type AeoAuditOutboundAttempt,
  type AeoAuditOutboundAttemptKind,
  type AeoAuditOutboundAttemptObserver,
  type AuditReport,
  type RunAeoAuditOptions,
  type SitemapAuditBudgetMetadata,
  type SitemapAuditMetadata,
  type SitemapAuditOptions,
  type SitemapAuditPartialReason,
  type SitemapAuditReport,
  type CrawlEvent,
  type CrawlWarning,
  type SiteCrawlOptions,
  type SiteCrawlReport,
} from '@ainyc/aeo-audit'

const code: AeoAuditErrorCode = 'BUDGET_EXCEEDED'
const error = new AeoAuditError(code, 'budget spent')
const observedCode: AeoAuditErrorCode | null = getAeoAuditErrorCode(error)
const kind: AeoAuditOutboundAttemptKind = 'sitemap'
const attempt: AeoAuditOutboundAttempt = {
  kind,
  method: 'GET',
  url: 'https://example.com/sitemap.xml',
  redirectDepth: 0,
}
const observer: AeoAuditOutboundAttemptObserver = (outbound) => {
  outbound satisfies AeoAuditOutboundAttempt
}
const controller = new AbortController()
const auditOptions: RunAeoAuditOptions = {
  signal: controller.signal,
  onOutboundAttempt: observer,
}
const sitemapOptions: SitemapAuditOptions = {
  ...auditOptions,
  maxFetches: 10,
  maxDurationMs: 1_000,
}
const crawlOptions: SiteCrawlOptions = {
  ...auditOptions,
  sitemapUrl: 'https://example.com/custom-sitemap.xml',
  maxPages: 100,
  requestDelayMs: 20,
  checkDeadLinks: false,
  onEvent: (event: CrawlEvent) => { event.sequence satisfies number },
}
const warning: CrawlWarning = {
  code: 'root-host-redirect',
  message: 'root moved hosts',
  from: 'https://example.com/',
  to: 'https://www.example.com/',
}
const budget: SitemapAuditBudgetMetadata = {
  maxFetches: 10,
  fetchesStarted: 10,
  maxDurationMs: 1_000,
  elapsedMs: 250,
  pagesQueued: 8,
  pagesCompleted: 6,
  pagesRemaining: 2,
  exhaustedReason: 'fetch-budget-exceeded',
}
const metadata: SitemapAuditMetadata = {
  partial: true,
  budget,
}
const partialReason: SitemapAuditPartialReason = 'duration-budget-exceeded'

void runAeoAudit
void runSitemapAudit
void runSiteCrawl
void crawlOptions
void warning
void CRAWL_SCHEMA_VERSION
void engineVersion
void isAeoAuditError
void isAeoAuditErrorCode
void observedCode
void attempt
void sitemapOptions
void metadata
void partialReason
void (undefined as unknown as AuditReport)
void (undefined as unknown as SitemapAuditReport)
void (undefined as unknown as SiteCrawlReport)
`, 'utf8')

  const result = spawnSync(process.execPath, [
    tscPath,
    '--noEmit',
    '--pretty',
    'false',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--target',
    'ES2022',
    '--lib',
    'ES2022,DOM,DOM.Iterable',
    '--types',
    'node',
    fixturePath,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})

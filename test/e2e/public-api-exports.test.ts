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
  CRAWL_LINK_PLACEMENT_RULESET_VERSION,
  RECOGNIZED_ARIA_ROLES,
  isRecognizedAriaRole,
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
  type CrawlEdgeObservation,
  type CrawlEvent,
  type CrawlLinkPlacement,
  type CrawlPlacementOccurrences,
  type CrawlSummary,
  type CrawlWarning,
  type SiteCrawlOptions,
  type SiteCrawlReport,
} from '@canonry/aeo-audit'

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
const placement: CrawlLinkPlacement = 'content'
const placementOccurrences: CrawlPlacementOccurrences = { navigation: 1, content: 1, unknown: 0 }
// A graph captured before the placement ruleset has no placement data. This
// literal fails to compile (TS2741) if the added field is required, which is
// what makes the addition a minor release rather than a breaking one.
const legacyEdge: CrawlEdgeObservation = {
  key: 'edge:0000',
  from: 'https://example.com/blog/post',
  to: 'https://example.com/service',
  type: 'anchor',
  classification: 'internal',
  totalOccurrences: 2,
  followableOccurrences: 2,
  nofollowOccurrences: 0,
  anchorSummaries: [{ text: 'Service', occurrences: 2 }],
}
const placedEdge: CrawlEdgeObservation = { ...legacyEdge, placementOccurrences }
// Absence is a real state, so reading it has to survive the undefined case.
const inContent: number = placedEdge.placementOccurrences?.[placement] ?? 0
// Same check for the summary field, without restating every required field.
const legacySummary: CrawlSummary = undefined as unknown as Omit<CrawlSummary, 'linkPlacementRulesetVersion'>

// The role registry is part of the documented ruleset, so a consumer can pin to
// it: a predicate for membership and a frozen array for enumeration. There is
// no exported Set, because a Set cannot be frozen and would let a consumer widen
// what the crawler accepts.
const recognizesDpub: boolean = isRecognizedAriaRole('doc-chapter')
const roleCount: number = RECOGNIZED_ARIA_ROLES.length

void runAeoAudit
void legacyEdge
void inContent
void legacySummary
void recognizesDpub
void roleCount
void CRAWL_LINK_PLACEMENT_RULESET_VERSION
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

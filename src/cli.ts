import { readFile, stat, writeFile } from 'node:fs/promises'
import { compareReports, renderCompareMarkdown, DEFAULT_COMPARE_POLICY } from './compare.js'
import { runAeoAudit } from './index.js'
import { runSitemapAudit } from './sitemap.js'
import { runStaticAudit } from './static-audit.js'
import { normalizeTargetUrl } from './fetch-page.js'
import { detectPlatform, detectPlatformBatch } from './detect-platform.js'
import { getChangedRoutePaths, normalizeRoutePath } from './changed-pages.js'
import { AeoAuditError, isAeoAuditError } from './errors.js'
import {
  formatBatchPlatformJson,
  formatJson,
  formatPlatformJson,
  formatSitemapJson,
} from './formatters/json.js'
import {
  formatBatchPlatformMarkdown,
  formatMarkdown,
  formatPlatformMarkdown,
  formatSitemapMarkdown,
} from './formatters/markdown.js'
import {
  formatBatchPlatformText,
  formatPlatformText,
  formatSitemapText,
  formatText,
} from './formatters/text.js'
import { formatAgent, formatSitemapAgent } from './formatters/agent.js'
import type {
  AuditReport,
  BatchPlatformDetectionReport,
  CompareFailOn,
  ComparePolicy,
  PlatformConfidence,
  PlatformDetectionReport,
  ScoredFactor,
  SitemapAuditOptions,
  SitemapAuditReport,
  SitemapPageResult,
} from './types.js'

// `agent` is the slim machine-readable decision (score, pass gate, ranked fixes)
// for audits. Platform-detection output has no decision list, so there `agent`
// falls back to the already-structured JSON.
const FORMATTERS = {
  json: formatJson,
  markdown: formatMarkdown,
  text: formatText,
  agent: formatAgent,
}

const SITEMAP_FORMATTERS = {
  json: (report: SitemapAuditReport, _topIssuesOnly: boolean) => formatSitemapJson(report),
  markdown: (report: SitemapAuditReport, topIssuesOnly: boolean) => formatSitemapMarkdown(report, topIssuesOnly),
  text: (report: SitemapAuditReport, topIssuesOnly: boolean) => formatSitemapText(report, topIssuesOnly),
  agent: (report: SitemapAuditReport, _topIssuesOnly: boolean) => formatSitemapAgent(report),
}

const PLATFORM_FORMATTERS = {
  json: (report: PlatformDetectionReport) => formatPlatformJson(report),
  markdown: (report: PlatformDetectionReport) => formatPlatformMarkdown(report),
  text: (report: PlatformDetectionReport) => formatPlatformText(report),
  agent: (report: PlatformDetectionReport) => formatPlatformJson(report),
}

const BATCH_PLATFORM_FORMATTERS = {
  json: (report: BatchPlatformDetectionReport) => formatBatchPlatformJson(report),
  markdown: (report: BatchPlatformDetectionReport) => formatBatchPlatformMarkdown(report),
  text: (report: BatchPlatformDetectionReport) => formatBatchPlatformText(report),
  agent: (report: BatchPlatformDetectionReport) => formatBatchPlatformJson(report),
}

type FormatterName = keyof typeof FORMATTERS

interface ParsedArgs {
  url: string | null
  format: string
  factors: string[] | null
  includeGeo: boolean
  includeAgentSkills: boolean
  lighthouse: boolean
  help: boolean
  sitemap: boolean
  sitemapUrl: string | null
  limit: number | null
  topIssues: boolean
  detectPlatform: boolean
  minConfidence: PlatformConfidence | null
  urls: string | null
  concurrency: number | null
  requireMeta: boolean
  allowLocal: boolean
  rewriteSitemapOrigin: boolean
  baseUrl: string | null
  changed: boolean
  base: string
  includeCritical: boolean
  criticalPaths: string[] | null
}

function isFormatterName(value: string): value is FormatterName {
  return value in FORMATTERS
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2)
  const result: ParsedArgs = {
    url: null,
    format: 'text',
    factors: null,
    includeGeo: false,
    includeAgentSkills: false,
    lighthouse: false,
    help: false,
    sitemap: false,
    sitemapUrl: null,
    limit: null,
    topIssues: false,
    detectPlatform: false,
    minConfidence: null,
    urls: null,
    concurrency: null,
    requireMeta: false,
    allowLocal: false,
    rewriteSitemapOrigin: false,
    baseUrl: null,
    changed: false,
    base: 'main',
    includeCritical: false,
    criticalPaths: null,
  }

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--format' && args[i + 1]) {
      result.format = args[i + 1]
      i += 1
    } else if (args[i] === '--factors' && args[i + 1]) {
      result.factors = args[i + 1].split(',').map((factor) => factor.trim())
      i += 1
    } else if (args[i] === '--include-geo') {
      result.includeGeo = true
    } else if (args[i] === '--include-agent-skills') {
      result.includeAgentSkills = true
    } else if (args[i] === '--lighthouse') {
      result.lighthouse = true
    } else if (args[i] === '--sitemap') {
      result.sitemap = true
      // Check if the next arg is an explicit sitemap URL (not another flag)
      if (args[i + 1] && !args[i + 1].startsWith('--')) {
        result.sitemapUrl = args[i + 1]
        i += 1
      }
    } else if (args[i] === '--limit' && args[i + 1]) {
      const num = parseInt(args[i + 1], 10)
      if (Number.isFinite(num) && num > 0) {
        result.limit = num
      }
      i += 1
    } else if (args[i] === '--top-issues') {
      result.topIssues = true
    } else if (args[i] === '--detect-platform') {
      result.detectPlatform = true
    } else if (args[i] === '--min-confidence' && args[i + 1]) {
      const value = args[i + 1]
      if (value === 'high' || value === 'medium' || value === 'low') {
        result.minConfidence = value
      }
      i += 1
    } else if (args[i] === '--urls' && args[i + 1]) {
      result.urls = args[i + 1]
      i += 1
    } else if (args[i] === '--concurrency' && args[i + 1]) {
      const num = parseInt(args[i + 1], 10)
      if (Number.isFinite(num) && num > 0) {
        result.concurrency = num
      }
      i += 1
    } else if (args[i] === '--require-meta') {
      result.requireMeta = true
    } else if (args[i] === '--allow-local' || args[i] === '--allow-private') {
      result.allowLocal = true
    } else if (args[i] === '--rewrite-sitemap-origin') {
      result.rewriteSitemapOrigin = true
    } else if (args[i] === '--base-url' && args[i + 1]) {
      result.baseUrl = args[i + 1]
      i += 1
    } else if (args[i] === '--changed') {
      result.changed = true
    } else if (args[i] === '--base' && args[i + 1]) {
      result.base = args[i + 1]
      i += 1
    } else if (args[i] === '--include-critical') {
      result.includeCritical = true
    } else if (args[i] === '--critical-paths' && args[i + 1]) {
      result.criticalPaths = args[i + 1]
        .split(',')
        .map((path) => path.trim())
        .filter((path) => path.length > 0)
      i += 1
    } else if (args[i] === '--help' || args[i] === '-h') {
      result.help = true
    } else if (!args[i].startsWith('-')) {
      result.url = args[i]
    }
  }

  return result
}

export function hasMissingMetaDescription(factors: ScoredFactor[] | undefined): boolean {
  if (!factors) return false
  const tech = factors.find((f) => f.id === 'technical-seo')
  if (!tech) return false
  // Key on the stable finding code rather than the message prefix — that's the
  // whole point of finding codes: gates don't break when copy changes.
  return tech.findings.some((f) => f.code === 'technical-seo.meta-description.missing')
}

export function parseUrlList(text: string): string[] {
  const urls: string[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    // Allow comma-separated values on a single line too.
    for (const part of line.split(',')) {
      const candidate = part.trim()
      if (candidate.length > 0) urls.push(candidate)
    }
  }
  return urls
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf-8')
}

async function resolveUrls(spec: string): Promise<string[]> {
  if (spec === '-') {
    return parseUrlList(await readStdin())
  }
  if (spec.startsWith('http://') || spec.startsWith('https://')) {
    return parseUrlList(spec)
  }
  const text = await readFile(spec, 'utf-8')
  return parseUrlList(text)
}

/**
 * Decide whether the positional argument is a filesystem path (static-output mode)
 * rather than a URL. An explicit `http(s)://` scheme is always a URL; a leading
 * `.`/`/`/`~` or a path that exists on disk is treated as a static target.
 */
async function isStaticTarget(arg: string): Promise<boolean> {
  if (/^https?:\/\//i.test(arg)) return false
  if (/^[./~]/.test(arg)) return true
  try {
    await stat(arg)
    return true
  } catch {
    return false
  }
}

/** Build the --require-meta failure message for a multi-page report, or null if all pages pass. */
function sitemapMetaFailureMessage(pages: SitemapPageResult[]): string | null {
  const missingPages = pages.filter(
    (p) => p.status === 'success' && hasMissingMetaDescription(p.factors),
  )
  if (missingPages.length === 0) return null
  return `Error: --require-meta failed. ${missingPages.length} page(s) missing <meta name="description">: ${missingPages
    .slice(0, 3)
    .map((p) => p.url)
    .join(', ')}${missingPages.length > 3 ? ` (+${missingPages.length - 3} more)` : ''}`
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => normalizeRoutePath(path)))]
}

async function resolveChangedIncludePaths(args: ParsedArgs): Promise<string[]> {
  const changedPaths = await getChangedRoutePaths({ base: args.base })
  const criticalPaths = args.includeCritical ? (args.criticalPaths ?? ['/']) : []
  return uniquePaths([...changedPaths, ...criticalPaths])
}

function printHelp() {
  console.log(`
Usage: aeo-audit <url|path> [options]
       aeo-audit compare --current <file> [--baseline <file>] [options]

Pass a URL to audit a live site, or a filesystem path (a .html file or a
directory of built HTML, e.g. ./out) to audit static output offline.

The 'compare' subcommand diffs two --format json reports into a regression
verdict (run 'aeo-audit compare --help' for its options).

Options:
  --format <type>         Output format: text (default), json, markdown, agent.
                          'agent' emits a slim JSON decision (score, pass gate,
                          criticalDefectCount, ranked issues[]) for AI agents —
                          none of the per-factor/per-page detail.
  --factors <list>        Comma-separated factor IDs to run (runs all if omitted)
  --include-geo           Include optional geographic signals factor
  --include-agent-skills  Include optional agent skill exposure factor (Schema.org Action, MCP, form affordances)
  --lighthouse            Include optional Lighthouse factor (Performance + Accessibility + Best Practices,
                          mobile strategy) via Google PageSpeed Insights. Adds ~15-30s per audit. Set
                          PAGESPEED_API_KEY to lift anonymous rate limits. Single-URL only (cannot combine
                          with --sitemap or --detect-platform).
  --sitemap [url]         Audit all pages from sitemap. Auto-discovery tries /sitemap.xml, then
                          /sitemap-index.xml, then the Sitemap: directive in /robots.txt. Pass an
                          explicit URL to override. Pages are fetched with bounded concurrency (5).
  --limit <n>             Max pages to audit in sitemap mode (default 200, sorted by sitemap priority).
                          When the sitemap exceeds the limit, a notice is printed to stderr.
  --top-issues            In sitemap mode, skip per-page output and show only the cross-cutting
                          issues and critical defects
  --detect-platform       Detect what platform/CMS/framework the site is built on (WordPress,
                          Webflow, Shopify, Next.js, etc.) instead of running a full audit.
  --urls <src>            In --detect-platform mode, run on multiple URLs. <src> can be a path
                          to a text file (one URL per line, # comments allowed), a comma-separated
                          list (e.g. https://a.com,https://b.com), or - to read from stdin.
  --concurrency <n>       In --detect-platform batch mode, max in-flight fetches (default 5).
  --min-confidence <lvl>  In platform-detect mode, only report platforms at or above this
                          confidence level: low (default), medium, high.
  --require-meta          Exit 1 if any audited page is missing <meta name="description">,
                          regardless of overall score. Works in single-URL, sitemap, and
                          static-output modes.
  --allow-local           Allow the target host you named on the CLI to resolve to a
  (alias --allow-private) private/loopback IP (e.g. http://localhost:3000). Scoped to that
                          one host only: redirects and sitemap <loc>s pointing at any other
                          private host stay blocked. For auditing your own dev/staging server.
  --rewrite-sitemap-origin
                          In --sitemap mode, rewrite every <loc>'s origin to the target URL's
                          origin before crawling (preserving path/query). Use when a sitemap
                          hardcodes the prod/canonical domain but you want to audit a staging
                          host or local dev server that serves the same paths.
  --changed               With --sitemap, audit only static routes changed since --base.
                          Dynamic route templates are skipped because concrete URL params
                          cannot be inferred safely from the file path alone.
  --base <ref>            Git base ref for --changed (default main).
  --include-critical      With --changed, also audit critical paths (default /).
  --critical-paths <list> Comma-separated critical paths for --include-critical.
  --base-url <url>        In static-output mode, base URL used to map files to page URLs
                          (e.g. out/about/index.html -> <base>/about/). Default https://localhost.
  -h, --help              Show this help message

Examples:
  aeo-audit https://example.com
  aeo-audit https://example.com --format json
  aeo-audit https://example.com --format agent
  aeo-audit https://example.com --sitemap --format agent
  aeo-audit https://example.com --factors structured-data,faq-content
  aeo-audit https://example.com --factors schema-validity
  aeo-audit https://example.com --include-geo
  aeo-audit https://example.com --include-agent-skills
  aeo-audit https://example.com --lighthouse
  PAGESPEED_API_KEY=xxx aeo-audit https://example.com --lighthouse --format json
  aeo-audit https://example.com --sitemap
  aeo-audit https://example.com --sitemap https://example.com/sitemap.xml
  aeo-audit https://example.com --sitemap --limit 10
  aeo-audit https://example.com --sitemap --top-issues
  aeo-audit https://example.com --require-meta
  aeo-audit https://example.com --sitemap --require-meta
  aeo-audit http://localhost:3000 --allow-local
  aeo-audit http://localhost:3000 --sitemap --rewrite-sitemap-origin --allow-local
  aeo-audit http://localhost:3000 --sitemap --rewrite-sitemap-origin --allow-local --changed --base main --include-critical
  aeo-audit https://staging.example.com --sitemap --rewrite-sitemap-origin
  aeo-audit ./out
  aeo-audit ./out --base-url https://example.com --require-meta
  aeo-audit ./dist/index.html
  aeo-audit https://example.com --detect-platform
  aeo-audit https://example.com --detect-platform --format json
  aeo-audit https://example.com --detect-platform --min-confidence medium
  aeo-audit --detect-platform --urls urls.txt
  aeo-audit --detect-platform --urls https://a.com,https://b.com --format json
  cat urls.txt | aeo-audit --detect-platform --urls -
  aeo-audit https://example.com --format json > current.json
  aeo-audit compare --baseline baseline.json --current current.json

Exit codes (audit/sitemap/static modes): 0 when score >= 70, 1 otherwise. In sitemap and
static-directory modes, the aggregate score is used.
In --detect-platform mode, exit code is 0 if any platform is detected, 1 otherwise.
In --detect-platform batch mode, exit code is 0 if at least one URL succeeded, 1 otherwise.
With --require-meta, exit is 1 if any audited page is missing <meta name="description">,
regardless of the score-based rule above.
For the 'compare' subcommand: 0 = no regression / improvement / no-baseline, 1 = regression,
2 = misconfiguration. See 'aeo-audit compare --help'.
`)
}

/* ── compare subcommand ───────────────────────────────────────────────────
 * `aeo-audit compare` diffs two report JSONs (a baseline and a current run) into
 * a regression verdict. It reads pre-existing reports and runs NO audit, so it is
 * dispatched before the audit if-chain in `main()` and has its own arg grammar.
 * stdout carries ONLY the machine output (JSON unless --format markdown); every
 * diagnostic goes to stderr so a consumer can pipe stdout straight into a parser.
 * Exit: 0 = no regression / improvement / no-baseline, 1 = regression, 2 = misconfig.
 */
interface CompareArgs {
  baseline: string | null
  current: string | null
  format: 'json' | 'markdown'
  mdOut: string | null
  policy: ComparePolicy
  help: boolean
  error: string | null
}

function parseCompareArgs(argv: string[]): CompareArgs {
  const args = argv.slice(3) // drop node, script, 'compare'
  const result: CompareArgs = {
    baseline: null,
    current: null,
    format: 'json',
    mdOut: null,
    policy: { ...DEFAULT_COMPARE_POLICY, failOn: [] },
    help: false,
    error: null,
  }

  const readNumber = (raw: string, flag: string): number | null => {
    const num = Number(raw)
    if (!Number.isFinite(num) || num < 0) {
      result.error = `Invalid value for ${flag}: "${raw}" (expected a non-negative number).`
      return null
    }
    return num
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--baseline' && args[i + 1]) {
      result.baseline = args[i + 1]
      i += 1
    } else if (arg === '--current' && args[i + 1]) {
      result.current = args[i + 1]
      i += 1
    } else if (arg === '--format' && args[i + 1]) {
      const value = args[i + 1]
      if (value !== 'json' && value !== 'markdown') {
        result.error = `Unknown compare format "${value}". Use: json, markdown.`
      } else {
        result.format = value
      }
      i += 1
    } else if (arg === '--md-out' && args[i + 1]) {
      result.mdOut = args[i + 1]
      i += 1
    } else if (arg === '--overall-tolerance' && args[i + 1]) {
      const n = readNumber(args[i + 1], arg)
      if (n !== null) result.policy.overallTolerance = n
      i += 1
    } else if (arg === '--page-tolerance' && args[i + 1]) {
      const n = readNumber(args[i + 1], arg)
      if (n !== null) result.policy.pageTolerance = n
      i += 1
    } else if (arg === '--factor-tolerance' && args[i + 1]) {
      const n = readNumber(args[i + 1], arg)
      if (n !== null) result.policy.factorTolerance = n
      i += 1
    } else if (arg === '--fail-on-new-critical') {
      result.policy.failOnNewCritical = true
    } else if (arg === '--no-fail-on-new-critical') {
      result.policy.failOnNewCritical = false
    } else if (arg === '--fail-on' && args[i + 1]) {
      for (const raw of args[i + 1].split(',')) {
        const token = raw.trim()
        if (token === 'removed-pages' || token === 'warnings') {
          if (!result.policy.failOn.includes(token)) result.policy.failOn.push(token as CompareFailOn)
        } else if (token.length > 0) {
          result.error = `Unknown --fail-on value "${token}". Use: removed-pages, warnings.`
        }
      }
      i += 1
    } else if (arg === '--on-missing-baseline' && args[i + 1]) {
      const value = args[i + 1]
      if (value === 'warn' || value === 'fail') {
        result.policy.onMissingBaseline = value
      } else {
        result.error = `Unknown --on-missing-baseline value "${value}". Use: warn, fail.`
      }
      i += 1
    } else if (arg === '--report-only') {
      result.policy.reportOnly = true
    } else if (arg === '--strict-comparability') {
      result.policy.strictComparability = true
    } else if (arg === '--help' || arg === '-h') {
      result.help = true
    } else {
      result.error = `Unknown compare argument: "${arg}".`
    }
  }

  return result
}

function printCompareHelp(): void {
  console.log(`
Usage: aeo-audit compare --current <file> [--baseline <file>] [options]

Diff two aeo-audit JSON reports (produced with --format json) into a regression
verdict and a non-zero exit code. Single (AuditReport) and multi-page
(SitemapAuditReport) reports are both supported; the two sides must be the same
mode. Runs no audit and touches no network.

Options:
  --current <file>          Current run's --format json report (required).
  --baseline <file>         Baseline --format json report to compare against.
                            Omit for a first run (result: no-baseline).
  --overall-tolerance <n>   Max overall/aggregate score drop before failing (default 2).
  --page-tolerance <n>      Max single-page score drop before failing (default 5).
  --factor-tolerance <n>    Max single-factor score drop before failing (default 8).
  --fail-on-new-critical    Fail on a new severity:critical defect (default on).
  --no-fail-on-new-critical Do not fail on new critical defects.
  --fail-on <list>          Promote report-only dimensions to failures:
                            removed-pages, warnings (comma-separated).
  --on-missing-baseline <m> warn (default) | fail — behaviour when no baseline.
  --report-only             Compute and print the diff but never exit non-zero.
  --strict-comparability    Treat a factor-set or major engine-version mismatch as a
                            misconfiguration (exit 2) instead of a non-gating warning.
                            Use for committed/artifact baselines.
  --md-out <file>           Also write a human Markdown summary to this file.
  --format <type>           stdout format: json (default) or markdown.
  -h, --help                Show this help message.

Exit code: 0 no regression / improvement / no-baseline, 1 regression,
2 misconfiguration (report-mode mismatch, incomparable factor-set/engine under
--strict-comparability, unreadable/invalid report files). --report-only always 0.

Examples:
  aeo-audit https://example.com --format json > current.json
  aeo-audit compare --baseline baseline.json --current current.json
  aeo-audit compare --baseline base.json --current cur.json --overall-tolerance 0 --md-out diff.md
  aeo-audit compare --baseline base.json --current cur.json --strict-comparability --fail-on removed-pages
`)
}

async function readReport(path: string): Promise<AuditReport | SitemapAuditReport> {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    throw new AeoAuditError('COMPARE_MISCONFIG', `Could not read report file: ${path}`)
  }
  try {
    return JSON.parse(raw) as AuditReport | SitemapAuditReport
  } catch {
    throw new AeoAuditError('COMPARE_MISCONFIG', `Report file is not valid JSON: ${path}`)
  }
}

export async function mainCompare(argv: string[]): Promise<number> {
  const args = parseCompareArgs(argv)

  if (args.help) {
    printCompareHelp()
    return 0
  }
  if (args.error) {
    console.error(`Error: ${args.error}`)
    return 2
  }
  if (!args.current) {
    console.error('Error: compare requires --current <file>. Run "aeo-audit compare --help" for usage.')
    return 2
  }

  try {
    const current = await readReport(args.current)
    const baseline = args.baseline ? await readReport(args.baseline) : null

    const report = compareReports(baseline, current, args.policy)

    if (args.mdOut) {
      await writeFile(args.mdOut, renderCompareMarkdown(report), 'utf-8')
    }

    // stdout: machine output ONLY.
    console.log(args.format === 'markdown' ? renderCompareMarkdown(report) : JSON.stringify(report, null, 2))

    // Human context to stderr so it never corrupts the parsed stdout.
    for (const warning of report.warnings) console.error(`Warning: ${warning}`)
    for (const reason of report.failReasons) console.error(`Regression: ${reason}`)

    if (report.result === 'no-baseline' && report.verdict === 'pass') {
      console.error('No baseline supplied — nothing to compare against (first run).')
    }

    return report.verdict === 'fail' ? 1 : 0
  } catch (error) {
    if (isAeoAuditError(error) && error.code === 'COMPARE_MISCONFIG') {
      console.error(`Error [COMPARE_MISCONFIG]: ${error.message}`)
      return 2
    }
    if (isAeoAuditError(error)) {
      console.error(`Error [${error.code}]: ${error.message}`)
    } else if (error instanceof Error) {
      console.error(`Error: ${error.message}`)
    } else {
      console.error(`Error: ${String(error)}`)
    }
    return 2
  }
}

export async function main(argv: string[] = process.argv): Promise<number> {
  // `compare` reads reports rather than auditing, so it dispatches before the
  // audit arg parser (which would otherwise swallow the bare "compare" token as a
  // positional URL).
  if (argv[2] === 'compare') {
    return mainCompare(argv)
  }

  const args = parseArgs(argv)

  if (args.help) {
    printHelp()
    return 0
  }

  if (!isFormatterName(args.format)) {
    console.error(`Error: Unknown format "${args.format}". Use: text, json, markdown, agent`)
    return 1
  }

  if (args.urls && !args.detectPlatform) {
    console.error('Error: --urls is only supported with --detect-platform.')
    return 1
  }

  if (args.lighthouse && args.sitemap) {
    console.error('Error: --lighthouse cannot be combined with --sitemap. Each Lighthouse audit takes 15-30s and would blow up sitemap runtime. Run --lighthouse on individual URLs instead.')
    return 1
  }

  if (args.lighthouse && args.detectPlatform) {
    console.error('Error: --lighthouse cannot be combined with --detect-platform.')
    return 1
  }

  if (args.rewriteSitemapOrigin && !args.sitemap) {
    console.error('Error: --rewrite-sitemap-origin only applies to --sitemap mode.')
    return 1
  }

  if (args.changed && !args.sitemap) {
    console.error('Error: --changed only applies to --sitemap mode, where concrete URLs can be selected from the sitemap.')
    return 1
  }

  try {
    // Static-output mode: the positional arg is a filesystem path, audited offline.
    if (args.url && (await isStaticTarget(args.url))) {
      if (args.detectPlatform || args.sitemap || args.lighthouse || args.factors?.includes('lighthouse')) {
        console.error(
          'Error: a filesystem path (static-output mode) cannot be combined with --detect-platform, --sitemap, or Lighthouse (--lighthouse or --factors lighthouse). Those modes need a live URL.',
        )
        return 1
      }

      const result = await runStaticAudit(args.url, {
        factors: args.factors,
        includeGeo: args.includeGeo,
        includeAgentSkills: args.includeAgentSkills,
        baseUrl: args.baseUrl ?? undefined,
        limit: args.limit ?? undefined,
        topIssuesOnly: args.topIssues,
        onPlan: (plan) => {
          if (plan.truncated > 0) {
            console.error(
              `Notice: ${plan.discovered} HTML files found; auditing ${plan.willAudit} sampled across the site's URL templates (--limit ${plan.effectiveLimit}). ${plan.truncated} skipped. Pass --limit ${Math.max(plan.discovered, 9999)} to audit all.`,
            )
          }
        },
      })

      if (result.kind === 'single') {
        console.log(FORMATTERS[args.format](result.report))
        if (args.requireMeta && hasMissingMetaDescription(result.report.factors)) {
          console.error(`Error: --require-meta failed. Page is missing <meta name="description">: ${result.report.finalUrl}`)
          return 1
        }
        return result.report.overallScore >= 70 ? 0 : 1
      }

      console.log(SITEMAP_FORMATTERS[args.format](result.report, args.topIssues))
      if (args.requireMeta) {
        const message = sitemapMetaFailureMessage(result.report.pages)
        if (message) {
          console.error(message)
          return 1
        }
      }
      return result.report.aggregateScore >= 70 ? 0 : 1
    }

    if (args.detectPlatform) {
      if (args.urls) {
        if (args.url) {
          console.error('Error: cannot combine a positional URL with --urls. Use one or the other.')
          return 1
        }

        const urls = await resolveUrls(args.urls)
        if (urls.length === 0) {
          console.error('Error: no URLs found in --urls input.')
          return 1
        }

        const batch = await detectPlatformBatch(urls, {
          minConfidence: args.minConfidence ?? undefined,
          concurrency: args.concurrency ?? undefined,
        })
        const batchFormatter = BATCH_PLATFORM_FORMATTERS[args.format]
        console.log(batchFormatter(batch))
        return batch.successful > 0 ? 0 : 1
      }

      if (!args.url) {
        console.error('Error: URL is required (or pass --urls <file|->|<url1,url2>). Run with --help for usage.')
        return 1
      }

      const report = await detectPlatform(args.url, {
        minConfidence: args.minConfidence ?? undefined,
      })
      const platformFormatter = PLATFORM_FORMATTERS[args.format]
      console.log(platformFormatter(report))
      return report.detected.length > 0 ? 0 : 1
    }

    if (!args.url) {
      console.error('Error: URL is required. Run with --help for usage.')
      return 1
    }

    // --allow-local relaxes the private-host guard for the exact host the user
    // named — and only that host. Derived here from the positional target so a
    // redirect or sitemap <loc> to any other private host is still blocked.
    const allowPrivateHost = args.allowLocal ? normalizeTargetUrl(args.url).hostname : undefined

    if (args.sitemap) {
      const includePaths = args.changed ? await resolveChangedIncludePaths(args) : undefined
      if (args.changed && (!includePaths || includePaths.length === 0)) {
        console.error('Error: --changed found no static route files. Dynamic route templates cannot be mapped to concrete URLs without route params; use --include-critical/--critical-paths or audit explicit URLs.')
        return 1
      }
      if (includePaths) {
        console.error(`Notice: --changed selected ${includePaths.length} sitemap path(s): ${includePaths.join(', ')}`)
      }

      const options: SitemapAuditOptions = {
        factors: args.factors,
        includeGeo: args.includeGeo,
        includeAgentSkills: args.includeAgentSkills,
        sitemapUrl: args.sitemapUrl ?? undefined,
        limit: args.limit ?? undefined,
        topIssuesOnly: args.topIssues,
        rewriteOrigin: args.rewriteSitemapOrigin,
        includePaths,
        allowPrivateHost,
        onPlan: (plan) => {
          if (plan.childSitemapsSkipped > 0) {
            console.error(
              `Notice: sitemap index exceeded the child-sitemap safety cap; ${plan.childSitemapsSkipped} child sitemap(s) were not fetched.`,
            )
          }
          if (plan.truncated > 0) {
            console.error(
              `Notice: sitemap has ${plan.discovered} URLs; auditing ${plan.willAudit} sampled across the site's URL templates, highest <priority> first within each (--limit ${plan.effectiveLimit}). ${plan.truncated} pages skipped. Pass --limit ${Math.max(plan.discovered, 9999)} to audit all.`,
            )
          }
        },
      }

      const report = await runSitemapAudit(args.url, options)
      const sitemapFormatter = SITEMAP_FORMATTERS[args.format]
      console.log(sitemapFormatter(report, args.topIssues))

      if (args.requireMeta) {
        const message = sitemapMetaFailureMessage(report.pages)
        if (message) {
          console.error(message)
          return 1
        }
      }

      return report.aggregateScore >= 70 ? 0 : 1
    }

    const formatter = FORMATTERS[args.format]
    const report = await runAeoAudit(args.url, {
      factors: args.factors,
      includeGeo: args.includeGeo,
      includeAgentSkills: args.includeAgentSkills,
      includeLighthouse: args.lighthouse,
      allowPrivateHost,
    })

    console.log(formatter(report))

    if (args.requireMeta && hasMissingMetaDescription(report.factors)) {
      console.error(`Error: --require-meta failed. Page is missing <meta name="description">: ${report.finalUrl}`)
      return 1
    }

    return report.overallScore >= 70 ? 0 : 1
  } catch (error) {
    if (isAeoAuditError(error)) {
      console.error(`Error [${error.code}]: ${error.message}`)
    } else if (error instanceof Error) {
      console.error(`Error: ${error.message}`)
    } else {
      console.error(`Error: ${String(error)}`)
    }

    return 1
  }
}

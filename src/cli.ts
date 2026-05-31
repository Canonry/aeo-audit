import { readFile, stat } from 'node:fs/promises'
import { runAeoAudit } from './index.js'
import { runSitemapAudit } from './sitemap.js'
import { runStaticAudit } from './static-audit.js'
import { normalizeTargetUrl } from './fetch-page.js'
import { detectPlatform, detectPlatformBatch } from './detect-platform.js'
import { isAeoAuditError } from './errors.js'
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
import type {
  BatchPlatformDetectionReport,
  PlatformConfidence,
  PlatformDetectionReport,
  ScoredFactor,
  SitemapAuditOptions,
  SitemapAuditReport,
  SitemapPageResult,
} from './types.js'

const FORMATTERS = {
  json: formatJson,
  markdown: formatMarkdown,
  text: formatText,
}

const SITEMAP_FORMATTERS = {
  json: (report: SitemapAuditReport, _topIssuesOnly: boolean) => formatSitemapJson(report),
  markdown: (report: SitemapAuditReport, topIssuesOnly: boolean) => formatSitemapMarkdown(report, topIssuesOnly),
  text: (report: SitemapAuditReport, topIssuesOnly: boolean) => formatSitemapText(report, topIssuesOnly),
}

const PLATFORM_FORMATTERS = {
  json: (report: PlatformDetectionReport) => formatPlatformJson(report),
  markdown: (report: PlatformDetectionReport) => formatPlatformMarkdown(report),
  text: (report: PlatformDetectionReport) => formatPlatformText(report),
}

const BATCH_PLATFORM_FORMATTERS = {
  json: (report: BatchPlatformDetectionReport) => formatBatchPlatformJson(report),
  markdown: (report: BatchPlatformDetectionReport) => formatBatchPlatformMarkdown(report),
  text: (report: BatchPlatformDetectionReport) => formatBatchPlatformText(report),
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
  return tech.findings.some(
    (f) => f.type === 'missing' && f.message.startsWith('No meta description found'),
  )
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

function printHelp() {
  console.log(`
Usage: aeo-audit <url|path> [options]

Pass a URL to audit a live site, or a filesystem path (a .html file or a
directory of built HTML, e.g. ./out) to audit static output offline.

Options:
  --format <type>         Output format: text (default), json, markdown
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
  --top-issues            In sitemap mode, skip per-page output and show only cross-cutting issues
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
  --base-url <url>        In static-output mode, base URL used to map files to page URLs
                          (e.g. out/about/index.html -> <base>/about/). Default https://localhost.
  -h, --help              Show this help message

Examples:
  aeo-audit https://example.com
  aeo-audit https://example.com --format json
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

Exit code: 0 when score >= 70, 1 otherwise. In sitemap and static-directory modes, the aggregate score is used.
In --detect-platform mode, exit code is 0 if any platform is detected, 1 otherwise.
In --detect-platform batch mode, exit code is 0 if at least one URL succeeded, 1 otherwise.
With --require-meta, exit is 1 if any audited page is missing <meta name="description">,
regardless of the score-based rule above.
`)
}

export async function main(argv: string[] = process.argv): Promise<number> {
  const args = parseArgs(argv)

  if (args.help) {
    printHelp()
    return 0
  }

  if (!isFormatterName(args.format)) {
    console.error(`Error: Unknown format "${args.format}". Use: text, json, markdown`)
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
              `Notice: ${plan.discovered} HTML files found; auditing the first ${plan.willAudit} (--limit ${plan.effectiveLimit}). ${plan.truncated} skipped. Pass --limit ${Math.max(plan.discovered, 9999)} to audit all.`,
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
      const options: SitemapAuditOptions = {
        factors: args.factors,
        includeGeo: args.includeGeo,
        includeAgentSkills: args.includeAgentSkills,
        sitemapUrl: args.sitemapUrl ?? undefined,
        limit: args.limit ?? undefined,
        topIssuesOnly: args.topIssues,
        rewriteOrigin: args.rewriteSitemapOrigin,
        allowPrivateHost,
        onPlan: (plan) => {
          if (plan.truncated > 0) {
            console.error(
              `Notice: sitemap has ${plan.discovered} URLs; auditing top ${plan.willAudit} by priority (--limit ${plan.effectiveLimit}). ${plan.truncated} pages skipped. Pass --limit ${Math.max(plan.discovered, 9999)} to audit all.`,
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

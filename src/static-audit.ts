import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { AeoAuditError } from './errors.js'
import { normalizeTargetUrl } from './fetch-page.js'
import { auditHtmlPage } from './index.js'
import { buildCriticalDefects } from './critical-defects.js'
import { SCHEMA_VERSION, engineVersion } from './schema.js'
import { buildCrossCuttingIssues, buildPrioritizedFixes, mapWithConcurrency, unionFactorIds } from './sitemap.js'
import type {
  AuditReport,
  AuxiliaryResources,
  RunAeoAuditOptions,
  SitemapAuditPlan,
  SitemapAuditReport,
  SitemapPageResult,
} from './types.js'

const DEFAULT_BASE_URL = 'https://localhost'
const DEFAULT_LIMIT = 200
const DEFAULT_CONCURRENCY = 5
const HTML_EXTENSIONS = new Set(['.html', '.htm'])
const IGNORED_DIRS = new Set(['node_modules', '.git'])

interface AuxFileSpec {
  key: keyof AuxiliaryResources
  file: string
  contentType: string
}

// Read the same auxiliary files the network auditor probes, but from disk so
// llms.txt / robots.txt / sitemap.xml checks still work offline in CI.
const AUX_FILE_SPECS: AuxFileSpec[] = [
  { key: 'llmsTxt', file: 'llms.txt', contentType: 'text/plain' },
  { key: 'llmsFullTxt', file: 'llms-full.txt', contentType: 'text/plain' },
  { key: 'robotsTxt', file: 'robots.txt', contentType: 'text/plain' },
  { key: 'sitemapXml', file: 'sitemap.xml', contentType: 'application/xml' },
]

export interface StaticAuditOptions extends RunAeoAuditOptions {
  /**
   * Base URL used to synthesize page URLs from file paths (e.g.
   * `out/about/index.html` → `<baseUrl>/about/`). Improves URL-sensitive factors
   * (canonical, og:url, robots.txt path matching). Treated as an origin; defaults
   * to `https://localhost`.
   */
  baseUrl?: string
  /** Max HTML files to audit when the target is a directory (default 200). */
  limit?: number
  topIssuesOnly?: boolean
  onPlan?: (plan: SitemapAuditPlan) => void
}

/**
 * A single HTML file produces an `AuditReport` (same shape as single-URL mode); a
 * directory produces a `SitemapAuditReport` (same aggregation as sitemap mode).
 */
export type StaticAuditResult =
  | { kind: 'single'; report: AuditReport }
  | { kind: 'multi'; report: SitemapAuditReport }

function resolveBaseUrl(baseUrl?: string): URL {
  return baseUrl ? normalizeTargetUrl(baseUrl) : new URL(DEFAULT_BASE_URL)
}

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/')
}

/**
 * Map a file path (relative to the audited root) to a URL under `baseUrl`.
 * `index.html` collapses to its directory with a trailing slash; other files drop
 * the `.html`/`.htm` extension to mirror how static hosts serve clean URLs.
 */
export function staticFileToUrl(relPath: string, baseUrl: URL): string {
  const posix = toPosix(relPath)
  const ext = path.posix.extname(posix).toLowerCase()
  const withoutExt = ext ? posix.slice(0, -ext.length) : posix
  const segments = withoutExt.split('/').filter((segment) => segment !== '')

  let urlPath: string
  if (segments[segments.length - 1] === 'index') {
    segments.pop()
    urlPath = segments.length > 0 ? `/${segments.join('/')}/` : '/'
  } else {
    urlPath = `/${segments.join('/')}`
  }

  return new URL(urlPath || '/', baseUrl).toString()
}

async function readDiskAuxiliary(dir: string, baseUrl: URL): Promise<AuxiliaryResources> {
  const auxiliary: AuxiliaryResources = {}

  for (const spec of AUX_FILE_SPECS) {
    const url = new URL(`/${spec.file}`, baseUrl).toString()
    try {
      const body = await readFile(path.join(dir, spec.file), 'utf-8')
      auxiliary[spec.key] = {
        state: 'ok',
        url,
        statusCode: 200,
        contentType: spec.contentType,
        body,
        redirectChain: [],
        timingMs: 0,
      }
    } catch {
      auxiliary[spec.key] = {
        state: 'missing',
        url,
        statusCode: 404,
        contentType: '',
        body: '',
        redirectChain: [],
        timingMs: 0,
      }
    }
  }

  return auxiliary
}

async function walkHtmlFiles(root: string): Promise<string[]> {
  const found: string[] = []

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      // Skip symlinks to avoid traversal loops and escaping the audited tree.
      if (entry.isSymbolicLink()) continue

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        await walk(path.join(dir, entry.name))
      } else if (entry.isFile() && HTML_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        found.push(path.join(dir, entry.name))
      }
    }
  }

  await walk(root)
  return found
}

async function auditOneFile(
  absFile: string,
  url: string,
  auxiliary: AuxiliaryResources,
  options: RunAeoAuditOptions,
): Promise<AuditReport> {
  const startedAt = Date.now()
  const html = await readFile(absFile, 'utf-8')

  return auditHtmlPage(
    {
      inputUrl: url,
      finalUrl: url,
      html,
      headers: {},
      redirectChain: [],
      auxiliary,
      fetchTimeMs: Date.now() - startedAt,
    },
    options,
  )
}

/**
 * Audit built HTML directly from disk — no network. A single `.html` file returns
 * one report; a directory is walked for `.html`/`.htm` files and aggregated like a
 * sitemap run. Coverage is partial by nature: server-only signals (redirects,
 * `X-Robots-Tag`, `Last-Modified`, `Link` headers) aren't visible from static
 * files, so factors that depend on them score as if the header were absent.
 */
export async function runStaticAudit(targetPath: string, options: StaticAuditOptions = {}): Promise<StaticAuditResult> {
  const resolved = path.resolve(targetPath)

  let stats
  try {
    stats = await stat(resolved)
  } catch {
    throw new AeoAuditError('BAD_INPUT', `Path not found: ${targetPath}`)
  }

  const baseUrl = resolveBaseUrl(options.baseUrl)

  if (stats.isFile()) {
    if (!HTML_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
      throw new AeoAuditError(
        'BAD_INPUT',
        `Not an HTML file: ${targetPath}. Static mode audits a .html/.htm file or a directory of them.`,
      )
    }

    const auxiliary = await readDiskAuxiliary(path.dirname(resolved), baseUrl)
    const url = staticFileToUrl(path.basename(resolved), baseUrl)
    const report = await auditOneFile(resolved, url, auxiliary, options)
    return { kind: 'single', report }
  }

  if (!stats.isDirectory()) {
    throw new AeoAuditError('BAD_INPUT', `Unsupported path: ${targetPath}. Expected an HTML file or a directory.`)
  }

  // Directory mode: audit every HTML file and aggregate like a sitemap run.
  const auxiliary = await readDiskAuxiliary(resolved, baseUrl)
  const files = (await walkHtmlFiles(resolved)).sort()
  const discovered = files.length

  if (discovered === 0) {
    throw new AeoAuditError('BAD_INPUT', `No .html files found under ${targetPath}.`)
  }

  const effectiveLimit = options.limit && options.limit > 0 ? options.limit : DEFAULT_LIMIT
  const selected = files.slice(0, effectiveLimit)
  const truncated = discovered - selected.length

  options.onPlan?.({
    discovered,
    filtered: 0,
    truncated,
    willAudit: selected.length,
    effectiveLimit,
    // Static mode reads local files; there is no sitemap index to fan out from.
    childSitemapsSkipped: 0,
  })

  const auditOptions: RunAeoAuditOptions = {
    factors: options.factors,
    includeGeo: options.includeGeo,
    includeAgentSkills: options.includeAgentSkills,
  }

  const settled = await mapWithConcurrency(
    selected,
    DEFAULT_CONCURRENCY,
    async (absFile): Promise<{ pageResult: SitemapPageResult; report: AuditReport | null }> => {
      const url = staticFileToUrl(path.relative(resolved, absFile), baseUrl)
      try {
        const report = await auditOneFile(absFile, url, auxiliary, auditOptions)
        return {
          pageResult: {
            url: report.finalUrl,
            overallScore: report.overallScore,
            status: 'success',
            factors: report.factors,
            metadata: report.metadata,
          },
          report,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          pageResult: { url, overallScore: 0, status: 'error', error: message },
          report: null,
        }
      }
    },
  )

  const pageResults: SitemapPageResult[] = settled.map((s) => s.pageResult)
  const successReports: AuditReport[] = settled
    .map((s) => s.report)
    .filter((r): r is AuditReport => r !== null)

  const successScores = pageResults.filter((p) => p.status === 'success').map((p) => p.overallScore)
  const aggregateScore = successScores.length > 0
    ? Math.round(successScores.reduce((a, b) => a + b, 0) / successScores.length)
    : 0

  // Static output has no sitemap <priority>, so the rollup ranks by homepage
  // (derived from the file path → URL) only — no priority map is passed.
  const criticalDefects = buildCriticalDefects(successReports)
  const crossCuttingIssues = buildCrossCuttingIssues(successReports)
  const prioritizedFixes = buildPrioritizedFixes(crossCuttingIssues, successReports.length, criticalDefects, successReports)

  const report: SitemapAuditReport = {
    schemaVersion: SCHEMA_VERSION,
    compareMeta: {
      engineVersion: engineVersion(),
      factorIds: unionFactorIds(successReports),
    },
    sitemapUrl: resolved,
    auditedAt: new Date().toISOString(),
    pagesDiscovered: discovered,
    pagesAudited: selected.length,
    pagesSkipped: truncated,
    pagesFiltered: 0,
    pagesTruncated: truncated,
    effectiveLimit,
    aggregateScore,
    pages: pageResults,
    criticalDefects,
    crossCuttingIssues,
    prioritizedFixes,
    budget: { exhausted: false, discoveryComplete: true },
  }

  return { kind: 'multi', report }
}

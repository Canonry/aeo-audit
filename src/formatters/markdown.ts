import { isHomepageUrl } from '../critical-defects.js'
import type {
  AuditCoverage,
  AuditReport,
  BatchDetectionEntry,
  BatchPlatformDetectionReport,
  DetectedPlatform,
  PlatformCategory,
  PlatformDetectionReport,
  SitemapAuditReport,
} from '../types.js'

export function formatMarkdown(report: AuditReport): string {
  const lines = []

  lines.push(`# AEO Audit Report`)
  lines.push(``)
  lines.push(`**URL:** ${report.finalUrl}`)
  lines.push(`**Overall Score:** ${report.overallScore}/100`)
  lines.push(`**Audited:** ${report.auditedAt}`)
  lines.push(``)
  lines.push(`## Summary`)
  lines.push(``)
  lines.push(report.summary)
  lines.push(``)
  lines.push(`## Factor Breakdown`)
  lines.push(``)
  lines.push(`| Factor | Weight | Score |`)
  lines.push(`|--------|--------|-------|`)

  for (const factor of report.factors) {
    lines.push(`| ${factor.name} | ${factor.weight}% | ${factor.score} |`)
  }

  lines.push(``)

  const sorted = [...report.factors].sort((a, b) => b.score - a.score)
  const strengths = sorted.slice(0, 3)
  const opportunities = sorted.slice(-3).reverse()

  lines.push(`## Strengths`)
  lines.push(``)
  for (const factor of strengths) {
    lines.push(`- **${factor.name}** (${factor.score}/100): ${factor.findings.filter((f) => f.type === 'found').map((f) => f.message).join(' ')}`)
  }

  lines.push(``)
  lines.push(`## Opportunities`)
  lines.push(``)
  for (const factor of opportunities) {
    const recs = factor.recommendations.slice(0, 2)
    lines.push(`- **${factor.name}** (${factor.score}/100): ${recs.join(' ')}`)
  }

  lines.push(``)
  lines.push(`## Metadata`)
  lines.push(``)
  lines.push(`- **Page Title:** ${report.metadata.pageTitle}`)
  lines.push(`- **Word Count:** ${report.metadata.wordCount}`)
  lines.push(`- **Fetch Time:** ${report.metadata.fetchTimeMs}ms`)
  lines.push(`- **llms.txt:** ${report.metadata.auxiliary.llmsTxt}`)
  lines.push(`- **llms-full.txt:** ${report.metadata.auxiliary.llmsFullTxt}`)
  lines.push(`- **robots.txt:** ${report.metadata.auxiliary.robotsTxt}`)
  lines.push(`- **sitemap.xml:** ${report.metadata.auxiliary.sitemapXml}`)

  return lines.join('\n')
}

/**
 * A score with no sample size next to it gets read as a statement about the
 * whole site. Say what it was taken over, in templates as well as pages —
 * a sample that reached every URL shape generalizes, and one that didn't can't.
 */
function coverageSuffix(coverage: AuditCoverage): string {
  if (!coverage.sampled) return ''
  return ` _(${coverage.confidence}: ${coverage.pagesAudited} of ${coverage.pagesDiscovered} pages, ${coverage.coveragePct}%, covering ${coverage.templatesRepresented}/${coverage.templatesDiscovered} URL templates)_`
}

export function formatSitemapMarkdown(report: SitemapAuditReport, topIssuesOnly = false): string {
  const lines = []

  lines.push(`# AEO Sitemap Audit Report`)
  lines.push(``)
  lines.push(`**Sitemap:** ${report.sitemapUrl}`)
  lines.push(`**Aggregate Score:** ${report.aggregateScore}/100${coverageSuffix(report.coverage)}`)
  lines.push(`**Pages:** ${report.pagesAudited} audited of ${report.pagesDiscovered} discovered (${report.pagesFiltered} filtered as non-HTML, ${report.pagesTruncated} truncated by --limit ${report.effectiveLimit})`)
  if (report.coverage.confidence === 'indicative') {
    lines.push(``)
    lines.push(`> **Indicative only:** the sample reached ${report.coverage.templatesRepresented} of ${report.coverage.templatesDiscovered} URL templates. Whole sections of the site were never audited, so this score does not describe them. Raise \`--limit\` for a figure that covers the site.`)
  }
  if (report.pagesTruncated > 0) {
    lines.push(``)
    lines.push(`> **Note:** ${report.pagesTruncated} additional pages were skipped because of the page limit. Pass \`--limit ${Math.max(report.pagesDiscovered, 9999)}\` to audit them all.`)
  }
  if (report.metadata?.partial && report.metadata.budget?.exhaustedReason) {
    lines.push(``)
    lines.push(`> **Partial:** ${report.metadata.budget.exhaustedReason}; ${report.metadata.budget.pagesRemaining} queued pages were not started.`)
  }
  lines.push(`**Audited:** ${report.auditedAt}`)
  lines.push(``)

  if (!topIssuesOnly) {
    lines.push(`## Per-Page Scores`)
    lines.push(``)
    lines.push(`| URL | Score | Status |`)
    lines.push(`|-----|-------|--------|`)

    for (const page of report.pages) {
      const url = page.url.length > 60 ? page.url.slice(0, 57) + '...' : page.url
      if (page.status === 'error') {
        lines.push(`| ${url} | - | error: ${page.error} |`)
      } else {
        lines.push(`| ${url} | ${page.overallScore} | ${page.status} |`)
      }
    }

    lines.push(``)
  }

  if (report.templateGroups.length > 0) {
    lines.push(`## Templates`)
    lines.push(``)
    lines.push(`Pages sharing a URL shape and scoring alike — one change to each template reaches every page under it.`)
    lines.push(``)
    lines.push(`| Template | Pages | Avg | Fix on |`)
    lines.push(`|----------|-------|-----|--------|`)
    for (const group of report.templateGroups) {
      lines.push(`| \`${group.templateKey}\` | ${group.pageCount} | ${group.avgScore} | ${group.representativeUrl} |`)
    }
    lines.push(``)
  }

  if (report.criticalDefects.length > 0) {
    lines.push(`## Critical Defects`)
    lines.push(``)
    lines.push(`High-impact, binary structural defects — surfaced regardless of how few pages they affect.`)
    lines.push(``)

    for (const group of report.criticalDefects) {
      const count = group.pages.length
      lines.push(`### ${group.title} _(${group.severity}, ${count} page${count === 1 ? '' : 's'})_`)
      lines.push(``)
      lines.push(group.recommendation)
      lines.push(``)
      // List every affected page — a report must surface all issues, not a sample.
      for (const page of group.pages) {
        const home = page.isHomepage ? ' **(homepage)**' : ''
        lines.push(`- \`${page.url}\`${home} — ${page.detail}`)
      }
      lines.push(``)
    }
  }

  if (report.crossCuttingIssues.length > 0) {
    const shortUrl = (u: string): string => (u.length > 48 ? u.slice(0, 45) + '...' : u)
    const statusLabel: Record<string, string> = { sitewide: 'Site-wide', limited: 'Limited', opportunity: 'Opportunity' }

    lines.push(`## Cross-Cutting Issues`)
    lines.push(``)
    lines.push(`\`Avg\` is over the pages the factor applies to; \`Coverage\` is how many pages that is.`)
    lines.push(``)
    lines.push(`| Factor | Status | Avg | Best (page) | Affected Pages | Coverage |`)
    lines.push(`|--------|--------|-----|-------------|----------------|----------|`)

    for (const issue of report.crossCuttingIssues) {
      // Page-specific factors carry a structurally-low average across pages that
      // correctly lack them, so "affected" is reported as isolated/none rather than
      // a misleading near-100% gap.
      const affected = issue.pageSpecific
        ? issue.status === 'limited'
          ? `${issue.applicableAffectedPages}/${issue.applicablePages} with it`
          : 'none'
        : `${issue.affectedPages}/${issue.totalPages} (${Math.round((issue.affectedPages / issue.totalPages) * 100)}%)`
      // Site-wide factors apply everywhere, so the two denominators agree and
      // repeating it adds nothing.
      const coverage = issue.applicablePages === issue.totalPages
        ? 'all pages'
        : `${issue.applicablePages}/${issue.totalPages} pages`
      lines.push(
        `| ${issue.factorName} | ${statusLabel[issue.status]} | ${issue.applicableAvgScore} | ${issue.bestScore} (${shortUrl(issue.bestPageUrl)}) | ${affected} | ${coverage} |`,
      )
    }

    lines.push(``)

    // The per-page breakdown is for site-wide factors only. A page-specific factor's
    // "Add FAQ to this page" rows are the same false-positive noise that demotion
    // removes; its real, scoped fix is in Prioritized Fixes below.
    const factorsWithIssues = report.crossCuttingIssues.filter((i) => !i.pageSpecific && i.topIssues.length > 0)
    if (factorsWithIssues.length > 0) {
      lines.push(`### Per-Issue Breakdown`)
      lines.push(``)

      for (const issue of factorsWithIssues) {
        lines.push(`**${issue.factorName}**`)
        lines.push(``)
        for (const detail of issue.topIssues) {
          lines.push(`- ${detail.recommendation} _(${detail.affectedUrls.length}/${issue.totalPages} pages)_`)
          for (const url of detail.affectedUrls) {
            lines.push(`  - ${url}`)
          }
        }
        lines.push(``)
      }
    }
  }

  if (report.prioritizedFixes.length > 0) {
    lines.push(`## Prioritized Fixes (critical defects first, then site-wide impact)`)
    lines.push(``)
    for (let i = 0; i < report.prioritizedFixes.length; i++) {
      const fix = report.prioritizedFixes[i]
      const tag = fix.severity ? `**[${fix.severity}]** ` : ''
      const statusTag = fix.status === 'limited' ? `**[limited]** ` : fix.status === 'opportunity' ? `**[opportunity]** ` : ''
      // Skip best for `opportunity` — the factor is absent everywhere, so "best 0/100 on /" is noise.
      const showBest = fix.bestScore !== undefined && fix.status !== 'opportunity'
      const avg =
        fix.avgScore !== undefined
          ? ` (avg ${fix.applicableAvgScore ?? fix.avgScore}/100${showBest ? `, best ${fix.bestScore}/100 on ${fix.bestPageUrl}` : ''})`
          : ''
      // Lead with the unit of work. "1 template" and "194 pages" describe the
      // same fault, and only the first is something anyone can schedule.
      const reach =
        fix.templateCount !== undefined && fix.instanceCount !== undefined &&
        fix.templateCount > 0 && fix.templateCount < fix.instanceCount
          ? `${fix.templateCount} template${fix.templateCount === 1 ? '' : 's'} · ${fix.instanceCount} pages · ${fix.prevalencePct}%`
          : `${fix.prevalencePct}% of pages`
      lines.push(`${i + 1}. ${tag}${statusTag}**${fix.title}**${avg} _(${reach})_ — ${fix.recommendation}`)
      // Spell out every affected page — agents and humans both need the full set.
      for (const url of fix.affectedPages) {
        const home = isHomepageUrl(url) ? ' **(homepage)**' : ''
        lines.push(`   - \`${url}\`${home}`)
      }
    }
    lines.push(``)
  }

  return lines.join('\n')
}

const PLATFORM_CATEGORY_LABEL: Record<PlatformCategory, string> = {
  cms: 'CMS',
  'site-builder': 'Site Builder',
  ecommerce: 'E-commerce',
  framework: 'Framework',
  ssg: 'Static Site Generator',
  hosting: 'Hosting / CDN',
}

const PLATFORM_CATEGORY_ORDER: PlatformCategory[] = [
  'cms',
  'site-builder',
  'ecommerce',
  'framework',
  'ssg',
  'hosting',
]

export function formatPlatformMarkdown(report: PlatformDetectionReport): string {
  const lines: string[] = []

  lines.push(`# Platform Detection`)
  lines.push(``)
  lines.push(`**URL:** ${report.finalUrl}`)
  lines.push(`**Detected at:** ${report.detectedAt}`)
  lines.push(`**Fetch time:** ${report.fetchTimeMs}ms`)
  lines.push(``)

  if (report.detected.length === 0) {
    lines.push(`No platform fingerprints matched. The site appears to be **custom-built** (or uses an unrecognized stack).`)
    lines.push(``)
    if (report.rawSignals.generator || report.rawSignals.xPoweredBy || report.rawSignals.server) {
      lines.push(`## Raw signals`)
      lines.push(``)
      if (report.rawSignals.generator) lines.push(`- **generator:** ${report.rawSignals.generator}`)
      if (report.rawSignals.xPoweredBy) lines.push(`- **x-powered-by:** ${report.rawSignals.xPoweredBy}`)
      if (report.rawSignals.server) lines.push(`- **server:** ${report.rawSignals.server}`)
      lines.push(``)
    }
    return lines.join('\n')
  }

  if (report.isCustom) {
    lines.push(`> The site looks **custom-built** — no CMS, site-builder, or e-commerce platform was identified. Framework, SSG, or hosting fingerprints (below) are still informative.`)
    lines.push(``)
  }

  const byCategory = new Map<PlatformCategory, DetectedPlatform[]>()
  for (const p of report.detected) {
    const list = byCategory.get(p.category) ?? []
    list.push(p)
    byCategory.set(p.category, list)
  }

  for (const category of PLATFORM_CATEGORY_ORDER) {
    const platforms = byCategory.get(category)
    if (!platforms || platforms.length === 0) continue

    lines.push(`## ${PLATFORM_CATEGORY_LABEL[category]}`)
    lines.push(``)
    for (const p of platforms) {
      const versionStr = p.version ? ` v${p.version}` : ''
      lines.push(`### ${p.name}${versionStr}`)
      lines.push(``)
      lines.push(`- **Confidence:** ${p.confidence} (${p.confidenceScore}/100)`)
      lines.push(`- **Evidence:**`)
      for (const ev of p.evidence) {
        lines.push(`  - ${ev}`)
      }
      lines.push(``)
    }
  }

  return lines.join('\n')
}

function summarizePlatformsInline(platforms: DetectedPlatform[]): string {
  if (platforms.length === 0) return '_no fingerprints matched_'
  return platforms
    .map((p) => {
      const v = p.version ? ` v${p.version}` : ''
      return `**${p.name}${v}** (${PLATFORM_CATEGORY_LABEL[p.category]}, ${p.confidence})`
    })
    .join(', ')
}

function batchEntryRow(entry: BatchDetectionEntry): string {
  if (entry.status === 'error') {
    return `| ${entry.url} | error | ${entry.error ?? 'unknown error'} |`
  }
  const platforms = entry.detected ?? []
  const summary = summarizePlatformsInline(platforms)
  const customSuffix = entry.isCustom ? ' _[custom-built]_' : ''
  return `| ${entry.url} | success | ${summary}${customSuffix} |`
}

export function formatBatchPlatformMarkdown(report: BatchPlatformDetectionReport): string {
  const lines: string[] = []

  lines.push(`# Platform Detection (Batch)`)
  lines.push(``)
  lines.push(`**Total URLs:** ${report.totalUrls}`)
  lines.push(`**Successful:** ${report.successful}`)
  lines.push(`**Failed:** ${report.failed}`)
  lines.push(`**Detected at:** ${report.detectedAt}`)
  lines.push(`**Total fetch time:** ${report.totalFetchTimeMs}ms`)
  lines.push(``)

  if (report.results.length === 0) {
    lines.push(`_No URLs to process._`)
    return lines.join('\n')
  }

  lines.push(`| URL | Status | Platforms |`)
  lines.push(`|-----|--------|-----------|`)
  for (const entry of report.results) {
    lines.push(batchEntryRow(entry))
  }
  lines.push(``)

  return lines.join('\n')
}

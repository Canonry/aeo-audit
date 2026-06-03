const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const CYAN = '\x1b[36m'

import { isHomepageUrl } from '../critical-defects.js'
import type {
  AuditReport,
  BatchDetectionEntry,
  BatchPlatformDetectionReport,
  DetectedPlatform,
  PlatformCategory,
  PlatformConfidence,
  PlatformDetectionReport,
  ScoredFactor,
  SitemapAuditReport,
} from '../types.js'

function gradeColor(grade: string): string {
  if (grade.startsWith('A')) return GREEN
  if (grade.startsWith('B')) return YELLOW
  return RED
}

function statusIcon(status: ScoredFactor['status']): string {
  if (status === 'pass') return `${GREEN}✓${RESET}`
  if (status === 'partial') return `${YELLOW}~${RESET}`
  return `${RED}✗${RESET}`
}

function bar(score: number, width = 20): string {
  const filled = Math.round((score / 100) * width)
  const color = score >= 70 ? GREEN : score >= 40 ? YELLOW : RED
  return `${color}${'█'.repeat(filled)}${DIM}${'░'.repeat(width - filled)}${RESET}`
}

export function formatText(report: AuditReport): string {
  const lines = []

  const gc = gradeColor(report.overallGrade)
  lines.push(``)
  lines.push(`${BOLD}AEO Audit Report${RESET}`)
  lines.push(`${DIM}${report.finalUrl}${RESET}`)
  lines.push(``)
  lines.push(`  ${BOLD}Grade:${RESET} ${gc}${BOLD}${report.overallGrade}${RESET}  ${bar(report.overallScore, 30)} ${report.overallScore}/100`)
  lines.push(``)
  lines.push(`${BOLD}Factors${RESET}`)
  lines.push(`${'─'.repeat(70)}`)

  const sorted = [...report.factors].sort((a, b) => b.score - a.score)

  for (const factor of sorted) {
    const icon = statusIcon(factor.status)
    const fc = gradeColor(factor.grade)
    const name = factor.name.padEnd(30)
    lines.push(`  ${icon} ${name} ${bar(factor.score)} ${fc}${factor.grade.padEnd(3)}${RESET} ${DIM}(${factor.weight}%)${RESET}`)
  }

  lines.push(`${'─'.repeat(70)}`)
  lines.push(``)
  lines.push(`${BOLD}Summary${RESET}`)
  lines.push(`  ${report.summary}`)
  lines.push(``)

  // Show top recommendations
  const withRecs = report.factors
    .filter((f) => f.recommendations.length > 0)
    .sort((a, b) => a.score - b.score)
    .slice(0, 3)

  if (withRecs.length) {
    lines.push(`${BOLD}Top Recommendations${RESET}`)
    for (const factor of withRecs) {
      lines.push(`  ${CYAN}${factor.name}:${RESET} ${factor.recommendations[0]}`)
    }
    lines.push(``)
  }

  lines.push(`${DIM}Fetched in ${report.metadata.fetchTimeMs}ms | ${report.metadata.wordCount} words | ${report.auditedAt}${RESET}`)

  return lines.join('\n')
}

export function formatSitemapText(report: SitemapAuditReport, topIssuesOnly = false): string {
  const lines = []

  const gc = gradeColor(report.aggregateGrade)
  lines.push(``)
  lines.push(`${BOLD}AEO Sitemap Audit Report${RESET}`)
  lines.push(`${DIM}${report.sitemapUrl}${RESET}`)
  lines.push(``)
  lines.push(`  ${BOLD}Aggregate Grade:${RESET} ${gc}${BOLD}${report.aggregateGrade}${RESET}  ${bar(report.aggregateScore, 30)} ${report.aggregateScore}/100`)
  lines.push(`  ${DIM}${report.pagesAudited} pages audited of ${report.pagesDiscovered} discovered (${report.pagesFiltered} filtered, ${report.pagesTruncated} truncated by --limit ${report.effectiveLimit})${RESET}`)
  if (report.pagesTruncated > 0) {
    lines.push(`  ${DIM}Note: ${report.pagesTruncated} additional pages skipped by --limit. Pass --limit ${Math.max(report.pagesDiscovered, 9999)} to audit them all.${RESET}`)
  }
  lines.push(``)

  if (!topIssuesOnly) {
    lines.push(`${BOLD}Per-Page Scores${RESET}`)
    lines.push(`${'─'.repeat(70)}`)

    const sorted = [...report.pages].sort((a, b) => b.overallScore - a.overallScore)
    for (const page of sorted) {
      if (page.status === 'error') {
        const url = page.url.length > 50 ? page.url.slice(0, 47) + '...' : page.url
        lines.push(`  ${RED}✗${RESET} ${url.padEnd(50)} ${RED}error${RESET}`)
      } else {
        const url = page.url.length > 50 ? page.url.slice(0, 47) + '...' : page.url
        const pgc = gradeColor(page.overallGrade)
        lines.push(`  ${statusIcon(page.overallScore >= 70 ? 'pass' : page.overallScore >= 40 ? 'partial' : 'fail')} ${url.padEnd(50)} ${bar(page.overallScore, 15)} ${pgc}${page.overallGrade.padEnd(3)}${RESET}`)
      }
    }

    lines.push(`${'─'.repeat(70)}`)
    lines.push(``)
  }

  if (report.criticalDefects.length > 0) {
    lines.push(`${BOLD}Critical Defects${RESET} ${DIM}(high-impact, shown regardless of prevalence)${RESET}`)
    lines.push(`${'─'.repeat(70)}`)

    for (const group of report.criticalDefects) {
      const tag = group.severity === 'critical' ? `${RED}critical${RESET}` : `${YELLOW}warning${RESET}`
      const count = group.pages.length
      lines.push(`  [${tag}] ${BOLD}${group.title}${RESET} ${DIM}(${count} page${count === 1 ? '' : 's'})${RESET}`)
      lines.push(`      ${DIM}→ ${group.recommendation}${RESET}`)
      // List every affected page — a report must surface all issues, not a sample.
      for (const page of group.pages) {
        const home = page.isHomepage ? ` ${CYAN}(homepage)${RESET}` : ''
        lines.push(`      ${DIM}- ${page.url}${home}: ${page.detail}${RESET}`)
      }
    }

    lines.push(`${'─'.repeat(70)}`)
    lines.push(``)
  }

  if (report.crossCuttingIssues.length > 0) {
    lines.push(`${BOLD}Cross-Cutting Issues${RESET}`)
    lines.push(`${'─'.repeat(70)}`)

    for (const issue of report.crossCuttingIssues) {
      const pct = Math.round((issue.affectedPages / issue.totalPages) * 100)
      const igc = gradeColor(issue.avgGrade)
      lines.push(`  ${igc}${issue.avgGrade.padEnd(3)}${RESET} ${issue.factorName.padEnd(32)} ${DIM}avg ${issue.avgScore}/100, affects ${pct}% of pages${RESET}`)

      for (const detail of issue.topIssues) {
        lines.push(`      ${DIM}• ${detail.recommendation}${RESET} ${DIM}(${detail.affectedUrls.length}/${issue.totalPages} pages)${RESET}`)
        for (const url of detail.affectedUrls) {
          lines.push(`          ${DIM}- ${url}${RESET}`)
        }
      }
    }

    lines.push(`${'─'.repeat(70)}`)
    lines.push(``)
  }

  if (report.prioritizedFixes.length > 0) {
    lines.push(`${BOLD}Prioritized Fixes (critical defects first, then site-wide impact)${RESET}`)
    for (let i = 0; i < report.prioritizedFixes.length; i++) {
      const fix = report.prioritizedFixes[i]
      const tag = fix.severity ? `[${fix.severity === 'critical' ? RED : YELLOW}${fix.severity}${RESET}] ` : ''
      const grade = fix.avgGrade ? `${DIM} avg ${fix.avgGrade}${RESET}` : ''
      lines.push(`  ${CYAN}${i + 1}.${RESET} ${tag}${BOLD}${fix.title}${RESET}${grade} ${DIM}(${fix.prevalencePct}% of pages)${RESET}`)
      lines.push(`     ${DIM}→ ${fix.recommendation}${RESET}`)
      // Spell out every affected page — agents and humans both need the full set.
      for (const url of fix.affectedPages) {
        const home = isHomepageUrl(url) ? ` ${CYAN}(homepage)${RESET}` : ''
        lines.push(`       ${DIM}- ${url}${home}${RESET}`)
      }
    }
    lines.push(``)
  }

  lines.push(`${DIM}${report.auditedAt}${RESET}`)

  return lines.join('\n')
}

const CATEGORY_LABEL: Record<PlatformCategory, string> = {
  cms: 'CMS',
  'site-builder': 'Site Builder',
  ecommerce: 'E-commerce',
  framework: 'Framework',
  ssg: 'Static Site Generator',
  hosting: 'Hosting / CDN',
}

const CATEGORY_ORDER: PlatformCategory[] = ['cms', 'site-builder', 'ecommerce', 'framework', 'ssg', 'hosting']

function confidenceColor(confidence: PlatformConfidence): string {
  if (confidence === 'high') return GREEN
  if (confidence === 'medium') return YELLOW
  return DIM
}

export function formatPlatformText(report: PlatformDetectionReport): string {
  const lines: string[] = []

  lines.push(``)
  lines.push(`${BOLD}Platform Detection${RESET}`)
  lines.push(`${DIM}${report.finalUrl}${RESET}`)
  lines.push(``)

  if (report.detected.length === 0) {
    lines.push(`  ${DIM}No platform fingerprints matched. The site appears to be ${BOLD}custom-built${RESET}${DIM} (or uses an unrecognized stack).${RESET}`)
    if (report.rawSignals.generator || report.rawSignals.xPoweredBy || report.rawSignals.server) {
      lines.push(``)
      lines.push(`${BOLD}Raw signals${RESET}`)
      if (report.rawSignals.generator) lines.push(`  generator: ${report.rawSignals.generator}`)
      if (report.rawSignals.xPoweredBy) lines.push(`  x-powered-by: ${report.rawSignals.xPoweredBy}`)
      if (report.rawSignals.server) lines.push(`  server: ${report.rawSignals.server}`)
    }
    lines.push(``)
    lines.push(`${DIM}Fetched in ${report.fetchTimeMs}ms | ${report.detectedAt}${RESET}`)
    return lines.join('\n')
  }

  const byCategory = new Map<PlatformCategory, DetectedPlatform[]>()
  for (const platform of report.detected) {
    const list = byCategory.get(platform.category) ?? []
    list.push(platform)
    byCategory.set(platform.category, list)
  }

  if (report.isCustom) {
    lines.push(`  ${BOLD}Custom-built${RESET} ${DIM}(no CMS, site-builder, or e-commerce platform detected)${RESET}`)
    lines.push(``)
  }

  for (const category of CATEGORY_ORDER) {
    const platforms = byCategory.get(category)
    if (!platforms || platforms.length === 0) continue

    lines.push(`${BOLD}${CATEGORY_LABEL[category]}${RESET}`)
    for (const p of platforms) {
      const cc = confidenceColor(p.confidence)
      const versionStr = p.version ? ` ${DIM}v${p.version}${RESET}` : ''
      lines.push(`  ${cc}●${RESET} ${BOLD}${p.name}${RESET}${versionStr} ${DIM}(${p.confidence}, ${p.confidenceScore}/100)${RESET}`)
      for (const ev of p.evidence.slice(0, 3)) {
        lines.push(`      ${DIM}• ${ev}${RESET}`)
      }
      if (p.evidence.length > 3) {
        lines.push(`      ${DIM}• …and ${p.evidence.length - 3} more signal(s)${RESET}`)
      }
    }
    lines.push(``)
  }

  lines.push(`${DIM}Fetched in ${report.fetchTimeMs}ms | ${report.detectedAt}${RESET}`)

  return lines.join('\n')
}

function summarizePlatforms(platforms: DetectedPlatform[]): string {
  if (platforms.length === 0) return `${DIM}no fingerprints matched${RESET}`
  return platforms
    .map((p) => {
      const cc = confidenceColor(p.confidence)
      const v = p.version ? ` v${p.version}` : ''
      return `${cc}${p.name}${v}${RESET} ${DIM}(${CATEGORY_LABEL[p.category]}, ${p.confidence})${RESET}`
    })
    .join(', ')
}

export function formatBatchPlatformText(report: BatchPlatformDetectionReport): string {
  const lines: string[] = []

  lines.push(``)
  lines.push(`${BOLD}Platform Detection (Batch)${RESET}`)
  lines.push(
    `${DIM}${report.totalUrls} URL(s): ${GREEN}${report.successful} success${RESET}${DIM}, ${RED}${report.failed} failed${RESET}${DIM} in ${report.totalFetchTimeMs}ms${RESET}`,
  )
  lines.push(``)

  if (report.results.length === 0) {
    lines.push(`  ${DIM}No URLs to process.${RESET}`)
    return lines.join('\n')
  }

  const urlWidth = Math.min(60, Math.max(...report.results.map((r) => r.url.length)))

  for (const entry of report.results) {
    lines.push(formatBatchEntry(entry, urlWidth))
  }

  lines.push(``)
  lines.push(`${DIM}${report.detectedAt}${RESET}`)

  return lines.join('\n')
}

function formatBatchEntry(entry: BatchDetectionEntry, urlWidth: number): string {
  const urlDisplay = entry.url.length > urlWidth ? entry.url.slice(0, urlWidth - 1) + '…' : entry.url.padEnd(urlWidth)

  if (entry.status === 'error') {
    return `  ${RED}✗${RESET} ${urlDisplay}  ${RED}error:${RESET} ${entry.error ?? 'unknown error'}`
  }

  const platforms = entry.detected ?? []
  const customMarker = entry.isCustom ? ` ${DIM}[custom-built]${RESET}` : ''
  const summary = summarizePlatforms(platforms)
  const icon = platforms.length > 0 ? `${GREEN}✓${RESET}` : `${YELLOW}~${RESET}`
  return `  ${icon} ${urlDisplay}  ${summary}${customMarker}`
}

import { clampScore } from './helpers.js'
import type { AnalysisResult, AuditContext } from '../types.js'

export function analyzeTechnicalSeo(context: AuditContext): AnalysisResult {
  const findings: AnalysisResult['findings'] = []
  const recommendations: string[] = []
  let score = 0

  // ── H1 presence ──────────────────────────────────────────────────────────
  const h1Elements = context.$('h1')
  const h1Count = h1Elements.length

  if (h1Count === 1) {
    score += 40
    const h1Text = context.$(h1Elements[0]).text().trim()
    findings.push({ type: 'found', code: 'technical-seo.h1.single', message: `One H1 found: "${h1Text.slice(0, 80)}${h1Text.length > 80 ? '…' : ''}"` })
  } else if (h1Count === 0) {
    findings.push({ type: 'missing', code: 'technical-seo.h1.missing', message: 'No H1 tag found. AI models and search engines use the H1 as the primary page topic signal.' })
    recommendations.push('Add exactly one H1 tag that clearly states the page topic or primary keyword.')
  } else {
    score += 20
    findings.push({ type: 'info', code: 'technical-seo.h1.multiple', message: `${h1Count} H1 tags found. Pages should have exactly one H1 for clear topic signaling.` })
    recommendations.push(`Consolidate to a single H1. Currently ${h1Count} H1 tags are present.`)
  }

  // ── Image alt text ────────────────────────────────────────────────────────
  const allImages = context.$('img')
  const totalImages = allImages.length

  if (totalImages === 0) {
    score += 30
    findings.push({ type: 'info', code: 'technical-seo.alt-text.none', message: 'No images found on this page.' })
  } else {
    const missingAlt: string[] = []
    const emptyAlt: string[] = []

    allImages.each((_, el) => {
      const src = context.$(el).attr('src') || '(no src)'
      const alt = context.$(el).attr('alt')
      if (alt === undefined || alt === null) {
        missingAlt.push(src)
      } else if (alt.trim() === '') {
        emptyAlt.push(src)
      }
    })

    const problematic = missingAlt.length + emptyAlt.length
    const covered = totalImages - problematic

    if (problematic === 0) {
      score += 30
      findings.push({ type: 'found', code: 'technical-seo.alt-text.ok', message: `All ${totalImages} image(s) have descriptive alt text.` })
    } else {
      const ratio = covered / totalImages
      score += Math.round(ratio * 30)

      if (missingAlt.length > 0) {
        const preview = missingAlt.slice(0, 3).map((s) => s.split('/').pop() || s).join(', ')
        findings.push({
          type: 'missing',
          code: 'technical-seo.alt-text.missing',
          message: `${missingAlt.length} image(s) missing alt attribute entirely: ${preview}${missingAlt.length > 3 ? ` (+${missingAlt.length - 3} more)` : ''}.`,
        })
      }

      if (emptyAlt.length > 0) {
        const preview = emptyAlt.slice(0, 3).map((s) => s.split('/').pop() || s).join(', ')
        findings.push({
          type: 'info',
          code: 'technical-seo.alt-text.empty',
          message: `${emptyAlt.length} image(s) have empty alt="" (acceptable for decorative images, but verify): ${preview}${emptyAlt.length > 3 ? ` (+${emptyAlt.length - 3} more)` : ''}.`,
        })
      }

      if (missingAlt.length > 0) {
        recommendations.push(
          `Add descriptive alt text to ${missingAlt.length} image(s) that are missing alt attributes entirely.`,
        )
      }
      if (emptyAlt.length > 0) {
        recommendations.push(
          `Review ${emptyAlt.length} image(s) with empty alt="". Set descriptive alt text for content images; empty alt="" is only appropriate for purely decorative images.`,
        )
      }
    }
  }

  // ── Meta description ──────────────────────────────────────────────────────
  const metaDesc = context.$('meta[name="description"]').attr('content')?.trim() ?? ''

  if (!metaDesc) {
    findings.push({ type: 'missing', code: 'technical-seo.meta-description.missing', message: 'No meta description found.' })
    recommendations.push('Add a meta description (150–160 characters) summarising the page. Short or missing descriptions reduce click-through rates and give AI crawlers less context about the page.')
  } else if (metaDesc.length < 120) {
    score += 8
    findings.push({
      type: 'info',
      code: 'technical-seo.meta-description.short',
      message: `Meta description is too short (${metaDesc.length} chars; target 150–160): "${metaDesc}"`,
    })
    recommendations.push(
      'Expand the meta description to 150–160 characters. Short descriptions don\'t give search engines and AI crawlers enough context about the page, which can lower click-through rates and reduce visibility.',
    )
  } else if (metaDesc.length > 160) {
    score += 12
    findings.push({ type: 'info', code: 'technical-seo.meta-description.long', message: `Meta description is long (${metaDesc.length} chars) and may be truncated in search results.` })
    recommendations.push('Trim the meta description to 150–160 characters so it isn\'t truncated in search snippets.')
  } else {
    score += 20
    findings.push({ type: 'found', code: 'technical-seo.meta-description.present', message: `Meta description present (${metaDesc.length} chars).` })
  }

  // ── Canonical tag ─────────────────────────────────────────────────────────
  const canonicalEl = context.$('link[rel="canonical"]')
  const canonicalHref = canonicalEl.attr('href')?.trim() ?? ''

  if (!canonicalHref) {
    findings.push({ type: 'missing', code: 'technical-seo.canonical.missing', message: 'No canonical tag found. Without a canonical, duplicate content issues can dilute crawl signals.' })
    recommendations.push('Add <link rel="canonical" href="<page-url>"> to prevent duplicate content issues.')
  } else {
    score += 10
    findings.push({ type: 'found', code: 'technical-seo.canonical.present', message: `Canonical tag present: "${canonicalHref}"` })
  }

  return {
    score: clampScore(score),
    findings,
    recommendations,
  }
}

import { clampScore, countWords } from './helpers.js'
import type { AnalysisResult, AuditContext, AuxiliaryResource } from '../types.js'

function pushDiagnosticFindings(
  fallbackLabel: string,
  auxEntry: AuxiliaryResource | undefined,
  findings: AnalysisResult['findings'],
  recommendations: string[],
): void {
  const diagnostics = auxEntry?.diagnostics
  if (!diagnostics) return

  // Prefer the actual fetched path so that fallback resolutions (e.g.
  // /sitemap.xml → /sitemap-index.xml) are reflected accurately in the
  // finding instead of the spec's default label.
  let label = fallbackLabel
  if (auxEntry?.url) {
    try {
      label = new URL(auxEntry.url).pathname
    } catch {
      // ignore — keep the fallback label
    }
  }

  if (diagnostics.contentNegotiation) {
    findings.push({
      type: 'info',
      message: `${label} returns a non-2xx response when fetched with \`Accept: text/markdown\` — content negotiation hides it from AI content extraction tools that prefer markdown.`,
    })
    recommendations.push(
      `Serve ${label} with the same body regardless of the \`Accept\` header (avoid redirecting .txt to a non-existent .md variant).`,
    )
  }
}

function scoreAuxState(
  auxEntry: AuxiliaryResource | undefined,
  missingMessage: string,
  unavailableMessage: string,
  findings: AnalysisResult['findings'],
  recommendations: string[],
): number {
  if (!auxEntry || auxEntry.state === 'missing') {
    findings.push({ type: 'missing', message: missingMessage })
    recommendations.push(`Create ${missingMessage.split(' ')[0]} at your site root.`)
    return 0
  }

  if (auxEntry.state === 'timeout') {
    findings.push({ type: 'timeout', message: unavailableMessage })
    return 8
  }

  if (auxEntry.state === 'unreachable') {
    findings.push({ type: 'unreachable', message: unavailableMessage })
    return 8
  }

  if (auxEntry.state === 'not-html') {
    findings.push({ type: 'info', message: `${missingMessage.split(' ')[0]} returned an unexpected content type.` })
    return 10
  }

  findings.push({ type: 'found', message: `${missingMessage.split(' ')[0]} is available.` })
  return 24
}

export function analyzeAiReadableContent(context: AuditContext): AnalysisResult {
  const findings: AnalysisResult['findings'] = []
  const recommendations: string[] = []
  const auxiliary = context.auxiliary || {}
  let score = 0

  // llms.txt presence and quality
  score += scoreAuxState(
    auxiliary.llmsTxt,
    '/llms.txt is missing.',
    'Could not reliably fetch /llms.txt.',
    findings,
    recommendations,
  )
  pushDiagnosticFindings('/llms.txt', auxiliary.llmsTxt, findings, recommendations)

  if (auxiliary.llmsTxt?.state === 'ok') {
    const wordCount = countWords(auxiliary.llmsTxt.body || '')
    if (wordCount >= 100) {
      score += 8
      findings.push({ type: 'found', message: '/llms.txt has useful content depth.' })
    } else {
      findings.push({ type: 'info', message: '/llms.txt is present but short.' })
      recommendations.push('Expand /llms.txt with concise service and entity context.')
    }
  }

  // llms-full.txt presence and quality
  score += scoreAuxState(
    auxiliary.llmsFullTxt,
    '/llms-full.txt is missing.',
    'Could not reliably fetch /llms-full.txt.',
    findings,
    recommendations,
  )
  pushDiagnosticFindings('/llms-full.txt', auxiliary.llmsFullTxt, findings, recommendations)

  if (auxiliary.llmsFullTxt?.state === 'ok') {
    const wordCount = countWords(auxiliary.llmsFullTxt.body || '')
    if (wordCount >= 200) {
      score += 10
      findings.push({ type: 'found', message: '/llms-full.txt has strong long-form coverage.' })
    } else {
      findings.push({ type: 'info', message: '/llms-full.txt exists but lacks detail.' })
      recommendations.push('Add complete offerings, FAQ, and service-area coverage to /llms-full.txt.')
    }
  }

  // robots.txt presence (not bot-access — that's in ai-crawler-access.js)
  const robotsState = auxiliary.robotsTxt?.state
  if (robotsState === 'ok') {
    score += 16
    findings.push({ type: 'found', message: 'robots.txt is accessible.' })
  } else if (robotsState === 'timeout' || robotsState === 'unreachable') {
    score += 6
    findings.push({ type: robotsState, message: 'Could not reliably fetch /robots.txt.' })
  } else {
    findings.push({ type: 'missing', message: '/robots.txt is missing.' })
    recommendations.push('Add a robots.txt file.')
  }
  pushDiagnosticFindings('/robots.txt', auxiliary.robotsTxt, findings, recommendations)

  // Sitemap presence
  const sitemapState = auxiliary.sitemapXml?.state
  if (sitemapState === 'ok') {
    score += 16
    findings.push({ type: 'found', message: 'sitemap.xml is accessible.' })
  } else if (sitemapState === 'timeout' || sitemapState === 'unreachable') {
    score += 6
    findings.push({ type: sitemapState, message: 'Could not reliably fetch /sitemap.xml.' })
  } else {
    findings.push({ type: 'missing', message: '/sitemap.xml is missing.' })
    recommendations.push('Add a sitemap.xml file.')
  }
  pushDiagnosticFindings('/sitemap.xml', auxiliary.sitemapXml, findings, recommendations)

  // HTML head link to llms.txt
  const llmsLink = context.$('link[href*="llms.txt"]').length > 0
  if (llmsLink) {
    score += 10
    findings.push({ type: 'found', message: 'HTML head links to llms.txt.' })
  } else {
    findings.push({ type: 'info', message: 'No llms.txt link detected in <head>.' })
    recommendations.push('Add a <link> reference to /llms.txt in your document head.')
  }

  return {
    score: clampScore(score),
    findings,
    recommendations,
  }
}

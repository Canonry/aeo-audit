import { clampScore } from './helpers.js'
import type { AnalysisResult, AuditContext, AuditFinding } from '../types.js'

const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed'
const LIGHTHOUSE_CATEGORIES = ['performance', 'accessibility', 'best-practices'] as const
const LIGHTHOUSE_STRATEGY = 'mobile'
const LIGHTHOUSE_TIMEOUT_MS = 35_000
const MAX_RECOMMENDATIONS = 5
const FAILING_AUDIT_THRESHOLD = 0.9

interface PsiCategory {
  id?: string
  title?: string
  score?: number | null
}

interface PsiAudit {
  id?: string
  title?: string
  score?: number | null
  scoreDisplayMode?: string
}

interface PsiResponse {
  lighthouseResult?: {
    categories?: Record<string, PsiCategory | undefined>
    audits?: Record<string, PsiAudit | undefined>
  }
  error?: {
    message?: string
  }
}

function buildEndpoint(url: string): string {
  const params = new URLSearchParams({
    url,
    strategy: LIGHTHOUSE_STRATEGY,
  })

  for (const category of LIGHTHOUSE_CATEGORIES) {
    params.append('category', category)
  }

  const apiKey = process.env.PAGESPEED_API_KEY?.trim()
  if (apiKey) {
    params.set('key', apiKey)
  }

  return `${PSI_ENDPOINT}?${params.toString()}`
}

async function fetchPsi(url: string): Promise<PsiResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LIGHTHOUSE_TIMEOUT_MS)

  try {
    const response = await fetch(buildEndpoint(url), {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as PsiResponse | null
      const detail = body?.error?.message ? `: ${body.error.message}` : ''
      throw new Error(`PageSpeed Insights returned HTTP ${response.status}${detail}`)
    }

    const body = (await response.json()) as PsiResponse
    if (body.error?.message) {
      throw new Error(body.error.message)
    }

    return body
  } finally {
    clearTimeout(timer)
  }
}

function classifyByScore(percent: number): AuditFinding['type'] {
  if (percent >= 90) return 'found'
  if (percent >= 50) return 'info'
  return 'missing'
}

export async function analyzeLighthouse(context: AuditContext): Promise<AnalysisResult> {
  const findings: AuditFinding[] = []
  const recommendations: string[] = []

  let psi: PsiResponse
  try {
    psi = await fetchPsi(context.url)
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError'
    const message = isAbort
      ? `PageSpeed Insights timed out after ${LIGHTHOUSE_TIMEOUT_MS}ms.`
      : `PageSpeed Insights request failed: ${error instanceof Error ? error.message : String(error)}`

    return {
      score: 0,
      findings: [{ type: isAbort ? 'timeout' : 'unreachable', code: 'lighthouse.psi.unreachable', message }],
      recommendations: [
        'Confirm the URL is publicly reachable from Google\'s infrastructure (PSI cannot audit localhost or auth-walled pages). Set PAGESPEED_API_KEY to lift anonymous rate limits.',
      ],
    }
  }

  const categories = psi.lighthouseResult?.categories ?? {}
  const categoryScores: number[] = []

  for (const id of LIGHTHOUSE_CATEGORIES) {
    const category = categories[id]
    const rawScore = category?.score
    const label = category?.title ?? id

    if (typeof rawScore !== 'number') {
      findings.push({ type: 'info', code: 'lighthouse.category.missing', message: `Lighthouse did not return a score for ${label}.` })
      continue
    }

    const percent = Math.round(rawScore * 100)
    categoryScores.push(percent)
    findings.push({
      type: classifyByScore(percent),
      code: 'lighthouse.category.score',
      message: `${label}: ${percent}/100`,
    })
  }

  if (categoryScores.length === 0) {
    return {
      score: 0,
      findings: [...findings, { type: 'unreachable', code: 'lighthouse.category.none', message: 'Lighthouse returned no category scores.' }],
      recommendations: ['Confirm the URL is publicly reachable from Google PageSpeed Insights.'],
    }
  }

  const audits = psi.lighthouseResult?.audits ?? {}
  const failingAudits = Object.values(audits)
    .filter((audit): audit is PsiAudit & { score: number; title: string } => {
      if (!audit || typeof audit.title !== 'string') return false
      if (typeof audit.score !== 'number') return false
      if (audit.scoreDisplayMode !== 'numeric' && audit.scoreDisplayMode !== 'binary') return false
      return audit.score < FAILING_AUDIT_THRESHOLD
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, MAX_RECOMMENDATIONS)

  for (const audit of failingAudits) {
    recommendations.push(`Lighthouse: ${audit.title} (score ${Math.round(audit.score * 100)}/100)`)
  }

  const overall = clampScore(
    categoryScores.reduce((sum, value) => sum + value, 0) / categoryScores.length,
  )

  return {
    score: overall,
    findings,
    recommendations,
  }
}

import type { AnalysisResult, AuditContext } from '../types.js'

export const MAX_CANONICAL_TARGETS = 5

interface CanonicalLinks extends AnalysisResult {
  urls: string[]
}

export function inspectCanonicalLinks(context: AuditContext): CanonicalLinks {
  const findings: AnalysisResult['findings'] = []
  const recommendations: string[] = []
  const links = context.$('link[rel]').toArray().filter((link) => {
    const element = context.$(link)
    if (!(element.attr('rel') || '').toLowerCase().split(/[\t\n\f\r ]+/).includes('canonical')) return false

    if (element.parents('template').length || !element.parents('head').length) {
      findings.push({ type: 'info', code: 'entity-consistency.canonical.ignored-location', message: 'Canonical tag is ignored because it is outside the document head or inside template content.' })
      recommendations.push('Place canonical link tags in the document head, outside template content.')
      return false
    }

    const alternateAttributes = ['media', 'hreflang', 'lang', 'type'].filter((attribute) => element.attr(attribute) !== undefined)
    if (alternateAttributes.length) {
      findings.push({ type: 'info', code: 'entity-consistency.canonical.ignored-attributes', message: `Canonical tag is ignored because it has alternate-version attributes: ${alternateAttributes.join(', ')}.` })
      recommendations.push('Remove media, hreflang, lang and type attributes from the primary canonical link tag.')
      return false
    }

    return true
  })

  if (!links.length) {
    return {
      score: 0,
      urls: [],
      findings: [...findings, { type: 'missing', code: 'entity-consistency.canonical.missing', message: 'Canonical URL tag is missing.' }],
      recommendations: [...new Set([...recommendations, 'Add a canonical link tag to declare the primary page URL.'])],
    }
  }

  let baseUrl = context.url
  const baseHref = context.$('base[href]').filter((_, base) => {
    if ('namespace' in base && base.namespace !== 'http://www.w3.org/1999/xhtml') return false
    // Cheerio's ancestor selectors stop at a template's document fragment.
    for (let parent = base.parent; parent; parent = parent.parent) {
      if ('name' in parent && parent.name === 'template') return false
    }
    return true
  }).first().attr('href')
  if (baseHref) {
    try {
      const parsedBase = new URL(baseHref, context.url)
      if (!['data:', 'javascript:'].includes(parsedBase.protocol)) {
        baseUrl = parsedBase.toString()
      }
    } catch {
      // Browsers ignore a base URL that cannot be parsed.
    }
  }

  let score = 20
  const urls: string[] = []
  for (const link of links) {
    const href = context.$(link).attr('href') || ''
    let url: URL
    try {
      // URL parsing strips only C0 controls and ASCII space, not Unicode whitespace.
      if ([...href].every((character) => character.charCodeAt(0) <= 0x20)) throw new Error('the href is empty')
      url = new URL(href, baseUrl)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('only HTTP and HTTPS are supported')
      if (url.username || url.password) throw new Error('credentials are not allowed')
      if (href.includes('#')) throw new Error('URL fragments are not supported')
    } catch (error) {
      const reason = error instanceof TypeError ? 'the URL cannot be parsed' : (error as Error).message
      findings.push({ type: 'missing', code: 'entity-consistency.canonical.invalid', message: `Invalid canonical URL${href ? ` "${href}"` : ''}: ${reason}.` })
      recommendations.push('Use a nonempty HTTP or HTTPS canonical URL without credentials or a fragment.')
      score = 0
      continue
    }

    urls.push(url.toString())
  }

  const uniqueUrls = [...new Set(urls)]
  if (links.length > 1) {
    if (uniqueUrls.length > 1) {
      findings.push({ type: 'missing', code: 'entity-consistency.canonical.conflicting', message: `Conflicting canonical tags point to different URLs: ${uniqueUrls.join(', ')}.` })
      recommendations.push('Declare one canonical URL and remove conflicting canonical tags.')
      score = 0
    } else {
      findings.push({ type: 'info', code: 'entity-consistency.canonical.duplicate', message: `Duplicate canonical tags found (${links.length} declarations).` })
      recommendations.push('Keep a single canonical link tag per page.')
      score = Math.min(score, 10)
    }
  }

  if (score === 20) {
    findings.push({ type: 'found', code: 'entity-consistency.canonical.present', message: 'Canonical URL tag is valid.' })
  }
  if (uniqueUrls.length > MAX_CANONICAL_TARGETS) {
    findings.push({ type: 'info', code: 'entity-consistency.canonical.target-limit', message: `Canonical target checks are limited to the first ${MAX_CANONICAL_TARGETS} distinct URLs.` })
  }

  return { score, urls: uniqueUrls, findings, recommendations: [...new Set(recommendations)] }
}

export function analyzeCanonicalLinks(context: AuditContext): AnalysisResult {
  const result = inspectCanonicalLinks(context)
  let score = result.score
  const { findings, recommendations } = result

  for (const url of result.urls.slice(0, MAX_CANONICAL_TARGETS)) {
    const target = context.canonicalTargets?.[url]
    if (!target) continue

    if (target.redirectChain.length) {
      const hops = `${target.redirectChain.length} hop${target.redirectChain.length === 1 ? '' : 's'}`
      const destination = target.state === 'ok'
        ? `to "${target.url}"`
        : `and checking stopped at "${target.url}"`
      findings.push({ type: 'info', code: 'entity-consistency.canonical.redirected', message: `Canonical URL "${url}" redirects (${hops}) ${destination}.` })
      if (target.state === 'ok') {
        recommendations.push('Point the canonical tag directly to the final destination URL.')
      }
      score = Math.min(score, 10)
    }

    if (target.state === 'timeout') {
      findings.push({ type: 'timeout', code: 'entity-consistency.canonical.timeout', message: `Canonical target "${url}" timed out; availability could not be verified.` })
      recommendations.push('Retry the audit and confirm the canonical target responds promptly.')
      score = Math.min(score, 10)
    } else if (target.state === 'unreachable') {
      const detail = target.statusCode ? `HTTP ${target.statusCode}` : (target.errorCode || 'network failure')
      findings.push({ type: 'unreachable', code: 'entity-consistency.canonical.unreachable', message: `Canonical target "${url}" could not be reached successfully (${detail}).` })
      recommendations.push('Use a reachable canonical target that returns a successful HTTP response.')
      score = 0
    } else {
      const status = target.statusCode ? ` (HTTP ${target.statusCode})` : ''
      findings.push({ type: 'found', code: 'entity-consistency.canonical.reachable', message: `Canonical target "${url}" is reachable${status}.` })
    }
  }

  return { score, findings, recommendations: [...new Set(recommendations)] }
}

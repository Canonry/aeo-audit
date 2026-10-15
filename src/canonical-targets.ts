import { load } from 'cheerio'
import { inspectCanonicalLinks, MAX_CANONICAL_TARGETS } from './analyzers/canonical-links.js'
import { fetchCanonicalTarget, type CanonicalTargetFetchOptions } from './fetch-page.js'
import type { AuxiliaryResources, CanonicalTargetResult, FetchedPage, RunAeoAuditOptions } from './types.js'

/** Shared single-page and crawl probes; self canonicals reuse the response already fetched. */
export async function collectCanonicalTargets(
  page: Pick<FetchedPage, 'html' | 'finalUrl' | 'statusCode' | 'headers'> & { auxiliary: AuxiliaryResources },
  options: CanonicalTargetFetchOptions & Pick<RunAeoAuditOptions, 'factors'>,
): Promise<Record<string, CanonicalTargetResult> | undefined> {
  if (options.factors?.length && !options.factors.some((id) => id === 'entity-consistency' || id === 'technical-seo')) return undefined
  const { urls } = inspectCanonicalLinks({
    $: load(page.html), html: page.html, url: page.finalUrl, headers: page.headers,
    auxiliary: page.auxiliary, structuredData: [], textContent: '', pageTitle: '',
  })
  const results = await Promise.allSettled(urls.slice(0, MAX_CANONICAL_TARGETS).map(async (url): Promise<[string, CanonicalTargetResult]> => {
    if (url === page.finalUrl && page.statusCode !== undefined) {
      return [url, {
        state: page.statusCode >= 200 && page.statusCode < 300 ? 'ok' : 'unreachable',
        url, statusCode: page.statusCode, redirectChain: [],
      }]
    }
    return [url, await fetchCanonicalTarget(url, options)]
  }))
  // Settle every probe before returning a crawl receipt, even if another
  // target exhausted the shared budget or rejected the outbound observer.
  return Object.fromEntries(results.map((result) => {
    if (result.status === 'rejected') throw result.reason
    return result.value
  }))
}

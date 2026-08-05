/**
 * URL shape inference: which paths on a site are the same route rendered with
 * different content.
 *
 * Two consumers need the same answer. The crawl sampler needs it to spread a
 * limited page budget across every kind of page instead of exhausting it on
 * whichever URLs the sitemap happened to list first, and template grouping needs
 * it as the structural half of "these N pages are one template" — a claim that
 * identical scores alone cannot support, since 194 unrelated pages can be
 * identically bad.
 *
 * The inference is corpus-driven. Nothing about `/properties/austin/the-mark`
 * says which segments are route and which are identifier when you look at it
 * alone; it becomes obvious across a few hundred sibling URLs, where the route
 * segments repeat and the identifier segments never do.
 */

import type { AuditCoverage } from './types.js'

/**
 * A path position stays structural — kept verbatim in the key — while its
 * distinct-value count across same-depth URLs is at or below this. Above it the
 * position is an identifier slot and collapses to `*`.
 *
 * 8 separates a fixed route vocabulary (`/floorplans`, `/amenities`, `/contact`
 * hanging off one template) from an identifier slot, which on any site large
 * enough to need sampling runs to dozens or hundreds of values. A site with more
 * than 8 genuine sibling routes at one position splits into several templates
 * rather than one. That costs some sampling breadth and some collapse precision;
 * it never invents a grouping that isn't there, which is the error that matters.
 */
const STRUCTURAL_MAX_DISTINCT = 8

/** Lowercased, empty-segment-free path parts, or null when the URL won't parse. */
function pathSegments(url: string): string[] | null {
  try {
    const { pathname } = new URL(url)
    return pathname.toLowerCase().split('/').filter(Boolean)
  } catch {
    return null
  }
}

/**
 * A key that identifies the same route across the trivial URL differences a fetch
 * introduces — a redirect that adds a trailing slash, upgrades http to https, or
 * canonicalizes the host. A sitemap `<loc>` and the final URL an audit lands on
 * routinely differ in exactly those ways, and every one of them is already
 * invisible to the template key (built from the lowercased path segments), so
 * route identity ignores them too. Callers lining up loc-space URLs against
 * audited final URLs bridge the two through this rather than raw string equality.
 */
export function routeKey(url: string): string {
  const segments = pathSegments(url)
  return segments ? `/${segments.join('/')}` : url
}

/**
 * Map every URL to its inferred template key, e.g. `/properties/*` + `/blog/*`.
 *
 * Keys are only meaningful relative to the corpus they were derived from: the
 * same URL in a different set can land on a different key, because whether a
 * position varies is a fact about the set. Derive once per crawl and reuse.
 */
export interface UrlShape {
  /** Route with each identifier segment collapsed to a star, e.g. `/properties/star/star`. */
  templateKey: string
  /** The values that filled those identifier slots, left to right. */
  identifiers: string[]
}

/**
 * Template key plus the identifier values for every URL, in one pass.
 *
 * The identifiers matter for sampling: knowing that a set of URLs is one
 * template says which pages are interchangeable, and knowing what filled the
 * slots says which parts of the site they belong to. Taking 16 pages from one
 * template is only representative if they aren't all the same city.
 */
export function deriveUrlShapes(urls: readonly string[]): Map<string, UrlShape> {
  // Bucket by depth first: positions are only comparable between URLs that have
  // the same number of segments. `/a/b` and `/a/b/c` hold unrelated things at
  // position 1, and pooling them would call both positions variable.
  const segmentsByUrl = new Map<string, string[] | null>()
  const rowsByDepth = new Map<number, string[][]>()

  for (const url of urls) {
    if (segmentsByUrl.has(url)) continue
    const segments = pathSegments(url)
    segmentsByUrl.set(url, segments)
    if (!segments || segments.length === 0) continue
    const rows = rowsByDepth.get(segments.length)
    if (rows) rows.push(segments)
    else rowsByDepth.set(segments.length, [segments])
  }

  // Per depth, per position: does this position carry a route name or an id?
  const variableByDepth = new Map<number, boolean[]>()
  for (const [depth, rows] of rowsByDepth) {
    const variable: boolean[] = []
    for (let position = 0; position < depth; position++) {
      const distinct = new Set(rows.map((row) => row[position]))
      variable.push(distinct.size > STRUCTURAL_MAX_DISTINCT)
    }
    variableByDepth.set(depth, variable)
  }

  const shapes = new Map<string, UrlShape>()
  for (const [url, segments] of segmentsByUrl) {
    // Unparseable URLs get a key of their own so they never merge with anything.
    if (!segments) {
      shapes.set(url, { templateKey: url, identifiers: [] })
      continue
    }
    if (segments.length === 0) {
      shapes.set(url, { templateKey: '/', identifiers: [] })
      continue
    }
    const variable = variableByDepth.get(segments.length) ?? []
    shapes.set(url, {
      templateKey: `/${segments.map((segment, i) => (variable[i] ? '*' : segment)).join('/')}`,
      identifiers: segments.filter((_, i) => variable[i]),
    })
  }

  return shapes
}

/** Template key per URL; see `deriveUrlShapes` for the identifiers alongside it. */
export function deriveTemplateKeys(urls: readonly string[]): Map<string, string> {
  return new Map([...deriveUrlShapes(urls)].map(([url, shape]) => [url, shape.templateKey]))
}

/** Count of distinct template keys in a corpus. */
export function countTemplates(urls: readonly string[]): number {
  return new Set(deriveTemplateKeys(urls).values()).size
}

/**
 * Describe what a crawl actually reached.
 *
 * Coverage is reported in templates as well as pages because raw percentage is
 * the weaker signal: a 6% sample touching every URL shape supports a site-wide
 * statement, and a 40% prefix that never left one section does not. Both URL
 * sets are keyed against the discovered corpus so the two template counts are
 * measured the same way and are comparable.
 */
export function buildCoverage(
  discoveredUrls: readonly string[],
  auditedUrls: readonly string[],
): AuditCoverage {
  // Index by route, not by raw URL string. The audited set carries each page's
  // final URL after redirects, which routinely differs from the sitemap <loc> it
  // came from (trailing slash, http->https, host case); keying both sides on
  // routeKey lets a redirected page still resolve to its discovered template
  // instead of missing the lookup and dragging templatesRepresented down.
  const keyByRoute = new Map<string, string>()
  for (const [url, key] of deriveTemplateKeys(discoveredUrls)) {
    const route = routeKey(url)
    if (!keyByRoute.has(route)) keyByRoute.set(route, key)
  }
  const templatesDiscovered = new Set(keyByRoute.values()).size
  const represented = new Set<string>()
  for (const url of auditedUrls) {
    const key = keyByRoute.get(routeKey(url))
    if (key !== undefined) represented.add(key)
  }

  const pagesDiscovered = discoveredUrls.length
  const pagesAudited = auditedUrls.length
  const sampled = pagesAudited < pagesDiscovered

  return {
    pagesAudited,
    pagesDiscovered,
    coveragePct: pagesDiscovered > 0 ? Math.round((pagesAudited / pagesDiscovered) * 100) : 0,
    sampled,
    selection: sampled ? 'stratified' : 'all',
    templatesDiscovered,
    templatesRepresented: represented.size,
    confidence: !sampled
      ? 'full'
      : represented.size >= templatesDiscovered
        ? 'representative'
        : 'indicative',
  }
}

export interface SampleOptions<T> {
  /** Template key for an item; items sharing a key compete for the same slots. */
  keyOf: (item: T) => string
  /** Items matching this are always selected, ahead of the round-robin. */
  pin?: (item: T) => boolean
  /** Order within one template group — earlier items are taken first. */
  rank?: (a: T, b: T) => number
  /**
   * A second axis to spread across *inside* each template, typically the first
   * identifier segment (a city, a section, a year).
   *
   * Spreading across templates alone still leaves the picks within one template
   * in list order, so a budget of 18 property pages lands entirely on whichever
   * city sorts first — the same over-representation one level down. Cycling the
   * sub-values first means those 18 span every city before any city gets a
   * second page.
   */
  spreadBy?: (item: T) => string
}

/**
 * Reorder one group's indices so consecutive picks come from different
 * sub-values, cycling round-robin over them. Sub-values are visited largest
 * first, then lexically, for the same reason and with the same determinism as
 * the outer round-robin.
 */
function interleaveBySubValue<T>(
  indices: readonly number[],
  items: readonly T[],
  spreadBy: (item: T) => string,
): number[] {
  const buckets = new Map<string, number[]>()
  for (const index of indices) {
    const key = spreadBy(items[index] as T)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(index)
    else buckets.set(key, [index])
  }
  if (buckets.size <= 1) return [...indices]

  const ordered = [...buckets.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  )
  const result: number[] = []
  for (let round = 0; result.length < indices.length; round++) {
    for (const [, bucket] of ordered) {
      const index = bucket[round]
      if (index !== undefined) result.push(index)
    }
  }
  return result
}

/**
 * Take `limit` items spread across template groups rather than off the front.
 *
 * A prefix is not a sample. Slicing a sitemap in document order gives one
 * property 16 pages and its neighbour 1, purely because of how the URLs sorted,
 * and every number computed downstream inherits that skew — including the
 * conclusion that one property has a richer site than another when the sitemap
 * says they are identical.
 *
 * Round-robin across groups, largest group first so a limit that lands
 * mid-round spends its remainder on the site's dominant shapes. Small groups
 * exhaust early and the big ones keep drawing, so allocation ends up roughly
 * proportional while still guaranteeing every template at least one page.
 *
 * Selection is a pure function of the input list: no randomness, no clock. Two
 * runs over one sitemap pick the same pages, which is what `compare` needs to
 * diff two reports. Returned in original input order.
 */
export function selectRepresentativeSample<T>(
  items: readonly T[],
  limit: number,
  options: SampleOptions<T>,
): T[] {
  if (!Number.isFinite(limit) || limit <= 0) return []
  // Nothing to choose between — keep the caller's order exactly as it was.
  if (limit >= items.length) return [...items]

  const selected = new Set<number>()
  const pinned: number[] = []
  const groups = new Map<string, number[]>()

  items.forEach((item, index) => {
    if (options.pin?.(item)) {
      pinned.push(index)
      return
    }
    const key = options.keyOf(item)
    const group = groups.get(key)
    if (group) group.push(index)
    else groups.set(key, [index])
  })

  for (const index of pinned) {
    if (selected.size >= limit) break
    selected.add(index)
  }

  const { rank, spreadBy } = options
  const ordered = [...groups.entries()]
    .map(([key, indices]) => {
      // Rank first (it expresses a real preference, e.g. sitemap <priority>),
      // then interleave, which only reorders within equal standing.
      const ranked = rank ? [...indices].sort((a, b) => rank(items[a] as T, items[b] as T)) : indices
      return { key, indices: spreadBy ? interleaveBySubValue(ranked, items, spreadBy) : ranked }
    })
    .sort((a, b) => b.indices.length - a.indices.length || a.key.localeCompare(b.key))

  let round = 0
  let tookOne = true
  while (selected.size < limit && tookOne) {
    tookOne = false
    for (const group of ordered) {
      if (selected.size >= limit) break
      const index = group.indices[round]
      if (index === undefined) continue
      selected.add(index)
      tookOne = true
    }
    round++
  }

  return items.filter((_, index) => selected.has(index))
}

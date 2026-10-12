import type { AuditMetadata, SiteIssue } from './types.js'

/** Already-eligible pages; callers own crawl and indexability scope. */
interface MetadataPage {
  url: string
  metadata?: Pick<AuditMetadata, 'pageTitle' | 'metaDescription'>
}

/** Exact duplicates among observed pages, never an assertion about unseen URLs. */
export function buildDuplicateMetadataIssues(pages: Iterable<MetadataPage>): SiteIssue[] {
  const titles = new Map<string, Set<string>>()
  const descriptions = new Map<string, Set<string>>()
  const add = (groups: Map<string, Set<string>>, value: string | null | undefined, url: string): void => {
    const text = value?.trim()
    if (!text) return
    const urls = groups.get(text)
    if (urls) urls.add(url)
    else groups.set(text, new Set([url]))
  }
  for (const page of pages) {
    add(titles, page.metadata?.pageTitle, page.url)
    add(descriptions, page.metadata?.metaDescription, page.url)
  }
  const issues: SiteIssue[] = []
  for (const [code, label, groups] of [
    ['site.duplicate-title', 'title', titles],
    ['site.duplicate-meta-description', 'meta description', descriptions],
  ] as const) {
    for (const [value, urls] of groups) {
      if (urls.size < 2) continue
      issues.push({
        code,
        message: `${urls.size} pages share the same ${label} word for word: "${value.slice(0, 120)}"`,
        affectedUrls: [...urls].sort(),
      })
    }
  }
  return issues.sort((left, right) => left.code.localeCompare(right.code)
    || left.affectedUrls[0].localeCompare(right.affectedUrls[0])
    || left.message.localeCompare(right.message))
}

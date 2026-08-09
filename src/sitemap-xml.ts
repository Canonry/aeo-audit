export interface SitemapXmlEntry {
  loc: string
  priority?: number
}

export interface SitemapXmlDocument {
  pages: SitemapXmlEntry[]
  children: SitemapXmlEntry[]
}

/**
 * Decode XML entities in a sitemap `<loc>`. `&amp;` is last so `&amp;lt;`
 * remains the literal `&lt;`; invalid numeric references stay unchanged.
 */
export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (match, dec) => codePointToChar(Number(dec), match))
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => codePointToChar(parseInt(hex, 16), match))
    .replace(/&amp;/g, '&')
}

function codePointToChar(codePoint: number, original: string): string {
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : original
}

function locFromBlock(block: string): string | null {
  const raw = block.match(/<loc\b[^>]*>([\s\S]*?)<\/loc>/i)?.[1]?.trim()
  return raw ? decodeXmlEntities(raw) : null
}

function parsePageEntries(xml: string): SitemapXmlEntry[] {
  const entries: SitemapXmlEntry[] = []
  const urlBlock = /<url\b[^>]*>([\s\S]*?)<\/url>/gi
  let match: RegExpExecArray | null
  while ((match = urlBlock.exec(xml)) !== null) {
    const loc = locFromBlock(match[1])
    if (!loc) continue
    const priorityText = match[1].match(/<priority\b[^>]*>([\s\S]*?)<\/priority>/i)?.[1]?.trim()
    const priority = priorityText === undefined ? undefined : parseFloat(priorityText)
    entries.push({ loc, priority: Number.isFinite(priority) ? priority : undefined })
  }
  return entries
}

function parseChildEntries(xml: string): SitemapXmlEntry[] {
  const entries: SitemapXmlEntry[] = []
  const sitemapBlock = /<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi
  let match: RegExpExecArray | null
  while ((match = sitemapBlock.exec(xml)) !== null) {
    const loc = locFromBlock(match[1])
    if (loc) entries.push({ loc })
  }
  return entries
}

/** Parse page and child sitemap locations without discarding either document shape. */
export function parseSitemapXmlDocument(xml: string): SitemapXmlDocument {
  return {
    pages: parsePageEntries(xml),
    children: parseChildEntries(xml),
  }
}

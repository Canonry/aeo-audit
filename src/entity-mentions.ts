import { load } from 'cheerio'
import type {
  AuditContext,
  CriticalDefect,
  EntityMentionEvidence,
  EntityMentionField,
  EntityRegistry,
  StructuredDataEntry,
} from './types.js'

/**
 * Words are runs of letters and digits; an apostrophe inside a word stays part of it,
 * so "Hunter's" and "Hunter’s" both read as one word. A possessive "'s" is dropped from
 * names and text alike, so "Northwind Ridge's pool" names "Northwind Ridge".
 */
const WORD = /[\p{L}\p{N}]+(?:['‘’][\p{L}\p{N}]+)*/gu
const CURLY_APOSTROPHES = /[‘’]/g
const POSSESSIVE = /'s$/
const MAX_EVIDENCE = 25
const SNIPPET_LENGTH = 160

interface Word {
  word: string
  start: number
  end: number
}

interface NameNode {
  children: Map<string, NameNode>
  /** The registry name ending at this node, as written. */
  name?: string
  /** Every entity that uses this name. */
  keys?: string[]
}

interface OwnerMatcher {
  host: string
  /** Lowercase, always ends with `/`. */
  prefix: string
  key: string
}

interface CompiledRegistry {
  root: NameNode
  /** Longest prefix first, then registry order, so the first hit is the owner. */
  matchers: OwnerMatcher[]
  namesByKey: Map<string, string[][]>
  displayName: Map<string, string>
}

interface ScannedText {
  field: EntityMentionField
  question?: string
  text: string
}

interface Mention {
  key: string
  name: string
  start: number
  end: number
}

// A crawl passes the same registry object for every page, so it compiles once.
const compiledRegistries = new WeakMap<EntityRegistry, CompiledRegistry>()

function wordsOf(text: string): Word[] {
  const out: Word[] = []
  for (const match of text.matchAll(WORD)) {
    const start = match.index ?? 0
    const word = match[0].toLowerCase().replace(CURLY_APOSTROPHES, "'").replace(POSSESSIVE, '')
    out.push({ word, start, end: start + match[0].length })
  }
  return out
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '')
}

function normalizePrefix(prefix: string): string | null {
  const value = prefix.trim().toLowerCase()
  if (!value.startsWith('/')) return null
  return value.endsWith('/') ? value : `${value}/`
}

function compileRegistry(registry: EntityRegistry): CompiledRegistry {
  const cached = compiledRegistries.get(registry)
  if (cached) return cached
  const root: NameNode = { children: new Map() }
  const matchers: Array<OwnerMatcher & { order: number }> = []
  const namesByKey = new Map<string, string[][]>()
  const displayName = new Map<string, string>()
  const entities = Array.isArray(registry?.entities) ? registry.entities : []
  for (const entity of entities) {
    if (!entity || typeof entity.key !== 'string' || !entity.key) continue
    const key = entity.key
    for (const rawName of Array.isArray(entity.names) ? entity.names : []) {
      if (typeof rawName !== 'string') continue
      const tokens = wordsOf(rawName).map((word) => word.word)
      // A single word ("Harbor", "Legacy") is too often an ordinary word to match on.
      if (tokens.length < 2) continue
      const name = rawName.replace(/\s+/g, ' ').trim()
      if (!displayName.has(key)) displayName.set(key, name)
      namesByKey.set(key, [...(namesByKey.get(key) ?? []), tokens])
      let node = root
      for (const token of tokens) {
        let next = node.children.get(token)
        if (!next) {
          next = { children: new Map() }
          node.children.set(token, next)
        }
        node = next
      }
      node.name ??= name
      node.keys = [...new Set([...(node.keys ?? []), key])]
    }
    for (const matcher of Array.isArray(entity.urlMatchers) ? entity.urlMatchers : []) {
      if (!matcher || typeof matcher.host !== 'string' || typeof matcher.pathPrefix !== 'string') continue
      const host = normalizeHost(matcher.host)
      const prefix = normalizePrefix(matcher.pathPrefix)
      if (host && prefix) matchers.push({ host, prefix, key, order: matchers.length })
    }
  }
  matchers.sort((a, b) => b.prefix.length - a.prefix.length || a.order - b.order)
  const compiled: CompiledRegistry = { root, matchers, namesByKey, displayName }
  compiledRegistries.set(registry, compiled)
  return compiled
}

/** The entity a page belongs to: the matcher with the longest path prefix on the page's host. */
function ownerOf(url: string, registry: CompiledRegistry): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const host = normalizeHost(parsed.hostname)
  const path = parsed.pathname.toLowerCase()
  const withSlash = path.endsWith('/') ? path : `${path}/`
  return registry.matchers.find((matcher) => matcher.host === host && withSlash.startsWith(matcher.prefix))?.key ?? null
}

function containsSequence(haystack: string[], needle: string[]): boolean {
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    if (needle.every((word, offset) => haystack[start + offset] === word)) return true
  }
  return false
}

/**
 * Every registry name in `text`, longest name first at each position, never overlapping.
 * A name the owner uses, or one that contains or sits inside an owner name, is the
 * page talking about itself and is skipped.
 */
function findMentions(text: string, registry: CompiledRegistry, owner: string): Mention[] {
  const words = wordsOf(text)
  const ownerNames = registry.namesByKey.get(owner) ?? []
  const mentions: Mention[] = []
  let index = 0
  while (index < words.length) {
    let node = registry.root
    let best: { node: NameNode; last: number } | null = null
    for (let next = index; next < words.length; next++) {
      const child = node.children.get(words[next]!.word)
      if (!child) break
      node = child
      if (child.keys) best = { node: child, last: next }
    }
    if (!best) {
      index++
      continue
    }
    const sequence = words.slice(index, best.last + 1).map((word) => word.word)
    const keys = best.node.keys!
    const ownName = keys.includes(owner)
      || ownerNames.some((ownerName) => containsSequence(ownerName, sequence) || containsSequence(sequence, ownerName))
    if (!ownName) {
      mentions.push({ key: [...keys].sort()[0]!, name: best.node.name!, start: words[index]!.start, end: words[best.last]!.end })
    }
    index = best.last + 1
  }
  return mentions
}

function plainText(value: unknown): string {
  if (typeof value !== 'string') return ''
  const text = /[<&]/.test(value) ? load(value, null, false).text() : value
  return text.replace(/\s+/g, ' ').trim()
}

function typesOf(entry: StructuredDataEntry): string[] {
  const types = entry['@type']
  return (Array.isArray(types) ? types : [types]).filter((type): type is string => typeof type === 'string')
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  return value ? [value] : []
}

/** FAQPage questions and answers, then the title and every H1. */
function scannedTexts(context: AuditContext): ScannedText[] {
  const texts: ScannedText[] = []
  for (const entry of context.structuredData) {
    if (!typesOf(entry).includes('FAQPage')) continue
    for (const item of asList(entry.mainEntity)) {
      if (!item || typeof item !== 'object') continue
      const question = plainText((item as StructuredDataEntry).name)
      if (question) texts.push({ field: 'faq-question', question, text: question })
      for (const answer of asList((item as StructuredDataEntry).acceptedAnswer)) {
        if (!answer || typeof answer !== 'object') continue
        const text = plainText((answer as StructuredDataEntry).text)
        if (text) texts.push({ field: 'faq-answer', ...(question ? { question } : {}), text })
      }
    }
  }
  if (context.pageTitle) texts.push({ field: 'title', text: context.pageTitle.replace(/\s+/g, ' ').trim() })
  context.$('h1').each((_, element) => {
    const text = context.$(element).text().replace(/\s+/g, ' ').trim()
    if (text) texts.push({ field: 'h1', text })
  })
  return texts
}

function snippetAround(text: string, start: number, end: number): string {
  if (text.length <= SNIPPET_LENGTH) return text
  const room = Math.max(0, SNIPPET_LENGTH - (end - start))
  let from = Math.max(0, start - Math.floor(room / 2))
  const to = Math.min(text.length, from + SNIPPET_LENGTH)
  from = Math.max(0, to - SNIPPET_LENGTH)
  return `${from > 0 ? '…' : ''}${text.slice(from, to).trim()}${to < text.length ? '…' : ''}`
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

const PLACE_LABELS: Record<EntityMentionField, string> = {
  'faq-question': 'FAQ',
  'faq-answer': 'FAQ',
  title: 'title',
  h1: 'H1',
}

/**
 * The `names-another-entity` critical defect: a page that belongs to one registry
 * entity names a different one in its FAQ, title, or H1. That is the usual trace of
 * content copied between entity pages without the names changed, and it is the text
 * search engines and AI assistants read first. Returns null without a registry, for a
 * page no entity owns, and for a page that names only its own entity.
 */
export function detectEntityMentions(context: AuditContext, registry: EntityRegistry | undefined): CriticalDefect | null {
  if (!registry) return null
  const compiled = compileRegistry(registry)
  if (compiled.matchers.length === 0) return null
  const owner = ownerOf(context.url, compiled)
  if (!owner) return null
  const evidence: EntityMentionEvidence[] = []
  const seen = new Set<string>()
  // Counted over every mention, not just the listed ones.
  const places = new Set<string>()
  const names = new Set<string>()
  let total = 0
  for (const scanned of scannedTexts(context)) {
    for (const mention of findMentions(scanned.text, compiled, owner)) {
      const id = JSON.stringify([scanned.field, scanned.question ?? '', mention.key])
      if (seen.has(id)) continue
      seen.add(id)
      total++
      places.add(PLACE_LABELS[scanned.field])
      names.add(mention.name)
      if (evidence.length < MAX_EVIDENCE) {
        evidence.push({
          field: scanned.field,
          ...(scanned.question ? { question: scanned.question } : {}),
          entityKey: mention.key,
          entityName: mention.name,
          snippet: snippetAround(scanned.text, mention.start, mention.end),
        })
      }
    }
  }
  if (evidence.length === 0) return null
  const placeList = [...places]
  const nameList = [...names]
  const shown = nameList.slice(0, 3)
  const nameText = nameList.length === 1
    ? `another entity, ${nameList[0]}`
    : `${nameList.length} other entities: ${nameList.length > shown.length ? `${shown.join(', ')} and ${nameList.length - shown.length} more` : joinList(shown)}`
  const listed = total > evidence.length ? ` ${evidence.length} of ${total} mentions are listed.` : ''
  const ownerName = compiled.displayName.get(owner) ?? owner
  return {
    id: 'names-another-entity',
    severity: 'critical',
    detail: `The ${joinList(placeList)} ${placeList.length === 1 ? 'names' : 'name'} ${nameText}.${listed}`,
    recommendation: `This page belongs to ${ownerName}. Replace each mention with ${ownerName}'s own details, or remove it.`,
    evidence,
  }
}

import { load } from 'cheerio'
import { createSchemaRefResolver, findSchemaByType } from './analyzers/helpers.js'
import { isIdentifying, isJoiningWord } from './analyzers/schema-identity.js'
import type {
  AuditContext,
  CriticalDefect,
  EntityMentionEvidence,
  EntityMentionField,
  EntityRegistry,
  EntityRegistryEntry,
  EntityUrlMatcher,
} from './types.js'

/**
 * Words are runs of letters, digits and combining marks; an apostrophe inside a word
 * stays part of it, so "Hunter's" and "Hunter’s" both read as one word. Words compare
 * without case or accents, so "Café" matches "Cafe" in either Unicode form. A possessive
 * "'s" is dropped from names and text alike, so "Northwind Ridge's pool" names
 * "Northwind Ridge".
 */
const WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:['‘’][\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*/gu
const POSSESSIVE = /'s$/
const MAX_EVIDENCE = 25
const SNIPPET_LENGTH = 160
const RECOMMENDATION = 'Replace each mention with the details of the entity this page belongs to, or remove it.'

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
  /** Lowercase and URL-encoded, always ends with `/`. */
  prefix: string
  key: string
}

interface CompiledRegistry {
  root: NameNode
  /** Longest prefix first, then registry order, so the first hit is the owner. */
  matchers: OwnerMatcher[]
  /** Every name of each entity as words, one-word names included. */
  namesByKey: Map<string, string[][]>
  /** Each entity's first name, as written. */
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

/** A parsed HTML node, as cheerio's DOM exposes it. */
interface DomNode {
  type: string
  name?: string
  data?: string
  children?: DomNode[]
}

// Registries copied by `snapshotEntityRegistry`, and their compiled form. A run passes
// one copy for every page, so it compiles once per run.
const snapshots = new WeakSet<EntityRegistry>()
const compiledRegistries = new WeakMap<EntityRegistry, CompiledRegistry>()

function foldWord(raw: string): string {
  return raw.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[‘’]/g, "'").replace(POSSESSIVE, '')
}

function wordsOf(text: string): Word[] {
  const out: Word[] = []
  for (const match of text.matchAll(WORD)) {
    const start = match.index ?? 0
    out.push({ word: foldWord(match[0]), start, end: start + match[0].length })
  }
  return out
}

/**
 * Whether a name is distinctive enough to find in running text: at least two words
 * besides articles, joiners and lone letters, at least one of them identifying.
 * "The Lofts", "Building A" and "Luxury Apartments" read as ordinary text;
 * "Northwind Harbor" and "The Residences at Westshore" do not.
 */
function isMatchableName(words: string[]): boolean {
  const content = words.filter((word) => !isJoiningWord(word))
  return content.length >= 2 && content.some(isIdentifying)
}

/** A hostname as the URL parser writes it, without a trailing dot, `www.` or port. */
function normalizeHost(host: string): string | null {
  const value = host.trim().replace(/^[a-z][a-z\d+.-]*:\/\//i, '')
  if (!value) return null
  try {
    return new URL(`http://${value}`).hostname.replace(/\.$/, '').replace(/^www\./, '') || null
  } catch {
    return null
  }
}

/** A path prefix as the URL parser encodes it, lowercase, ending with `/`. */
function normalizePrefix(prefix: string): string | null {
  const value = prefix.trim()
  if (!value.startsWith('/') || value.startsWith('//')) return null
  let path: string
  try {
    path = new URL(value, 'http://host.invalid').pathname.toLowerCase()
  } catch {
    return null
  }
  return path.endsWith('/') ? path : `${path}/`
}

/**
 * A copy of the registry as it is now, with malformed entries left out, or undefined
 * for anything that is not an object. A run reads the copy, so a caller that changes
 * its own registry object later changes the next run, never one in progress. A copy
 * passed in again comes back as is.
 */
export function snapshotEntityRegistry(registry: unknown): EntityRegistry | undefined {
  if (!registry || typeof registry !== 'object') return undefined
  if (snapshots.has(registry as EntityRegistry)) return registry as EntityRegistry
  const raw = (registry as { entities?: unknown }).entities
  const entities: EntityRegistryEntry[] = []
  for (const entity of Array.isArray(raw) ? raw : []) {
    if (!entity || typeof entity !== 'object') continue
    const { key, names, urlMatchers } = entity as Record<string, unknown>
    if (typeof key !== 'string' || !key) continue
    const matchers: EntityUrlMatcher[] = []
    for (const matcher of Array.isArray(urlMatchers) ? urlMatchers : []) {
      if (!matcher || typeof matcher !== 'object') continue
      const { host, pathPrefix } = matcher as Record<string, unknown>
      if (typeof host === 'string' && typeof pathPrefix === 'string') matchers.push({ host, pathPrefix })
    }
    entities.push({
      key,
      names: Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string') : [],
      urlMatchers: matchers,
    })
  }
  const snapshot: EntityRegistry = { entities }
  snapshots.add(snapshot)
  return snapshot
}

function compileRegistry(registry: EntityRegistry): CompiledRegistry {
  const cached = compiledRegistries.get(registry)
  if (cached) return cached
  const root: NameNode = { children: new Map() }
  const matchers: Array<OwnerMatcher & { order: number }> = []
  const namesByKey = new Map<string, string[][]>()
  const displayName = new Map<string, string>()
  for (const entity of registry.entities) {
    const key = entity.key
    for (const rawName of entity.names) {
      const words = wordsOf(rawName).map((word) => word.word)
      if (words.length === 0) continue
      const name = rawName.replace(/\s+/g, ' ').trim()
      if (!displayName.has(key)) displayName.set(key, name)
      namesByKey.set(key, [...(namesByKey.get(key) ?? []), words])
      if (!isMatchableName(words)) continue
      let node = root
      for (const word of words) {
        let next = node.children.get(word)
        if (!next) {
          next = { children: new Map() }
          node.children.set(word, next)
        }
        node = next
      }
      node.name ??= name
      node.keys = [...new Set([...(node.keys ?? []), key])]
    }
    for (const matcher of entity.urlMatchers ?? []) {
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
  if (!host) return null
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

// Block elements and line breaks end a word; inline elements do not.
const WORD_BREAKS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
])

/** Text of parsed nodes, with a space where a block element or line break separates words. */
function textOf(nodes: DomNode[]): string {
  const parts: string[] = []
  const visit = (node: DomNode): void => {
    if (node.type === 'text') {
      parts.push(node.data ?? '')
      return
    }
    // Scripts, styles and comments are not text.
    if (node.type !== 'tag' && node.type !== 'root') return
    const breaks = WORD_BREAKS.has(node.name ?? '')
    if (breaks) parts.push(' ')
    for (const child of node.children ?? []) visit(child)
    if (breaks) parts.push(' ')
  }
  for (const node of nodes) visit(node)
  return parts.join('').replace(/\s+/g, ' ').trim()
}

function plainText(value: unknown): string {
  if (typeof value !== 'string') return ''
  if (!/[<&]/.test(value)) return value.replace(/\s+/g, ' ').trim()
  return textOf(load(value, null, false).root().toArray() as unknown as DomNode[])
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  return value ? [value] : []
}

/**
 * Questions and answers of every FAQPage on the page, including one nested in another
 * node and questions or answers it names by `@id` (as Yoast writes them), then the
 * title and every H1.
 */
function scannedTexts(context: AuditContext): ScannedText[] {
  const texts: ScannedText[] = []
  const resolve = createSchemaRefResolver(context.structuredData, context.url)
  for (const faq of findSchemaByType(context.structuredData, 'FAQPage')) {
    for (const reference of asList(faq.mainEntity)) {
      const item = resolve(reference)
      if (!item) continue
      const question = plainText(item.name)
      if (question) texts.push({ field: 'faq-question', question, text: question })
      for (const answerReference of asList(item.acceptedAnswer)) {
        const answer = resolve(answerReference)
        if (!answer) continue
        const text = plainText(answer.text)
        if (text) texts.push({ field: 'faq-answer', ...(question ? { question } : {}), text })
      }
    }
  }
  if (context.pageTitle) texts.push({ field: 'title', text: context.pageTitle.replace(/\s+/g, ' ').trim() })
  context.$('h1').each((_, element) => {
    const text = textOf([element as unknown as DomNode])
    if (text) texts.push({ field: 'h1', text })
  })
  return texts
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/** Up to SNIPPET_LENGTH characters around a match, ellipses included, never splitting a character. */
function snippetAround(text: string, start: number, end: number): string {
  if (text.length <= SNIPPET_LENGTH) return text
  // Room is kept for an ellipsis at each end.
  const budget = SNIPPET_LENGTH - 2
  const room = Math.max(0, budget - (end - start))
  let from = Math.max(0, start - Math.floor(room / 2))
  let to = Math.min(text.length, from + budget)
  from = Math.max(0, to - budget)
  if (from > 0 && isLowSurrogate(text.charCodeAt(from))) from++
  if (to < text.length && isLowSurrogate(text.charCodeAt(to))) to--
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
 * page no entity owns, and for a page that names only its own entity. The detail names
 * the page's own entity; the recommendation reads the same on every page, so a rollup
 * can show it once for all of them.
 */
export function detectEntityMentions(context: AuditContext, registry: EntityRegistry | undefined): CriticalDefect | null {
  const snapshot = snapshotEntityRegistry(registry)
  if (!snapshot) return null
  const compiled = compileRegistry(snapshot)
  if (compiled.matchers.length === 0) return null
  const owner = ownerOf(context.url, compiled)
  if (!owner) return null
  const evidence: EntityMentionEvidence[] = []
  const seen = new Set<string>()
  // Counted over every mention, not just the listed ones.
  const places = new Set<string>()
  const entities = new Set<string>()
  let total = 0
  for (const scanned of scannedTexts(context)) {
    for (const mention of findMentions(scanned.text, compiled, owner)) {
      const id = JSON.stringify([scanned.field, scanned.question ?? '', mention.key])
      if (seen.has(id)) continue
      seen.add(id)
      total++
      places.add(PLACE_LABELS[scanned.field])
      entities.add(mention.key)
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
  const nameList = [...entities].map((key) => compiled.displayName.get(key) ?? key)
  const shown = nameList.slice(0, 3)
  const nameText = nameList.length === 1
    ? `another entity, ${nameList[0]}`
    : `${nameList.length} other entities: ${nameList.length > shown.length ? `${shown.join(', ')} and ${nameList.length - shown.length} more` : joinList(shown)}`
  const listed = total > evidence.length ? ` ${evidence.length} of ${total} mentions are listed.` : ''
  const ownerName = compiled.displayName.get(owner) ?? owner
  return {
    id: 'names-another-entity',
    severity: 'critical',
    detail: `This page belongs to ${ownerName}, but its ${joinList(placeList)} ${placeList.length === 1 ? 'names' : 'name'} ${nameText}.${listed}`,
    recommendation: RECOMMENDATION,
    evidence,
  }
}

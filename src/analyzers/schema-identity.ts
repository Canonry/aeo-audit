import type { CheerioAPI } from 'cheerio'
import { countWords, normalizeText } from './helpers.js'
import { pageBusinessNodes } from '../local-business.js'
import type { AuditContext, StructuredDataEntry } from '../types.js'

/**
 * Words that do not tell one business from another: articles and joiners,
 * legal forms, and the kind of business. Sister properties share these
 * ("The Example Resort" and "Example Resort & Spa" are one name), so matching
 * on them would let any two resorts match.
 */
const NON_IDENTIFYING: ReadonlySet<string> = new Set(`
  the a an and of at on in by for to
  la le les el los las lo il de del della di du des da do dos das der die und y e et
  llc inc incorporated corp corporation co company ltd limited plc llp lp pllc pc
  gmbh ag sa sas sarl srl bv nv pty sl
  hotel hotels resort resorts inn inns lodge lodges motel motels suite suites hostel hostels
  spa spas villa villas cottage cottages cabin cabins campground camp bnb bed breakfast
  boutique luxury residences apartments marina golf casino
  restaurant restaurants cafe coffee bar grill bistro kitchen bakery pub tavern brewery winery
  clinic dental medical store shop salon studio center centre club group collection
  hospitality properties
  official site website home homepage welcome
`.split(/\s+/).filter(Boolean))

/**
 * Below this many words of page text, a name missing from the page is no
 * evidence: the content may be rendered by script after load.
 */
const MIN_WORDS_FOR_ABSENCE = 50

const US_STATES = 'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY'
const CA_PROVINCES = 'AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT'
// "Port Alder, ME 04001" and "Port Alder, NS B0J 1A0". Case-sensitive on purpose:
// an uppercase region code right before a postal code is an address, not prose.
const POSTAL_ADDRESSES: ReadonlyArray<{ country: string; label: string; pattern: RegExp }> = [
  { country: 'US', label: 'a US postal address', pattern: new RegExp(`[A-Za-z.]\\s*,?\\s+(?:${US_STATES})\\s*,?\\s+\\d{5}(?:-\\d{4})?(?![\\d-])`) },
  {
    country: 'CA',
    label: 'a Canadian postal address',
    pattern: new RegExp(`[A-Za-z.]\\s*,?\\s+(?:${CA_PROVINCES})\\s*,?\\s+[ABCEGHJ-NPRSTVXY]\\d[ABCEGHJ-NPRSTV-Z] ?\\d[ABCEGHJ-NPRSTV-Z]\\d(?![A-Za-z0-9])`),
  },
]

interface DomNode { type: string; name?: string; data?: string; children?: DomNode[] }
// Not page text. Form choices are left out too: a booking widget that lists
// every sister property in a <select> does not name them as the page's own.
const UNRENDERED = new Set(['script', 'style', 'noscript', 'template', 'select', 'option', 'optgroup', 'datalist'])

/**
 * The body's text with a space between elements. The shared `textContent`
 * joins adjacent elements, so `<li>Inn</li><li>Hotel</li>` reads "InnHotel"
 * and a listed name would never match.
 */
function bodyText($: CheerioAPI): string {
  const parts: string[] = []
  const stack = ($('body').toArray() as unknown as DomNode[]).reverse()
  while (stack.length) {
    const node = stack.pop()!
    if (node.type === 'text') {
      parts.push(node.data ?? '')
    } else if (node.children && !UNRENDERED.has(node.name ?? '')) {
      for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]!)
    }
  }
  return normalizeText(parts.join(' '))
}

// Country names are matched in English and the languages business names most
// often borrow from. Codes that name a group or a test region are not countries.
const NAME_LOCALES = ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl']
const NOT_COUNTRIES: ReadonlySet<string> = new Set(['EU', 'EZ', 'QO', 'UN', 'XA', 'XB', 'ZZ'])
const EXTRA_COUNTRY_NAMES: Readonly<Record<string, readonly string[]>> = {
  US: ['USA', 'U.S.A.', 'U.S.', 'United States of America'],
  GB: ['UK', 'U.K.', 'Great Britain', 'Britain', 'England', 'Scotland', 'Wales', 'Northern Ireland'],
}
// ISO alpha-3 codes seen in addressCountry often enough to resolve.
const ALPHA3: Readonly<Record<string, string>> = { USA: 'US', CAN: 'CA', MEX: 'MX', GBR: 'GB' }

/** Case, accents, apostrophes and punctuation folded away; words separated by one space. */
function fold(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/['’‘`´]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** `haystack` is folded and padded with spaces; `needle` is folded. */
function containsWords(haystack: string, needle: string): boolean {
  if (!needle) return false
  // Scripts written without spaces between words only match as substrings.
  return /^[a-z0-9 ]+$/.test(needle) ? haystack.includes(` ${needle} `) : haystack.includes(needle)
}

function isIdentifying(token: string): boolean {
  return !NON_IDENTIFYING.has(token) && (token.length > 1 || /\d/.test(token))
}

/** Runs of identifying words: "Hotel Playa Azul & Spa at Bahia" -> ["playa azul"], ["bahia"]. */
function identifyingRuns(tokens: string[]): string[][] {
  const runs: string[][] = [[]]
  for (const token of tokens) {
    if (isIdentifying(token)) runs.at(-1)!.push(token)
    else if (runs.at(-1)!.length) runs.push([])
  }
  return runs.filter((run) => run.length > 0)
}

let regionNames: Intl.DisplayNames[] | null | undefined
function displayNames(): Intl.DisplayNames[] | null {
  if (regionNames === undefined) {
    try {
      regionNames = NAME_LOCALES.map((locale) => new Intl.DisplayNames([locale], { type: 'region', fallback: 'none' }))
    } catch {
      regionNames = null
    }
  }
  return regionNames
}

/** "UK" -> "GB"; undefined when the code is not a country. */
function canonicalCountryCode(code: string): string | undefined {
  if (!/^[A-Z]{2}$/.test(code) || NOT_COUNTRIES.has(code)) return undefined
  const names = displayNames()
  if (names && names[0]!.of(code) === undefined) return undefined
  try {
    return Intl.getCanonicalLocales(`und-${code}`)[0]!.split('-')[1] ?? code
  } catch {
    return code
  }
}

const namesByCode = new Map<string, string[]>()
/** Folded names a page might use for a country. */
function countryNames(code: string): string[] {
  let names = namesByCode.get(code)
  if (!names) {
    const raw = [...(displayNames()?.map((display) => display.of(code)) ?? []), ...(EXTRA_COUNTRY_NAMES[code] ?? [])]
    names = [...new Set(raw.filter((name): name is string => typeof name === 'string').map(fold).filter(Boolean))]
    namesByCode.set(code, names)
  }
  return names
}

let codesByName: Map<string, string> | undefined
function countryCodeByName(name: string): string | undefined {
  if (!codesByName) {
    codesByName = new Map()
    for (const [code, extra] of Object.entries(EXTRA_COUNTRY_NAMES)) {
      for (const alias of extra) codesByName.set(fold(alias), code)
    }
    for (let first = 65; first <= 90; first += 1) {
      for (let second = 65; second <= 90; second += 1) {
        const code = canonicalCountryCode(String.fromCharCode(first, second))
        if (!code) continue
        for (const display of displayNames() ?? []) {
          const folded = fold(display.of(code) ?? '')
          if (folded && !codesByName.has(folded)) codesByName.set(folded, code)
        }
      }
    }
  }
  return codesByName.get(name)
}

/** An ISO 3166-1 alpha-2 code for an addressCountry value, if it names one. */
export function resolveCountry(raw: string): string | undefined {
  const value = raw.trim()
  const upper = value.toUpperCase()
  if (Object.hasOwn(ALPHA3, upper)) return ALPHA3[upper]
  // A bare code, or a subdivision code such as "MX-SIN".
  const code = /^([A-Z]{2})(?:[-_][A-Z0-9]{1,3})?$/.exec(upper)?.[1]
  if (code) return canonicalCountryCode(code)
  const folded = fold(value)
  return folded ? countryCodeByName(folded) : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? normalizeText(value) : undefined
}

function readNames(node: StructuredDataEntry, key: 'name' | 'alternateName' | 'legalName'): string[] {
  const value = node[key]
  return (Array.isArray(value) ? value : [value]).flatMap((entry) => {
    const name = text(entry) ?? (entry && typeof entry === 'object' ? text((entry as Record<string, unknown>)['@value']) : undefined)
    return name ? [name] : []
  })
}

interface Place {
  locality?: string
  region?: string
  country?: string
  postalCode?: string
  street?: string
}

function readPlaces(node: StructuredDataEntry): Place[] {
  const value = node.address
  return (Array.isArray(value) ? value : [value]).flatMap((entry): Place[] => {
    if (!entry || typeof entry !== 'object') return []
    const address = entry as Record<string, unknown>
    const rawCountry = address.addressCountry
    const countryText = text(rawCountry)
      ?? (rawCountry && typeof rawCountry === 'object' ? text((rawCountry as Record<string, unknown>).name) : undefined)
    const place: Place = {
      locality: text(address.addressLocality),
      region: text(address.addressRegion),
      country: countryText ? resolveCountry(countryText) : undefined,
      postalCode: text(address.postalCode),
      street: text(address.streetAddress),
    }
    return place.locality || place.country ? [place] : []
  })
}

interface PageIdentity {
  title: string
  h1s: string[]
  /** Folded and padded: the places a page states its own name. */
  anchors: string[]
  /** Host name without the TLD, letters and digits only. Part of the site's brand. */
  host: string
  /** Identifying words of og:site_name: the site's brand, on every page of it. */
  brand: Set<string>
  /** Folded and padded: everything the page says, for mentions. */
  corpus: string
  raw: string
  words: number
  /** Country code to the evidence for it. */
  countries: Map<string, string>
}

function readPage(context: AuditContext): PageIdentity {
  const { $ } = context
  const meta = (selector: string): string => normalizeText($(selector).first().attr('content') ?? '')
  const metaByName = new Map<string, string>()
  $('meta[name]').each((_, element) => {
    const name = ($(element).attr('name') ?? '').trim().toLowerCase()
    const content = normalizeText($(element).attr('content') ?? '')
    if (name && content && !metaByName.has(name)) metaByName.set(name, content)
  })

  const title = normalizeText(context.pageTitle)
  const h1s = $('h1').toArray().map((element) => normalizeText($(element).text())).filter(Boolean)
  const ogTitle = meta('meta[property="og:title"]')
  const siteName = meta('meta[property="og:site_name"]')
  const alts = $('img[alt]').toArray().map((element) => $(element).attr('alt') ?? '')
  const visible = bodyText($)
  const raw = [
    title, ...h1s, ogTitle, siteName, meta('meta[property="og:description"]'),
    metaByName.get('description') ?? '', metaByName.get('geo.placename') ?? '', visible, ...alts,
  ].join(' ')

  let host = ''
  try {
    host = new URL(context.url).hostname.toLowerCase().replace(/^www\./, '').split('.').slice(0, -1).join('').replace(/[^a-z0-9]/g, '')
  } catch {
    // Unparseable URL: no host evidence.
  }

  const countries = new Map<string, string>()
  const geoRegion = metaByName.get('geo.region')
  const geoCountry = geoRegion ? resolveCountry(geoRegion) : undefined
  if (geoRegion && geoCountry) countries.set(geoCountry, `the page's geo.region tag is "${geoRegion}"`)
  for (const { country, label, pattern } of POSTAL_ADDRESSES) {
    if (!countries.has(country) && pattern.test(raw)) countries.set(country, `the page shows ${label}`)
  }

  return {
    title,
    h1s,
    anchors: [title, ...h1s, ogTitle].filter(Boolean).map((value) => ` ${fold(value)} `),
    host,
    brand: new Set(fold(siteName).split(' ').filter(isIdentifying)),
    corpus: ` ${fold(raw)} `,
    raw,
    words: countWords(visible),
    countries,
  }
}

/** A word the site's own brand explains: in og:site_name, or part of the host name. */
function isBrandWord(token: string, page: PageIdentity): boolean {
  return page.brand.has(token) || (token.length >= 4 && /^[a-z0-9]+$/.test(token) && page.host.includes(token))
}

/**
 * True when the page names it, undefined when the name has nothing distinctive
 * to look for. A brand word sits on every page of the site, sister properties
 * included, so it cannot show which business a page is about: "Example Lakes
 * Resort" is judged by "lakes" on a page of example.com. A name made only of
 * the brand is left unjudged.
 */
function nameOnPage(name: string, page: PageIdentity): boolean | undefined {
  const tokens = fold(name).split(' ').filter(Boolean)
  const specific = new Set(tokens.filter((token) => isIdentifying(token) && !isBrandWord(token, page)))
  if (!specific.size) return undefined
  const phrase = identifyingRuns(tokens).find((run) => run.some((token) => specific.has(token)))
  return page.anchors.some((anchor) => [...specific].some((token) => containsWords(anchor, token)))
    || Boolean(phrase && containsWords(page.corpus, phrase.join(' ')))
}

function placeOnPage(place: Place, page: PageIdentity): boolean {
  const phrases = [place.locality, place.street]
  if (place.region && place.region.length > 3) phrases.push(place.region)
  if (phrases.some((phrase) => phrase && containsWords(page.corpus, fold(phrase)))) return true
  if (place.country && countryNames(place.country).some((name) => containsWords(page.corpus, name))) return true
  if (place.region && /^[A-Za-z]{2,3}$/.test(place.region)
    && new RegExp(`(?<![A-Za-z])${place.region.toUpperCase()}(?![A-Za-z])`).test(page.raw)) return true
  return Boolean(place.postalCode && place.postalCode.length >= 4 && page.raw.includes(place.postalCode))
}

interface BusinessCheck {
  type: string
  name?: string
  key: string
  /** undefined: the name could not be judged on this page. */
  named?: boolean
  conflict?: { place: Place; evidence: string }
}

function checkBusiness(node: StructuredDataEntry, type: string, page: PageIdentity): BusinessCheck {
  const primary = readNames(node, 'name')
  const names = [...primary, ...readNames(node, 'alternateName'), ...readNames(node, 'legalName')]
  const verdicts = names.map((name) => nameOnPage(name, page)).filter((verdict) => verdict !== undefined)
  let named: boolean | undefined
  if (primary.length && verdicts.length && (page.title || page.h1s.length)) {
    named = verdicts.some(Boolean) ? true : page.words >= MIN_WORDS_FOR_ABSENCE ? false : undefined
  }

  // A different country only counts with positive evidence of where the page
  // is, and only when the page never mentions the schema's place: a resort
  // page that lists a sales office abroad still names its own town.
  let conflict: BusinessCheck['conflict']
  const places = readPlaces(node)
  const located = places.filter((place) => place.country)
  if (located.length && page.countries.size
    && !located.some((place) => page.countries.has(place.country!))
    && !places.some((place) => placeOnPage(place, page))) {
    conflict = { place: located[0]!, evidence: [...page.countries.values()][0]! }
  }

  return { type, name: primary[0], key: primary[0] ? fold(primary[0]) : `#${type}`, named, conflict }
}

export type SchemaIdentityResult =
  | { status: 'match'; message: string }
  | { status: 'mismatch'; message: string }
  | { status: 'unknown' }

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function countryName(code: string): string {
  return displayNames()?.[0]?.of(code) ?? code
}

function describeMismatch(check: BusinessCheck, page: PageIdentity, nameMissing: boolean): string {
  const parts = [`JSON-LD ${check.type}${check.name ? ` "${clip(check.name, 80)}"` : ''} does not match this page.`]
  if (nameMissing) {
    const where = [
      page.title ? `the title "${clip(page.title, 70)}"` : '',
      page.h1s[0] ? `the H1 "${clip(page.h1s[0], 70)}"` : '',
    ].filter(Boolean)
    parts.push(`Name: not found in ${where.join(', ')} or the page text.`)
  }
  if (check.conflict) {
    const { place, evidence } = check.conflict
    const country = countryName(place.country!)
    const label = [place.locality, place.region, country].filter(Boolean).join(', ')
    const mentions = [place.locality, place.region && place.region.length > 3 ? place.region : undefined, country]
      .filter((value): value is string => Boolean(value))
    const listed = mentions.length > 1 ? `${mentions.slice(0, -1).join(', ')} or ${mentions.at(-1)}` : mentions[0]
    parts.push(`Address: ${clip(label, 100)}, but ${evidence} and never mentions ${listed}.`)
  }
  return parts.join(' ')
}

/**
 * Whether the page's LocalBusiness JSON-LD describes the business the page
 * itself shows. A mismatch means one of two things the page contradicts:
 *
 * - The business name appears nowhere on the page: not in the title, an H1,
 *   og:title or the page text. Words like "The", "&", legal forms and "Resort"
 *   or "Hotel" are ignored, so variants of one name match. So are words the
 *   site's brand explains (og:site_name, the host name), which every sister
 *   property shares. Form choices, such as a booking `<select>`, are not text.
 * - The address is in another country than the page shows (a `geo.region` tag,
 *   or a US or Canadian postal address in the page text), and the page never
 *   mentions the address's town, region, country or postal code.
 *
 * Both are conservative. A page that names the business anywhere, or a page
 * with too little text to judge, is not flagged on the name. On a page with
 * several businesses, an unnamed one is flagged only when another business on
 * the page is named, because a listing page names none of them in its title.
 */
export function checkSchemaIdentity(context: AuditContext): SchemaIdentityResult {
  const nodes = pageBusinessNodes(context.structuredData)
  if (!nodes.length) return { status: 'unknown' }

  const page = readPage(context)
  const checks = nodes.map(({ node, type }) => checkBusiness(node, type, page))
  const distinctBusinesses = new Set(checks.map((check) => check.key)).size
  const pageNamesABusiness = checks.some((check) => check.named === true)
  const nameMissing = (check: BusinessCheck): boolean => check.named === false && (distinctBusinesses === 1 || pageNamesABusiness)

  const mismatches = checks.filter((check) => nameMissing(check) || check.conflict)
  if (mismatches.length) {
    const first = mismatches[0]!
    const others = new Set(mismatches.slice(1).map((check) => check.key).filter((key) => key !== first.key)).size
    const more = others ? ` ${others} more business ${others === 1 ? 'entry' : 'entries'} on this page also ${others === 1 ? 'does' : 'do'} not match.` : ''
    return { status: 'mismatch', message: `${describeMismatch(first, page, nameMissing(first))}${more}` }
  }

  const matched = checks.find((check) => check.named === true)
  if (matched) {
    return { status: 'match', message: `JSON-LD ${matched.type} "${clip(matched.name!, 80)}" matches the business this page names.` }
  }
  return { status: 'unknown' }
}

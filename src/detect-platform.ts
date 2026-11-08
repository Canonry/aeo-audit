import { load, type CheerioAPI } from 'cheerio'
import { isAgentReadinessError } from './errors.js'
import { fetchPage, normalizeTargetUrl } from './fetch-page.js'
import { mapWithConcurrency } from './sitemap.js'
import type {
  BatchDetectionEntry,
  BatchPlatformDetectionReport,
  DetectedPlatform,
  PlatformCategory,
  PlatformConfidence,
  PlatformDetectionReport,
} from './types.js'

const HIGH_THRESHOLD = 70
const MEDIUM_THRESHOLD = 40
const LOW_THRESHOLD = 15

interface DetectionInput {
  $: CheerioAPI
  html: string
  headers: Record<string, string>
}

interface SignalHit {
  evidence: string
  weight: number
  version?: string
}

type SignalFn = (input: DetectionInput) => SignalHit | null

interface PlatformDef {
  id: string
  name: string
  category: PlatformCategory
  signals: SignalFn[]
}

/* ── Signal helpers ───────────────────────────────────────────────────── */

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key]
  }
  return undefined
}

function metaGenerator(pattern: RegExp, weight: number): SignalFn {
  return ({ $ }) => {
    const content = $('meta[name="generator" i]').attr('content')?.trim()
    if (!content) return null
    const match = content.match(pattern)
    if (!match) return null
    return {
      evidence: `<meta name="generator" content="${content.slice(0, 80)}">`,
      weight,
      version: match[1],
    }
  }
}

function scriptSrcContains(needle: string | RegExp, weight: number): SignalFn {
  return ({ $ }) => {
    let hit: string | undefined
    $('script[src]').each((_, el) => {
      if (hit) return
      const src = $(el).attr('src') || ''
      if (typeof needle === 'string' ? src.includes(needle) : needle.test(src)) {
        hit = src
      }
    })
    if (!hit) return null
    return { evidence: `script src includes "${truncate(hit, 80)}"`, weight }
  }
}

function linkHrefContains(needle: string | RegExp, weight: number): SignalFn {
  return ({ $ }) => {
    let hit: string | undefined
    $('link[href]').each((_, el) => {
      if (hit) return
      const href = $(el).attr('href') || ''
      if (typeof needle === 'string' ? href.includes(needle) : needle.test(href)) {
        hit = href
      }
    })
    if (!hit) return null
    return { evidence: `link href includes "${truncate(hit, 80)}"`, weight }
  }
}

function imgSrcContains(needle: string | RegExp, weight: number): SignalFn {
  return ({ $ }) => {
    let hit: string | undefined
    $('img[src]').each((_, el) => {
      if (hit) return
      const src = $(el).attr('src') || ''
      if (typeof needle === 'string' ? src.includes(needle) : needle.test(src)) {
        hit = src
      }
    })
    if (!hit) return null
    return { evidence: `img src includes "${truncate(hit, 80)}"`, weight }
  }
}

function htmlMatches(pattern: RegExp, weight: number, label?: string): SignalFn {
  return ({ html }) => {
    const match = html.match(pattern)
    if (!match) return null
    return {
      evidence: label ?? `HTML contains ${pattern.source.slice(0, 60)}`,
      weight,
      version: match[1],
    }
  }
}

function headerMatches(name: string, pattern: RegExp, weight: number): SignalFn {
  return ({ headers }) => {
    const value = getHeader(headers, name)
    if (!value) return null
    const match = value.match(pattern)
    if (!match) return null
    return {
      evidence: `${name} header: "${truncate(value, 80)}"`,
      weight,
      version: match[1],
    }
  }
}

function headerExists(name: string, weight: number): SignalFn {
  return ({ headers }) => {
    const value = getHeader(headers, name)
    if (!value) return null
    return { evidence: `${name} header present: "${truncate(value, 80)}"`, weight }
  }
}

function bodyClassContains(token: string, weight: number): SignalFn {
  return ({ $ }) => {
    const cls = $('body').attr('class') || ''
    if (!cls.split(/\s+/).some((c) => c.includes(token))) return null
    return { evidence: `body class contains "${token}"`, weight }
  }
}

function elementExists(selector: string, weight: number, label?: string): SignalFn {
  return ({ $ }) => {
    if ($(selector).length === 0) return null
    return { evidence: label ?? `element ${selector} present`, weight }
  }
}

function attributeExists(selector: string, attr: string, weight: number): SignalFn {
  return ({ $ }) => {
    let hit: string | undefined
    $(selector).each((_, el) => {
      if (hit) return
      const v = $(el).attr(attr)
      if (typeof v === 'string') hit = v
    })
    if (hit === undefined) return null
    return { evidence: `${selector}[${attr}] present`, weight }
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

/* ── Platform definitions ─────────────────────────────────────────────── */

const PLATFORMS: PlatformDef[] = [
  /* === CMS ============================================================ */
  {
    id: 'wordpress',
    name: 'WordPress',
    category: 'cms',
    signals: [
      metaGenerator(/WordPress(?:\s+(\d+\.\d+(?:\.\d+)?))?/i, 5),
      scriptSrcContains('/wp-includes/', 5),
      scriptSrcContains('/wp-content/', 4),
      linkHrefContains('/wp-content/', 3),
      linkHrefContains('/wp-json/', 4),
      htmlMatches(/wp-block-[a-z]/, 2, 'wp-block-* class found'),
      headerExists('x-pingback', 3),
      headerMatches('link', /wp-json/i, 4),
    ],
  },
  {
    id: 'drupal',
    name: 'Drupal',
    category: 'cms',
    signals: [
      metaGenerator(/Drupal(?:\s+(\d+))?/i, 5),
      headerMatches('x-generator', /drupal/i, 5),
      headerExists('x-drupal-cache', 4),
      headerExists('x-drupal-dynamic-cache', 4),
      htmlMatches(/sites\/(?:default|all)\//i, 3, '/sites/default/ or /sites/all/ path'),
    ],
  },
  {
    id: 'joomla',
    name: 'Joomla',
    category: 'cms',
    signals: [
      metaGenerator(/Joomla(?:!\s*-?\s*(\d+\.\d+))?/i, 5),
      htmlMatches(/\/media\/jui\//i, 3, '/media/jui/ path'),
      htmlMatches(/\/components\/com_/i, 3, '/components/com_* path'),
    ],
  },
  {
    id: 'ghost',
    name: 'Ghost',
    category: 'cms',
    signals: [
      metaGenerator(/Ghost(?:\s+(\d+\.\d+))?/i, 5),
      linkHrefContains('/ghost/', 3),
      scriptSrcContains('ghost.io', 3),
    ],
  },
  {
    id: 'hubspot',
    name: 'HubSpot CMS',
    category: 'cms',
    signals: [
      metaGenerator(/HubSpot/i, 5),
      // tracking/forms scripts: low weight — many non-CMS sites embed HubSpot CRM tooling.
      scriptSrcContains('js.hs-scripts.com', 2),
      scriptSrcContains('js.hsforms.net', 1),
      scriptSrcContains('hs-banner.com', 1),
      scriptSrcContains('hs-analytics.net', 1),
    ],
  },
  {
    id: 'craft-cms',
    name: 'Craft CMS',
    category: 'cms',
    signals: [
      headerMatches('x-powered-by', /Craft\s*CMS/i, 5),
      scriptSrcContains('cdn.craft.cm', 3),
    ],
  },
  {
    id: 'sanity',
    name: 'Sanity',
    category: 'cms',
    signals: [
      imgSrcContains('cdn.sanity.io', 4),
      htmlMatches(/cdn\.sanity\.io/i, 3, 'cdn.sanity.io reference'),
    ],
  },
  {
    id: 'contentful',
    name: 'Contentful',
    category: 'cms',
    signals: [
      imgSrcContains('images.ctfassets.net', 4),
      imgSrcContains('assets.ctfassets.net', 4),
      htmlMatches(/(?:images|assets|videos)\.ctfassets\.net/i, 3, 'ctfassets.net reference'),
    ],
  },
  {
    id: 'notion',
    name: 'Notion (notion.site)',
    category: 'cms',
    signals: [
      htmlMatches(/notion\.site/i, 3, 'notion.site reference'),
      metaGenerator(/Notion/i, 5),
      htmlMatches(/__NOTION/, 3, '__NOTION marker'),
    ],
  },

  /* === Site builders =================================================== */
  {
    id: 'wix',
    name: 'Wix',
    category: 'site-builder',
    signals: [
      metaGenerator(/Wix(?:\.com)?/i, 5),
      scriptSrcContains('static.wixstatic.com', 5),
      htmlMatches(/wix-warmup-data/i, 4, 'wix-warmup-data marker'),
      htmlMatches(/parastorage\.com/i, 3, 'parastorage.com (Wix CDN)'),
    ],
  },
  {
    id: 'squarespace',
    name: 'Squarespace',
    category: 'site-builder',
    signals: [
      metaGenerator(/Squarespace/i, 5),
      scriptSrcContains('static1.squarespace.com', 5),
      htmlMatches(/Static\.SQUARESPACE_CONTEXT/, 5, 'Static.SQUARESPACE_CONTEXT global'),
      headerMatches('x-served-by', /squarespace/i, 4),
    ],
  },
  {
    id: 'webflow',
    name: 'Webflow',
    category: 'site-builder',
    signals: [
      metaGenerator(/Webflow/i, 5),
      attributeExists('html', 'data-wf-page', 5),
      attributeExists('html', 'data-wf-site', 5),
      scriptSrcContains('webflow.js', 4),
      scriptSrcContains('webflow.com', 3),
      imgSrcContains('uploads-ssl.webflow.com', 4),
      imgSrcContains('cdn.prod.website-files.com', 4),
    ],
  },
  {
    id: 'framer',
    name: 'Framer',
    category: 'site-builder',
    signals: [
      metaGenerator(/Framer/i, 5),
      htmlMatches(/framerusercontent\.com/i, 4, 'framerusercontent.com reference'),
      htmlMatches(/framer\.com/i, 2, 'framer.com reference'),
    ],
  },
  {
    id: 'carrd',
    name: 'Carrd',
    category: 'site-builder',
    signals: [
      metaGenerator(/Carrd/i, 5),
      htmlMatches(/carrd\.co/i, 3, 'carrd.co reference'),
    ],
  },
  {
    id: 'bubble',
    name: 'Bubble',
    category: 'site-builder',
    signals: [
      metaGenerator(/Bubble/i, 4),
      scriptSrcContains('bubble.io', 4),
      htmlMatches(/bubble-app/i, 3, 'bubble-app marker'),
    ],
  },

  /* === E-commerce ====================================================== */
  {
    id: 'shopify',
    name: 'Shopify',
    category: 'ecommerce',
    signals: [
      headerExists('x-shopid', 5),
      headerExists('x-shopify-stage', 5),
      scriptSrcContains('cdn.shopify.com', 5),
      htmlMatches(/Shopify\.theme\b/, 5, 'Shopify.theme global'),
      htmlMatches(/Shopify\.shop\b/, 4, 'Shopify.shop global'),
      headerMatches('powered-by', /Shopify/i, 4),
    ],
  },
  {
    id: 'woocommerce',
    name: 'WooCommerce',
    category: 'ecommerce',
    signals: [
      bodyClassContains('woocommerce', 4),
      htmlMatches(/wp-content\/plugins\/woocommerce/i, 5, 'WooCommerce plugin path'),
      metaGenerator(/WooCommerce(?:\s+(\d+\.\d+))?/i, 5),
    ],
  },
  {
    id: 'bigcommerce',
    name: 'BigCommerce',
    category: 'ecommerce',
    signals: [
      scriptSrcContains('cdn11.bigcommerce.com', 5),
      headerMatches('x-bc-apigw-client-id', /./, 5),
      htmlMatches(/bigcommerce\.com/i, 3, 'bigcommerce.com reference'),
    ],
  },
  {
    id: 'magento',
    name: 'Magento (Adobe Commerce)',
    category: 'ecommerce',
    signals: [
      htmlMatches(/Mage\.Cookies/, 5, 'Mage.Cookies marker'),
      htmlMatches(/\/skin\/frontend\//i, 4, '/skin/frontend/ path'),
      htmlMatches(/\/static\/version\d+\//i, 4, '/static/versionN/ path'),
      headerMatches('x-magento-cache-debug', /./, 5),
    ],
  },
  {
    id: 'prestashop',
    name: 'PrestaShop',
    category: 'ecommerce',
    signals: [
      metaGenerator(/PrestaShop/i, 5),
      headerMatches('powered-by', /PrestaShop/i, 5),
    ],
  },

  /* === JS frameworks =================================================== */
  {
    id: 'nextjs',
    name: 'Next.js',
    category: 'framework',
    signals: [
      elementExists('script#__NEXT_DATA__', 5, '<script id="__NEXT_DATA__"> present'),
      scriptSrcContains('/_next/static/', 5),
      htmlMatches(/next-route-announcer/i, 3, 'next-route-announcer marker'),
      headerExists('x-nextjs-cache', 4),
      headerExists('x-nextjs-prerender', 4),
    ],
  },
  {
    id: 'nuxt',
    name: 'Nuxt',
    category: 'framework',
    signals: [
      htmlMatches(/window\.__NUXT__/, 5, 'window.__NUXT__ global'),
      scriptSrcContains('/_nuxt/', 5),
      attributeExists('div#__nuxt', 'id', 4),
    ],
  },
  {
    id: 'gatsby',
    name: 'Gatsby',
    category: 'framework',
    signals: [
      elementExists('div#___gatsby', 5, '<div id="___gatsby"> present'),
      htmlMatches(/window\.___gatsby/i, 4, 'window.___gatsby global'),
      scriptSrcContains('/page-data/', 3),
    ],
  },
  {
    id: 'remix',
    name: 'Remix',
    category: 'framework',
    signals: [
      htmlMatches(/window\.__remixContext\b/, 5, 'window.__remixContext global'),
      htmlMatches(/window\.__remixManifest\b/, 5, 'window.__remixManifest global'),
      scriptSrcContains('/build/manifest-', 3),
    ],
  },
  {
    id: 'astro',
    name: 'Astro',
    category: 'framework',
    signals: [
      metaGenerator(/Astro(?:\s+v?(\d+\.\d+(?:\.\d+)?))?/i, 5),
      attributeExists('astro-island', 'uid', 4),
      htmlMatches(/data-astro-cid-/i, 3, 'data-astro-cid attribute'),
    ],
  },
  {
    id: 'sveltekit',
    name: 'SvelteKit',
    category: 'framework',
    signals: [
      htmlMatches(/__sveltekit_/i, 5, '__sveltekit_ marker'),
      attributeExists('[data-sveltekit-preload-data]', 'data-sveltekit-preload-data', 4),
      scriptSrcContains('/_app/immutable/', 4),
    ],
  },
  {
    id: 'angular',
    name: 'Angular',
    category: 'framework',
    signals: [
      attributeExists('[ng-version]', 'ng-version', 5),
      htmlMatches(/ng-version="(\d+\.\d+\.\d+)"/, 5, 'ng-version attribute'),
    ],
  },
  {
    id: 'vue',
    name: 'Vue',
    category: 'framework',
    signals: [
      attributeExists('[data-v-app]', 'data-v-app', 4),
      htmlMatches(/__VUE_/i, 3, '__VUE_ global'),
    ],
  },
  {
    id: 'react',
    name: 'React',
    category: 'framework',
    signals: [
      attributeExists('[data-reactroot]', 'data-reactroot', 3),
      htmlMatches(/__REACT_DEVTOOLS_GLOBAL_HOOK__/, 2, 'react devtools hook'),
    ],
  },
  {
    id: 'ember',
    name: 'Ember.js',
    category: 'framework',
    signals: [
      htmlMatches(/window\.EmberENV/, 4, 'EmberENV global'),
      attributeExists('[data-ember-extension]', 'data-ember-extension', 3),
    ],
  },
  {
    id: 'qwik',
    name: 'Qwik',
    category: 'framework',
    signals: [
      attributeExists('[q\\:container]', 'q:container', 5),
      htmlMatches(/q:render/i, 3, 'q:render attribute'),
    ],
  },

  /* === Static site generators ========================================== */
  {
    id: 'hugo',
    name: 'Hugo',
    category: 'ssg',
    signals: [
      metaGenerator(/Hugo(?:\s+(\d+\.\d+(?:\.\d+)?))?/i, 5),
    ],
  },
  {
    id: 'jekyll',
    name: 'Jekyll',
    category: 'ssg',
    signals: [
      metaGenerator(/Jekyll(?:\s+v?(\d+\.\d+(?:\.\d+)?))?/i, 5),
    ],
  },
  {
    id: 'eleventy',
    name: 'Eleventy (11ty)',
    category: 'ssg',
    signals: [
      metaGenerator(/Eleventy(?:\s+v?(\d+\.\d+(?:\.\d+)?))?/i, 5),
    ],
  },
  {
    id: 'hexo',
    name: 'Hexo',
    category: 'ssg',
    signals: [
      metaGenerator(/Hexo(?:\s+(\d+\.\d+))?/i, 5),
    ],
  },
  {
    id: 'docusaurus',
    name: 'Docusaurus',
    category: 'ssg',
    signals: [
      metaGenerator(/Docusaurus(?:\s+v?(\d+\.\d+(?:\.\d+)?))?/i, 5),
      htmlMatches(/__docusaurus/i, 4, '__docusaurus marker'),
    ],
  },
  {
    id: 'mkdocs',
    name: 'MkDocs',
    category: 'ssg',
    signals: [
      metaGenerator(/MkDocs/i, 5),
    ],
  },

  /* === Hosting ========================================================= */
  {
    id: 'vercel',
    name: 'Vercel',
    category: 'hosting',
    signals: [
      headerMatches('server', /Vercel/i, 5),
      headerExists('x-vercel-id', 5),
      headerExists('x-vercel-cache', 4),
    ],
  },
  {
    id: 'netlify',
    name: 'Netlify',
    category: 'hosting',
    signals: [
      headerMatches('server', /Netlify/i, 5),
      headerExists('x-nf-request-id', 5),
    ],
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    category: 'hosting',
    signals: [
      headerMatches('server', /^cloudflare$/i, 4),
      headerExists('cf-ray', 4),
      headerExists('cf-cache-status', 3),
    ],
  },
  {
    id: 'github-pages',
    name: 'GitHub Pages',
    category: 'hosting',
    signals: [
      headerMatches('server', /GitHub\.com/i, 5),
      headerMatches('x-github-request-id', /./, 5),
    ],
  },
  {
    id: 'fastly',
    name: 'Fastly',
    category: 'hosting',
    signals: [
      headerMatches('via', /varnish.*fastly/i, 4),
      headerMatches('server', /fastly/i, 4),
      headerExists('x-served-by', 1),
    ],
  },
  {
    id: 'cloudfront',
    name: 'AWS CloudFront',
    category: 'hosting',
    signals: [
      headerMatches('via', /CloudFront/i, 5),
      headerExists('x-amz-cf-id', 5),
    ],
  },
]

/* ── Detection ────────────────────────────────────────────────────────── */

function weightToConfidence(totalWeight: number): number {
  // Each weight unit ≈ 18 confidence points; saturates at 100.
  return Math.min(100, totalWeight * 18)
}

function bucket(confidence: number): PlatformConfidence {
  if (confidence >= HIGH_THRESHOLD) return 'high'
  if (confidence >= MEDIUM_THRESHOLD) return 'medium'
  return 'low'
}

function evaluatePlatform(def: PlatformDef, input: DetectionInput): DetectedPlatform | null {
  const hits: SignalHit[] = []
  let version: string | undefined

  for (const signal of def.signals) {
    const hit = signal(input)
    if (hit) {
      hits.push(hit)
      if (!version && hit.version) version = hit.version
    }
  }

  if (hits.length === 0) return null

  const totalWeight = hits.reduce((sum, h) => sum + h.weight, 0)
  const confidence = weightToConfidence(totalWeight)
  if (confidence < LOW_THRESHOLD) return null

  return {
    id: def.id,
    name: def.name,
    category: def.category,
    confidence: bucket(confidence),
    confidenceScore: confidence,
    version,
    evidence: hits.map((h) => h.evidence),
  }
}

export interface DetectPlatformOptions {
  minConfidence?: PlatformConfidence
}

export interface DetectPlatformInput {
  html: string
  headers?: Record<string, string>
}

export interface DetectPlatformFromInputResult {
  detected: DetectedPlatform[]
  isCustom: boolean
  rawSignals: {
    generator: string | null
    xPoweredBy: string | null
    server: string | null
  }
}

export function detectPlatformFromInput(
  source: DetectPlatformInput,
  options: DetectPlatformOptions = {},
): DetectPlatformFromInputResult {
  const headers = source.headers ?? {}
  const $ = load(source.html)
  const input: DetectionInput = {
    $,
    html: source.html,
    headers,
  }

  const minBucket = options.minConfidence ?? 'low'
  const minScore =
    minBucket === 'high' ? HIGH_THRESHOLD : minBucket === 'medium' ? MEDIUM_THRESHOLD : LOW_THRESHOLD

  const all: DetectedPlatform[] = []
  for (const def of PLATFORMS) {
    const result = evaluatePlatform(def, input)
    if (result && result.confidenceScore >= minScore) {
      all.push(result)
    }
  }

  all.sort((a, b) => b.confidenceScore - a.confidenceScore)

  const platformsByCategory = new Map<PlatformCategory, DetectedPlatform[]>()
  for (const p of all) {
    const list = platformsByCategory.get(p.category) ?? []
    list.push(p)
    platformsByCategory.set(p.category, list)
  }

  const isCustom =
    !platformsByCategory.has('cms') &&
    !platformsByCategory.has('site-builder') &&
    !platformsByCategory.has('ecommerce')

  return {
    detected: all,
    isCustom,
    rawSignals: {
      generator: $('meta[name="generator" i]').attr('content')?.trim() ?? null,
      xPoweredBy: getHeader(headers, 'x-powered-by') ?? null,
      server: getHeader(headers, 'server') ?? null,
    },
  }
}

export async function detectPlatform(
  rawUrl: string,
  options: DetectPlatformOptions = {},
): Promise<PlatformDetectionReport> {
  const normalized = normalizeTargetUrl(rawUrl)
  const fetched = await fetchPage(normalized.toString(), { skipAuxiliary: true })

  const result = detectPlatformFromInput(
    {
      html: fetched.html,
      headers: fetched.headers,
    },
    options,
  )

  return {
    url: fetched.inputUrl,
    finalUrl: fetched.finalUrl,
    detectedAt: new Date().toISOString(),
    isCustom: result.isCustom,
    detected: result.detected,
    rawSignals: result.rawSignals,
    fetchTimeMs: fetched.timings.fetchTimeMs,
  }
}

export interface BatchDetectPlatformOptions extends DetectPlatformOptions {
  concurrency?: number
}

const DEFAULT_BATCH_CONCURRENCY = 5

function buildBatchEntry(url: string, report: PlatformDetectionReport): BatchDetectionEntry {
  return {
    url,
    status: 'success',
    finalUrl: report.finalUrl,
    isCustom: report.isCustom,
    detected: report.detected,
    rawSignals: report.rawSignals,
    fetchTimeMs: report.fetchTimeMs,
  }
}

function buildBatchError(url: string, error: unknown): BatchDetectionEntry {
  const message = isAgentReadinessError(error)
    ? `[${error.code}] ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error)
  return { url, status: 'error', error: message }
}

export async function detectPlatformBatch(
  urls: string[],
  options: BatchDetectPlatformOptions = {},
): Promise<BatchPlatformDetectionReport> {
  const startedAt = Date.now()
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_BATCH_CONCURRENCY)
  const detectorOptions: DetectPlatformOptions = { minConfidence: options.minConfidence }

  const results = urls.length === 0
    ? []
    : await mapWithConcurrency(urls, concurrency, async (url) => {
        try {
          const report = await detectPlatform(url, detectorOptions)
          return buildBatchEntry(url, report)
        } catch (error) {
          return buildBatchError(url, error)
        }
      })

  const successful = results.filter((r) => r.status === 'success').length

  return {
    detectedAt: new Date().toISOString(),
    totalUrls: urls.length,
    successful,
    failed: results.length - successful,
    totalFetchTimeMs: Date.now() - startedAt,
    results,
  }
}

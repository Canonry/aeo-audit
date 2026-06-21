import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const ROUTE_EXTENSIONS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'vue', 'svelte', 'md', 'mdx'])

function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '')
}

function extensionFor(filePath: string): string {
  const match = filePath.match(/\.([a-z0-9]+)$/i)
  return match ? match[1].toLowerCase() : ''
}

function stripExtension(filePath: string): string {
  return filePath.replace(/\.[a-z0-9]+$/i, '')
}

export function normalizeRoutePath(routePath: string): string {
  if (!routePath || routePath === '/') return '/'
  const withoutTrailingSlash = routePath.replace(/\/+$/, '')
  return withoutTrailingSlash.startsWith('/') ? withoutTrailingSlash : `/${withoutTrailingSlash}`
}

function routeFromSegments(rawSegments: string[]): string | null {
  const segments: string[] = []

  for (const rawSegment of rawSegments) {
    const segment = rawSegment.trim()
    if (!segment || segment === 'index') continue

    if (
      segment.startsWith('_')
      || segment.startsWith('@')
      || (segment.startsWith('(') && segment.endsWith(')'))
    ) {
      continue
    }

    if (
      segment.includes('[')
      || segment.includes(']')
      || segment.startsWith(':')
      || segment.startsWith('$')
    ) {
      return null
    }

    segments.push(segment)
  }

  return normalizeRoutePath(`/${segments.join('/')}`)
}

function inferAppRoute(filePath: string, root: string): string | null {
  if (!filePath.startsWith(`${root}/`)) return null

  const relativePath = filePath.slice(root.length + 1)
  const match = relativePath.match(/^(?:(.*)\/)?page\.(jsx?|tsx?|mdx?)$/i)
  if (!match) return null

  return routeFromSegments((match[1] || '').split('/'))
}

function inferPagesRoute(filePath: string, root: string): string | null {
  if (!filePath.startsWith(`${root}/`)) return null

  const relativePath = filePath.slice(root.length + 1)
  const extension = extensionFor(relativePath)
  if (!ROUTE_EXTENSIONS.has(extension)) return null
  if (relativePath.startsWith('api/') || relativePath.startsWith('_')) return null

  return routeFromSegments(stripExtension(relativePath).split('/'))
}

function inferSvelteKitRoute(filePath: string): string | null {
  if (!filePath.startsWith('src/routes/')) return null

  const relativePath = filePath.slice('src/routes/'.length)
  const match = relativePath.match(/^(?:(.*)\/)?\+page\.svelte$/i)
  if (!match) return null

  return routeFromSegments((match[1] || '').split('/'))
}

function inferContentRoute(filePath: string): string | null {
  const contentRoots: Array<[string, string]> = [
    ['content/blog/', '/blog'],
    ['content/posts/', '/blog'],
    ['src/content/blog/', '/blog'],
    ['src/content/posts/', '/blog'],
    ['blog/', '/blog'],
    ['posts/', '/blog'],
  ]

  for (const [root, routePrefix] of contentRoots) {
    if (!filePath.startsWith(root)) continue

    const relativePath = filePath.slice(root.length)
    const extension = extensionFor(relativePath)
    if (!['md', 'mdx'].includes(extension)) return null

    const routePath = routeFromSegments(stripExtension(relativePath).split('/'))
    if (!routePath) return null

    return routePath === '/' ? routePrefix : `${routePrefix}${routePath}`
  }

  return null
}

export function inferRoutePath(filePath: string): string | null {
  const normalized = normalizeFilePath(filePath)

  return (
    inferAppRoute(normalized, 'app')
    || inferAppRoute(normalized, 'src/app')
    || inferPagesRoute(normalized, 'pages')
    || inferPagesRoute(normalized, 'src/pages')
    || inferSvelteKitRoute(normalized)
    || inferContentRoute(normalized)
  )
}

export function inferChangedRoutePaths(filePaths: string[]): string[] {
  const routePaths: string[] = []

  for (const filePath of filePaths) {
    const routePath = inferRoutePath(filePath)
    if (routePath) routePaths.push(routePath)
  }

  return [...new Set(routePaths)].sort()
}

export async function getChangedFiles(options: { base?: string; cwd?: string } = {}): Promise<string[]> {
  const base = options.base || 'main'
  const { stdout } = await execFileAsync('git', ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`], {
    cwd: options.cwd || process.cwd(),
    maxBuffer: 1024 * 1024,
  })

  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

export async function getChangedRoutePaths(options: { base?: string; cwd?: string } = {}): Promise<string[]> {
  return inferChangedRoutePaths(await getChangedFiles(options))
}

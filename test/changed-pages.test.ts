import { describe, expect, it } from 'vitest'

import { inferChangedRoutePaths, inferRoutePath } from '../src/changed-pages.js'

describe('changed page route inference', () => {
  it('maps static framework route files to URL paths', () => {
    expect(inferRoutePath('app/page.tsx')).toBe('/')
    expect(inferRoutePath('src/app/(marketing)/about/page.tsx')).toBe('/about')
    expect(inferRoutePath('pages/contact.tsx')).toBe('/contact')
    expect(inferRoutePath('src/pages/blog/index.vue')).toBe('/blog')
    expect(inferRoutePath('src/routes/pricing/+page.svelte')).toBe('/pricing')
    expect(inferRoutePath('content/blog/answer-engine-optimization.md')).toBe('/blog/answer-engine-optimization')
  })

  it('skips dynamic and API route templates', () => {
    expect(inferRoutePath('src/app/blog/[slug]/page.tsx')).toBeNull()
    expect(inferRoutePath('pages/api/health.ts')).toBeNull()
    expect(inferRoutePath('pages/[handle].vue')).toBeNull()
  })

  it('dedupes and sorts inferred routes', () => {
    expect(inferChangedRoutePaths([
      'pages/contact.tsx',
      'src/app/about/page.tsx',
      'src/app/about/page.tsx',
      'src/app/blog/[slug]/page.tsx',
    ])).toEqual(['/about', '/contact'])
  })
})

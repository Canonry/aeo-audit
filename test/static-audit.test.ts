import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runStaticAudit, staticFileToUrl } from '../src/static-audit.js'

const BASE = new URL('https://example.com')

function page(title: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>`
    + `<meta name="description" content="${title} page, long enough to read as a real description."></head>`
    + `<body><h1>${title}</h1><p>Some content for the analyzers to chew on.</p></body></html>`
}

describe('staticFileToUrl', () => {
  it('collapses index.html to a trailing-slash directory URL', () => {
    expect(staticFileToUrl('index.html', BASE)).toBe('https://example.com/')
    expect(staticFileToUrl('about/index.html', BASE)).toBe('https://example.com/about/')
  })

  it('drops the extension for non-index files (clean URLs)', () => {
    expect(staticFileToUrl('blog/post.html', BASE)).toBe('https://example.com/blog/post')
    expect(staticFileToUrl('404.html', BASE)).toBe('https://example.com/404')
  })
})

describe('runStaticAudit', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'aeo-static-'))
    await writeFile(path.join(dir, 'index.html'), page('Home'))
    await mkdir(path.join(dir, 'about'), { recursive: true })
    await writeFile(path.join(dir, 'about', 'index.html'), page('About'))
    await mkdir(path.join(dir, 'blog'), { recursive: true })
    await writeFile(path.join(dir, 'blog', 'post.html'), page('Post'))
    await writeFile(path.join(dir, 'llms.txt'), '# Example\nExample llms.txt\n')
    // Non-HTML asset that must be ignored by the walker.
    await writeFile(path.join(dir, 'styles.css'), 'body{color:red}')
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('audits every HTML file in a directory and aggregates like a sitemap run', async () => {
    const result = await runStaticAudit(dir, { baseUrl: 'https://example.com' })
    expect(result.kind).toBe('multi')
    if (result.kind !== 'multi') return

    expect(result.report.pagesDiscovered).toBe(3)
    expect(result.report.pagesAudited).toBe(3)
    expect(result.report.pages.map((p) => p.url).sort()).toEqual([
      'https://example.com/',
      'https://example.com/about/',
      'https://example.com/blog/post',
    ])
  })

  it('reads auxiliary files (llms.txt) from disk', async () => {
    const result = await runStaticAudit(dir, { baseUrl: 'https://example.com' })
    if (result.kind !== 'multi') throw new Error('expected multi')

    const success = result.report.pages.find((p) => p.status === 'success')
    expect(success?.metadata?.auxiliary.llmsTxt).toBe('ok')
    expect(success?.metadata?.auxiliary.robotsTxt).toBe('missing')
  })

  it('audits a single HTML file', async () => {
    const result = await runStaticAudit(path.join(dir, 'index.html'), { baseUrl: 'https://example.com' })
    expect(result.kind).toBe('single')
    if (result.kind !== 'single') return

    expect(result.report.finalUrl).toBe('https://example.com/')
    expect(typeof result.report.overallScore).toBe('number')
  })

  it('respects --limit', async () => {
    const result = await runStaticAudit(dir, { baseUrl: 'https://example.com', limit: 1 })
    if (result.kind !== 'multi') throw new Error('expected multi')

    expect(result.report.pagesAudited).toBe(1)
    expect(result.report.pagesTruncated).toBe(2)
  })

  it('throws BAD_INPUT when the path does not exist', async () => {
    await expect(runStaticAudit(path.join(dir, 'does-not-exist'))).rejects.toMatchObject({
      code: 'BAD_INPUT',
    })
  })
})

describe('runStaticAudit critical defects (issue #42)', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'aeo-defects-'))
    // Homepage with two H1s (a split headline) — a single-page defect that the
    // prevalence ranking would otherwise bury.
    await writeFile(
      path.join(dir, 'index.html'),
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Home</title>'
        + '<meta name="description" content="Home page, long enough to read as a real description for the site."></head>'
        + '<body><h1>Build</h1><h1>faster</h1><p>Some content for the analyzers.</p></body></html>',
    )
    // A clean page so the defect really is low-prevalence.
    await writeFile(
      path.join(dir, 'about.html'),
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>About</title>'
        + '<meta name="description" content="About page, long enough to read as a real description for the site."></head>'
        + '<body><h1>About</h1><p>Some content for the analyzers.</p></body></html>',
    )
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('surfaces the homepage H1 defect in criticalDefects and at the top of prioritizedFixes', async () => {
    const result = await runStaticAudit(dir, { baseUrl: 'https://example.com' })
    if (result.kind !== 'multi') throw new Error('expected multi')

    const multipleH1 = result.report.criticalDefects.find((g) => g.id === 'multiple-h1')
    expect(multipleH1).toBeDefined()
    expect(multipleH1?.pages[0].url).toBe('https://example.com/')
    expect(multipleH1?.pages[0].isHomepage).toBe(true)

    // The defect leads the prioritized fixes despite affecting only 1 of 2 pages.
    const topFix = result.report.prioritizedFixes[0]
    expect(topFix.kind).toBe('critical-defect')
    expect(topFix.id).toBe('multiple-h1')
    expect(topFix.affectsHomepage).toBe(true)
    expect(topFix.affectedPages).toContain('https://example.com/')

    // The report carries a schema version so agent parsers can detect shape drift.
    expect(result.report.schemaVersion).toBe('1.0')
  })
})

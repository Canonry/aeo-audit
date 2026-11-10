import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { main } from '../src/cli.js'
import { parseEntityRegistry } from '../src/cli-entities.js'

const host = 'homes.example.com'
const registry = {
  entities: [
    { key: 'ridge', names: ['Northwind Ridge'], urlMatchers: [{ host, pathPrefix: '/homes/northwind-ridge/' }] },
    { key: 'harbor', names: ['Northwind Harbor'], urlMatchers: [{ host, pathPrefix: '/homes/northwind-harbor/' }] },
  ],
}

function page(title: string, question: string, answer: string): string {
  const faq = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: question, acceptedAnswer: { '@type': 'Answer', text: answer } }] }
  return `<!doctype html><html><head><title>${title}</title><meta name="description" content="Apartment homes with a pool, a fitness center, and room for pets, close to shops and parks."><script type="application/ld+json">${JSON.stringify(faq)}</script></head><body><h1>${title}</h1></body></html>`
}

describe('parseEntityRegistry', () => {
  it('accepts the documented shape, with urlMatchers optional and other fields ignored', () => {
    expect(parseEntityRegistry({ entities: [
      { key: 'ridge', names: ['Northwind Ridge'], urlMatchers: [{ host, pathPrefix: '/homes/northwind-ridge/', note: 'x' }], city: 'Austin' },
      { key: 'rival', names: ['Rival Lofts'] },
    ] }, 'entities.json')).toEqual({ entities: [
      { key: 'ridge', names: ['Northwind Ridge'], urlMatchers: [{ host, pathPrefix: '/homes/northwind-ridge/' }] },
      { key: 'rival', names: ['Rival Lofts'], urlMatchers: [] },
    ] })
  })

  it('names the file and the exact field that is wrong', () => {
    const cases: Array<[value: unknown, message: string]> = [
      [[], 'expected a JSON object with an "entities" array'],
      [{ entities: {} }, 'expected a JSON object with an "entities" array'],
      [{ entities: ['ridge'] }, 'entities[0] must be an object'],
      [{ entities: [{ key: ' ', names: [] }] }, 'entities[0].key must be a non-empty string'],
      [{ entities: [{ key: 'a', names: [] }, { key: 'a', names: [] }] }, 'entities[1].key "a" is used by an earlier entity'],
      [{ entities: [{ key: 'a', names: 'Northwind Ridge' }] }, 'entities[0].names must be an array of strings'],
      [{ entities: [{ key: 'a', names: [], urlMatchers: {} }] }, 'entities[0].urlMatchers must be an array'],
      [{ entities: [{ key: 'a', names: [], urlMatchers: [{ pathPrefix: '/' }] }] }, 'entities[0].urlMatchers[0].host must be a non-empty string'],
      [{ entities: [{ key: 'a', names: [], urlMatchers: [{ host, pathPrefix: 'homes/' }] }] }, 'entities[0].urlMatchers[0].pathPrefix must be a string starting with "/"'],
    ]
    for (const [value, message] of cases) {
      expect(() => parseEntityRegistry(value, 'entities.json'), message).toThrow(`--entities entities.json: ${message}`)
    }
  })
})

describe('agent-readiness --entities', () => {
  let dir: string
  let output: string[]
  let errors: string[]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cli-entities-'))
    for (const [path, html] of [
      ['homes/northwind-ridge', page('Northwind Ridge', 'Do apartments come with appliances?', 'Yes, at Northwind Harbor residents enjoy in-home washers.')],
      ['homes/northwind-harbor', page('Northwind Harbor', 'Is Northwind Harbor pet friendly?', 'Yes.')],
    ] as const) {
      await mkdir(join(dir, 'out', path), { recursive: true })
      await writeFile(join(dir, 'out', path, 'index.html'), html)
    }
    await writeFile(join(dir, 'entities.json'), JSON.stringify(registry))
    output = []
    errors = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { output.push(args.join(' ')) })
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')) })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  const run = (...args: string[]) => main(['node', 'agent-readiness', ...args])
  // eslint-disable-next-line no-control-regex
  const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '')

  it('flags the page that names another entity, with the FAQ question, in every format', async () => {
    const out = join(dir, 'out')
    const file = join(dir, 'entities.json')
    await run(out, '--base-url', `https://${host}`, '--entities', file, '--top-issues')
    const text = plain(output.join('\n'))
    expect(text).toContain('Names another entity (1 page)')
    expect(text).toContain(`https://${host}/homes/northwind-ridge/: This page belongs to Northwind Ridge, but its FAQ names another entity, Northwind Harbor.`)
    expect(text).toContain('· FAQ answer to "Do apartments come with appliances?": "Yes, at Northwind Harbor residents enjoy in-home washers."')
    expect(errors.join('\n')).not.toMatch(/Error|Notice/)

    output.length = 0
    await run(out, '--base-url', `https://${host}`, '--entities', file, '--format', 'markdown')
    expect(output.join('\n')).toContain('  - FAQ answer to "Do apartments come with appliances?": "Yes, at Northwind Harbor residents enjoy in-home washers."')

    output.length = 0
    await run(out, '--base-url', `https://${host}`, '--entities', file, '--format', 'json')
    const report = JSON.parse(output.join('\n'))
    expect(report.compareMeta.entityCheck).toBe(true)
    expect(report.criticalDefects.find((group: { id: string }) => group.id === 'names-another-entity').pages[0].evidence[0])
      .toMatchObject({ field: 'faq-answer', entityKey: 'harbor', entityName: 'Northwind Harbor' })

    // Without the flag nothing is checked.
    output.length = 0
    await run(out, '--base-url', `https://${host}`, '--top-issues')
    expect(plain(output.join('\n'))).not.toContain('Names another entity')
  })

  it('stops with an error naming the file and the problem', async () => {
    await writeFile(join(dir, 'broken.json'), '{ "entities": [')
    await writeFile(join(dir, 'shape.json'), JSON.stringify({ entities: [{ key: 'ridge', names: ['Northwind Ridge'], urlMatchers: [{ host, pathPrefix: 'homes/' }] }] }))
    const cases: Array<[file: string, message: string]> = [
      [join(dir, 'missing.json'), 'the file could not be read'],
      [join(dir, 'broken.json'), 'the file is not valid JSON'],
      [join(dir, 'shape.json'), 'entities[0].urlMatchers[0].pathPrefix must be a string starting with "/"'],
    ]
    for (const [file, message] of cases) {
      errors.length = 0
      expect(await run(join(dir, 'out'), '--base-url', `https://${host}`, '--entities', file)).toBe(1)
      expect(errors.join('\n')).toContain(`Error [BAD_INPUT]: --entities ${file}: ${message}`)
    }
    expect(output).toEqual([])
    expect(await run('https://example.com', '--detect-platform', '--entities', join(dir, 'entities.json'))).toBe(1)
    expect(errors.join('\n')).toContain('--entities cannot be combined with --detect-platform')
  })

  it('warns when nothing can match: no urlMatchers, or static pages without --base-url', async () => {
    await writeFile(join(dir, 'names-only.json'), JSON.stringify({ entities: [{ key: 'ridge', names: ['Northwind Ridge'] }] }))
    await run(join(dir, 'out'), '--base-url', `https://${host}`, '--entities', join(dir, 'names-only.json'))
    expect(errors.join('\n')).toContain('has urlMatchers, so no page belongs to an entity and nothing is checked')
    errors.length = 0
    await run(join(dir, 'out'), '--entities', join(dir, 'entities.json'))
    expect(errors.join('\n')).toContain('Pass --base-url with the site\'s origin so --entities urlMatchers can match them.')
  })
})

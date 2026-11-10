import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { parseEntityRegistry } from '../src/cli-entities.js'
import { runStaticAudit } from '../src/static-audit.js'

const examplePath = new URL('../skills/agent-readiness/entities.example.json', import.meta.url)

function page(title: string, faq: Array<[string, string]>): string {
  const jsonLd = { '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: faq.map(([question, answer]) => ({ '@type': 'Question', name: question, acceptedAnswer: { '@type': 'Answer', text: answer } })) }
  return `<!doctype html><html><head><title>${title}</title><meta name="description" content="Apartment homes with a pool, a fitness center, and room for pets, close to shops and parks."><script type="application/ld+json">${JSON.stringify(jsonLd)}</script></head><body><h1>${title}</h1></body></html>`
}

describe('the shipped entities example', () => {
  it('passes the --entities file check and is the example docs/cli.md shows', async () => {
    const text = await readFile(examplePath, 'utf8')
    expect(parseEntityRegistry(JSON.parse(text), 'entities.example.json').entities.map((entity) => entity.key))
      .toEqual(['northwind-ridge', 'northwind-harbor', 'westshore', 'rival-lofts'])
    expect(await readFile(new URL('../docs/cli.md', import.meta.url), 'utf8')).toContain(`\`\`\`json\n${text}\`\`\``)
  })

  it('flags copied names on a site laid out the way it describes', async () => {
    const entityRegistry = parseEntityRegistry(JSON.parse(await readFile(examplePath, 'utf8')), 'entities.example.json')
    const dir = await mkdtemp(join(tmpdir(), 'entities-example-'))
    try {
      const pages: Record<string, string> = {
        'apartments/northwind-ridge': page('Northwind Ridge', [['Is there a shuttle?', 'Residents of The Harbor at Northwind ride the shuttle for free.']]),
        'apartments/northwind-harbor': page('Northwind Harbor', [['Is Northwind Harbor pet friendly?', 'Yes, dogs and cats are welcome.']]),
        'apartments/westshore': page('The Residences at Westshore', [['Do homes have balconies?', 'Unlike Rival Lofts, every home has a balcony.']]),
      }
      for (const [path, html] of Object.entries(pages)) {
        await mkdir(join(dir, path), { recursive: true })
        await writeFile(join(dir, path, 'index.html'), html)
      }
      const result = await runStaticAudit(dir, { baseUrl: 'https://homes.example.com', factors: ['technical-seo'], entityRegistry })
      if (result.kind !== 'multi') throw new Error(`expected a multi-page static report, got ${result.kind}`)
      const group = result.report.criticalDefects.find((item) => item.id === 'names-another-entity')
      expect(group?.pages.map((item) => [new URL(item.url).pathname, item.evidence?.map((mention) => mention.entityKey)])).toEqual([
        ['/apartments/northwind-ridge/', ['northwind-harbor']],
        ['/apartments/westshore/', ['rival-lofts']],
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

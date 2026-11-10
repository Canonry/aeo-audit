import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AuditReport, CriticalDefect } from '../src/types.js'

const runAgentReadinessAuditMock = vi.hoisted(() => vi.fn())
const runSitemapAuditMock = vi.hoisted(() => vi.fn())

vi.mock('../src/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/index.js')>()),
  runAgentReadinessAudit: runAgentReadinessAuditMock,
}))

vi.mock('../src/sitemap.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sitemap.js')>()),
  runSitemapAudit: runSitemapAuditMock,
}))

import { main } from '../src/cli.js'

const url = 'https://homes.example.com/homes/northwind-ridge/'
const registry = { entities: [{ key: 'ridge', names: ['Northwind Ridge'], urlMatchers: [{ host: 'homes.example.com', pathPrefix: '/homes/northwind-ridge/' }] }] }
const namesAnother: CriticalDefect = {
  id: 'names-another-entity',
  severity: 'critical',
  detail: 'This page belongs to Northwind Ridge, but its FAQ names another entity, Northwind Harbor.',
  recommendation: 'Replace each mention with the details of the entity this page belongs to, or remove it.',
  // Page text reaches the report, so control characters and Markdown are neutralized.
  evidence: [{ field: 'faq-answer', question: 'Do *apartments* come with appliances?', entityKey: 'harbor', entityName: 'Northwind Harbor', snippet: 'Yes,\u001b[31m at Northwind Harbor.' }],
}

function report(criticalDefects: CriticalDefect[]): AuditReport {
  return {
    schemaVersion: '3.6', url, finalUrl: url, auditedAt: '2026-11-10T00:00:00.000Z', overallScore: 80, summary: 'Solid page.',
    factors: [], criticalDefects,
    metadata: { fetchTimeMs: 1, pageTitle: 'Northwind Ridge', wordCount: 100, metaDescription: null, internalLinks: [], redirectChain: [],
      auxiliary: { llmsTxt: 'missing', llmsFullTxt: 'missing', robotsTxt: 'missing', sitemapXml: 'missing' } },
  }
}

describe('agent-readiness <url> --entities', () => {
  let dir: string
  let output: string[]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cli-entities-url-'))
    await writeFile(join(dir, 'entities.json'), JSON.stringify(registry))
    output = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { output.push(args.join(' ')) })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    runAgentReadinessAuditMock.mockReset()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  it('passes the list to the audit and shows the page\'s critical defects with each mention', async () => {
    runAgentReadinessAuditMock.mockResolvedValue(report([namesAnother]))
    expect(await main(['node', 'agent-readiness', url, '--entities', join(dir, 'entities.json')])).toBe(0)
    expect(runAgentReadinessAuditMock).toHaveBeenCalledWith(url, expect.objectContaining({ entityRegistry: registry }))
    // eslint-disable-next-line no-control-regex
    const text = output.join('\n').replace(/\x1b\[[0-9;]*m/g, '')
    expect(text).toContain('Critical Defects (not counted in the score)')
    expect(text).toContain('[critical] Names another entity: This page belongs to Northwind Ridge, but its FAQ names another entity, Northwind Harbor.')
    expect(text).toContain('· FAQ answer to "Do *apartments* come with appliances?": "Yes, [31m at Northwind Harbor."')
    expect(text).toContain('→ Replace each mention with the details of the entity this page belongs to, or remove it.')

    output.length = 0
    await main(['node', 'agent-readiness', url, '--entities', join(dir, 'entities.json'), '--format', 'markdown'])
    const markdown = output.join('\n')
    expect(markdown).toContain('## Critical Defects')
    expect(markdown).toContain('- **Names another entity** _(critical)_: This page belongs to Northwind Ridge, but its FAQ names another entity, Northwind Harbor.')
    expect(markdown).toContain('  - FAQ answer to "Do \\*apartments\\* come with appliances?": "Yes, \\[31m at Northwind Harbor."')
    expect(markdown).toContain('  - Fix: Replace each mention')
  })

  it('passes the list to a sitemap audit', async () => {
    runSitemapAuditMock.mockRejectedValue(new Error('stop after the call'))
    await main(['node', 'agent-readiness', 'https://homes.example.com', '--sitemap', '--entities', join(dir, 'entities.json')])
    expect(runSitemapAuditMock).toHaveBeenCalledWith('https://homes.example.com', expect.objectContaining({ entityRegistry: registry }))
  })

  it('shows no critical defect section for a page without one, and runs without a registry when the flag is absent', async () => {
    runAgentReadinessAuditMock.mockResolvedValue(report([]))
    await main(['node', 'agent-readiness', url])
    expect(runAgentReadinessAuditMock.mock.calls[0]?.[1]?.entityRegistry).toBeUndefined()
    expect(output.join('\n')).not.toContain('Critical Defects')
  })
})

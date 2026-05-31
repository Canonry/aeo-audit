import { afterEach, describe, expect, it, vi } from 'vitest'

import { main } from '../src/cli.js'

// A leading "./" marks the positional arg as a static target without touching
// disk, so the guard runs before runStaticAudit — no real path is needed.
const STATIC_ARG = './out'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('static-output mode rejects Lighthouse', () => {
  it('rejects --factors lighthouse and makes no network call (offline guarantee)', async () => {
    // Lighthouse calls PageSpeed Insights via global fetch; fail loudly if reached.
    const fetchSpy = vi.fn(async () => {
      throw new Error('static mode must not make network calls')
    })
    vi.stubGlobal('fetch', fetchSpy)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const code = await main(['node', 'aeo-audit', STATIC_ARG, '--factors', 'lighthouse'])

    expect(code).toBe(1)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('--factors lighthouse')
  })

  it('still rejects the --lighthouse flag in static mode', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const code = await main(['node', 'aeo-audit', STATIC_ARG, '--lighthouse'])

    expect(code).toBe(1)
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('static-output mode')
  })
})

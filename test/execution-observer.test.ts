import { afterEach, describe, expect, it, vi } from 'vitest'
import { AeoAuditError, runAeoAudit } from '../src/index.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('single-audit execution provenance', () => {
  it('reports zero attempts for initial validation and one for a connect-time blocked address', async () => {
    let attempts = 0
    await expect(runAeoAudit('', { onOutboundAttempt: () => { attempts += 1 } })).rejects.toMatchObject({ code: 'BAD_INPUT' })
    expect(attempts).toBe(0)

    const blocked = new AeoAuditError('BLOCKED_IP', 'connect-time DNS changed to private')
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed', { cause: blocked })
    }))
    await expect(runAeoAudit('http://localhost', {
      allowPrivateHost: 'localhost',
      onOutboundAttempt: () => { attempts += 1 },
    })).rejects.toBe(blocked)
    expect(attempts).toBe(1)
  })

  it('propagates caller cancellation into an in-flight fetch', async () => {
    const controller = new AbortController()
    let fetchStarted!: () => void
    const started = new Promise<void>((resolve) => { fetchStarted = resolve })
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      fetchStarted()
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })))
    const audit = runAeoAudit('http://localhost', {
      allowPrivateHost: 'localhost',
      signal: controller.signal,
    })
    await started
    const reason = new Error('caller stopped')
    controller.abort(reason)
    await expect(audit).rejects.toBe(reason)
  })
})

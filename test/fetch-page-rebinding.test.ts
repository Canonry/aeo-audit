import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const resolve4Mock = vi.hoisted(() => vi.fn())
const resolve6Mock = vi.hoisted(() => vi.fn())
const lookupMock = vi.hoisted(() => vi.fn())

vi.mock('node:dns/promises', () => ({
  default: {
    resolve4: resolve4Mock,
    resolve6: resolve6Mock,
  },
  resolve4: resolve4Mock,
  resolve6: resolve6Mock,
}))

vi.mock('node:dns', async () => {
  const actual = await vi.importActual<typeof import('node:dns')>('node:dns')
  return {
    ...actual,
    lookup: lookupMock,
  }
})

import { fetchWithValidatedRedirects } from '../src/fetch-page.js'
import { isAeoAuditError } from '../src/errors.js'

describe('fetchWithValidatedRedirects DNS rebinding guard', () => {
  beforeEach(() => {
    resolve4Mock.mockResolvedValue(['1.1.1.1'])
    resolve6Mock.mockRejectedValue(Object.assign(new Error('no IPv6'), { code: 'ENODATA' }))
    lookupMock.mockImplementation((_hostname: string, _options: unknown, callback: (...args: unknown[]) => void) => {
      callback(null, [{ address: '127.0.0.1', family: 4 }])
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('blocks public-preflight to private-connect rebinding before contacting the private endpoint', async () => {
    let hits = 0
    const server = http.createServer((_req, res) => {
      hits += 1
      res.end('private service should not be reached')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    try {
      let caught: unknown
      try {
        await fetchWithValidatedRedirects(`http://public-preflight.test:${port}/`, {
          timeoutMs: 1_000,
        })
      } catch (error) {
        caught = error
      }

      expect(isAeoAuditError(caught) && caught.code).toBe('BLOCKED_IP')
      expect(resolve4Mock).toHaveBeenCalledWith('public-preflight.test')
      expect(lookupMock).toHaveBeenCalled()
      expect(hits).toBe(0)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    }
  })
})

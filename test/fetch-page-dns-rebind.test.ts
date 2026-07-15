import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { Agent } from 'undici'

import {
  createValidatingLookup,
  fetchPage,
  type FetchNetworkAdapter,
} from '../src/fetch-page.js'

const PUBLIC_IP = '93.184.216.34'
const PRIVATE_IP = '127.0.0.1'

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

describe('fetchPage DNS-rebinding regression', () => {
  it('blocks a public-at-validation, private-at-connect DNS flip before opening a socket', async () => {
    let serverHits = 0
    const server = http.createServer((_request, response) => {
      serverHits += 1
      response.setHeader('content-type', 'text/html')
      response.end('<!doctype html><title>must not be reached</title>')
    })
    await new Promise<void>((resolve) => server.listen(0, PRIVATE_IP, resolve))
    const port = (server.address() as AddressInfo).port

    const preflightResolve = vi.fn(async () => [PUBLIC_IP])
    let connectLookups = 0
    const dispatcher = new Agent({
      connect: {
        lookup: createValidatingLookup((_hostname, _options, callback) => {
          connectLookups += 1
          callback(null, [{ address: PRIVATE_IP, family: 4 }])
        }),
      },
    })
    const network: FetchNetworkAdapter = {
      resolveHostAddresses: preflightResolve,
      dispatcher,
    }
    let outboundAttempts = 0

    try {
      await expect(
        fetchPage(`http://rebind.example:${port}/`, {
          skipAuxiliary: true,
          network,
          onOutboundAttempt: () => {
            outboundAttempts += 1
          },
        }),
      ).rejects.toMatchObject({ code: 'BLOCKED_IP' })

      expect(preflightResolve).toHaveBeenCalledOnce()
      expect(connectLookups).toBe(1)
      expect(outboundAttempts).toBe(1)
      expect(serverHits).toBe(0)
    } finally {
      await dispatcher.close()
      await closeServer(server)
    }
  })

  it('blocks a private address during validation without starting an HTTP attempt', async () => {
    const preflightResolve = vi.fn(async () => [PRIVATE_IP])
    let connectLookups = 0
    const dispatcher = new Agent({
      connect: {
        lookup: createValidatingLookup((_hostname, _options, callback) => {
          connectLookups += 1
          callback(null, [{ address: PUBLIC_IP, family: 4 }])
        }),
      },
    })
    const network: FetchNetworkAdapter = {
      resolveHostAddresses: preflightResolve,
      dispatcher,
    }
    let outboundAttempts = 0

    try {
      await expect(
        fetchPage('http://rebind.example/', {
          skipAuxiliary: true,
          network,
          onOutboundAttempt: () => {
            outboundAttempts += 1
          },
        }),
      ).rejects.toMatchObject({ code: 'BLOCKED_IP' })

      expect(preflightResolve).toHaveBeenCalledOnce()
      expect(connectLookups).toBe(0)
      expect(outboundAttempts).toBe(0)
    } finally {
      await dispatcher.close()
    }
  })
})

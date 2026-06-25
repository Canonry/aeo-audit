import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { fetch as undiciFetch, Agent } from 'undici'

import { validatingLookup } from '../src/fetch-page.js'

interface LookupResult {
  err: (Error & { code?: string }) | null
  address: unknown
  family?: number
}

// Drive the connect-time lookup directly. dns.lookup resolves IP literals to
// themselves without touching the network, so these cases are deterministic/offline.
function runLookup(hostname: string, all: boolean): Promise<LookupResult> {
  return new Promise((resolve) => {
    validatingLookup(hostname, { all }, (err, address, family) => {
      resolve({ err: err as LookupResult['err'], address, family })
    })
  })
}

describe('validatingLookup — DNS-rebinding pin decision', () => {
  it('rejects a host that resolves to a private/loopback IPv4', async () => {
    const { err } = await runLookup('127.0.0.1', true)
    expect(err?.code).toBe('BLOCKED_IP')
  })

  it('rejects an IPv6 loopback', async () => {
    const { err } = await runLookup('::1', true)
    expect(err?.code).toBe('BLOCKED_IP')
  })

  it('rejects a link-local (cloud-metadata) address', async () => {
    const { err } = await runLookup('169.254.169.254', true)
    expect(err?.code).toBe('BLOCKED_IP')
  })

  it('returns only the public address (all form)', async () => {
    const { err, address } = await runLookup('8.8.8.8', true)
    expect(err).toBeNull()
    expect(address).toEqual([{ address: '8.8.8.8', family: 4 }])
  })

  it('returns the public address in single-address form', async () => {
    const { err, address, family } = await runLookup('1.1.1.1', false)
    expect(err).toBeNull()
    expect(address).toBe('1.1.1.1')
    expect(family).toBe(4)
  })
})

describe('pinned dispatcher — blocks a private rebind at connect time', () => {
  it('never reaches a server when the host resolves to a private IP', async () => {
    let hits = 0
    const server = http.createServer((_req, res) => {
      hits += 1
      res.end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as AddressInfo).port

    // Same wiring as production: the lookup is the only thing standing between the
    // request and the socket. `localhost` resolves to a private IP, so the pin must
    // reject before any connection is opened.
    const dispatcher = new Agent({ connect: { lookup: validatingLookup } })
    try {
      await expect(undiciFetch(`http://localhost:${port}/`, { dispatcher })).rejects.toThrow()
      expect(hits).toBe(0)
    } finally {
      await dispatcher.close()
      server.close()
    }
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchPage, isHostExplicitlyAllowed } from '../src/fetch-page.js'

const HTML = '<!doctype html><html><head><title>Dev</title></head><body>hi</body></html>'

function htmlResponse() {
  return new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isHostExplicitlyAllowed', () => {
  it('is false when no allow-host is configured (guard stays on by default)', () => {
    expect(isHostExplicitlyAllowed('localhost')).toBe(false)
    expect(isHostExplicitlyAllowed('localhost', undefined)).toBe(false)
    expect(isHostExplicitlyAllowed('localhost', '')).toBe(false)
  })

  it('matches only the exact named host, case- and trailing-dot-insensitive', () => {
    expect(isHostExplicitlyAllowed('localhost', 'localhost')).toBe(true)
    expect(isHostExplicitlyAllowed('LOCALHOST', 'localhost')).toBe(true)
    expect(isHostExplicitlyAllowed('localhost.', 'localhost')).toBe(true)
    expect(isHostExplicitlyAllowed('10.0.0.5', '10.0.0.5')).toBe(true)
  })

  it('does not match a different host (the scoping that blocks SSRF pivots)', () => {
    expect(isHostExplicitlyAllowed('169.254.169.254', 'localhost')).toBe(false)
    expect(isHostExplicitlyAllowed('internal-db', 'localhost')).toBe(false)
    expect(isHostExplicitlyAllowed('evil.example.com', 'localhost')).toBe(false)
  })
})

describe('fetchPage with allowPrivateHost', () => {
  it('blocks a localhost target by default', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse()))
    await expect(fetchPage('http://localhost:3000/', { skipAuxiliary: true })).rejects.toMatchObject({
      code: 'BLOCKED_HOST',
    })
  })

  it('allows the exact named localhost host when opted in', async () => {
    const fetchMock = vi.fn(async () => htmlResponse())
    vi.stubGlobal('fetch', fetchMock)

    const page = await fetchPage('http://localhost:3000/', {
      skipAuxiliary: true,
      allowPrivateHost: 'localhost',
    })

    expect(page.html).toContain('<title>Dev</title>')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('allows a private-IP target only when it is the named host', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse()))

    await expect(
      fetchPage('http://10.0.0.5/', { skipAuxiliary: true, allowPrivateHost: '10.0.0.5' }),
    ).resolves.toMatchObject({ finalUrl: 'http://10.0.0.5/' })

    // Naming a different host must NOT unblock 10.0.0.5 — this is the SSRF-pivot guard.
    await expect(
      fetchPage('http://10.0.0.5/', { skipAuxiliary: true, allowPrivateHost: 'localhost' }),
    ).rejects.toMatchObject({ code: 'BLOCKED_IP' })
  })
})

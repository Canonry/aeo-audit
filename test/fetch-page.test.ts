import { afterEach, test, expect, vi } from 'vitest'

import { fetchPage, isHostnameBlocked, isHtmlResponse, isPublicIpAddress, normalizeTargetUrl } from '../src/fetch-page.js'

afterEach(() => vi.unstubAllGlobals())

test('normalizeTargetUrl prepends https when scheme is missing', () => {
  const normalized = normalizeTargetUrl('example.com')
  expect(normalized.toString()).toBe('https://example.com/')
})

test('normalizeTargetUrl rejects unsupported protocols', () => {
  expect(() => normalizeTargetUrl('ftp://example.com')).toThrow()
})

test('isHostnameBlocked blocks localhost-like targets', () => {
  expect(isHostnameBlocked('localhost')).toBe(true)
  expect(isHostnameBlocked('internal')).toBe(true)
  expect(isHostnameBlocked('subdomain.local')).toBe(true)
})

test('isHostnameBlocked allows public hostnames', () => {
  expect(isHostnameBlocked('example.com')).toBe(false)
})

test('isPublicIpAddress rejects private and loopback ranges', () => {
  expect(isPublicIpAddress('127.0.0.1')).toBe(false)
  expect(isPublicIpAddress('10.10.10.10')).toBe(false)
  expect(isPublicIpAddress('192.168.1.20')).toBe(false)
})

test('isPublicIpAddress accepts routable addresses', () => {
  expect(isPublicIpAddress('1.1.1.1')).toBe(true)
  expect(isPublicIpAddress('8.8.8.8')).toBe(true)
})

test('isHtmlResponse supports crawl and strict single-page classification', () => {
  expect(isHtmlResponse('text/html', '{"status":"ok"}')).toBe(true)
  expect(isHtmlResponse('text/html', '{"status":"ok"}', true)).toBe(false)
  expect(isHtmlResponse('text/plain', '<!doctype html><html><body>ok</body></html>')).toBe(true)
  expect(isHtmlResponse('application/json', '<!doctype html><html><body>ok</body></html>')).toBe(false)
})

test('rejects and cancels a streamed non-HTML ambiguous response after the first 512 bytes', async () => {
  let cancelled = false
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(new Error('test timeout')), 100)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new TextEncoder().encode('x'.repeat(512)))
    },
    cancel() {
      cancelled = true
    },
  }), { headers: { 'content-type': 'text/plain' } })))

  try {
    await expect(fetchPage('https://example.test/', {
      allowPrivateHost: 'example.test',
      signal: controller.signal,
      skipAuxiliary: true,
    })).rejects.toMatchObject({ code: 'NOT_HTML' })
  } finally {
    clearTimeout(deadline)
  }

  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(cancelled).toBe(true)
})

test('cancels an explicit non-HTML response before rejecting it', async () => {
  const cancel = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new TextEncoder().encode('{"status":"ok"}'))
    },
    cancel,
  }), { headers: { 'content-type': 'application/json' } })))

  await expect(fetchPage('https://example.test/', {
    allowPrivateHost: 'example.test',
    skipAuxiliary: true,
  })).rejects.toMatchObject({ code: 'NOT_HTML' })

  expect(cancel).toHaveBeenCalledOnce()
})

test('accepts a streamed HTML document after the first 512 bytes', async () => {
  let cancelled = false
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new TextEncoder().encode(`<!doctype html><html><body>${'x'.repeat(512)}</body></html>`))
      stream.close()
    },
    cancel() {
      cancelled = true
    },
  }), { headers: { 'content-type': 'text/plain' } })))

  const page = await fetchPage('https://example.test/', {
    allowPrivateHost: 'example.test',
    skipAuxiliary: true,
  })

  expect(page.html).toContain('<html>')
  expect(cancelled).toBe(false)
})

import assert from 'node:assert/strict'
import dns from 'node:dns/promises'
import { afterEach, test, vi } from 'vitest'

import { FetchBudgetController, fetchCanonicalTarget, fetchPage } from '../src/fetch-page.js'
import type { AeoAuditOutboundAttempt } from '../src/types.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mockFetch(implementation: typeof globalThis.fetch) {
  const mocked = vi.fn(implementation)
  vi.stubGlobal('fetch', mocked)
  return mocked
}

test('fetchCanonicalTarget uses a single GET and cancels the successful response body', async () => {
  let canceled = false
  const fetchMock = mockFetch(async (_input: string | URL | Request, options?: RequestInit) => {
    assert.equal(options?.method, 'GET')
    assert.equal(options?.redirect, 'manual')
    assert.ok(options?.signal instanceof AbortSignal)
    return new Response(new ReadableStream({ cancel() { canceled = true } }), { status: 200 })
  })

  const result = await fetchCanonicalTarget('https://1.1.1.1/page#section')

  assert.deepEqual(result, { state: 'ok', url: 'https://1.1.1.1/page', statusCode: 200, redirectChain: [] })
  assert.equal(fetchMock.mock.calls.length, 1)
  assert.equal(canceled, true)
})

test('fetchCanonicalTarget accepts a 204 response without a body', async () => {
  mockFetch(async () => new Response(null, { status: 204 }))
  const result = await fetchCanonicalTarget('https://1.1.1.1/')
  assert.equal(result.state, 'ok')
  assert.equal(result.statusCode, 204)
})

test('fetchCanonicalTarget accepts public IPv6 literals without DNS lookup', async () => {
  const fetchMock = mockFetch(async () => new Response(null, { status: 204 }))
  const result = await fetchCanonicalTarget('https://[2606:4700:4700::1111]/')
  assert.equal(result.state, 'ok')
  assert.equal(fetchMock.mock.calls.length, 1)
})

test('fetchCanonicalTarget does not wait for stalled body cancellation', async () => {
  let canceled = 0
  let requests = 0
  mockFetch(async () => {
    requests += 1
    return new Response(new ReadableStream({
      cancel() {
        canceled += 1
        return new Promise<void>(() => {})
      },
    }), requests === 1 ? { status: 301, headers: { location: '/canonical' } } : { status: 200 })
  })
  const result = await fetchCanonicalTarget('https://1.1.1.1/')
  assert.equal(result.state, 'ok')
  assert.equal(result.url, 'https://1.1.1.1/canonical')
  assert.equal(canceled, 2)
})

for (const status of [404, 500, 302]) {
  test(`fetchCanonicalTarget reports HTTP ${status} as unreachable`, async () => {
    let canceled = false
    mockFetch(async () => new Response(new ReadableStream({ cancel() { canceled = true } }), { status }))

    const result = await fetchCanonicalTarget('https://1.1.1.1/')

    assert.equal(result.state, 'unreachable')
    assert.equal(result.statusCode, status)
    assert.deepEqual(result.redirectChain, [])
    assert.equal(canceled, true)
  })
}

for (const status of [200, 404, 500]) {
  test(`fetchCanonicalTarget preserves redirects ending in HTTP ${status}`, async () => {
    let requests = 0
    let canceled = 0
    const fetchMock = mockFetch(async () => {
      requests += 1
      return new Response(new ReadableStream({ cancel() { canceled += 1 } }), requests === 1
        ? { status: 301, headers: { location: '/canonical' } }
        : { status })
    })

    const result = await fetchCanonicalTarget('https://1.1.1.1/original')

    assert.equal(result.state, status === 200 ? 'ok' : 'unreachable')
    assert.equal(result.url, 'https://1.1.1.1/canonical')
    assert.equal(result.statusCode, status)
    assert.deepEqual(result.redirectChain, [{ status: 301, from: 'https://1.1.1.1/original', to: 'https://1.1.1.1/canonical' }])
    assert.equal(fetchMock.mock.calls.length, 2)
    assert.equal(canceled, 2)
  })
}

for (const [url, errorCode] of [
  ['http://127.0.0.1/private', 'BLOCKED_IP'],
  ['http://10.0.0.1/private', 'BLOCKED_IP'],
  ['http://[::1]/private', 'BLOCKED_IP'],
  ['http://[::ffff:127.0.0.1]/private', 'BLOCKED_IP'],
  ['http://localhost/private', 'BLOCKED_HOST'],
  ['ftp://1.1.1.1/file', 'UNSUPPORTED_PROTOCOL'],
  ['https://user:password@1.1.1.1/private', 'BAD_INPUT'],
  ['invalid URL', 'INVALID_URL'],
]) {
  test(`fetchCanonicalTarget rejects ${url} before requesting it`, async () => {
    const fetchMock = mockFetch(async () => { throw new Error('Unexpected request') })
    const result = await fetchCanonicalTarget(url)
    assert.equal(result.state, 'unreachable')
    assert.equal(result.errorCode, errorCode)
    assert.deepEqual(result.redirectChain, [])
    assert.equal(fetchMock.mock.calls.length, 0)
  })
}

for (const [location, errorCode] of [
  ['http://127.0.0.1/private', 'BLOCKED_IP'],
  ['http://[::1]/private', 'BLOCKED_IP'],
  ['http://localhost/private', 'BLOCKED_HOST'],
  ['ftp://1.1.1.1/file', 'UNSUPPORTED_PROTOCOL'],
  ['https://user:password@1.1.1.1/private', 'BAD_INPUT'],
]) {
  test(`fetchCanonicalTarget blocks redirect to ${location} and preserves the hop`, async () => {
    let canceled = false
    const fetchMock = mockFetch(async () => new Response(new ReadableStream({ cancel() { canceled = true } }), {
      status: 302,
      headers: { location },
    }))

    const result = await fetchCanonicalTarget('https://1.1.1.1/')

    assert.equal(result.state, 'unreachable')
    assert.equal(result.url, location)
    assert.equal(result.errorCode, errorCode)
    assert.equal(result.statusCode, null)
    assert.deepEqual(result.redirectChain, [{ status: 302, from: 'https://1.1.1.1/', to: location }])
    assert.equal(fetchMock.mock.calls.length, 1)
    assert.equal(canceled, true)
  })
}

test('fetchCanonicalTarget preserves malformed redirect locations', async () => {
  const fetchMock = mockFetch(async () => new Response(null, {
    status: 301,
    headers: { location: 'http://[invalid' },
  }))
  const result = await fetchCanonicalTarget('https://1.1.1.1/')
  assert.equal(result.state, 'unreachable')
  assert.equal(result.errorCode, 'UNREACHABLE')
  assert.deepEqual(result.redirectChain, [{ status: 301, from: 'https://1.1.1.1/', to: 'http://[invalid' }])
  assert.equal(fetchMock.mock.calls.length, 1)
})

for (const loop of [false, true]) {
  test(`fetchCanonicalTarget stops a redirect ${loop ? 'loop' : 'chain'} after five followed hops`, async () => {
    let requests = 0
    let canceled = 0
    const fetchMock = mockFetch(async () => {
      requests += 1
      return new Response(new ReadableStream({ cancel() { canceled += 1 } }), {
        status: 301,
        headers: { location: loop ? '/' : `/hop-${requests}` },
      })
    })
    const result = await fetchCanonicalTarget('https://1.1.1.1/')
    assert.equal(result.state, 'unreachable')
    assert.equal(result.errorCode, 'REDIRECT_LIMIT')
    assert.equal(result.redirectChain.length, 6)
    assert.equal(fetchMock.mock.calls.length, 6)
    assert.equal(canceled, 6)
  })
}

test('fetchCanonicalTarget preserves redirects when the next request fails', async () => {
  let requests = 0
  mockFetch(async () => {
    requests += 1
    if (requests === 1) {
      return new Response(null, { status: 307, headers: { location: '/unreachable' } })
    }
    throw new TypeError('fetch failed')
  })
  const result = await fetchCanonicalTarget('https://1.1.1.1/')
  assert.equal(result.state, 'unreachable')
  assert.equal(result.url, 'https://1.1.1.1/unreachable')
  assert.equal(result.errorCode, 'UNREACHABLE')
  assert.equal(result.statusCode, null)
  assert.deepEqual(result.redirectChain, [{ status: 307, from: 'https://1.1.1.1/', to: 'https://1.1.1.1/unreachable' }])
})

test('fetchCanonicalTarget times out after five seconds and aborts the request', async () => {
  vi.useFakeTimers()
  let started: () => void = () => {}
  const requestStarted = new Promise<void>((resolve) => { started = resolve })
  mockFetch((_input: string | URL | Request, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    started()
  }))
  const pending = fetchCanonicalTarget('https://1.1.1.1/')
  await requestStarted
  await vi.advanceTimersByTimeAsync(5_000)
  const result = await pending
  assert.equal(result.state, 'timeout')
  assert.equal(result.errorCode, 'TIMEOUT')
  assert.deepEqual(result.redirectChain, [])
})

test('fetchCanonicalTarget shares its five-second deadline across redirect requests', async () => {
  vi.useFakeTimers()
  let requests = 0
  let started: () => void = () => {}
  const requestStarted = new Promise<void>((resolve) => { started = resolve })
  mockFetch((_input: string | URL | Request, options?: RequestInit) => {
    requests += 1
    if (requests === 1) {
      return new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(null, { status: 308, headers: { location: '/slow' } })), 4_000))
    }
    return new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      started()
    })
  })
  const pending = fetchCanonicalTarget('https://1.1.1.1/')
  await vi.advanceTimersByTimeAsync(4_000)
  await requestStarted
  await vi.advanceTimersByTimeAsync(1_000)
  const result = await pending
  assert.equal(result.state, 'timeout')
  assert.equal(result.url, 'https://1.1.1.1/slow')
  assert.equal(result.errorCode, 'TIMEOUT')
  assert.deepEqual(result.redirectChain, [{ status: 308, from: 'https://1.1.1.1/', to: 'https://1.1.1.1/slow' }])
})


test('fetchCanonicalTarget preserves caller cancellation before any request', async () => {
  const controller = new AbortController()
  const reason = new Error('audit cancelled')
  controller.abort(reason)
  const mocked = mockFetch(async () => new Response(null, { status: 200 }))

  await assert.rejects(fetchCanonicalTarget('https://1.1.1.1/', { signal: controller.signal }), (error) => error === reason)
  assert.equal(mocked.mock.calls.length, 0)
})

test('fetchCanonicalTarget preserves caller cancellation during a request', async () => {
  const controller = new AbortController()
  const reason = new Error('audit cancelled during canonical probe')
  mockFetch((_url, options) => new Promise<Response>((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
    controller.abort(reason)
  }))

  await assert.rejects(fetchCanonicalTarget('https://1.1.1.1/', { signal: controller.signal }), (error) => error === reason)
})

test('fetchCanonicalTarget observes and budgets every redirect request', async () => {
  const attempts: AeoAuditOutboundAttempt[] = []
  const budget = new FetchBudgetController({ maxFetches: 2 })
  const mocked = mockFetch(async () => attempts.length === 1
    ? new Response(null, { status: 301, headers: { location: '/final' } })
    : new Response(null, { status: 204 }))

  const result = await fetchCanonicalTarget('https://1.1.1.1/', {
    budget,
    onOutboundAttempt: async (attempt) => { attempts.push(attempt) },
  })

  assert.equal(result.state, 'ok')
  assert.equal(budget.fetchesStarted, 2)
  assert.equal(mocked.mock.calls.length, 2)
  assert.deepEqual(attempts, [
    { kind: 'canonical', method: 'GET', url: 'https://1.1.1.1/', redirectDepth: 0 },
    { kind: 'canonical', method: 'GET', url: 'https://1.1.1.1/final', redirectDepth: 1 },
  ])
})

test('fetchCanonicalTarget propagates budget exhaustion before a redirect request', async () => {
  const budget = new FetchBudgetController({ maxFetches: 1 })
  const observed = vi.fn()
  const mocked = mockFetch(async () => new Response(null, { status: 301, headers: { location: '/final' } }))

  await assert.rejects(fetchCanonicalTarget('https://1.1.1.1/', { budget, onOutboundAttempt: observed }), (error) => {
    assert.ok(error && typeof error === 'object' && 'code' in error)
    assert.equal(error.code, 'BUDGET_EXCEEDED')
    return true
  })
  assert.equal(budget.fetchesStarted, 1)
  assert.equal(mocked.mock.calls.length, 1)
  assert.equal(observed.mock.calls.length, 1)
})

test('fetchCanonicalTarget propagates observer failures before starting transport', async () => {
  const reason = new Error('observer rejected the outbound request')
  const mocked = mockFetch(async () => new Response(null, { status: 200 }))

  await assert.rejects(fetchCanonicalTarget('https://1.1.1.1/', {
    onOutboundAttempt: () => { throw reason },
  }), (error) => error === reason)
  assert.equal(mocked.mock.calls.length, 0)
})

test('fetchCanonicalTarget forwards the exact allowed private host but blocks other redirect hosts', async () => {
  const mocked = mockFetch(async () => new Response(null, {
    status: 302,
    headers: { location: 'http://127.0.0.2/private' },
  }))

  const result = await fetchCanonicalTarget('http://127.0.0.1/page', { allowPrivateHost: '127.0.0.1' })

  assert.equal(result.state, 'unreachable')
  assert.equal(result.errorCode, 'BLOCKED_IP')
  assert.deepEqual(result.redirectChain, [{ status: 302, from: 'http://127.0.0.1/page', to: 'http://127.0.0.2/private' }])
  assert.equal(mocked.mock.calls.length, 1)
})

test('fetchPage exposes the final HTTP status for canonical target reuse', async () => {
  mockFetch(async () => new Response('<html><head></head><body>Page</body></html>', {
    status: 404,
    headers: { 'content-type': 'text/html' },
  }))
  const page = await fetchPage('https://1.1.1.1/page', { skipAuxiliary: true })
  assert.equal(page.statusCode, 404)
})


test('fetchCanonicalTarget deadline includes stalled DNS and never starts a late request', async () => {
  vi.useFakeTimers()
  let releaseDns: (addresses: string[]) => void = () => {}
  vi.spyOn(dns, 'resolve4').mockImplementation(() => new Promise<string[]>((resolve) => { releaseDns = resolve }) as never)
  vi.spyOn(dns, 'resolve6').mockResolvedValue([])
  const mocked = mockFetch(async () => new Response(null, { status: 200 }))

  const pending = fetchCanonicalTarget('https://canonical.example/target')
  await vi.advanceTimersByTimeAsync(5_000)
  const result = await pending
  assert.equal(result.state, 'timeout')
  assert.equal(result.errorCode, 'TIMEOUT')
  assert.equal(mocked.mock.calls.length, 0)

  releaseDns(['1.1.1.1'])
  await vi.advanceTimersByTimeAsync(0)
  assert.equal(mocked.mock.calls.length, 0)
})

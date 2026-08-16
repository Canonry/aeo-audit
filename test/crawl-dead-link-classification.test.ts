import { afterEach, describe, expect, test, vi } from 'vitest'

import { runSiteCrawl } from '../src/index.js'

const html = (body: string) => new Response(`<!doctype html><html><body>${body}</body></html>`, {
  status: 200,
  headers: { 'content-type': 'text/html' },
})

const missing = () => new Response('', { status: 404 })

afterEach(() => vi.unstubAllGlobals())

/**
 * The invariant: a dead link is a link whose target ANSWERED with 4xx/5xx. A
 * target the crawler could not fetch has no status code, so it is not evidence
 * about the link and must never reach `findings`.
 *
 * The regression these lock down shipped a client-facing report claiming six
 * live, sub-second URLs were broken: every finding carried `statusCode: null`
 * and `reason: 'fetch-error'`, and every one of them served a 200 on a manual
 * check moments later.
 */
describe('dead-link classification separates "broken" from "could not check"', () => {
  /** A site whose links all resolve, except that `/flaky` fails `failures` times before serving 200. */
  const flakySite = (failures: number, failure: () => never | Promise<never>) => {
    let seen = 0
    return vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml' || url.pathname === '/sitemap-index.xml') return missing()
      if (url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt') return missing()
      if (url.pathname === '/') return html('<a href="/flaky">flaky</a>')
      if (url.pathname === '/flaky') {
        seen += 1
        if (seen <= failures) return failure()
        return html('<p>alive</p>')
      }
      return missing()
    })
  }

  const reset = (): never => {
    throw Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNRESET') })
  }

  test('an unfetchable target is never a dead link, and is reported as unverified instead', async () => {
    // Retries disabled, so the transient failure survives to classification —
    // exactly the state the old code called a dead link.
    vi.stubGlobal('fetch', flakySite(Number.POSITIVE_INFINITY, reset))

    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      checkDeadLinks: true,
      maxFetchRetries: 0,
    })

    expect(report.deadLinks.state).toBe('complete')
    expect(report.deadLinks.findings).toEqual([])
    expect(report.deadLinks.unverified).toEqual([
      expect.objectContaining({
        from: 'https://example.test/',
        to: 'https://example.test/flaky',
        reason: 'unreachable',
        statusCode: null,
      }),
    ])
    // The unverified row carries WHY, which the fabricated dead links never did.
    expect(report.deadLinks.unverified[0]!.error).toBeTruthy()
    // Distinct key prefixes: a consumer keying findings by `key` cannot collide.
    expect(report.deadLinks.unverified[0]!.key.startsWith('unverified-link:')).toBe(true)
  })

  test('no null-status observation can reach dead-link findings, whatever the failure mode', async () => {
    for (const failure of [
      reset,
      (): never => { throw new Error('socket hang up') },
      (): never => { throw new DOMException('The operation timed out.', 'TimeoutError') },
    ]) {
      vi.stubGlobal('fetch', flakySite(Number.POSITIVE_INFINITY, failure))

      const report = await runSiteCrawl('https://example.test/', {
        allowPrivateHost: 'example.test',
        checkDeadLinks: true,
        maxFetchRetries: 0,
      })
      if (report.mode !== 'full') throw new Error('expected full report')

      // The observation really is the null-status one this guards against.
      const target = report.pages.find((page) => page.requestedUrl === 'https://example.test/flaky')
      expect(target).toMatchObject({ state: 'fetch-error', statusCode: null })

      expect(report.deadLinks.findings).toEqual([])
      expect(report.deadLinks.findings.every((finding) => typeof finding.statusCode === 'number')).toBe(true)
      expect(report.deadLinks.unverified).toHaveLength(1)
    }
  })

  test('a real 4xx target is still a dead link, and is not diverted into unverified', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/') return html('<a href="/gone">gone</a>')
      if (url.pathname === '/gone') return new Response('gone', { status: 404, headers: { 'content-type': 'text/html' } })
      return missing()
    }))

    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      checkDeadLinks: true,
    })

    expect(report.deadLinks.findings).toEqual([
      expect.objectContaining({
        from: 'https://example.test/',
        to: 'https://example.test/gone',
        statusCode: 404,
        reason: 'http-error',
      }),
    ])
    expect(report.deadLinks.unverified).toEqual([])
  })

  test('a 5xx target is a dead link on its status code, not on the crawl state', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/') return html('<a href="/broken">broken</a>')
      if (url.pathname === '/broken') return new Response('boom', { status: 503, headers: { 'content-type': 'text/html' } })
      return missing()
    }))

    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      checkDeadLinks: true,
    })

    expect(report.deadLinks.findings).toEqual([
      expect.objectContaining({ to: 'https://example.test/broken', statusCode: 503, reason: 'http-error' }),
    ])
    expect(report.deadLinks.unverified).toEqual([])
  })

  test('the disabled result carries both empty buckets, so a consumer never reads undefined', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/') return html('<a href="/gone">gone</a>')
      return missing()
    }))

    const report = await runSiteCrawl('https://example.test/', { allowPrivateHost: 'example.test' })
    expect(report.deadLinks).toEqual({ state: 'disabled', findings: [], unverified: [] })
  })
})

describe('bounded retry before classification', () => {
  const site = (failuresBeforeSuccess: number, calls: { flaky: number }) => vi.fn(async (input: string) => {
    const url = new URL(input)
    if (url.pathname === '/') return html('<a href="/flaky">flaky</a>')
    if (url.pathname === '/flaky') {
      calls.flaky += 1
      if (calls.flaky <= failuresBeforeSuccess) throw new TypeError('fetch failed')
      return html('<p>alive</p>')
    }
    return missing()
  })

  test('a target that fails once and then serves 200 is neither dead nor unverified', async () => {
    const calls = { flaky: 0 }
    vi.stubGlobal('fetch', site(1, calls))

    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      checkDeadLinks: true,
    })
    if (report.mode !== 'full') throw new Error('expected full report')

    expect(calls.flaky).toBe(2)
    expect(report.deadLinks.findings).toEqual([])
    expect(report.deadLinks.unverified).toEqual([])
    expect(report.pages.find((page) => page.finalUrl === 'https://example.test/flaky')?.state).toBe('html')
    // The recovery is recorded, so a flaky crawl is visible rather than silent.
    expect(report.summary.fetchRetries).toEqual({ attempted: 1, recovered: 1 })
  })

  test('retries are bounded by maxFetchRetries and stop attempting after it', async () => {
    const calls = { flaky: 0 }
    vi.stubGlobal('fetch', site(Number.POSITIVE_INFINITY, calls))

    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      checkDeadLinks: true,
      maxFetchRetries: 2,
    })

    // One initial attempt plus exactly two retries.
    expect(calls.flaky).toBe(3)
    expect(report.summary.fetchRetries).toEqual({ attempted: 2, recovered: 0 })
    expect(report.deadLinks.findings).toEqual([])
    expect(report.deadLinks.unverified).toHaveLength(1)
  })

  test('a permanent failure is not retried', async () => {
    // A redirect loop past the redirect limit reproduces on every attempt, so
    // spending retries on it only burns the fetch budget.
    let hops = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/') return html('<a href="/loop">loop</a>')
      if (url.pathname.startsWith('/loop')) {
        hops += 1
        return new Response('', { status: 302, headers: { location: `/loop${hops}` } })
      }
      return missing()
    }))

    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      checkDeadLinks: true,
      maxFetchRetries: 2,
    })

    if (report.mode !== 'full') throw new Error('expected full report')
    // The failure path really ran — this is not a vacuous zero.
    expect(report.pages.find((page) => page.requestedUrl === 'https://example.test/loop'))
      .toMatchObject({ state: 'fetch-error', statusCode: null, error: expect.stringContaining('redirects') })
    expect(report.summary.fetchRetries).toEqual({ attempted: 0, recovered: 0 })
    expect(report.deadLinks.findings).toEqual([])
  })

  test('maxFetchRetries: 0 restores single-attempt behavior', async () => {
    const calls = { flaky: 0 }
    vi.stubGlobal('fetch', site(Number.POSITIVE_INFINITY, calls))

    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      checkDeadLinks: true,
      maxFetchRetries: 0,
    })

    expect(calls.flaky).toBe(1)
    expect(report.summary.fetchRetries).toEqual({ attempted: 0, recovered: 0 })
  })
})

describe('a target that answered is never described as silent, and 429 is never broken', () => {
  const linkTo = (path: string) => vi.fn(async (input: string) => {
    const url = new URL(input)
    if (url.pathname === '/') return html(`<a href="${path}">t</a>`)
    if (url.pathname === path) return new Response('slow down', { status: 429, headers: { 'content-type': 'text/html' } })
    return missing()
  })

  test('a throttled target is unverified, not a dead link', async () => {
    // 429 describes OUR request rate. Reporting it as a broken link blames the
    // site for how hard we crawled it, which is the same mistake as reporting
    // a timeout — it just arrives with a status code attached.
    vi.stubGlobal('fetch', linkTo('/throttled'))

    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test', checkDeadLinks: true, maxFetchRetries: 0,
    })

    expect(report.deadLinks.findings).toEqual([])
    expect(report.deadLinks.unverified).toEqual([
      expect.objectContaining({ to: 'https://example.test/throttled', reason: 'throttled', statusCode: 429 }),
    ])
  })

  test('a 429 is retried, and a target that then answers is neither bucket', async () => {
    let hits = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/') return html('<a href="/busy">busy</a>')
      if (url.pathname === '/busy') {
        hits += 1
        if (hits === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } })
        return html('<p>alive</p>')
      }
      return missing()
    }))

    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test', checkDeadLinks: true, maxFetchRetries: 2,
    })

    expect(hits).toBe(2)
    expect(report.deadLinks.findings).toEqual([])
    expect(report.deadLinks.unverified).toEqual([])
    expect(report.summary.fetchRetries).toEqual({ attempted: 1, recovered: 1 })
  })

  test('a redirect loop says redirect-limit, because the target did answer', async () => {
    let hops = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/') return html('<a href="/loop">loop</a>')
      if (url.pathname.startsWith('/loop')) {
        hops += 1
        return new Response('', { status: 302, headers: { location: `/loop${hops}` } })
      }
      return missing()
    }))

    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test', checkDeadLinks: true,
    })

    // "never answered" would be false here: it answered, repeatedly.
    expect(report.deadLinks.unverified).toEqual([
      expect.objectContaining({ to: 'https://example.test/loop', reason: 'redirect-limit' }),
    ])
    expect(report.deadLinks.findings).toEqual([])
  })
})

describe('a request may not outlive the crawl that owns it', () => {
  test('a retry dispatched inside the budget is still bounded by the deadline', async () => {
    let hits = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input)
      if (url.pathname === '/') return html('<a href="/slow">slow</a>')
      if (url.pathname === '/slow') {
        hits += 1
        if (hits === 1) throw new TypeError('fetch failed')
        // Hangs far past both the crawl budget and the 10s per-request ceiling.
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 30_000)
          init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
        })
        return html('<p>ok</p>')
      }
      return missing()
    }))

    const startedAt = Date.now()
    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test', checkDeadLinks: true, maxDurationMs: 2_000, maxFetchRetries: 1,
    })
    const elapsed = Date.now() - startedAt

    // Before the fix this took ~10.7s on a 3s budget: the backoff was clipped
    // to the deadline but the retry it released then ran on the fixed 10s
    // socket timeout, which no budget check can interrupt mid-flight.
    expect(elapsed).toBeLessThan(6_000)
    // The hung target is reported as unchecked rather than broken, and the
    // crawl still says it covered everything it discovered — nothing was
    // truncated, one page just never answered in the time it was allowed.
    expect(report.deadLinks.findings).toEqual([])
    expect(report.deadLinks.unverified).toEqual([
      expect.objectContaining({ to: 'https://example.test/slow', reason: 'unreachable' }),
    ])
  }, 30_000)

  test('a deadline that expires during backoff still records the page', async () => {
    // The retry never happens, but the transient failure that prompted it is
    // real and observed. Losing it would drop the URL from the crawl entirely:
    // no page row, no unverified entry, nothing to explain the gap.
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/') return html('<a href="/gone-quiet">x</a>')
      if (url.pathname === '/gone-quiet') throw new TypeError('fetch failed')
      return missing()
    }))

    const report = await runSiteCrawl('https://example.test/', {
      allowPrivateHost: 'example.test',
      checkDeadLinks: true,
      mode: 'full',
      // Enough to fetch the root and fail the child once, then expire during
      // the 500ms backoff before the retry can be dispatched.
      maxDurationMs: 300,
      maxFetchRetries: 2,
    })
    if (report.mode !== 'full') throw new Error('expected full report')

    const target = report.pages.find((page) => page.requestedUrl.endsWith('/gone-quiet'))
    expect(target).toMatchObject({ state: 'fetch-error', statusCode: null })
    // Nothing was retried, so nothing may be counted as attempted.
    expect(report.summary.fetchRetries).toEqual({ attempted: 0, recovered: 0 })
  })
})

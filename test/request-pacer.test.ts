import { describe, expect, test, vi } from 'vitest'

import { RequestPacer } from '../src/request-pacer.js'

describe('RequestPacer', () => {
  test('serializes concurrent start slots at the configured delay', async () => {
    vi.useFakeTimers({ now: 0 })
    try {
      const pacer = new RequestPacer({ delayMs: 20 })
      const starts: number[] = []
      const callers = Array.from({ length: 3 }, () => pacer.wait().then(() => starts.push(Date.now())))

      await vi.advanceTimersByTimeAsync(40)
      await Promise.all(callers)

      expect(starts).toEqual([0, 20, 40])
    } finally {
      vi.useRealTimers()
    }
  })

  test('uses a later mutable delay for slots reserved after the change', async () => {
    vi.useFakeTimers({ now: 0 })
    try {
      const pacer = new RequestPacer({ delayMs: 10 })
      const starts: number[] = []

      const first = pacer.wait().then(() => starts.push(Date.now()))
      pacer.delayMs = 25
      const second = pacer.wait().then(() => starts.push(Date.now()))
      const third = pacer.wait().then(() => starts.push(Date.now()))

      await vi.advanceTimersByTimeAsync(60)
      await Promise.all([first, second, third])

      expect(starts).toEqual([0, 10, 35])
    } finally {
      vi.useRealTimers()
    }
  })

  test('can apply a raised delay to the request that follows an existing grant', async () => {
    vi.useFakeTimers({ now: 0 })
    try {
      const pacer = new RequestPacer({ delayMs: 0 })
      await pacer.wait()
      pacer.delayMs = 25
      pacer.applyDelaySinceLastGrant()
      const next = pacer.wait()

      await vi.advanceTimersByTimeAsync(24)
      let granted = false
      void next.then(() => { granted = true })
      await vi.advanceTimersByTimeAsync(1)

      expect(granted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  test('spaces actual grants after the event loop stalls past reserved slots', async () => {
    const pacer = new RequestPacer({ delayMs: 20 })
    const starts: number[] = []
    const blockFor = (durationMs: number): void => {
      const until = Date.now() + durationMs
      while (Date.now() < until) {
        // Deliberately prevent overdue timers from firing until the first grant completes.
      }
    }

    const first = pacer.wait().then(() => {
      starts.push(Date.now())
      blockFor(75)
    })
    const second = pacer.wait().then(() => { starts.push(Date.now()) })
    const third = pacer.wait().then(() => { starts.push(Date.now()) })

    await Promise.all([first, second, third])

    expect(starts).toHaveLength(3)
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(15)
  })

  test('rejects with the caller abort reason while waiting', async () => {
    vi.useFakeTimers({ now: 0 })
    try {
      const pacer = new RequestPacer({ delayMs: 50 })
      await pacer.wait()
      const controller = new AbortController()
      const reason = new Error('caller stopped crawl')
      const waiting = pacer.wait({ signal: controller.signal })

      const rejected = expect(waiting).rejects.toBe(reason)
      controller.abort(reason)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })

  test('uses the supplied deadline error instead of sleeping beyond the deadline', async () => {
    vi.useFakeTimers({ now: 0 })
    try {
      const pacer = new RequestPacer({ delayMs: 50 })
      await pacer.wait()
      const deadlineError = new Error('crawl duration exhausted')
      const waiting = pacer.wait({ deadlineAt: Date.now() + 10, deadlineError: () => deadlineError })

      const rejected = expect(waiting).rejects.toBe(deadlineError)
      await vi.advanceTimersByTimeAsync(10)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })

  test('accepts only finite nonnegative delays', () => {
    const pacer = new RequestPacer({ delayMs: 0 })
    expect(() => { pacer.delayMs = -1 }).toThrow(RangeError)
    expect(() => { pacer.delayMs = Number.POSITIVE_INFINITY }).toThrow(RangeError)
    expect(() => new RequestPacer({ delayMs: Number.NaN })).toThrow(RangeError)
  })
})

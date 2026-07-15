import { describe, expect, it } from 'vitest'
import { RequestContainment, SaturatedError } from '../src/service/containment.js'

describe('request containment', () => {
  it('uses weighted capacity and releases queued work', async () => {
    const containment = new RequestContainment({ capacity: 8, queueSize: 2, queueWaitMs: 1_000, perKeyConcurrency: 2 })
    const releaseA = await containment.acquire('a', 4)
    const releaseB = await containment.acquire('b', 4)
    let acquired = false
    const queued = containment.acquire('c', 1).then((release) => {
      acquired = true
      return release
    })
    await Promise.resolve()
    expect(acquired).toBe(false)
    releaseA()
    const releaseC = await queued
    expect(acquired).toBe(true)
    releaseB()
    releaseC()
  })

  it('rejects work after the per-key cap', async () => {
    const containment = new RequestContainment({ capacity: 8, queueSize: 2, queueWaitMs: 1_000, perKeyConcurrency: 2 })
    const releaseA = await containment.acquire('same', 1)
    const releaseB = await containment.acquire('same', 1)
    await expect(containment.acquire('same', 1)).rejects.toBeInstanceOf(SaturatedError)
    releaseA()
    releaseB()
  })
})

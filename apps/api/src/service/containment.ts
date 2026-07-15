export class SaturatedError extends Error {
  constructor(message = 'Audit capacity is temporarily saturated.') {
    super(message)
    this.name = 'SaturatedError'
  }
}

export class ClientAbortError extends Error {
  constructor() {
    super('The client disconnected.')
    this.name = 'ClientAbortError'
  }
}

interface QueueEntry {
  weight: number
  signal?: AbortSignal
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  onAbort?: () => void
}

export interface ContainmentOptions {
  capacity: number
  queueSize: number
  queueWaitMs: number
  perKeyConcurrency: number
}

export class RequestContainment {
  private used = 0
  private readonly queue: QueueEntry[] = []
  private readonly activeByKey = new Map<string, number>()

  constructor(private readonly options: ContainmentOptions) {}

  async acquire(keyHash: string, weight: number, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new ClientAbortError()
    const keyCount = this.activeByKey.get(keyHash) ?? 0
    if (keyCount >= this.options.perKeyConcurrency) throw new SaturatedError('Per-key concurrency limit reached.')
    this.activeByKey.set(keyHash, keyCount + 1)

    try {
      const releaseGlobal = await this.acquireGlobal(weight, signal)
      let released = false
      return () => {
        if (released) return
        released = true
        releaseGlobal()
        this.releaseKey(keyHash)
      }
    } catch (error) {
      this.releaseKey(keyHash)
      throw error
    }
  }

  private acquireGlobal(weight: number, signal?: AbortSignal): Promise<() => void> {
    if (!Number.isInteger(weight) || weight <= 0 || weight > this.options.capacity) {
      return Promise.reject(new SaturatedError('Invalid request weight.'))
    }
    if (this.queue.length === 0 && this.used + weight <= this.options.capacity) {
      this.used += weight
      return Promise.resolve(this.releaseFactory(weight))
    }
    if (this.queue.length >= this.options.queueSize) {
      return Promise.reject(new SaturatedError())
    }

    return new Promise<() => void>((resolve, reject) => {
      const entry: QueueEntry = {
        weight,
        signal,
        resolve,
        reject,
        timer: setTimeout(() => this.rejectQueued(entry, new SaturatedError('Audit queue wait timed out.')), this.options.queueWaitMs),
      }
      if (signal) {
        entry.onAbort = () => this.rejectQueued(entry, new ClientAbortError())
        signal.addEventListener('abort', entry.onAbort, { once: true })
      }
      this.queue.push(entry)
    })
  }

  private rejectQueued(entry: QueueEntry, error: Error): void {
    const index = this.queue.indexOf(entry)
    if (index === -1) return
    this.queue.splice(index, 1)
    this.cleanupEntry(entry)
    entry.reject(error)
    this.drainQueue()
  }

  private releaseFactory(weight: number): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.used -= weight
      this.drainQueue()
    }
  }

  private drainQueue(): void {
    while (this.queue.length > 0) {
      const entry = this.queue[0]
      if (entry.signal?.aborted) {
        this.queue.shift()
        this.cleanupEntry(entry)
        entry.reject(new ClientAbortError())
        continue
      }
      if (this.used + entry.weight > this.options.capacity) return
      this.queue.shift()
      this.cleanupEntry(entry)
      this.used += entry.weight
      entry.resolve(this.releaseFactory(entry.weight))
    }
  }

  private cleanupEntry(entry: QueueEntry): void {
    clearTimeout(entry.timer)
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort)
  }

  private releaseKey(keyHash: string): void {
    const count = this.activeByKey.get(keyHash) ?? 0
    if (count <= 1) this.activeByKey.delete(keyHash)
    else this.activeByKey.set(keyHash, count - 1)
  }
}

export interface RequestPacerOptions {
  delayMs?: number
}

export interface RequestPacerWaitOptions {
  signal?: AbortSignal
  deadlineAt?: number
  deadlineError?: () => unknown
}

function assertDelay(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('Request delay must be a finite nonnegative number.')
  }
  return value
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted.', 'AbortError')
}

function deadlineReason(options: RequestPacerWaitOptions): unknown {
  return options.deadlineError?.() ?? new DOMException('Request deadline exceeded.', 'TimeoutError')
}

/**
 * Reserves globally serialized request-start slots. Changing `delayMs` affects
 * only future reservations, preserving the spacing already promised to waiters.
 */
export class RequestPacer {
  private _delayMs: number
  private nextSlotAt: number
  private lastGrantAt: number | null = null
  private tail: Promise<void> = Promise.resolve()

  constructor(options: RequestPacerOptions = {}) {
    this._delayMs = assertDelay(options.delayMs ?? 0)
    this.nextSlotAt = Date.now()
  }

  get delayMs(): number {
    return this._delayMs
  }

  set delayMs(value: number) {
    this._delayMs = assertDelay(value)
  }

  /** Raise the next start slot to honor the current delay after the last grant. */
  applyDelaySinceLastGrant(): void {
    if (this.lastGrantAt !== null) {
      this.nextSlotAt = Math.max(this.nextSlotAt, this.lastGrantAt + this._delayMs)
    }
  }

  async wait(options: RequestPacerWaitOptions = {}): Promise<void> {
    this.assertCanWait(options)
    const delayAfterGrant = this._delayMs
    const predecessor = this.tail
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    // A cancelled waiter may release its own gate early, but the chain remains
    // behind its predecessor so it can never let a later request overtake one.
    this.tail = predecessor.then(() => gate)

    try {
      await this.waitFor(predecessor, options)
      const slotAt = Math.max(Date.now(), this.nextSlotAt)
      await this.waitUntil(slotAt, options)
      this.assertCanWait(options)

      const grantedAt = Date.now()
      this.lastGrantAt = grantedAt
      this.nextSlotAt = grantedAt + delayAfterGrant
    } finally {
      release()
    }
  }

  private assertCanWait(options: RequestPacerWaitOptions): void {
    if (options.signal?.aborted) throw abortReason(options.signal)
    if (options.deadlineAt !== undefined && options.deadlineAt <= Date.now()) throw deadlineReason(options)
  }

  private async waitFor(turn: Promise<void>, options: RequestPacerWaitOptions): Promise<void> {
    await this.waitWithGuards(options, (resolve) => {
      void turn.then(resolve)
      return () => {}
    })
  }

  private async waitUntil(targetAt: number, options: RequestPacerWaitOptions): Promise<void> {
    if (targetAt <= Date.now()) return

    await this.waitWithGuards(options, (resolve) => {
      if (options.deadlineAt !== undefined && options.deadlineAt <= targetAt) return () => {}
      const timer = setTimeout(resolve, targetAt - Date.now())
      return () => clearTimeout(timer)
    })
  }

  private async waitWithGuards(
    options: RequestPacerWaitOptions,
    subscribe: (resolve: () => void) => () => void,
  ): Promise<void> {
    this.assertCanWait(options)
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        if (deadlineTimer) clearTimeout(deadlineTimer)
        unsubscribe()
        options.signal?.removeEventListener('abort', onAbort)
        callback()
      }
      const onAbort = (): void => finish(() => reject(abortReason(options.signal!)))
      options.signal?.addEventListener('abort', onAbort, { once: true })
      if (options.deadlineAt !== undefined) {
        deadlineTimer = setTimeout(() => finish(() => reject(deadlineReason(options))), options.deadlineAt - Date.now())
      }
      const unsubscribe = subscribe(() => finish(resolve))
      if (settled) unsubscribe()
      if (options.signal?.aborted) onAbort()
    })
  }
}

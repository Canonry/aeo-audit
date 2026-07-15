export type SitemapBudgetReason = 'fetches' | 'duration'

/** Internal control-flow sentinel. It is converted only at the sitemap boundary. */
export class SitemapBudgetExceededError extends Error {
  constructor(readonly reason: SitemapBudgetReason) {
    super(`Sitemap ${reason} budget exhausted.`)
    this.name = 'SitemapBudgetExceededError'
  }
}

export function isSitemapBudgetExceeded(error: unknown): error is SitemapBudgetExceededError {
  return error instanceof SitemapBudgetExceededError
}

export function rethrowExecutionControlFlow(error: unknown): void {
  if (isSitemapBudgetExceeded(error)) throw error
}

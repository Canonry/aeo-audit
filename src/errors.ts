export interface AeoAuditErrorOptions {
  statusCode?: number
  details?: unknown
  cause?: unknown
}

/**
 * Closed set of public engine failure identities. HTTP adapters can exhaustively
 * map this list without parsing messages or importing private implementation files.
 */
export const AUDIT_ERROR_CODES = [
  'BAD_INPUT',
  'BLOCKED_HOST',
  'BLOCKED_IP',
  'BODY_TOO_LARGE',
  'COMPARE_MISCONFIG',
  'INVALID_URL',
  'NOT_HTML',
  'REDIRECT_LIMIT',
  'SITEMAP_INVALID',
  'TIMEOUT',
  'UNREACHABLE',
  'UNSUPPORTED_PROTOCOL',
] as const

export type AuditErrorCode = (typeof AUDIT_ERROR_CODES)[number]

export class AeoAuditError extends Error {
  readonly code: AuditErrorCode
  readonly statusCode?: number
  readonly details?: unknown

  constructor(code: AuditErrorCode, message: string, options: AeoAuditErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AeoAuditError'
    this.code = code
    this.statusCode = options.statusCode
    this.details = options.details
  }
}

export function isAeoAuditError(error: unknown): error is AeoAuditError {
  return error instanceof AeoAuditError
}

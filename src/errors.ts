export type AeoAuditErrorCode =
  | 'BAD_INPUT'
  | 'INVALID_URL'
  | 'UNSUPPORTED_PROTOCOL'
  | 'UNREACHABLE'
  | 'BLOCKED_HOST'
  | 'BLOCKED_IP'
  | 'TIMEOUT'
  | 'REDIRECT_LIMIT'
  | 'BODY_TOO_LARGE'
  | 'NOT_HTML'
  | 'COMPARE_MISCONFIG'
  | 'BUDGET_EXCEEDED'

export interface AeoAuditErrorOptions {
  statusCode?: number
  details?: unknown
  cause?: unknown
}

export class AeoAuditError extends Error {
  readonly code: AeoAuditErrorCode
  readonly statusCode?: number
  readonly details?: unknown

  constructor(code: AeoAuditErrorCode, message: string, options: AeoAuditErrorOptions = {}) {
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

const AEO_AUDIT_ERROR_CODES = new Set<AeoAuditErrorCode>([
  'BAD_INPUT',
  'INVALID_URL',
  'UNSUPPORTED_PROTOCOL',
  'UNREACHABLE',
  'BLOCKED_HOST',
  'BLOCKED_IP',
  'TIMEOUT',
  'REDIRECT_LIMIT',
  'BODY_TOO_LARGE',
  'NOT_HTML',
  'COMPARE_MISCONFIG',
  'BUDGET_EXCEEDED',
])

export function isAeoAuditErrorCode(code: unknown): code is AeoAuditErrorCode {
  return typeof code === 'string' && AEO_AUDIT_ERROR_CODES.has(code as AeoAuditErrorCode)
}

export function getAeoAuditErrorCode(error: unknown): AeoAuditErrorCode | null {
  if (isAeoAuditError(error)) {
    return error.code
  }

  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    return isAeoAuditErrorCode(code) ? code : null
  }

  return null
}

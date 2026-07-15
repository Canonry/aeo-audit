import { AeoAuditError, type AuditErrorCode } from '@ainyc/aeo-audit'

export type PublicEngineErrorCode =
  | 'INVALID_URL'
  | 'TARGET_BLOCKED'
  | 'TARGET_UNREACHABLE'
  | 'TARGET_TIMEOUT'
  | 'TARGET_TOO_LARGE'
  | 'TARGET_NOT_HTML'
  | 'TOO_MANY_REDIRECTS'
  | 'SITEMAP_INVALID'
  | 'INTERNAL'

export interface ErrorMapping {
  status: number
  code: PublicEngineErrorCode
}

function assertNever(value: never): never {
  throw new Error(`Unmapped audit error code: ${String(value)}`)
}

export function mapAuditErrorCode(code: AuditErrorCode): ErrorMapping {
  switch (code) {
    case 'BAD_INPUT':
    case 'INVALID_URL':
    case 'UNSUPPORTED_PROTOCOL':
      return { status: 400, code: 'INVALID_URL' }
    case 'BLOCKED_HOST':
    case 'BLOCKED_IP':
      return { status: 422, code: 'TARGET_BLOCKED' }
    case 'UNREACHABLE':
      return { status: 422, code: 'TARGET_UNREACHABLE' }
    case 'TIMEOUT':
      return { status: 504, code: 'TARGET_TIMEOUT' }
    case 'BODY_TOO_LARGE':
      return { status: 422, code: 'TARGET_TOO_LARGE' }
    case 'NOT_HTML':
      return { status: 422, code: 'TARGET_NOT_HTML' }
    case 'REDIRECT_LIMIT':
      return { status: 422, code: 'TOO_MANY_REDIRECTS' }
    case 'SITEMAP_INVALID':
      return { status: 422, code: 'SITEMAP_INVALID' }
    case 'COMPARE_MISCONFIG':
      return { status: 500, code: 'INTERNAL' }
    default:
      return assertNever(code)
  }
}

export function mapEngineError(error: unknown): ErrorMapping {
  return error instanceof AeoAuditError
    ? mapAuditErrorCode(error.code)
    : { status: 500, code: 'INTERNAL' }
}

export type AgentReadinessErrorCode =
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

export interface AgentReadinessErrorOptions {
  statusCode?: number
  details?: unknown
  cause?: unknown
}

export class AgentReadinessError extends Error {
  readonly code: AgentReadinessErrorCode
  readonly statusCode?: number
  readonly details?: unknown

  constructor(code: AgentReadinessErrorCode, message: string, options: AgentReadinessErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AgentReadinessError'
    this.code = code
    this.statusCode = options.statusCode
    this.details = options.details
  }
}

export function isAgentReadinessError(error: unknown): error is AgentReadinessError {
  return error instanceof AgentReadinessError
}

const AGENT_READINESS_ERROR_CODES = new Set<AgentReadinessErrorCode>([
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

export function isAgentReadinessErrorCode(code: unknown): code is AgentReadinessErrorCode {
  return typeof code === 'string' && AGENT_READINESS_ERROR_CODES.has(code as AgentReadinessErrorCode)
}

export function getAgentReadinessErrorCode(error: unknown): AgentReadinessErrorCode | null {
  if (isAgentReadinessError(error)) {
    return error.code
  }

  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    return isAgentReadinessErrorCode(code) ? code : null
  }

  return null
}

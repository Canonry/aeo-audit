import type { FastifyRequest } from 'fastify'

const AUDIT_KEY_PATTERN = /^aak_[0-9a-f]{64}$/

export function parseBearer(value: unknown): string | null {
  if (typeof value !== 'string' || value.includes(',')) return null
  const match = /^([^ ]+) ([^ ]+)$/.exec(value)
  if (!match || match[1].toLowerCase() !== 'bearer') return null
  return AUDIT_KEY_PATTERN.test(match[2]) ? match[2] : null
}

function authorizationOccurrences(request: FastifyRequest): string[] {
  const raw = request.raw as typeof request.raw & {
    headersDistinct?: Record<string, string[] | undefined>
  }
  const distinct = raw.headersDistinct?.authorization
  if (distinct) return [...distinct]

  const values: string[] = []
  for (let index = 0; index < raw.rawHeaders.length; index += 2) {
    if (raw.rawHeaders[index]?.toLowerCase() === 'authorization') {
      values.push(raw.rawHeaders[index + 1] || '')
    }
  }
  return values
}

export function extractAuditKey(request: FastifyRequest): string | null {
  const values = authorizationOccurrences(request)
  return values.length === 1 ? parseBearer(values[0]) : null
}

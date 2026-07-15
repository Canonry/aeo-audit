import { describe, expect, it } from 'vitest'
import { AeoAuditError, AUDIT_ERROR_CODES } from '../src/index.js'

describe('audit error contract', () => {
  it('exports the closed public code set from the package root', () => {
    expect(AUDIT_ERROR_CODES).toEqual([
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
    ])
    expect(new AeoAuditError('SITEMAP_INVALID', 'bad sitemap').code).toBe('SITEMAP_INVALID')
  })
})

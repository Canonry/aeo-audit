import { AUDIT_ERROR_CODES, AeoAuditError } from '@ainyc/aeo-audit'
import { describe, expect, it } from 'vitest'
import { mapEngineError } from '../src/service/error-map.js'

describe('engine error mapping', () => {
  it('maps every exported error identity without message parsing', () => {
    for (const code of AUDIT_ERROR_CODES) {
      expect(mapEngineError(new AeoAuditError(code, 'arbitrary message'))).toMatchObject({
        status: expect.any(Number),
        code: expect.any(String),
      })
    }
    expect(mapEngineError(new AeoAuditError('SITEMAP_INVALID', 'anything'))).toEqual({ status: 422, code: 'SITEMAP_INVALID' })
    expect(mapEngineError(new Error('secret detail'))).toEqual({ status: 500, code: 'INTERNAL' })
  })
})

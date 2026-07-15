import { describe, expect, it } from 'vitest'
import { parseBearer } from '../src/auth/bearer.js'

const key = `aak_${'ab'.repeat(32)}`

describe('audit bearer parser', () => {
  it('accepts only one case-insensitive bearer scheme with the lowercase minted key shape', () => {
    expect(parseBearer(`Bearer ${key}`)).toBe(key)
    expect(parseBearer(`bEaReR ${key}`)).toBe(key)

    for (const value of [
      undefined,
      '',
      `Basic ${key}`,
      `Bearer  ${key}`,
      `Bearer ${key} extra`,
      `Bearer ${key},Bearer ${key}`,
      `Bearer AAK_${'ab'.repeat(32)}`,
      `Bearer aak_${'AB'.repeat(32)}`,
      ` Bearer ${key}`,
      `Bearer ${key} `,
    ]) {
      expect(parseBearer(value)).toBeNull()
    }
  })
})

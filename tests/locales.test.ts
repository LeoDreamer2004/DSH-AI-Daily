import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.js'

describe('AI Daily dashboard locales', () => {
  it('keeps the English and Chinese dictionaries key-identical', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})


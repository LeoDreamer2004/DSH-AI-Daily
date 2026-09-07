import { describe, expect, it } from 'vitest'
import { articleIdFor, canonicalizeArticleUrl } from '../src/url.js'

describe('canonicalizeArticleUrl', () => {
  it('removes fragments, trailing slashes, and tracking parameters', () => {
    expect(canonicalizeArticleUrl(
      'HTTPS://AIERA.COM.CN/story/?utm_source=feed&b=2&ref=home&a=1#section',
    )).toBe('https://aiera.com.cn/story?a=1&b=2')
  })

  it('keeps semantic query parameters and normalizes their order', () => {
    expect(canonicalizeArticleUrl('https://example.com/article?tag=ai&page=2'))
      .toBe('https://example.com/article?page=2&tag=ai')
  })

  it('rejects non-HTTP protocols', () => {
    expect(() => canonicalizeArticleUrl('file:///tmp/article.html')).toThrow(/HTTP\(S\)/)
  })

  it('rejects embedded credentials', () => {
    expect(() => canonicalizeArticleUrl('https://user:secret@example.com/article'))
      .toThrow(/credentials/)
  })
})

describe('articleIdFor', () => {
  it('is stable for a source and URL but source-scoped', () => {
    const url = 'https://aiera.com.cn/article'
    expect(articleIdFor('aiera', url)).toBe(articleIdFor('aiera', url))
    expect(articleIdFor('aiera', url)).not.toBe(articleIdFor('qbitai', url))
    expect(articleIdFor('aiera', url)).toMatch(/^[a-f0-9]{64}$/)
  })
})

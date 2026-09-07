import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { extractHtmlArticle, htmlToText } from '../src/extraction/html.js'

const fixtureUrl = new URL('./fixtures/aiera-article.html', import.meta.url)

describe('HTML extraction', () => {
  it('selects article content and removes executable or unrelated elements', async () => {
    const html = await readFile(fixtureUrl, 'utf8')
    const article = extractHtmlArticle(html, 10_000)

    expect(article).toMatchObject({
      title: 'A research result worth reading',
      author: 'AIERA Editor',
      publishedAt: '2026-09-05T00:30:00.000Z',
      truncated: false,
    })
    expect(article.content).toContain('First paragraph with important evidence.')
    expect(article.content).toContain('Key result')
    expect(article.content).toContain('Second paragraph.\nAnother line.')
    expect(article.content).not.toContain('Navigation')
    expect(article.content).not.toContain('Related content')
    expect(article.content).not.toContain('window.untrusted')
    expect(article.contentHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('reports truncation while hashing the complete normalized content', async () => {
    const html = await readFile(fixtureUrl, 'utf8')
    const complete = extractHtmlArticle(html, 10_000)
    const truncated = extractHtmlArticle(html, 20)

    expect(truncated.content).toHaveLength(20)
    expect(truncated.truncated).toBe(true)
    expect(truncated.contentHash).toBe(complete.contentHash)
  })

  it('normalizes an HTML fragment and validates the output limit', () => {
    expect(htmlToText('<p>Hello <strong>world</strong>.</p><p>Next.</p>', 100))
      .toBe('Hello world.\nNext.')
    expect(() => htmlToText('<p>x</p>', 0)).toThrow(/positive safe integer/)
    expect(() => extractHtmlArticle('<article>x</article>', 0)).toThrow(/positive safe integer/)
  })
})

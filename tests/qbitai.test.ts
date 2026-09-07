import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { WebFetchResult } from '@deepseek-ai/dsh-web'
import { parseQbitFeed, QbitSource, QbitSourceError } from '../src/sources/qbitai.js'

const feedFixtureUrl = new URL('./fixtures/qbitai-feed.xml', import.meta.url)
const articleFixtureUrl = new URL('./fixtures/qbitai-article.html', import.meta.url)
const feedUrl = 'https://www.qbitai.com/feed/'

function response(content: string, kind: 'html' | 'text' = 'text'): WebFetchResult {
  return {
    url: feedUrl,
    statusCode: 200,
    body: { kind, content },
    truncated: false,
  }
}

describe('parseQbitFeed', () => {
  it('normalizes official entries and refuses external article links', async () => {
    const xml = await readFile(feedFixtureUrl, 'utf8')
    const articles = parseQbitFeed(xml, feedUrl, 10)

    expect(articles).toHaveLength(2)
    expect(articles[0]).toEqual({
      source: 'qbitai',
      url: 'https://www.qbitai.com/2026/09/484897.html?utm_source=feed',
      canonicalUrl: 'https://www.qbitai.com/2026/09/484897.html',
      title: 'Embodied learning reaches a new milestone',
      publishedAt: '2026-09-06T11:44:21.000Z',
      author: 'QbitAI Editor',
      excerpt: 'Robots learn from longer multimodal context.',
    })
  })

  it('rejects malformed or empty feeds with a stable error code', () => {
    expect(() => parseQbitFeed('<rss>', feedUrl, 10)).toThrow(QbitSourceError)
    expect(() => parseQbitFeed('<rss><channel /></rss>', feedUrl, 10))
      .toThrow(/no valid article entries/)
  })
})

describe('QbitSource', () => {
  it('discovers entries and retrieves normalized article content through WebRuntime', async () => {
    const xml = await readFile(feedFixtureUrl, 'utf8')
    const html = await readFile(articleFixtureUrl, 'utf8')
    const requests: string[] = []
    const responses = [response(xml), response(html, 'html')]
    const source = new QbitSource({
      fetch: async request => {
        requests.push(request.url)
        const next = responses.shift()
        if (next === undefined) throw new Error('unexpected fetch')
        return next
      },
    }, {
      feedUrl,
      maxFeedItems: 10,
      maxArticleChars: 10_000,
      requestTimeoutMs: 5_000,
    })

    const articles = await source.discover()
    const first = articles[0]
    if (first === undefined) throw new Error('fixture did not yield an article')
    const document = await source.read(first)

    expect(requests).toEqual([feedUrl, first.canonicalUrl])
    expect(document.source).toBe('qbitai')
    expect(document.author).toBe('QbitAI Editor')
    expect(document.content).toContain('longer multimodal context')
    expect(document.content).not.toContain('Popular articles')
    expect(document.contentHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('refuses records outside the QbitAI domain before fetching them', async () => {
    const source = new QbitSource({
      fetch: async () => { throw new Error('unexpected fetch') },
    }, {
      feedUrl,
      maxFeedItems: 10,
      maxArticleChars: 10_000,
      requestTimeoutMs: 5_000,
    })

    await expect(source.read({
      source: 'qbitai',
      url: 'https://example.com/article',
      canonicalUrl: 'https://example.com/article',
      title: 'External article',
    })).rejects.toThrow(/outside its publisher domain/)
  })
})

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { WebFetchResult } from '@deepseek-ai/dsh-web'
import {
  AieraSource,
  AieraSourceError,
  isAieraPlaceholderContent,
  parseAieraFeed,
  parseAieraPost,
} from '../src/sources/aiera.js'

const feedFixtureUrl = new URL('./fixtures/aiera-feed.xml', import.meta.url)
const articleFixtureUrl = new URL('./fixtures/aiera-article.html', import.meta.url)
const feedUrl = 'https://aiera.com.cn/feed/'

function response(content: string, kind: 'html' | 'text' = 'text'): WebFetchResult {
  return {
    url: feedUrl,
    statusCode: 200,
    body: { kind, content },
    truncated: false,
  }
}

describe('parseAieraFeed', () => {
  it('normalizes valid RSS entries and skips incomplete entries', async () => {
    const xml = await readFile(feedFixtureUrl, 'utf8')
    const articles = parseAieraFeed(xml, feedUrl, 10)

    expect(articles).toHaveLength(2)
    expect(articles[0]).toEqual({
      source: 'aiera',
      url: 'https://aiera.com.cn/2026/09/05/research/editor/100/first-story/?utm_source=feed&ref=home',
      canonicalUrl: 'https://aiera.com.cn/2026/09/05/research/editor/100/first-story',
      title: 'First research story',
      publishedAt: '2026-09-05T00:30:00.000Z',
      author: 'AIERA Editor',
      excerpt: 'A concise first description.',
    })
    expect(articles[1]?.canonicalUrl)
      .toBe('https://aiera.com.cn/2026/09/04/industry/editor/99/second-story')
  })

  it('honors the configured item limit', async () => {
    const xml = await readFile(feedFixtureUrl, 'utf8')
    expect(parseAieraFeed(xml, feedUrl, 1)).toHaveLength(1)
  })

  it('rejects malformed or empty feeds with stable error codes', () => {
    expect(() => parseAieraFeed('<rss>', feedUrl, 10)).toThrow(AieraSourceError)
    expect(() => parseAieraFeed('<rss><channel /></rss>', feedUrl, 10))
      .toThrow(/no valid article entries/)
  })

  it('refuses article links outside the Aiera domain', () => {
    const xml = '<rss><channel><item><title>External</title><link>https://example.com/article</link></item></channel></rss>'
    expect(() => parseAieraFeed(xml, feedUrl, 10)).toThrow(/no valid article entries/)
  })
})

describe('AieraSource', () => {
  it('discovers entries and retrieves normalized article content through WebRuntime', async () => {
    const xml = await readFile(feedFixtureUrl, 'utf8')
    const html = await readFile(articleFixtureUrl, 'utf8')
    const requests: string[] = []
    const responses = [response(xml), response(html, 'html')]
    const source = new AieraSource({
      fetch: async (request) => {
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
    expect(document.title).toBe('A research result worth reading')
    expect(document.content).toContain('important evidence')
    expect(document.contentHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('loads the official WordPress API when the article page only contains a placeholder', async () => {
    const article = (await parseFixtureArticles())[0]
    if (article === undefined) throw new Error('fixture did not yield an article')
    const requests: string[] = []
    const source = new AieraSource({
      fetch: async request => {
        requests.push(request.url)
        if (request.url === article.canonicalUrl) {
          return response('<main><p class="pstate">正在取这篇稿子…</p></main>', 'html')
        }
        return response(JSON.stringify({
          id: 100,
          date: '2026-09-05T08:30:00',
          date_gmt: '2026-09-05T00:30:00',
          title: { rendered: 'Complete <strong>research</strong> story' },
          content: { rendered: '<section><p>Full evidence from the official article API.</p></section>' },
          _embedded: { author: [{ name: 'Aiera API Editor' }] },
        }))
      },
    }, {
      feedUrl,
      maxFeedItems: 10,
      maxArticleChars: 10_000,
      requestTimeoutMs: 5_000,
    })

    const document = await source.read(article)

    expect(requests).toEqual([
      article.canonicalUrl,
      'https://aiera.com.cn/wp-json/wp/v2/posts/100?_embed=1',
    ])
    expect(document).toMatchObject({
      title: 'Complete research story',
      author: 'Aiera API Editor',
      publishedAt: '2026-09-05T00:30:00.000Z',
    })
    expect(document.content).toBe('Full evidence from the official article API.')
    expect(document.content).not.toContain('正在取这篇稿子')
  })

  it('keeps a placeholder article out of model analysis when the official API is truncated', async () => {
    const article = (await parseFixtureArticles())[0]
    if (article === undefined) throw new Error('fixture did not yield an article')
    const source = new AieraSource({
      fetch: async request => request.url === article.canonicalUrl
        ? response('<main>正在取这篇稿子...</main>', 'html')
        : { ...response('{"id":100}'), truncated: true },
    }, {
      feedUrl,
      maxFeedItems: 10,
      maxArticleChars: 10_000,
      requestTimeoutMs: 5_000,
    })

    await expect(source.read(article)).rejects.toMatchObject({ code: 'TRUNCATED_RESPONSE' })
  })

  it('rejects non-success HTTP responses', async () => {
    const source = new AieraSource({
      fetch: async () => ({ ...response('failure'), statusCode: 503 }),
    }, {
      feedUrl,
      maxFeedItems: 10,
      maxArticleChars: 10_000,
      requestTimeoutMs: 5_000,
    })

    await expect(source.discover()).rejects.toMatchObject({ code: 'HTTP_ERROR' })
  })

  it('rejects truncated source responses instead of processing partial data', async () => {
    const source = new AieraSource({
      fetch: async () => ({ ...response('<rss />'), truncated: true }),
    }, {
      feedUrl,
      maxFeedItems: 10,
      maxArticleChars: 10_000,
      requestTimeoutMs: 5_000,
    })

    await expect(source.discover()).rejects.toMatchObject({ code: 'TRUNCATED_RESPONSE' })
  })

  it('accepts a truncated page when the article element is complete', async () => {
    const html = await readFile(articleFixtureUrl, 'utf8')
    const source = new AieraSource({
      fetch: async () => ({ ...response(`${html}<script>${'x'.repeat(100)}</script>`, 'html'), truncated: true }),
    }, {
      feedUrl,
      maxFeedItems: 10,
      maxArticleChars: 10_000,
      requestTimeoutMs: 5_000,
    })
    const article = (await parseFixtureArticles())[0]
    if (article === undefined) throw new Error('fixture did not yield an article')

    await expect(source.read(article)).resolves.toMatchObject({
      title: 'A research result worth reading',
    })
  })

  it('rejects a truncated page when the article element is incomplete', async () => {
    const source = new AieraSource({
      fetch: async () => ({
        ...response('<html><body><article><p>Partial content', 'html'),
        truncated: true,
      }),
    }, {
      feedUrl,
      maxFeedItems: 10,
      maxArticleChars: 10_000,
      requestTimeoutMs: 5_000,
    })
    const article = (await parseFixtureArticles())[0]
    if (article === undefined) throw new Error('fixture did not yield an article')

    await expect(source.read(article)).rejects.toMatchObject({ code: 'TRUNCATED_RESPONSE' })
  })
})

describe('Aiera dynamic article parsing', () => {
  it('recognizes only loading-placeholder bodies', () => {
    expect(isAieraPlaceholderContent('正在取这篇稿子…')).toBe(true)
    expect(isAieraPlaceholderContent(' 正在加载这篇文章... ')).toBe(true)
    expect(isAieraPlaceholderContent('The article discusses the loading placeholder.')).toBe(false)
  })

  it('rejects a mismatched WordPress post response', async () => {
    const article = (await parseFixtureArticles())[0]
    if (article === undefined) throw new Error('fixture did not yield an article')
    const json = JSON.stringify({
      id: 101,
      title: { rendered: 'Wrong post' },
      content: { rendered: '<p>Wrong content.</p>' },
    })

    expect(() => parseAieraPost(json, article, 100, 10_000))
      .toThrow(/post id mismatch/)
  })
})

async function parseFixtureArticles() {
  return parseAieraFeed(await readFile(feedFixtureUrl, 'utf8'), feedUrl, 10)
}

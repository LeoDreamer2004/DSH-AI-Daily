import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import type { WebFetchResult, WebRuntime } from '@deepseek-ai/dsh-web'
import {
  JiqizhixinSource,
  JiqizhixinSourceError,
  parseJiqizhixinArticle,
  parseJiqizhixinListing,
} from '../src/sources/jiqizhixin.js'

const listFixtureUrl = new URL('./fixtures/jiqizhixin-list.json', import.meta.url)
const articleFixtureUrl = new URL('./fixtures/jiqizhixin-article.json', import.meta.url)
const listUrl = 'https://www.jiqizhixin.com/api/article_library/articles.json?sort=time&page=1'

function response(content: string): WebFetchResult {
  return {
    url: listUrl,
    statusCode: 200,
    body: { kind: 'text', content },
    truncated: false,
  }
}

describe('parseJiqizhixinListing', () => {
  it('normalizes anonymous article-library entries and Shanghai timestamps', async () => {
    const listing = await readFile(listFixtureUrl, 'utf8')
    const articles = parseJiqizhixinListing(listing, 10)

    expect(articles).toHaveLength(2)
    expect(articles[0]).toEqual({
      source: 'jiqizhixin',
      url: 'https://www.jiqizhixin.com/articles/2026-09-06-6',
      canonicalUrl: 'https://www.jiqizhixin.com/articles/2026-09-06-6',
      title: 'A mathematical system improves agent reasoning',
      sourceArticleId: 'machine-heart-article-1',
      publishedAt: '2026-09-06T11:08:00.000Z',
      author: 'Machine Heart',
      excerpt: 'Researchers introduced a system for testing adaptive reasoning.',
    })
  })

  it('honors the configured item limit', async () => {
    const listing = await readFile(listFixtureUrl, 'utf8')
    expect(parseJiqizhixinListing(listing, 1)).toHaveLength(1)
  })

  it('rejects malformed JSON and unsupported response structures', () => {
    expect(() => parseJiqizhixinListing('{', 10)).toThrow(JiqizhixinSourceError)
    expect(() => parseJiqizhixinListing('{"success":false,"articles":[]}', 10))
      .toThrow(/unsupported response structure/)
  })

  it('skips unsafe slugs and duplicate entries', () => {
    const listing = JSON.stringify({
      success: true,
      articles: [
        { id: '1', title: 'Unsafe', slug: '../private' },
        { id: '2', title: 'First', slug: 'safe-slug' },
        { id: '3', title: 'Duplicate', slug: 'safe-slug' },
      ],
    })

    expect(parseJiqizhixinListing(listing, 10)).toEqual([
      expect.objectContaining({ title: 'First', canonicalUrl: 'https://www.jiqizhixin.com/articles/safe-slug' }),
    ])
  })
})

describe('parseJiqizhixinArticle', () => {
  it('rejects data-service HTML without treating it as article text', async () => {
    const listing = await readFile(listFixtureUrl, 'utf8')
    const article = parseJiqizhixinListing(listing, 1)[0]
    if (article === undefined) throw new Error('fixture did not yield an article')
    expect(() => parseJiqizhixinArticle('<!DOCTYPE html><title>Machine Heart data service</title><a href="/rss">Learn more</a>', article, 1000))
      .toThrow(expect.objectContaining({ code: 'HTML_RESPONSE', message: expect.stringContaining('no article text was read') }))
  })

  it('extracts complete text and hashes content before applying the model limit', async () => {
    const listing = await readFile(listFixtureUrl, 'utf8')
    const detail = await readFile(articleFixtureUrl, 'utf8')
    const article = parseJiqizhixinListing(listing, 1)[0]
    if (article === undefined) throw new Error('fixture did not yield an article')

    const document = parseJiqizhixinArticle(detail, article, 50)

    expect(document.title).toBe('A mathematical system improves agent reasoning')
    expect(document.author).toBe('Machine Heart')
    expect(document.publishedAt).toBe('2026-09-06T11:08:26.000Z')
    expect(document.content).toHaveLength(50)
    expect(document.content).not.toContain('ignoreMe')
    expect(document.contentHash).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe('JiqizhixinSource', () => {
  it('uses the saved API ID after restart without another listing request', async () => {
    const listing = await readFile(listFixtureUrl, 'utf8')
    const detail = await readFile(articleFixtureUrl, 'utf8')
    const article = parseJiqizhixinListing(listing, 1)[0]
    if (article === undefined) throw new Error('fixture did not yield an article')
    const fetch = vi.fn(async () => response(detail))
    const source = new JiqizhixinSource({ fetch }, { listUrl, maxItems: 10, maxArticleChars: 10000, requestTimeoutMs: 5000 })
    const document = await source.read(article)
    expect(fetch).toHaveBeenCalledExactlyOnceWith({ url: 'https://www.jiqizhixin.com/api/article_library/articles/machine-heart-article-1.json' }, expect.any(AbortSignal))
    expect(document.canonicalUrl).toBe(article.canonicalUrl)
    expect(document.sourceArticleId).toBe('machine-heart-article-1')
  })

  it('resolves legacy URL-only records through listing pages before reading JSON', async () => {
    const listing = await readFile(listFixtureUrl, 'utf8')
    const detail = await readFile(articleFixtureUrl, 'utf8')
    const article = parseJiqizhixinListing(listing, 1)[0]
    if (article === undefined) throw new Error('fixture did not yield an article')
    const { sourceArticleId: _sourceArticleId, ...legacy } = article
    const requests: string[] = []
    const source = new JiqizhixinSource({ fetch: async request => {
      requests.push(request.url)
      if (request.url.includes('page=1')) return response(JSON.stringify({ success: true, articles: [{ id: 'other', title: 'Another article', slug: 'another' }], hasNextPage: true }))
      if (request.url.includes('page=2')) return response(listing)
      return response(detail)
    } }, { listUrl, maxItems: 10, maxArticleChars: 10000, requestTimeoutMs: 5000, maxLookupPages: 2 })
    const document = await source.read(legacy)
    expect(requests).toEqual([
      listUrl,
      listUrl.replace('page=1', 'page=2'),
      'https://www.jiqizhixin.com/api/article_library/articles/machine-heart-article-1.json',
    ])
    expect(document.content).toContain('important evidence')
    expect(document.canonicalUrl).toBe(legacy.canonicalUrl)
  })

  it('bounds legacy lookup and never retries the obsolete slug detail endpoint', async () => {
    const fetch = vi.fn<WebRuntime['fetch']>(async () => response(JSON.stringify({ success: true, articles: [{ id: 'other', title: 'Other', slug: 'other' }], hasNextPage: true })))
    const source = new JiqizhixinSource({ fetch }, { listUrl, maxItems: 10, maxArticleChars: 10000, requestTimeoutMs: 5000, maxLookupPages: 2 })
    await expect(source.read({ source: 'jiqizhixin', title: 'Old article', url: 'https://www.jiqizhixin.com/articles/old', canonicalUrl: 'https://www.jiqizhixin.com/articles/old' }))
      .rejects.toMatchObject({ code: 'ARTICLE_ID_NOT_FOUND' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls.every(([request]) => request.url.includes('articles.json?'))).toBe(true)
  })

  it('stops at the last listing page or an empty page', async () => {
    for (const body of [
      { success: true, articles: [], hasNextPage: true },
      { success: true, articles: [{ id: 'other', title: 'Other', slug: 'other' }], hasNextPage: false },
    ]) {
      const fetch = vi.fn(async () => response(JSON.stringify(body)))
      const source = new JiqizhixinSource({ fetch }, { listUrl, maxItems: 10, maxArticleChars: 10000, requestTimeoutMs: 5000 })
      await expect(source.read({ source: 'jiqizhixin', title: 'Old', url: 'https://www.jiqizhixin.com/articles/old', canonicalUrl: 'https://www.jiqizhixin.com/articles/old' }))
        .rejects.toMatchObject({ code: 'ARTICLE_ID_NOT_FOUND' })
      expect(fetch).toHaveBeenCalledOnce()
    }
  })

  it('stops lookup on cancellation before fetching another page', async () => {
    const controller = new AbortController()
    const reason = new Error('Stop lookup')
    const fetch = vi.fn(async () => {
      controller.abort(reason)
      return response(JSON.stringify({ success: true, articles: [{ id: 'other', title: 'Other', slug: 'other' }], hasNextPage: true }))
    })
    const source = new JiqizhixinSource({ fetch }, { listUrl, maxItems: 10, maxArticleChars: 10000, requestTimeoutMs: 5000 })
    await expect(source.read({ source: 'jiqizhixin', title: 'Old', url: 'https://www.jiqizhixin.com/articles/old', canonicalUrl: 'https://www.jiqizhixin.com/articles/old' }, controller.signal))
      .rejects.toBe(reason)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('rejects unsafe saved API IDs before any request', async () => {
    const fetch = vi.fn(async () => response('unexpected'))
    const source = new JiqizhixinSource({ fetch }, { listUrl, maxItems: 10, maxArticleChars: 10000, requestTimeoutMs: 5000 })
    await expect(source.read({ source: 'jiqizhixin', title: 'Unsafe', url: 'https://www.jiqizhixin.com/articles/safe', canonicalUrl: 'https://www.jiqizhixin.com/articles/safe', sourceArticleId: '../private' }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('discovers and reads public articles without credentials', async () => {
    const listing = await readFile(listFixtureUrl, 'utf8')
    const detail = await readFile(articleFixtureUrl, 'utf8')
    const requests: string[] = []
    const source = new JiqizhixinSource({
      fetch: async request => {
        requests.push(request.url)
        return response(request.url === listUrl ? listing : detail)
      },
    }, {
      listUrl,
      maxItems: 10,
      maxArticleChars: 10_000,
      requestTimeoutMs: 5_000,
    })

    const article = (await source.discover())[0]
    if (article === undefined) throw new Error('fixture did not yield an article')
    const document = await source.read(article)

    expect(requests).toEqual([
      listUrl,
      'https://www.jiqizhixin.com/api/article_library/articles/machine-heart-article-1.json',
    ])
    expect(document.source).toBe('jiqizhixin')
    expect(document.content).toContain('important evidence')
  })

  it('rejects non-success and truncated responses', async () => {
    const source = new JiqizhixinSource({
      fetch: async () => ({ ...response('failure'), statusCode: 503 }),
    }, {
      listUrl,
      maxItems: 10,
      maxArticleChars: 10_000,
      requestTimeoutMs: 5_000,
    })

    await expect(source.discover()).rejects.toMatchObject({ code: 'HTTP_ERROR' })

    const truncatedSource = new JiqizhixinSource({
      fetch: async () => ({ ...response('{"success":true,"articles":[]}'), truncated: true }),
    }, {
      listUrl,
      maxItems: 10,
      maxArticleChars: 10_000,
      requestTimeoutMs: 5_000,
    })
    await expect(truncatedSource.discover()).rejects.toMatchObject({ code: 'TRUNCATED_RESPONSE' })
  })

  it('refuses records outside the official article library before fetching', async () => {
    const source = new JiqizhixinSource({
      fetch: async () => { throw new Error('unexpected fetch') },
    }, {
      listUrl,
      maxItems: 10,
      maxArticleChars: 10_000,
      requestTimeoutMs: 5_000,
    })

    await expect(source.read({
      source: 'jiqizhixin',
      url: 'https://example.com/article',
      canonicalUrl: 'https://example.com/article',
      title: 'External article',
    })).rejects.toThrow(/outside the Machine Heart article library/)
  })
})

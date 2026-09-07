import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import type { WebFetchResult } from '@deepseek-ai/dsh-web'
import type { ArticleAnalysisEngine } from '../src/analysis/model.js'
import { AiDailyService } from '../src/service.js'
import { ArticleRepository } from '../src/storage/repository.js'
import { MemoryArticleTable } from './helpers/memory-article-table.js'

const feedFixtureUrl = new URL('./fixtures/aiera-feed.xml', import.meta.url)
const articleFixtureUrl = new URL('./fixtures/aiera-article.html', import.meta.url)
const qbitFeedFixtureUrl = new URL('./fixtures/qbitai-feed.xml', import.meta.url)
const qbitArticleFixtureUrl = new URL('./fixtures/qbitai-article.html', import.meta.url)
const jiqizhixinListFixtureUrl = new URL('./fixtures/jiqizhixin-list.json', import.meta.url)
const jiqizhixinArticleFixtureUrl = new URL('./fixtures/jiqizhixin-article.json', import.meta.url)
const jiqizhixinListUrl = 'https://www.jiqizhixin.com/api/article_library/articles.json?sort=time&page=1'

function response(content: string, kind: 'html' | 'text'): WebFetchResult {
  return {
    url: 'https://aiera.com.cn/',
    statusCode: 200,
    body: { kind, content },
    truncated: false,
  }
}

describe('AiDailyService refresh pipeline', () => {
  it('discovers and processes all configured publishers through their matching adapters', async () => {
    const aieraFeed = await readFile(feedFixtureUrl, 'utf8')
    const aieraArticle = await readFile(articleFixtureUrl, 'utf8')
    const qbitFeed = await readFile(qbitFeedFixtureUrl, 'utf8')
    const qbitArticle = await readFile(qbitArticleFixtureUrl, 'utf8')
    const jiqizhixinList = await readFile(jiqizhixinListFixtureUrl, 'utf8')
    const jiqizhixinArticle = await readFile(jiqizhixinArticleFixtureUrl, 'utf8')
    const repository = new ArticleRepository(new MemoryArticleTable())
    const analyzedSources: string[] = []
    const service = new AiDailyService({
      fetch: async request => {
        if (request.url === 'https://aiera.com.cn/feed/') return response(aieraFeed, 'text')
        if (request.url === 'https://www.qbitai.com/feed/') return response(qbitFeed, 'text')
        if (request.url === jiqizhixinListUrl) return response(jiqizhixinList, 'text')
        if (request.url.startsWith('https://www.jiqizhixin.com/api/article_library/articles/')) {
          return response(jiqizhixinArticle, 'text')
        }
        if (new URL(request.url).hostname.endsWith('aiera.com.cn')) return response(aieraArticle, 'html')
        if (new URL(request.url).hostname.endsWith('qbitai.com')) return response(qbitArticle, 'html')
        throw new Error(`unexpected fetch: ${request.url}`)
      },
    }, {
      stream: () => { throw new Error('unexpected model stream') },
    }, repository, {
      aieraFeedUrl: 'https://aiera.com.cn/feed/',
      jiqizhixinApiUrl: jiqizhixinListUrl,
      qbitFeedUrl: 'https://www.qbitai.com/feed/',
      maxFeedItems: 10,
      maxArticleChars: 10_000,
      requestTimeoutMs: 5_000,
      modelProvider: 'test-provider',
      model: 'test-model',
      maxAnalysisTokens: 500,
      modelTimeoutMs: 5_000,
      maxArticlesPerRefresh: 6,
      timeZone: 'Asia/Shanghai',
    }, {
      analyze: async article => {
        analyzedSources.push(article.source)
        return {
          contentHash: article.contentHash,
          category: 'other',
          duplicateOfArticleIds: [],
          summary: `Summary for ${article.source}`,
          detailedSummary: `Detailed summary for ${article.source}`,
          importanceScore: 75,
          importanceReason: 'Test importance.',
          modelProvider: 'test-provider',
          model: 'test-model',
        }
      },
    }, () => new Date('2026-09-06T12:00:00.000Z'))

    await expect(service.refresh()).resolves.toMatchObject({
      discoveredCount: 6,
      existingCount: 0,
      processedCount: 2,
      failedCount: 0,
    })
    await expect(service.refresh(undefined, undefined, '2026-09-05')).resolves.toMatchObject({
      processedCount: 3,
      failedCount: 0,
      digest: { date: '2026-09-05' },
    })
    await expect(service.refresh(undefined, undefined, '2026-09-04')).resolves.toMatchObject({
      processedCount: 1,
      failedCount: 0,
      digest: { date: '2026-09-04' },
    })
    expect(new Set(analyzedSources)).toEqual(new Set(['aiera', 'jiqizhixin', 'qbitai']))
    expect(new Set(repository.list().map(article => article.source)))
      .toEqual(new Set(['aiera', 'jiqizhixin', 'qbitai']))
    expect(service.dailyDigest('2026-09-06').articles.map(article => article.source))
      .toEqual(['qbitai', 'jiqizhixin'])
    await service.close()
  })

  it('separates crawling, pending analysis, and failed-article retries', async () => {
    const xml = await readFile(feedFixtureUrl, 'utf8')
    const html = await readFile(articleFixtureUrl, 'utf8')
    const repository = new ArticleRepository(new MemoryArticleTable())
    let analysisCount = 0
    const service = new AiDailyService({
      fetch: async request => request.url === 'https://aiera.com.cn/feed/'
        ? response(xml, 'text')
        : response(html, 'html'),
    }, {
      stream: () => { throw new Error('unexpected model stream') },
    }, repository, {
      aieraFeedUrl: 'https://aiera.com.cn/feed/',
      maxFeedItems: 10,
      maxArticleChars: 10_000,
      requestTimeoutMs: 5_000,
      modelProvider: 'test-provider',
      model: 'test-model',
      maxAnalysisTokens: 500,
      modelTimeoutMs: 5_000,
      maxArticlesPerRefresh: 1,
      timeZone: 'UTC',
    }, {
      analyze: async article => {
        analysisCount++
        return {
          contentHash: article.contentHash,
          category: 'other',
          duplicateOfArticleIds: [],
          summary: `Summary ${analysisCount}`,
          detailedSummary: `Detailed summary ${analysisCount}`,
          importanceScore: 70,
          importanceReason: 'Queue operation test.',
          modelProvider: 'test-provider',
          model: 'test-model',
        }
      },
    }, () => new Date('2026-09-05T12:00:00.000Z'))

    await expect(service.crawl()).resolves.toEqual({ discoveredCount: 2, existingCount: 0 })
    expect(analysisCount).toBe(0)
    expect(repository.list().every(article => article.status === 'discovered')).toBe(true)

    const firstCurrent = service.listQueuedArticles('2026-09-05')[0]
    if (firstCurrent === undefined) throw new Error('current article was not discovered')
    await repository.markFailed(firstCurrent.id, 'Previous model failure')
    await repository.registerDiscovered([{
      source: 'aiera',
      url: 'https://aiera.com.cn/queue-one',
      canonicalUrl: 'https://aiera.com.cn/queue-one',
      title: 'Queue one',
      publishedAt: '2026-09-05T02:00:00.000Z',
    }, {
      source: 'aiera',
      url: 'https://aiera.com.cn/queue-two',
      canonicalUrl: 'https://aiera.com.cn/queue-two',
      title: 'Queue two',
      publishedAt: '2026-09-05T03:00:00.000Z',
    }], new Date('2026-09-05T04:00:00.000Z'))

    await expect(service.summarize('2026-09-05')).resolves.toMatchObject({
      processedCount: 2,
      failedCount: 0,
    })
    expect(analysisCount).toBe(2)
    expect(service.listQueuedArticles('2026-09-05')).toMatchObject([{
      id: firstCurrent.id,
      status: 'failed',
      error: 'Previous model failure',
    }])

    await expect(service.retryFailures('2026-09-05')).resolves.toMatchObject({
      processedCount: 1,
      failedCount: 0,
    })
    expect(analysisCount).toBe(3)
    expect(service.listQueuedArticles('2026-09-05')).toEqual([])
    await service.close()
  })

  it('continues with a healthy publisher when another source cannot be discovered', async () => {
    const aieraFeed = await readFile(feedFixtureUrl, 'utf8')
    const aieraArticle = await readFile(articleFixtureUrl, 'utf8')
    const repository = new ArticleRepository(new MemoryArticleTable())
    const logs: string[] = []
    const service = new AiDailyService({
      fetch: async request => {
        if (request.url === 'https://aiera.com.cn/feed/') return response(aieraFeed, 'text')
        if (request.url === 'https://www.qbitai.com/feed/') {
          return { ...response('', 'text'), statusCode: 403 }
        }
        return response(aieraArticle, 'html')
      },
    }, {
      stream: () => { throw new Error('unexpected model stream') },
    }, repository, {
      aieraFeedUrl: 'https://aiera.com.cn/feed/',
      qbitFeedUrl: 'https://www.qbitai.com/feed/',
      maxFeedItems: 10,
      maxArticleChars: 10_000,
      requestTimeoutMs: 5_000,
      modelProvider: 'test-provider',
      model: 'test-model',
      maxAnalysisTokens: 500,
      modelTimeoutMs: 5_000,
      maxArticlesPerRefresh: 1,
      timeZone: 'UTC',
    }, {
      analyze: async article => ({
        contentHash: article.contentHash,
        category: 'other',
        duplicateOfArticleIds: [],
        summary: 'Healthy source summary.',
        detailedSummary: 'Healthy source detailed summary.',
        importanceScore: 70,
        importanceReason: 'Test importance.',
        modelProvider: 'test-provider',
        model: 'test-model',
      }),
    }, () => new Date('2026-09-05T02:00:00.000Z'), {
      info: message => { logs.push(`info: ${message}`) },
      warn: message => { logs.push(`warn: ${String(message)}`) },
      error: message => { logs.push(`error: ${String(message)}`) },
    })

    await expect(service.refresh()).resolves.toMatchObject({
      discoveredCount: 2,
      processedCount: 1,
      failedCount: 0,
    })
    expect(logs).toContainEqual(expect.stringContaining('source discovery failed source=qbitai'))
    expect(repository.list().every(article => article.source === 'aiera')).toBe(true)
    await service.close()
  })

  it('discovers, analyzes, persists, and ranks articles without reprocessing them', async () => {
    const xml = await readFile(feedFixtureUrl, 'utf8')
    const html = await readFile(articleFixtureUrl, 'utf8')
    const responses = [
      response(xml, 'text'),
      response(html, 'html'),
      response(xml, 'text'),
      response(html, 'html'),
      response(xml, 'text'),
    ]
    let analysisCount = 0
    let rejectAnalysis = false
    let service: AiDailyService
    const observedProgress: unknown[] = []
    const analyzer: ArticleAnalysisEngine = {
      analyze: async (article) => {
        observedProgress.push(service.operationProgress())
        if (rejectAnalysis) throw new Error('replacement analysis failed')
        analysisCount++
        return {
          contentHash: article.contentHash,
          category: 'other',
          duplicateOfArticleIds: [],
          summary: `Summary ${analysisCount}`,
          detailedSummary: `Detailed summary ${analysisCount}`,
          importanceScore: 90 - analysisCount,
          importanceReason: 'Test importance.',
          modelProvider: 'test-provider',
          model: 'test-model',
        }
      },
    }
    const repository = new ArticleRepository(new MemoryArticleTable())
    service = new AiDailyService({
      fetch: async () => {
        const next = responses.shift()
        if (next === undefined) throw new Error('unexpected fetch')
        return next
      },
    }, {
      stream: () => { throw new Error('unexpected model stream') },
    }, repository, {
      aieraFeedUrl: 'https://aiera.com.cn/feed/',
      maxFeedItems: 10,
      maxArticleChars: 10_000,
      requestTimeoutMs: 5_000,
      modelProvider: 'test-provider',
      model: 'test-model',
      maxAnalysisTokens: 500,
      modelTimeoutMs: 5_000,
      maxArticlesPerRefresh: 1,
      timeZone: 'Asia/Shanghai',
    }, analyzer, () => new Date('2026-09-05T02:00:00.000Z'))

    const first = await service.refresh()
    expect(first).toMatchObject({
      discoveredCount: 2,
      existingCount: 0,
      processedCount: 1,
      failedCount: 0,
    })
    expect(first.digest.articles).toHaveLength(1)
    expect(observedProgress[0]).toMatchObject({
      phase: 'analyzing',
      completedArticles: 0,
      totalArticles: 1,
      currentArticleIndex: 1,
      currentArticleTitle: 'First research story',
    })
    expect(service.operationProgress()).toBeUndefined()

    const second = await service.refresh(undefined, undefined, '2026-09-04')
    expect(second).toMatchObject({
      discoveredCount: 0,
      existingCount: 2,
      processedCount: 1,
      failedCount: 0,
    })
    expect(second.digest.date).toBe('2026-09-04')
    expect(analysisCount).toBe(2)
    expect(repository.list().filter(article => article.status === 'processed')).toHaveLength(2)
    expect(service.listProcessedArticles('2026-09-05')).toHaveLength(1)
    expect(service.listProcessedArticles('2026-09-04')).toHaveLength(1)

    const third = await service.refresh()
    expect(third).toMatchObject({
      discoveredCount: 0,
      existingCount: 2,
      processedCount: 0,
      failedCount: 0,
    })
    expect(analysisCount).toBe(2)

    const firstArticleId = first.digest.articles[0]?.id
    if (firstArticleId === undefined) throw new Error('first analyzed article was not returned')
    responses.push(response(html, 'html'))
    await expect(service.reanalyze(firstArticleId)).resolves.toMatchObject({
      id: firstArticleId,
      status: 'processed',
      summary: 'Summary 3',
    })
    expect(analysisCount).toBe(3)

    rejectAnalysis = true
    responses.push(response(html, 'html'))
    await expect(service.reanalyze(firstArticleId)).rejects.toThrow('replacement analysis failed')
    expect(repository.get(firstArticleId)).toMatchObject({
      status: 'processed',
      summary: 'Summary 3',
    })
    await service.close()
  })

  it('applies live source settings to discovery and pending work', async () => {
    const xml = await readFile(feedFixtureUrl, 'utf8')
    const html = await readFile(articleFixtureUrl, 'utf8')
    const repository = new ArticleRepository(new MemoryArticleTable())
    let fetchCount = 0
    let analysisCount = 0
    const service = new AiDailyService({
      fetch: async request => {
        fetchCount++
        return request.url.endsWith('/feed/') ? response(xml, 'text') : response(html, 'html')
      },
    }, {
      stream: () => { throw new Error('unexpected model stream') },
    }, repository, {
      aieraFeedUrl: 'https://aiera.com.cn/feed/',
      maxFeedItems: 10,
      maxArticleChars: 10_000,
      requestTimeoutMs: 5_000,
      modelProvider: 'test-provider',
      model: 'test-model',
      maxAnalysisTokens: 500,
      modelTimeoutMs: 5_000,
      maxArticlesPerRefresh: 1,
      timeZone: 'UTC',
      sourceSettings: { aiera: false, jiqizhixin: false, qbitai: false },
    }, {
      analyze: async article => {
        analysisCount++
        return {
          contentHash: article.contentHash,
          category: 'other',
          duplicateOfArticleIds: [],
          summary: 'Enabled-source summary.',
          detailedSummary: 'Enabled-source detailed summary.',
          importanceScore: 70,
          importanceReason: 'Test importance.',
          modelProvider: 'test-provider',
          model: 'test-model',
        }
      },
    }, () => new Date('2026-09-05T02:00:00.000Z'))

    await expect(service.refresh()).resolves.toMatchObject({
      discoveredCount: 0,
      processedCount: 0,
      failedCount: 0,
    })
    expect(fetchCount).toBe(0)

    service.setSettings({
      aiera: true,
      jiqizhixin: false,
      qbitai: false,
      modelProvider: 'test-provider',
      model: 'test-model',
    })
    await expect(service.refresh()).resolves.toMatchObject({
      discoveredCount: 2,
      processedCount: 1,
      failedCount: 0,
    })
    expect(analysisCount).toBe(1)
    expect(service.listQueuedArticles()).toHaveLength(0)
    expect(service.listQueuedArticles('2026-09-04')).toHaveLength(1)

    service.setSettings({
      aiera: false,
      jiqizhixin: false,
      qbitai: false,
      modelProvider: 'test-provider',
      model: 'test-model',
    })
    expect(service.listQueuedArticles()).toHaveLength(0)
    service.setSettings({
      aiera: true,
      jiqizhixin: false,
      qbitai: true,
      modelProvider: 'news-provider',
      model: 'news-model',
      reasoningEffort: 'high',
    })
    expect(service.getSourceSettings()).toEqual({ aiera: true, jiqizhixin: false, qbitai: true })
    await service.close()
  })

  it('does not retry failures during refresh and retries them only when explicitly requested', async () => {
    const xml = await readFile(feedFixtureUrl, 'utf8')
    const html = await readFile(articleFixtureUrl, 'utf8')
    const responses = [
      response(xml, 'text'),
      response(html, 'html'),
      response(xml, 'text'),
      response(html, 'html'),
    ]
    const repository = new ArticleRepository(new MemoryArticleTable())
    const logs: string[] = []
    let analysisAttempts = 0
    let rejectAnalysis = true
    const service = new AiDailyService({
      fetch: async () => {
        const next = responses.shift()
        if (next === undefined) throw new Error('unexpected fetch')
        return next
      },
    }, {
      stream: () => { throw new Error('unexpected model stream') },
    }, repository, {
      aieraFeedUrl: 'https://aiera.com.cn/feed/',
      maxFeedItems: 10,
      maxArticleChars: 10_000,
      requestTimeoutMs: 5_000,
      modelProvider: 'test-provider',
      model: 'test-model',
      maxAnalysisTokens: 500,
      modelTimeoutMs: 5_000,
      maxArticlesPerRefresh: 1,
      timeZone: 'UTC',
    }, {
      analyze: async article => {
        analysisAttempts++
        if (rejectAnalysis) throw new Error('model rejected article')
        return {
          contentHash: article.contentHash,
          category: 'other',
          duplicateOfArticleIds: [],
          summary: 'Recovered summary.',
          detailedSummary: 'Recovered detailed summary.',
          importanceScore: 72,
          importanceReason: 'Recovered after an explicit retry.',
          modelProvider: 'test-provider',
          model: 'test-model',
        }
      },
    }, () => new Date('2026-09-05T02:00:00.000Z'), {
      info: message => { logs.push(`info: ${message}`) },
      warn: message => { logs.push(`warn: ${String(message)}`) },
      error: message => { logs.push(`error: ${String(message)}`) },
    })

    await expect(service.refresh()).resolves.toMatchObject({
      processedCount: 0,
      failedCount: 1,
      failures: [{ error: 'model rejected article' }],
    })
    expect(repository.list()[0]).toMatchObject({
      status: 'failed',
      error: 'model rejected article',
    })
    const failedId = repository.list()[0]?.id
    if (failedId === undefined) throw new Error('failed article was not stored')
    await expect(service.refresh()).resolves.toMatchObject({
      processedCount: 0,
      failedCount: 0,
    })
    expect(analysisAttempts).toBe(1)

    rejectAnalysis = false
    await expect(service.retryFailures()).resolves.toMatchObject({
      processedCount: 1,
      failedCount: 0,
    })
    expect(repository.get(failedId)).toMatchObject({ status: 'processed', summary: 'Recovered summary.' })
    expect(analysisAttempts).toBe(2)
    expect(logs).toContainEqual(expect.stringContaining('title="First research story"'))
    expect(logs).toContainEqual(expect.stringContaining('model rejected article'))
    expect(logs).toContainEqual(expect.stringContaining('refresh for 2026-09-05 completed with 0 processed, 1 failed'))
    await service.close()
  })

  it('keeps failed articles durable and scopes queue views by date', async () => {
    const repository = new ArticleRepository(new MemoryArticleTable())
    const registration = await repository.registerDiscovered([{
      source: 'aiera',
      url: 'https://aiera.com.cn/current-failure',
      canonicalUrl: 'https://aiera.com.cn/current-failure',
      title: 'Current failure',
      publishedAt: '2026-09-05T01:00:00.000Z',
    }, {
      source: 'aiera',
      url: 'https://aiera.com.cn/expired-failure',
      canonicalUrl: 'https://aiera.com.cn/expired-failure',
      title: 'Expired failure',
      publishedAt: '2026-09-04T01:00:00.000Z',
    }], new Date('2026-09-05T02:00:00.000Z'))
    for (const article of registration.added) await repository.markFailed(article.id, 'Test failure')
    const service = new AiDailyService({
      fetch: async () => { throw new Error('unexpected fetch') },
    }, {
      stream: () => { throw new Error('unexpected model stream') },
    }, repository, {
      aieraFeedUrl: 'https://aiera.com.cn/feed/',
      maxFeedItems: 10,
      maxArticleChars: 10_000,
      requestTimeoutMs: 5_000,
      modelProvider: 'test-provider',
      model: 'test-model',
      maxAnalysisTokens: 500,
      modelTimeoutMs: 5_000,
      maxArticlesPerRefresh: 1,
      timeZone: 'UTC',
    }, undefined, () => new Date('2026-09-05T12:00:00.000Z'))

    expect(service.listQueuedArticles().map(article => article.title)).toEqual(['Current failure'])
    expect(service.listQueuedArticles('2026-09-04').map(article => article.title)).toEqual(['Expired failure'])
    expect(service.listQueuedArticles('2026-09-04')[0]?.status).toBe('failed')
    expect(repository.list().map(article => article.title).sort()).toEqual(['Current failure', 'Expired failure'])
    await service.close()
  })

  it('serializes articles within a bulk failed-article retry', async () => {
    const html = await readFile(articleFixtureUrl, 'utf8')
    const repository = new ArticleRepository(new MemoryArticleTable())
    const registration = await repository.registerDiscovered([{
      source: 'aiera',
      url: 'https://aiera.com.cn/retry-one',
      canonicalUrl: 'https://aiera.com.cn/retry-one',
      title: 'Retry one',
      publishedAt: '2026-09-05T01:00:00.000Z',
    }, {
      source: 'aiera',
      url: 'https://aiera.com.cn/retry-two',
      canonicalUrl: 'https://aiera.com.cn/retry-two',
      title: 'Retry two',
      publishedAt: '2026-09-05T01:30:00.000Z',
    }], new Date('2026-09-05T02:00:00.000Z'))
    for (const article of registration.added) await repository.markFailed(article.id, 'Retry me')
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let attempts = 0
    const service = new AiDailyService({
      fetch: async () => response(html, 'html'),
    }, {
      stream: () => { throw new Error('unexpected model stream') },
    }, repository, {
      aieraFeedUrl: 'https://aiera.com.cn/feed/',
      maxFeedItems: 10,
      maxArticleChars: 10_000,
      requestTimeoutMs: 5_000,
      modelProvider: 'test-provider',
      model: 'test-model',
      maxAnalysisTokens: 500,
      modelTimeoutMs: 5_000,
      maxArticlesPerRefresh: 2,
      timeZone: 'UTC',
    }, {
      analyze: async article => {
        attempts++
        if (attempts === 1) await firstGate
        return {
          contentHash: article.contentHash,
          category: 'other',
          duplicateOfArticleIds: [],
          summary: `Retry ${attempts}`,
          detailedSummary: `Retry detail ${attempts}`,
          importanceScore: 70,
          importanceReason: 'Explicit retry.',
          modelProvider: 'test-provider',
          model: 'test-model',
        }
      },
    }, () => new Date('2026-09-05T12:00:00.000Z'))
    const retry = service.retryFailures('2026-09-05')
    await vi.waitFor(() => { expect(attempts).toBe(1) })
    releaseFirst()
    await expect(retry).resolves.toMatchObject({ processedCount: 2, failedCount: 0 })

    expect(attempts).toBe(2)
    expect(repository.list().every(article => article.status === 'processed')).toBe(true)
    await service.close()
  })

  it('attaches all same-day other-publisher news and stores duplicates outside the digest', async () => {
    const xml = await readFile(feedFixtureUrl, 'utf8')
    const html = await readFile(articleFixtureUrl, 'utf8')
    const responses = [response(xml, 'text'), response(html, 'html')]
    const repository = new ArticleRepository(new MemoryArticleTable())
    const peerRegistration = await repository.registerDiscovered([{
      source: 'qbitai',
      url: 'https://www.qbitai.com/canonical',
      canonicalUrl: 'https://www.qbitai.com/canonical',
      title: 'Canonical report',
      publishedAt: '2026-09-05T01:00:00.000Z',
      excerpt: 'A short publisher-provided summary.',
    }], new Date('2026-09-05T01:10:00.000Z'))
    const peerId = peerRegistration.added[0]?.id
    if (peerId === undefined) throw new Error('peer article was not registered')
    await repository.markProcessed(peerId, {
      contentHash: 'c'.repeat(64),
      category: 'major-companies',
      duplicateOfArticleIds: [],
      summary: 'Canonical analyzed summary.',
      detailedSummary: 'Canonical detailed summary.',
      importanceScore: 80,
      importanceReason: 'Canonical coverage.',
      modelProvider: 'test-provider',
      model: 'test-model',
    }, new Date('2026-09-05T01:20:00.000Z'))

    let observedPeerNews: readonly import('../src/types.js').PeerNewsContext[] = []
    const service = new AiDailyService({
      fetch: async () => {
        const next = responses.shift()
        if (next === undefined) throw new Error('unexpected fetch')
        return next
      },
    }, {
      stream: () => { throw new Error('unexpected model stream') },
    }, repository, {
      aieraFeedUrl: 'https://aiera.com.cn/feed/',
      maxFeedItems: 10,
      maxArticleChars: 10_000,
      requestTimeoutMs: 5_000,
      modelProvider: 'test-provider',
      model: 'test-model',
      maxAnalysisTokens: 500,
      modelTimeoutMs: 5_000,
      maxArticlesPerRefresh: 1,
      timeZone: 'UTC',
    }, {
      analyze: async (article, peerNews) => {
        observedPeerNews = peerNews
        return {
          contentHash: article.contentHash,
          duplicateOfArticleIds: [peerId],
          modelProvider: 'test-provider',
          model: 'test-model',
        }
      },
    }, () => new Date('2026-09-05T02:00:00.000Z'))

    await expect(service.refresh()).resolves.toMatchObject({ processedCount: 1, failedCount: 0 })
    expect(observedPeerNews).toEqual([expect.objectContaining({
      id: peerId,
      title: 'Canonical report',
      summary: 'Canonical analyzed summary.',
      canBeDuplicateTarget: true,
    })])
    const duplicate = repository.list().find(article => article.source === 'aiera' && article.status === 'processed')
    expect(duplicate).toMatchObject({ duplicateOfArticleIds: [peerId] })
    expect(duplicate).not.toHaveProperty('summary')
    expect(duplicate).not.toHaveProperty('importanceScore')
    expect(service.dailyDigest('2026-09-05').articles.map(article => article.id)).toEqual([peerId])
    await service.close()
  })
})

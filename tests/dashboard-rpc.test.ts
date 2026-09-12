import { Context } from '@deepseek-ai/cordis'
import type {
  ConnectionFetchRoute,
  ConnectionRpcResult,
  ServerResponse,
} from '@deepseek-ai/dsh-client-connection'
import { describe, expect, it, vi } from 'vitest'
import {
  aiDailyRpcMethod,
  aiDailyRpcPath,
  type AiDailyRpcEndpoint,
} from '../src/dashboard/protocol.js'
import { registerDashboardRpc } from '../src/dashboard/rpc.js'
import type { AiDailyService } from '../src/service.js'
import type { ArticleId, ArticleRecord, DailyDigest } from '../src/types.js'

const articleId = 'a'.repeat(64) as ArticleId
const record: ArticleRecord = {
  id: articleId,
  source: 'aiera',
  url: 'https://aiera.com.cn/article/1',
  canonicalUrl: 'https://aiera.com.cn/article/1',
  title: 'A processed article',
  publishedAt: '2026-09-06T01:00:00.000Z',
  discoveredAt: '2026-09-06T01:10:00.000Z',
  lastSeenAt: '2026-09-06T01:10:00.000Z',
  status: 'processed',
  processedAt: '2026-09-06T01:20:00.000Z',
  contentHash: 'b'.repeat(64),
  category: 'latest-papers',
  summary: 'Short summary.',
  detailedSummary: 'Detailed summary.',
  importanceScore: 88,
  importanceReason: 'Important research impact.',
  modelProvider: 'test-provider',
  model: 'test-model',
}
const pendingRecord: ArticleRecord = {
  id: 'b'.repeat(64) as ArticleId,
  source: 'qbitai',
  url: 'https://www.qbitai.com/article/pending',
  canonicalUrl: 'https://www.qbitai.com/article/pending',
  title: 'A pending article',
  excerpt: 'Feed metadata.',
  publishedAt: '2026-09-06T01:30:00.000Z',
  discoveredAt: '2026-09-06T01:40:00.000Z',
  lastSeenAt: '2026-09-06T01:40:00.000Z',
  status: 'discovered',
}
const failedRecord: ArticleRecord = {
  id: 'c'.repeat(64) as ArticleId,
  source: 'aiera',
  url: 'https://aiera.com.cn/article/failed',
  canonicalUrl: 'https://aiera.com.cn/article/failed',
  title: 'A failed article',
  discoveredAt: '2026-09-06T01:10:00.000Z',
  lastSeenAt: '2026-09-06T01:10:00.000Z',
  status: 'failed',
  error: 'Model route was unavailable.',
}

function digest(date = '2026-09-06'): DailyDigest {
  return {
    date,
    generatedAt: '2026-09-06T02:00:00.000Z',
    timeZone: 'Asia/Shanghai',
    articles: [{
      id: articleId,
      source: 'aiera',
      title: record.title,
      url: record.canonicalUrl,
      publishedAt: record.publishedAt,
      category: record.category ?? 'other',
      summary: record.summary as string,
      importanceScore: record.importanceScore as number,
      importanceReason: record.importanceReason as string,
    }],
  }
}

function install(service: AiDailyService) {
  const ctx = new Context()
  const routes = new Map<string, ConnectionFetchRoute['fetch']>()
  ctx.provide('connection', {
    fetch: {
      register: (route: ConnectionFetchRoute) => {
        expect(route.methods).toEqual(['POST'])
        expect(route.requestBody).toBe('buffered')
        routes.set(route.path, route.fetch)
        return async () => {
          routes.delete(route.path)
        }
      },
    },
  } as never)
  return {
    ctx,
    handler: async () => {
      const fiber = await ctx.plugin({
        inject: ['connection'],
        apply: pluginContext => { registerDashboardRpc(pluginContext, service) },
      })
      return {
        fiber,
        handler: async (
          endpoint: AiDailyRpcEndpoint,
          payload: unknown,
          signal: AbortSignal,
        ): Promise<ConnectionRpcResult<unknown>> => {
          const path = aiDailyRpcPath(endpoint)
          const route = routes.get(path)
          if (route === undefined) throw new Error(`Dashboard route was not registered: ${path}`)
          const response = await route(new Request(`http://localhost${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              type: 'client-request',
              rpcId: `test-${endpoint}`,
              method: aiDailyRpcMethod(endpoint),
              payload,
            }),
            signal,
          }))
          expect(response.status).toBe(200)
          const envelope = await response.json() as ServerResponse
          expect(envelope).toMatchObject({
            type: 'server-response',
            rpcId: `test-${endpoint}`,
          })
          return envelope.result
        },
      }
    },
  }
}

describe('AI Daily dashboard RPC', () => {
  it('exposes the durable queue and separate crawl and analysis operations', async () => {
    const crawl = vi.fn(async () => ({ discoveredCount: 2, existingCount: 1 }))
    const summarize = vi.fn(async () => ({
      processedCount: 1,
      failedCount: 0,
      failures: [],
      digest: digest(),
    }))
    const retryFailures = vi.fn(async () => ({
      processedCount: 1,
      failedCount: 0,
      failures: [],
      digest: digest(),
    }))
    const reanalyze = vi.fn(async () => record)
    const listProcessedArticles = vi.fn(() => [record])
    const listQueuedArticles = vi.fn((date?: string) => date === undefined || date === '2026-09-06'
      ? [pendingRecord, failedRecord]
      : [])
    const service = {
      dailyDigest: (date?: string) => digest(date),
      listProcessedArticles,
      listQueuedArticles,
      operationProgress: () => ({
        operation: 'summarize' as const,
        phase: 'analyzing' as const,
        startedAt: '2026-09-06T02:00:00.000Z',
        completedArticles: 0,
        totalArticles: 1,
        currentArticleId: pendingRecord.id,
        currentArticleIndex: 1,
        currentArticleTitle: pendingRecord.title,
      }),
      getArticle: (id: ArticleId) => id === articleId ? record : undefined,
      crawl,
      summarize,
      retryFailures,
      reanalyze,
      getSourceSettings: () => ({ aiera: true, jiqizhixin: true, qbitai: true }),
    } as unknown as AiDailyService
    const installed = install(service)
    const { fiber, handler } = await installed.handler()
    const signal = new AbortController().signal

    await expect(handler('snapshot', { date: '2026-09-06', limit: 10 }, signal)).resolves.toMatchObject({
      ok: true,
      value: {
        totalProcessed: 1,
        totalQueued: 2,
        totalFailed: 1,
        sourceSettings: { aiera: true, jiqizhixin: true, qbitai: true },
        articles: [{ id: articleId, title: record.title }],
        queue: [
          { id: pendingRecord.id, status: 'pending', excerpt: pendingRecord.excerpt },
          { id: failedRecord.id, status: 'failed', error: failedRecord.error },
        ],
      },
    })
    expect(listProcessedArticles).toHaveBeenCalledWith('2026-09-06')
    expect(listQueuedArticles).toHaveBeenCalledWith('2026-09-06')

    await expect(handler('operation-status', { date: '2026-09-06' }, signal)).resolves.toMatchObject({
      ok: true,
      value: {
        progress: {
          operation: 'summarize',
          phase: 'analyzing',
          currentArticleId: pendingRecord.id,
        },
        snapshot: { totalQueued: 2, totalFailed: 1 },
      },
    })
    await expect(handler('crawl', { date: '2026-09-06', limit: 10 }, signal)).resolves.toMatchObject({
      ok: true,
      value: { crawl: { discoveredCount: 2 }, snapshot: { totalQueued: 2 } },
    })
    expect(crawl).toHaveBeenCalledWith(expect.any(AbortSignal))
    await expect(handler('summarize', { date: '2026-09-06', limit: 10 }, signal)).resolves.toMatchObject({
      ok: true,
      value: { analysis: { processedCount: 1 }, snapshot: { totalQueued: 2 } },
    })
    expect(summarize).toHaveBeenCalledWith('2026-09-06', expect.any(AbortSignal))
    await expect(handler('retry-failures', { date: '2026-09-06', limit: 10 }, signal)).resolves.toMatchObject({
      ok: true,
      value: { analysis: { processedCount: 1 }, snapshot: { totalFailed: 1 } },
    })
    expect(retryFailures).toHaveBeenCalledWith('2026-09-06', expect.any(AbortSignal))

    await expect(handler('article', { id: articleId }, signal)).resolves.toMatchObject({
      ok: true,
      value: { detailedSummary: 'Detailed summary.', category: 'latest-papers' },
    })
    const articleResponse = await handler('article', { id: articleId }, signal)
    expect((articleResponse as { value?: object }).value).not.toHaveProperty('keyPoints')
    await expect(handler('reanalyze', { id: articleId, limit: 10 }, signal)).resolves.toMatchObject({
      ok: true,
      value: { totalProcessed: 1 },
    })
    expect(reanalyze).toHaveBeenCalledWith(articleId, expect.any(AbortSignal))

    await fiber.dispose()
    await installed.ctx.fiber.dispose()
  })

  it('rejects malformed and unavailable article requests', async () => {
    const service = {
      dailyDigest: () => digest(),
      listProcessedArticles: () => [],
      listQueuedArticles: () => [],
      operationProgress: () => undefined,
      getArticle: () => undefined,
      getSourceSettings: () => ({ aiera: true, jiqizhixin: true, qbitai: true }),
    } as unknown as AiDailyService
    const installed = install(service)
    const { fiber, handler } = await installed.handler()
    const signal = new AbortController().signal

    await expect(handler('snapshot', { limit: 0 }, signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'ai-daily/invalid-request' },
    })
    await expect(handler('article', { id: 'b'.repeat(64) }, signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'ai-daily/not-found' },
    })

    await fiber.dispose()
    await installed.ctx.fiber.dispose()
  })

  it('hides legacy analysis for duplicates and links the earliest primary report', async () => {
    const earliest = {
      ...record,
      id: 'd'.repeat(64) as ArticleId,
      title: 'Earliest primary report',
      publishedAt: '2026-09-06T00:10:00.000Z',
    }
    const later = {
      ...record,
      id: 'e'.repeat(64) as ArticleId,
      title: 'Later primary report',
      publishedAt: '2026-09-06T00:20:00.000Z',
    }
    const duplicate = {
      ...record,
      id: 'f'.repeat(64) as ArticleId,
      title: 'Duplicate report',
      duplicateOfArticleIds: [later.id, earliest.id],
      summary: 'Legacy summary that must not reach the dashboard.',
      detailedSummary: 'Legacy details that must not reach the dashboard.',
      importanceScore: 99,
      importanceReason: 'Legacy rationale that must not reach the dashboard.',
    }
    const records = new Map([earliest, later, duplicate].map(article => [article.id, article]))
    const service = {
      dailyDigest: () => digest(),
      listProcessedArticles: () => [duplicate],
      listQueuedArticles: () => [],
      operationProgress: () => undefined,
      getArticle: (id: ArticleId) => records.get(id),
      getSourceSettings: () => ({ aiera: true, jiqizhixin: true, qbitai: true }),
    } as unknown as AiDailyService
    const installed = install(service)
    const { fiber, handler } = await installed.handler()
    const signal = new AbortController().signal

    const snapshotResponse = await handler('snapshot', { date: '2026-09-06' }, signal)
    expect(snapshotResponse).toMatchObject({
      ok: true,
      value: {
        articles: [{
          id: duplicate.id,
          duplicateOfCount: 2,
          duplicateTarget: { id: earliest.id, title: earliest.title },
        }],
      },
    })
    const snapshotArticle = (snapshotResponse as { value: { articles: object[] } }).value.articles[0]
    expect(snapshotArticle).not.toHaveProperty('category')
    expect(snapshotArticle).not.toHaveProperty('summary')
    expect(snapshotArticle).not.toHaveProperty('importanceScore')

    const detailResponse = await handler('article', { id: duplicate.id }, signal)
    expect(detailResponse).toMatchObject({
      ok: true,
      value: {
        duplicateOfCount: 2,
        duplicateTarget: { id: earliest.id, title: earliest.title },
      },
    })
    const detail = (detailResponse as { value: object }).value
    expect(detail).not.toHaveProperty('detailedSummary')
    expect(detail).not.toHaveProperty('importanceReason')

    await fiber.dispose()
    await installed.ctx.fiber.dispose()
  })
})

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { z } from 'zod'
import { parseCalendarDate } from '../digest.js'
import type { AiDailyService } from '../service.js'
import type { ArticleId, ArticleRecord } from '../types.js'
import type {
  DashboardArticleDetail,
  DashboardArticleItem,
  DashboardAnalysisResult,
  DashboardCrawlResult,
  DashboardQueueItem,
  DashboardOperationStatus,
  DashboardSnapshot,
} from './types.js'

/** Authenticated Connection channel owned by the AI Daily dashboard. */
export const AI_DAILY_RPC_CHANNEL = '/ai-daily'

const MAX_PAGE_SIZE = 100
const DEFAULT_PAGE_SIZE = 50
const ARTICLE_ID_PATTERN = /^[a-f0-9]{64}$/

const snapshotRequestSchema = z.object({
  date: z.string().optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
}).strict()

const articleRequestSchema = z.object({
  id: z.string().regex(ARTICLE_ID_PATTERN),
}).strict()

const reanalyzeRequestSchema = snapshotRequestSchema.extend({
  id: z.string().regex(ARTICLE_ID_PATTERN),
}).strict()

function earliestDuplicateTarget(
  service: AiDailyService,
  record: ArticleRecord,
): DashboardArticleItem['duplicateTarget'] {
  return (record.duplicateOfArticleIds ?? [])
    .map(id => service.getArticle(id))
    .filter((candidate): candidate is ArticleRecord => candidate?.status === 'processed')
    .sort((left, right) => (
      (left.publishedAt ?? left.discoveredAt).localeCompare(right.publishedAt ?? right.discoveredAt)
      || left.id.localeCompare(right.id)
    ))
    .map(candidate => ({ id: candidate.id, title: candidate.title }))[0]
}

function dashboardItem(service: AiDailyService, record: ArticleRecord): DashboardArticleItem {
  if (
    record.status !== 'processed'
    || record.processedAt === undefined
  ) {
    throw new Error(`ai-daily: article '${record.id}' is not a complete processed record`)
  }
  const common = {
    id: record.id,
    source: record.source,
    title: record.title,
    url: record.canonicalUrl,
    ...(record.publishedAt === undefined ? {} : { publishedAt: record.publishedAt }),
    duplicateOfCount: record.duplicateOfArticleIds?.length ?? 0,
    processedAt: record.processedAt,
  }
  if (common.duplicateOfCount > 0) {
    const duplicateTarget = earliestDuplicateTarget(service, record)
    return {
      ...common,
      ...(duplicateTarget === undefined ? {} : { duplicateTarget }),
    }
  }
  if (record.summary === undefined || record.importanceScore === undefined) {
    throw new Error(`ai-daily: article '${record.id}' is not a complete non-duplicate record`)
  }
  return {
    ...common,
    category: record.category ?? 'other',
    summary: record.summary,
    importanceScore: record.importanceScore,
  }
}

function dashboardDetail(service: AiDailyService, record: ArticleRecord): DashboardArticleDetail {
  if (
    record.status !== 'processed'
    || record.modelProvider === undefined
    || record.model === undefined
  ) {
    throw new Error(`ai-daily: article '${record.id}' is not a complete processed record`)
  }
  const item = dashboardItem(service, record)
  if (item.duplicateOfCount > 0) {
    return {
      ...item,
      ...(record.author === undefined ? {} : { author: record.author }),
      modelProvider: record.modelProvider,
      model: record.model,
    }
  }
  if (record.detailedSummary === undefined || record.importanceReason === undefined) {
    throw new Error(`ai-daily: article '${record.id}' is not a complete non-duplicate record`)
  }
  return {
    ...item,
    ...(record.author === undefined ? {} : { author: record.author }),
    detailedSummary: record.detailedSummary,
    importanceReason: record.importanceReason,
    modelProvider: record.modelProvider,
    model: record.model,
  }
}

function dashboardQueueItem(record: ArticleRecord): DashboardQueueItem {
  const common = {
    id: record.id,
    source: record.source,
    title: record.title,
    url: record.canonicalUrl,
    ...(record.publishedAt === undefined ? {} : { publishedAt: record.publishedAt }),
    ...(record.excerpt === undefined ? {} : { excerpt: record.excerpt }),
  }
  if (record.status === 'discovered') return { ...common, status: 'pending' }
  if (record.status === 'failed' && record.error !== undefined) {
    return { ...common, status: 'failed', error: record.error }
  }
  throw new Error(`ai-daily: article '${record.id}' is not a queue record`)
}

function snapshot(
  service: AiDailyService,
  request: z.infer<typeof snapshotRequestSchema>,
): DashboardSnapshot {
  const date = request.date === undefined ? undefined : parseCalendarDate(request.date)
  const offset = request.offset ?? 0
  const limit = request.limit ?? DEFAULT_PAGE_SIZE
  const processed = service.listProcessedArticles(date)
  const queue = service.listQueuedArticles(date)
  const currentDigest = service.dailyDigest()
  return {
    currentDate: currentDigest.date,
    digest: date === undefined || date === currentDigest.date
      ? currentDigest
      : service.dailyDigest(date),
    sourceSettings: service.getSourceSettings(),
    articles: processed.slice(offset, offset + limit).map(record => dashboardItem(service, record)),
    totalProcessed: processed.length,
    queue: queue.map(dashboardQueueItem),
    totalQueued: queue.length,
    totalFailed: queue.filter(record => record.status === 'failed').length,
  }
}

function failure(error: unknown): {
  readonly ok: false
  readonly error: { readonly code: string; readonly message: string; readonly details: object }
} {
  if (error instanceof z.ZodError || error instanceof TypeError || error instanceof RangeError) {
    return {
      ok: false,
      error: { code: 'ai-daily/invalid-request', message: error.message, details: {} },
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return {
    ok: false,
    error: { code: 'ai-daily/internal', message: message || 'AI Daily request failed', details: {} },
  }
}

/** Register the authenticated dashboard RPC endpoints on the DSH Connection. */
export function registerDashboardRpc(
  ctx: Context,
  service: AiDailyService,
): void {
  ctx.effect(
    () => ctx.connection.rpc.handle(AI_DAILY_RPC_CHANNEL, async (endpoint, payload, signal) => {
      try {
        if (endpoint === 'snapshot') {
          const request = snapshotRequestSchema.parse(payload)
          return { ok: true, value: snapshot(service, request) }
        }
        if (endpoint === 'crawl') {
          const request = snapshotRequestSchema.parse(payload)
          const crawl = await service.crawl(signal)
          const value: DashboardCrawlResult = {
            crawl,
            snapshot: snapshot(service, request),
          }
          return { ok: true, value }
        }
        if (endpoint === 'summarize' || endpoint === 'retry-failures') {
          const request = snapshotRequestSchema.parse(payload)
          const date = request.date === undefined ? undefined : parseCalendarDate(request.date)
          const result = endpoint === 'summarize'
            ? await service.summarize(date, signal)
            : await service.retryFailures(date, signal)
          const { digest: _digest, ...analysis } = result
          const value: DashboardAnalysisResult = {
            analysis,
            snapshot: snapshot(service, { ...request, ...(date === undefined ? {} : { date }) }),
          }
          return { ok: true, value }
        }
        if (endpoint === 'operation-status') {
          const request = snapshotRequestSchema.parse(payload)
          const value: DashboardOperationStatus = {
            progress: service.operationProgress() ?? null,
            snapshot: snapshot(service, request),
          }
          return { ok: true, value }
        }
        if (endpoint === 'reanalyze') {
          const request = reanalyzeRequestSchema.parse(payload)
          await service.reanalyze(request.id as ArticleId, signal)
          return { ok: true, value: snapshot(service, request) }
        }
        if (endpoint === 'article') {
          const request = articleRequestSchema.parse(payload)
          const article = service.getArticle(request.id as ArticleId)
          if (article === undefined || article.status !== 'processed') {
            return {
              ok: false,
              error: {
                code: 'ai-daily/not-found',
                message: 'Processed article was not found',
                details: {},
              },
            }
          }
          return { ok: true, value: dashboardDetail(service, article) }
        }
        return {
          ok: false,
          error: { code: 'ai-daily/not-found', message: 'Dashboard endpoint was not found', details: {} },
        }
      } catch (error) {
        return failure(error)
      }
    }),
    'ai-daily: dashboard RPC',
  )
}

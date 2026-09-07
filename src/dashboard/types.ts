import type {
  ArticleId,
  ArticleCategory,
  ArticleSource,
  DailyAnalysisResult,
  DailyCrawlResult,
  DailyDigest,
  DailyOperationProgress,
} from '../types.js'
import type { AiDailySourceSettings } from '../settings.js'

/** Earliest processed primary article referenced by a duplicate record. */
export interface DashboardDuplicateTarget {
  readonly id: ArticleId
  readonly title: string
}

/** Lightweight processed-article row rendered by the dashboard library. */
export interface DashboardArticleItem {
  readonly id: ArticleId
  readonly source: ArticleSource
  readonly title: string
  readonly url: string
  readonly publishedAt?: string | undefined
  readonly category?: ArticleCategory | undefined
  readonly duplicateOfCount: number
  readonly duplicateTarget?: DashboardDuplicateTarget | undefined
  readonly processedAt: string
  readonly summary?: string | undefined
  readonly importanceScore?: number | undefined
}

/** Full processed-article view loaded when a user opens one library row. */
export interface DashboardArticleDetail extends DashboardArticleItem {
  readonly author?: string | undefined
  readonly detailedSummary?: string | undefined
  readonly importanceReason?: string | undefined
  readonly modelProvider: string
  readonly model: string
}

/** Lightweight pending or failed article rendered in the reading queue. */
export type DashboardQueueItem = {
  readonly id: ArticleId
  readonly source: ArticleSource
  readonly title: string
  readonly url: string
  readonly publishedAt?: string | undefined
  readonly excerpt?: string | undefined
} & (
  | { readonly status: 'pending'; readonly error?: never }
  | { readonly status: 'failed'; readonly error: string }
)

/** One dashboard snapshot backed by the plugin's durable article repository. */
export interface DashboardSnapshot {
  readonly currentDate: string
  readonly digest: DailyDigest
  readonly sourceSettings: AiDailySourceSettings
  readonly articles: readonly DashboardArticleItem[]
  readonly totalProcessed: number
  readonly queue: readonly DashboardQueueItem[]
  readonly totalQueued: number
  readonly totalFailed: number
}

/** Dashboard response after source discovery completes. */
export interface DashboardCrawlResult {
  readonly crawl: DailyCrawlResult
  readonly snapshot: DashboardSnapshot
}

/** Dashboard response after one pending or failed queue pass completes. */
export interface DashboardAnalysisResult {
  readonly analysis: Omit<DailyAnalysisResult, 'digest'>
  readonly snapshot: DashboardSnapshot
}

/** Live operation state paired with the latest durable repository snapshot. */
export interface DashboardOperationStatus {
  readonly progress: DailyOperationProgress | null
  readonly snapshot: DashboardSnapshot
}

/** Supported media sources. */
export type ArticleSource = 'aiera' | 'jiqizhixin' | 'qbitai'

/** Stable editorial categories assigned during model analysis. */
export type ArticleCategory = 'latest-papers' | 'major-companies' | 'ai-applications' | 'other'

declare const articleIdBrand: unique symbol

/** Stable identifier derived from a source and canonical article URL. */
export type ArticleId = string & { readonly [articleIdBrand]: true }

/** Article metadata returned by a source adapter before durable registration. */
export interface DiscoveredArticle {
  readonly source: ArticleSource
  readonly url: string
  readonly canonicalUrl: string
  readonly title: string
  readonly publishedAt?: string | undefined
  readonly author?: string | undefined
  readonly excerpt?: string | undefined
}

/** Plain-text article body prepared for model consumption. */
export interface ArticleDocument extends DiscoveredArticle {
  readonly content: string
  readonly contentHash: string
}

/** Processing state of one durable article record. */
export type ArticleStatus = 'discovered' | 'processed' | 'failed'

/** Durable metadata and derived analysis for one article. */
export interface ArticleRecord extends DiscoveredArticle {
  readonly id: ArticleId
  readonly status: ArticleStatus
  readonly discoveredAt: string
  readonly lastSeenAt: string
  readonly processedAt?: string | undefined
  readonly contentHash?: string | undefined
  readonly summary?: string | undefined
  readonly detailedSummary?: string | undefined
  /** Legacy field retained only so repositories written by earlier versions remain readable. */
  readonly keyPoints?: readonly string[] | undefined
  readonly importanceScore?: number | undefined
  readonly importanceReason?: string | undefined
  readonly modelProvider?: string | undefined
  readonly model?: string | undefined
  readonly error?: string | undefined
  readonly category?: ArticleCategory | undefined
  readonly duplicateOfArticleIds?: readonly ArticleId[] | undefined
}

/** Same-day article context from publishers other than the article being analyzed. */
export interface PeerNewsContext {
  readonly id: ArticleId
  readonly source: ArticleSource
  readonly title: string
  readonly summary: string
  readonly publishedAt?: string | undefined
  readonly canBeDuplicateTarget: boolean
}

/** Provenance shared by unique and duplicate model decisions. */
interface ArticleAnalysisBase {
  readonly contentHash: string
  readonly modelProvider: string
  readonly model: string
}

/** Model-derived fields accepted when an article has been processed. */
export type ArticleAnalysis = ArticleAnalysisBase & (
  | {
    readonly duplicateOfArticleIds: readonly []
    readonly category: ArticleCategory
    readonly summary: string
    readonly detailedSummary: string
    readonly importanceScore: number
    readonly importanceReason: string
  }
  | {
    readonly duplicateOfArticleIds: readonly ArticleId[]
    readonly category?: never
    readonly summary?: never
    readonly detailedSummary?: never
    readonly importanceScore?: never
    readonly importanceReason?: never
  }
)

/** Outcome of registering one discovery batch. */
export interface DiscoveryRegistration {
  readonly added: readonly ArticleRecord[]
  readonly existing: readonly ArticleRecord[]
}

/** One ranked article in a daily digest. */
export interface DailyDigestItem {
  readonly id: ArticleId
  readonly source: ArticleSource
  readonly title: string
  readonly url: string
  readonly publishedAt?: string | undefined
  readonly category: ArticleCategory
  readonly summary: string
  readonly importanceScore: number
  readonly importanceReason: string
}

/** A date-scoped digest sorted from highest to lowest importance. */
export interface DailyDigest {
  readonly date: string
  readonly generatedAt: string
  readonly timeZone: string
  readonly articles: readonly DailyDigestItem[]
}

/** One article that could not be analyzed during a processing pass. */
export interface ArticleProcessingFailure {
  readonly id: ArticleId
  readonly title: string
  readonly error: string
}

/** Complete result of one discovery and model-analysis pass. */
export interface DailyRefreshResult {
  readonly discoveredCount: number
  readonly existingCount: number
  readonly processedCount: number
  readonly failedCount: number
  readonly failures: readonly ArticleProcessingFailure[]
  readonly digest: DailyDigest
}

/** Outcome of one source-discovery pass without model analysis. */
export interface DailyCrawlResult {
  readonly discoveredCount: number
  readonly existingCount: number
}

/** Outcome of analyzing one date-scoped article queue. */
export interface DailyAnalysisResult {
  readonly processedCount: number
  readonly failedCount: number
  readonly failures: readonly ArticleProcessingFailure[]
  readonly digest: DailyDigest
}

/** Background operation currently publishing progress. */
export type DailyOperation = 'crawl' | 'summarize' | 'retry-failures' | 'refresh' | 'reanalyze'

/** Observable stage of the currently executing background operation. */
export type DailyOperationPhase = 'discovering' | 'reading' | 'analyzing' | 'saving' | 'finalizing'

/** Read-only progress snapshot for one active background operation. */
export interface DailyOperationProgress {
  readonly operation: DailyOperation
  readonly phase: DailyOperationPhase
  readonly startedAt: string
  readonly completedArticles: number
  readonly totalArticles: number
  readonly currentArticleId?: ArticleId | undefined
  readonly currentArticleIndex?: number | undefined
  readonly currentArticleTitle?: string | undefined
}

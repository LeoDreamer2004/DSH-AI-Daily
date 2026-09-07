import type { WebRuntime } from '@deepseek-ai/dsh-web'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { LlmArticleAnalyzer } from './analysis/model.js'
import type { ArticleAnalysisEngine } from './analysis/model.js'
import { buildDailyDigest, dateInTimeZone, parseCalendarDate } from './digest.js'
import {
  DEFAULT_SOURCE_SETTINGS,
  modelSelectionOf,
  sourceIsEnabled,
  sourceSettingsOf,
  type AiDailyModelSelection,
  type AiDailySettings,
  type AiDailySourceSettings,
} from './settings.js'
import { AieraSource } from './sources/aiera.js'
import { JiqizhixinSource } from './sources/jiqizhixin.js'
import { QbitSource } from './sources/qbitai.js'
import type { ArticleSourceAdapter } from './sources/types.js'
import type {
  ArticleId,
  ArticleProcessingFailure,
  ArticleRecord,
  ArticleSource,
  DailyAnalysisResult,
  DailyCrawlResult,
  DailyDigest,
  DailyOperation,
  DailyOperationPhase,
  DailyOperationProgress,
  DailyRefreshResult,
  DiscoveredArticle,
  PeerNewsContext,
} from './types.js'
import { ArticleRepository } from './storage/repository.js'

/** Resolved runtime configuration for all enabled article sources. */
export interface AiDailyServiceConfig {
  readonly aieraFeedUrl: string
  readonly jiqizhixinApiUrl?: string
  readonly qbitFeedUrl?: string
  readonly maxFeedItems: number
  readonly maxArticleChars: number
  readonly requestTimeoutMs: number
  readonly modelProvider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly maxAnalysisTokens: number
  readonly modelTimeoutMs: number
  readonly maxArticlesPerRefresh: number
  readonly timeZone: string
  readonly sourceSettings?: AiDailySourceSettings
}

/** Logging surface used by background-operation diagnostics. */
export interface AiDailyLogger {
  info(message: string): void
  warn(message: string | Error): void
  error(message: string | Error): void
}

const SILENT_LOGGER: AiDailyLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

/** Discovery, model-analysis, and digest service consumed by AI Daily tools. */
export class AiDailyService {
  private readonly sources: ReadonlyMap<ArticleSource, ArticleSourceAdapter>
  private readonly analyzerOverride: ArticleAnalysisEngine | undefined
  private readonly llm: Pick<LlmRuntime, 'stream'>
  private readonly lifecycle = new AbortController()
  private operationTail: Promise<void> = Promise.resolve()
  private closeTask: Promise<void> | undefined
  private progress: DailyOperationProgress | undefined
  private sourceSettings: AiDailySourceSettings
  private modelSelection: AiDailyModelSelection

  constructor(
    private readonly web: Pick<WebRuntime, 'fetch'>,
    llm: Pick<LlmRuntime, 'stream'>,
    private readonly repository: ArticleRepository,
    private readonly config: AiDailyServiceConfig,
    analyzer: ArticleAnalysisEngine | undefined = undefined,
    private readonly clock: () => Date = () => new Date(),
    private readonly logger: AiDailyLogger = SILENT_LOGGER,
  ) {
    this.llm = llm
    this.analyzerOverride = analyzer
    this.sourceSettings = { ...(config.sourceSettings ?? DEFAULT_SOURCE_SETTINGS) }
    this.modelSelection = {
      modelProvider: config.modelProvider,
      model: config.model,
      ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    }
    const sources: ArticleSourceAdapter[] = [new AieraSource(this.web, {
      feedUrl: config.aieraFeedUrl,
      maxFeedItems: config.maxFeedItems,
      maxArticleChars: config.maxArticleChars,
      requestTimeoutMs: config.requestTimeoutMs,
    })]
    if (config.jiqizhixinApiUrl !== undefined) {
      sources.push(new JiqizhixinSource(this.web, {
        listUrl: config.jiqizhixinApiUrl,
        maxItems: config.maxFeedItems,
        maxArticleChars: config.maxArticleChars,
        requestTimeoutMs: config.requestTimeoutMs,
      }))
    }
    if (config.qbitFeedUrl !== undefined) {
      sources.push(new QbitSource(this.web, {
        feedUrl: config.qbitFeedUrl,
        maxFeedItems: config.maxFeedItems,
        maxArticleChars: config.maxArticleChars,
        requestTimeoutMs: config.requestTimeoutMs,
      }))
    }
    this.sources = new Map(sources.map(source => [source.source, source]))
  }
  /** Return a detached snapshot of the sources used by the next operation. */
  getSourceSettings(): AiDailySourceSettings {
    return { ...this.sourceSettings }
  }

  /** Apply one complete live settings snapshot. */
  setSettings(settings: AiDailySettings): void {
    this.sourceSettings = sourceSettingsOf(settings)
    this.modelSelection = modelSelectionOf(settings)
  }

  /** Return one durable article record by id. */
  getArticle(id: ArticleId): ArticleRecord | undefined {
    return this.repository.get(id)
  }

  /** Return a stable newest-first snapshot of processed articles for one local date. */
  listProcessedArticles(date?: string): readonly ArticleRecord[] {
    const targetDate = date ?? dateInTimeZone(this.clock(), this.config.timeZone)
    return this.repository.list({ status: 'processed' }).filter(article => dateInTimeZone(
      new Date(article.publishedAt ?? article.discoveredAt),
      this.config.timeZone,
    ) === targetDate)
  }

  /** Return pending and failed reading-queue records for one local date. */
  listQueuedArticles(date?: string): readonly ArticleRecord[] {
    const settings = this.sourceSettings
    const targetDate = date ?? dateInTimeZone(this.clock(), this.config.timeZone)
    return this.repository.list().filter(article => (
      article.status !== 'processed' && sourceIsEnabled(settings, article.source)
      && this.dateOf(article) === targetDate
    ))
  }

  /** Return a detached snapshot of the active background operation. */
  operationProgress(): DailyOperationProgress | undefined {
    return this.progress === undefined ? undefined : { ...this.progress }
  }

  /** Build a ranked digest for one local calendar date. */
  dailyDigest(date?: string): DailyDigest {
    const now = this.clock()
    return buildDailyDigest(
      this.repository.list(),
      date ?? dateInTimeZone(now, this.config.timeZone),
      this.config.timeZone,
      now,
    )
  }

  /** Discover source entries without invoking an analysis model. */
  crawl(signal?: AbortSignal): Promise<DailyCrawlResult> {
    if (this.closeTask !== undefined) return Promise.reject(new Error('ai-daily service is closed'))
    return this.enqueue(() => this.runCrawl(signal))
  }

  /** Analyze every pending article for one date, excluding failed records. */
  summarize(date?: string, signal?: AbortSignal): Promise<DailyAnalysisResult> {
    if (this.closeTask !== undefined) return Promise.reject(new Error('ai-daily service is closed'))
    const targetDate = date === undefined
      ? dateInTimeZone(this.clock(), this.config.timeZone)
      : parseCalendarDate(date)
    return this.enqueue(() => this.runQueueAnalysis('summarize', 'discovered', targetDate, signal))
  }

  /** Retry every failed article for one date as one serialized queue pass. */
  retryFailures(date?: string, signal?: AbortSignal): Promise<DailyAnalysisResult> {
    if (this.closeTask !== undefined) return Promise.reject(new Error('ai-daily service is closed'))
    const targetDate = date === undefined
      ? dateInTimeZone(this.clock(), this.config.timeZone)
      : parseCalendarDate(date)
    return this.enqueue(() => this.runQueueAnalysis('retry-failures', 'failed', targetDate, signal))
  }

  /** Discover source entries, analyze a bounded pending batch, and return that date's digest. */
  refresh(
    maxArticles: number = this.config.maxArticlesPerRefresh,
    signal?: AbortSignal,
    date?: string,
  ): Promise<DailyRefreshResult> {
    if (!Number.isSafeInteger(maxArticles) || maxArticles < 1) {
      return Promise.reject(new RangeError('maxArticles must be a positive safe integer'))
    }
    if (maxArticles > this.config.maxArticlesPerRefresh) {
      return Promise.reject(new RangeError(
        `maxArticles must not exceed configured limit ${this.config.maxArticlesPerRefresh}`,
      ))
    }
    if (this.closeTask !== undefined) return Promise.reject(new Error('ai-daily service is closed'))

    const targetDate = date === undefined
      ? dateInTimeZone(this.clock(), this.config.timeZone)
      : parseCalendarDate(date)
    return this.enqueue(() => this.runRefresh(maxArticles, targetDate, signal))
  }

  /** Re-fetch and replace one processed article's model analysis without losing it on failure. */
  reanalyze(id: ArticleId, signal?: AbortSignal): Promise<ArticleRecord> {
    if (this.closeTask !== undefined) return Promise.reject(new Error('ai-daily service is closed'))
    return this.enqueue(() => this.runReanalysis(id, signal))
  }

  /** Close persistent resources owned by this service. */
  close(): Promise<void> {
    if (this.closeTask !== undefined) return this.closeTask
    this.lifecycle.abort(new Error('ai-daily service is closing'))
    this.closeTask = this.operationTail.then(() => this.repository.close())
    return this.closeTask
  }

  private async runRefresh(
    maxArticles: number,
    targetDate: string,
    signal?: AbortSignal,
  ): Promise<DailyRefreshResult> {
    const startedAt = this.clock().toISOString()
    const operationSignal = this.operationSignal(signal)
    this.setProgress('refresh', startedAt, 'discovering', 0, 0)
    try {
      this.logger.info(`ai-daily: refresh started for ${targetDate} with an analysis limit of ${maxArticles}`)
      const registration = await this.performCrawl(operationSignal, this.sourceSettings)
      const candidates = this.analysisCandidates('discovered', targetDate).slice(0, maxArticles)
      const analysis = await this.performAnalysis('refresh', candidates, targetDate, operationSignal, startedAt)
      const result = {
        discoveredCount: registration.added.length,
        existingCount: registration.existing.length,
        ...analysis,
      }
      this.logger.info(
        `ai-daily: refresh for ${targetDate} completed with ${result.processedCount} processed, ${result.failedCount} failed, and ${result.digest.articles.length} article(s) in the digest`,
      )
      return result
    } finally {
      this.progress = undefined
    }
  }

  private async runCrawl(signal?: AbortSignal): Promise<DailyCrawlResult> {
    const startedAt = this.clock().toISOString()
    const operationSignal = this.operationSignal(signal)
    this.setProgress('crawl', startedAt, 'discovering', 0, 0)
    this.logger.info('ai-daily: article crawl started')
    try {
      const registration = await this.performCrawl(operationSignal, this.sourceSettings)
      this.setProgress('crawl', startedAt, 'finalizing', 0, 0)
      const result = {
        discoveredCount: registration.added.length,
        existingCount: registration.existing.length,
      }
      this.logger.info(
        `ai-daily: article crawl completed with ${result.discoveredCount} new and ${result.existingCount} existing article(s)`,
      )
      return result
    } finally {
      this.progress = undefined
    }
  }

  private async runQueueAnalysis(
    operation: 'summarize' | 'retry-failures',
    status: 'discovered' | 'failed',
    targetDate: string,
    signal?: AbortSignal,
  ): Promise<DailyAnalysisResult> {
    const startedAt = this.clock().toISOString()
    const operationSignal = this.operationSignal(signal)
    const candidates = this.analysisCandidates(status, targetDate)
    this.logger.info(
      `ai-daily: ${operation} started for ${targetDate} with ${candidates.length} article(s)`,
    )
    try {
      const result = await this.performAnalysis(operation, candidates, targetDate, operationSignal, startedAt)
      this.logger.info(
        `ai-daily: ${operation} for ${targetDate} completed with ${result.processedCount} processed and ${result.failedCount} failed`,
      )
      return result
    } finally {
      this.progress = undefined
    }
  }

  private async runReanalysis(id: ArticleId, signal?: AbortSignal): Promise<ArticleRecord> {
    const analyzer = this.analyzerFor(this.modelSelection)
    const article = this.repository.get(id)
    if (article === undefined || article.status !== 'processed') {
      throw new Error(`ai-daily: processed article '${id}' was not found`)
    }
    const sourceSettings = this.sourceSettings
    if (!sourceIsEnabled(sourceSettings, article.source)) {
      throw new Error(`ai-daily: source '${article.source}' is disabled`)
    }
    const startedAt = this.clock().toISOString()
    const operationSignal = this.operationSignal(signal)
    this.setProgress('reanalyze', startedAt, 'reading', 0, 1, article, 1)
    this.logger.info(
      `ai-daily: reanalysis started id=${article.id} title=${JSON.stringify(article.title)} url=${article.canonicalUrl}`,
    )
    try {
      operationSignal.throwIfAborted()
      const document = await this.sourceFor(article.source).read(article, operationSignal)
      const peerNews = this.peerNewsFor(article, sourceSettings)
      this.setProgress('reanalyze', startedAt, 'analyzing', 0, 1, article, 1)
      const analysis = await analyzer.analyze(document, peerNews, operationSignal)
      this.setProgress('reanalyze', startedAt, 'saving', 0, 1, article, 1)
      const updated = await this.repository.markProcessed(article.id, analysis, this.clock())
      this.setProgress('reanalyze', startedAt, 'finalizing', 1, 1)
      this.logger.info(
        `ai-daily: reanalysis completed id=${article.id} score=${'importanceScore' in analysis ? analysis.importanceScore : 'duplicate'} duplicates=${analysis.duplicateOfArticleIds.length}`,
      )
      return updated
    } catch (error) {
      this.logger.warn(
        `ai-daily: reanalysis failed without replacing the existing result id=${article.id}: ${this.errorMessage(error)}`,
      )
      throw error
    } finally {
      this.progress = undefined
    }
  }

  private async performCrawl(
    operationSignal: AbortSignal,
    sourceSettings: AiDailySourceSettings,
  ) {
    operationSignal.throwIfAborted()
    let discovered
    try {
      discovered = await this.discoverArticles(operationSignal, sourceSettings)
    } catch (error) {
      this.logFatalFailure('source discovery failed', error)
      throw error
    }
    const registration = await this.repository.registerDiscovered(discovered)
    this.logger.info(
      `ai-daily: discovery found ${registration.added.length} new and ${registration.existing.length} existing article(s)`,
    )
    return registration
  }

  private analysisCandidates(
    status: 'discovered' | 'failed',
    targetDate: string,
  ): readonly ArticleRecord[] {
    const sourceSettings = this.sourceSettings
    return this.repository.list({ status })
      .filter(article => sourceIsEnabled(sourceSettings, article.source))
      .filter(article => this.dateOf(article) === targetDate)
  }

  private async performAnalysis(
    operation: 'refresh' | 'summarize' | 'retry-failures',
    candidates: readonly ArticleRecord[],
    targetDate: string,
    operationSignal: AbortSignal,
    startedAt: string,
  ): Promise<DailyAnalysisResult> {
    const analyzer = this.analyzerFor(this.modelSelection)
    operationSignal.throwIfAborted()
    const sourceSettings = this.sourceSettings
    const failures: ArticleProcessingFailure[] = []
    let processedCount = 0

    for (const [index, article] of candidates.entries()) {
      operationSignal.throwIfAborted()
      this.setProgress(operation, startedAt, 'reading', index, candidates.length, article, index + 1)
      this.logger.info(
        `ai-daily: analyzing article id=${article.id} title=${JSON.stringify(article.title)} url=${article.canonicalUrl}`,
      )
      try {
        const document = await this.sourceFor(article.source).read(article, operationSignal)
        const peerNews = this.peerNewsFor(article, sourceSettings)
        this.logger.info(
          `ai-daily: attaching ${peerNews.length} same-day article(s) from other publishers for duplicate detection`,
        )
        this.setProgress(operation, startedAt, 'analyzing', index, candidates.length, article, index + 1)
        const analysis = await analyzer.analyze(document, peerNews, operationSignal)
        this.setProgress(operation, startedAt, 'saving', index, candidates.length, article, index + 1)
        await this.repository.markProcessed(article.id, analysis, this.clock())
        this.setProgress(operation, startedAt, 'saving', index + 1, candidates.length, article, index + 1)
        processedCount++
        this.logger.info(
          `ai-daily: analyzed article id=${article.id} score=${'importanceScore' in analysis ? analysis.importanceScore : 'duplicate'} duplicates=${analysis.duplicateOfArticleIds.length} title=${JSON.stringify(article.title)}`,
        )
      } catch (error) {
        operationSignal.throwIfAborted()
        const message = this.errorMessage(error)
        this.setProgress(operation, startedAt, 'saving', index, candidates.length, article, index + 1)
        await this.repository.markFailed(article.id, message)
        this.setProgress(operation, startedAt, 'saving', index + 1, candidates.length, article, index + 1)
        failures.push({ id: article.id, title: article.title, error: message })
        this.logger.warn(
          `ai-daily: article analysis failed id=${article.id} title=${JSON.stringify(article.title)} url=${article.canonicalUrl}: ${message}`,
        )
        if (error instanceof Error) this.logger.warn(error)
      }
    }

    this.setProgress(operation, startedAt, 'finalizing', candidates.length, candidates.length)
    const result = {
      processedCount,
      failedCount: failures.length,
      failures,
      digest: this.dailyDigest(targetDate),
    }
    return result
  }

  /** Snapshot one route for an entire refresh so one run never mixes providers. */
  private analyzerFor(selection: AiDailyModelSelection): ArticleAnalysisEngine {
    return this.analyzerOverride ?? new LlmArticleAnalyzer(this.llm, {
      provider: selection.modelProvider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      maxOutputTokens: this.config.maxAnalysisTokens,
      timeoutMs: this.config.modelTimeoutMs,
      timeZone: this.config.timeZone,
    }, this.clock)
  }

  private setProgress(
    operation: DailyOperation,
    startedAt: string,
    phase: DailyOperationPhase,
    completedArticles: number,
    totalArticles: number,
    currentArticle?: ArticleRecord,
    currentArticleIndex?: number,
  ): void {
    this.progress = {
      operation,
      phase,
      startedAt,
      completedArticles,
      totalArticles,
      ...(currentArticle === undefined
        ? {}
        : { currentArticleId: currentArticle.id, currentArticleTitle: currentArticle.title }),
      ...(currentArticleIndex === undefined ? {} : { currentArticleIndex }),
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => {}, () => {})
    return result
  }

  private async discoverArticles(
    signal: AbortSignal,
    sourceSettings: AiDailySourceSettings,
  ): Promise<readonly DiscoveredArticle[]> {
    const enabledSources = [...this.sources.values()]
      .filter(source => sourceIsEnabled(sourceSettings, source.source))
    if (enabledSources.length === 0) return []
    const outcomes = await Promise.all(enabledSources.map(async source => {
      try {
        return { source, articles: await source.discover(signal) } as const
      } catch (error) {
        return { source, error } as const
      }
    }))
    signal.throwIfAborted()

    const discovered: DiscoveredArticle[] = []
    const errors: unknown[] = []
    for (const outcome of outcomes) {
      if ('articles' in outcome) {
        discovered.push(...outcome.articles)
        this.logger.info(
          `ai-daily: source discovery completed source=${outcome.source.source} articles=${outcome.articles.length}`,
        )
        continue
      }
      errors.push(outcome.error)
      this.logger.warn(
        `ai-daily: source discovery failed source=${outcome.source.source}: ${this.errorMessage(outcome.error)}`,
      )
      if (outcome.error instanceof Error) this.logger.warn(outcome.error)
    }

    if (errors.length === outcomes.length) {
      throw new AggregateError(errors, 'all configured article sources failed discovery')
    }
    return discovered
  }

  private sourceFor(source: ArticleSource): ArticleSourceAdapter {
    const adapter = this.sources.get(source)
    if (adapter === undefined) {
      throw new Error(`ai-daily: no article source adapter is configured for '${source}'`)
    }
    return adapter
  }

  private peerNewsFor(
    article: ArticleRecord,
    sourceSettings: AiDailySourceSettings,
  ): readonly PeerNewsContext[] {
    const articleDate = dateInTimeZone(
      new Date(article.publishedAt ?? article.discoveredAt),
      this.config.timeZone,
    )
    return this.repository.list()
      .filter(candidate => candidate.id !== article.id)
      .filter(candidate => candidate.source !== article.source)
      .filter(candidate => sourceIsEnabled(sourceSettings, candidate.source))
      .filter(candidate => dateInTimeZone(
        new Date(candidate.publishedAt ?? candidate.discoveredAt),
        this.config.timeZone,
      ) === articleDate)
      .map(candidate => ({
        id: candidate.id,
        source: candidate.source,
        title: candidate.title,
        summary: candidate.summary ?? candidate.excerpt ?? candidate.title,
        ...(candidate.publishedAt === undefined ? {} : { publishedAt: candidate.publishedAt }),
        canBeDuplicateTarget: candidate.status === 'processed'
          && (candidate.duplicateOfArticleIds?.length ?? 0) === 0,
      }))
  }

  private operationSignal(signal?: AbortSignal): AbortSignal {
    return signal === undefined
      ? this.lifecycle.signal
      : AbortSignal.any([signal, this.lifecycle.signal])
  }

  private dateOf(article: ArticleRecord): string {
    return dateInTimeZone(
      new Date(article.publishedAt ?? article.discoveredAt),
      this.config.timeZone,
    )
  }

  private errorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    return message.trim().slice(0, 1_000) || 'Unknown article processing failure'
  }

  private logFatalFailure(stage: string, error: unknown): void {
    this.logger.error(`ai-daily: ${stage}: ${this.errorMessage(error)}`)
    if (error instanceof Error) this.logger.error(error)
  }
}

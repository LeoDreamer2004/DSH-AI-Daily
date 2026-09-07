import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { z } from 'zod'
import type { ArticleId, DailyOperationProgress } from '../types.js'
import type {
  DashboardAnalysisResult,
  DashboardArticleDetail,
  DashboardCrawlResult,
  DashboardOperationStatus,
  DashboardSnapshot,
} from '../dashboard/types.js'

const articleIdSchema = z.string().regex(/^[a-f0-9]{64}$/).transform(value => value as ArticleId)
const sourceSchema = z.enum(['aiera', 'jiqizhixin', 'qbitai'])
const categorySchema = z.enum(['latest-papers', 'major-companies', 'ai-applications', 'other'])
const digestItemSchema = z.object({
  id: articleIdSchema,
  source: sourceSchema,
  title: z.string(),
  url: z.string().url(),
  publishedAt: z.string().optional(),
  category: categorySchema,
  summary: z.string(),
  importanceScore: z.number().int().min(0).max(100),
  importanceReason: z.string(),
}).strict()
const digestSchema = z.object({
  date: z.string(),
  generatedAt: z.string(),
  timeZone: z.string(),
  articles: z.array(digestItemSchema),
}).strict()
const articleItemSchema = z.object({
  id: articleIdSchema,
  source: sourceSchema,
  title: z.string(),
  url: z.string().url(),
  publishedAt: z.string().optional(),
  category: categorySchema.optional(),
  duplicateOfCount: z.number().int().min(0),
  duplicateTarget: z.object({ id: articleIdSchema, title: z.string() }).strict().optional(),
  processedAt: z.string(),
  summary: z.string().optional(),
  importanceScore: z.number().int().min(0).max(100).optional(),
}).strict()
const queueItemBaseSchema = z.object({
  id: articleIdSchema,
  source: sourceSchema,
  title: z.string(),
  url: z.string().url(),
  publishedAt: z.string().optional(),
  excerpt: z.string().optional(),
})
const queueItemSchema = z.discriminatedUnion('status', [
  queueItemBaseSchema.extend({ status: z.literal('pending') }).strict(),
  queueItemBaseSchema.extend({ status: z.literal('failed'), error: z.string() }).strict(),
])
const sourceSettingsSchema = z.object({
  aiera: z.boolean(),
  jiqizhixin: z.boolean(),
  qbitai: z.boolean(),
}).strict()
const snapshotSchema = z.object({
  currentDate: z.string(),
  digest: digestSchema,
  sourceSettings: sourceSettingsSchema,
  articles: z.array(articleItemSchema),
  totalProcessed: z.number().int().min(0),
  queue: z.array(queueItemSchema),
  totalQueued: z.number().int().min(0),
  totalFailed: z.number().int().min(0),
}).strict()
const detailSchema = articleItemSchema.extend({
  author: z.string().optional(),
  detailedSummary: z.string().optional(),
  importanceReason: z.string().optional(),
  modelProvider: z.string(),
  model: z.string(),
}).strict()
const crawlResultSchema = z.object({
  crawl: z.object({
    discoveredCount: z.number().int().min(0),
    existingCount: z.number().int().min(0),
  }).strict(),
  snapshot: snapshotSchema,
}).strict()
const analysisResultSchema = z.object({
  analysis: z.object({
    processedCount: z.number().int().min(0),
    failedCount: z.number().int().min(0),
    failures: z.array(z.object({
      id: articleIdSchema,
      title: z.string(),
      error: z.string(),
    }).strict()),
  }).strict(),
  snapshot: snapshotSchema,
}).strict()
const progressSchema = z.object({
  operation: z.enum(['crawl', 'summarize', 'retry-failures', 'refresh', 'reanalyze']),
  phase: z.enum(['discovering', 'reading', 'analyzing', 'saving', 'finalizing']),
  startedAt: z.string(),
  completedArticles: z.number().int().min(0),
  totalArticles: z.number().int().min(0),
  currentArticleId: articleIdSchema.optional(),
  currentArticleIndex: z.number().int().min(1).optional(),
  currentArticleTitle: z.string().optional(),
}).strict()
const operationStatusSchema = z.object({
  progress: progressSchema.nullable(),
  snapshot: snapshotSchema,
}).strict()
const RPC_CHANNEL = '/ai-daily'
const INITIAL_PAGE_SIZE = 50
const PAGE_INCREMENT = 50
const PROGRESS_POLL_INTERVAL_MS = 500

type DashboardActivity = 'loading' | 'opening-article'
export type DashboardOperation = 'crawl' | 'summarize' | 'retry-failures' | 'reanalyze'
export type DashboardToast =
  | { readonly kind: 'crawl'; readonly discoveredCount: number }
  | { readonly kind: 'analysis'; readonly processedCount: number; readonly failedCount: number }

export interface DashboardState {
  readonly open: boolean
  readonly operation?: DashboardOperation | undefined
  readonly reanalyzingArticleId?: string | undefined
  readonly activity?: DashboardActivity | undefined
  readonly progress?: DailyOperationProgress | undefined
  readonly snapshot?: DashboardSnapshot | undefined
  readonly selected?: DashboardArticleDetail | undefined
  readonly error?: string | undefined
  readonly toast?: DashboardToast | undefined
}

/** Slot injection supplied to every AI Daily presentation entry. */
export interface DashboardInjected {
  readonly hooks: { readonly aiDaily: SnapshotStore<DashboardState> }
  readonly open: () => void
  readonly close: () => void
  readonly dismissArticle: () => void
  readonly dismissMessage: () => void
  readonly load: (date?: string) => Promise<void>
  readonly loadMore: () => Promise<void>
  readonly openArticle: (id: string) => Promise<void>
  readonly reanalyzeArticle: (id: string) => Promise<void>
  readonly crawl: (date?: string) => Promise<void>
  readonly summarize: (date?: string) => Promise<void>
  readonly retryFailures: (date?: string) => Promise<void>
  readonly setTrigger: (element: HTMLButtonElement | null) => void
}

/** Browser-side state owner for the AI Daily dashboard. */
export class DashboardController {
  /** Stable React-free snapshot consumed through the Slot hook adapter. */
  readonly store: SnapshotStore<DashboardState> = createSnapshotStore({ open: false })
  private requestVersion = 0
  private operationVersion = 0
  private progressTimer: ReturnType<typeof setTimeout> | undefined
  private toastTimer: ReturnType<typeof setTimeout> | undefined
  private trigger: HTMLButtonElement | null = null

  constructor(private readonly rpc: ClientConnectionRpc) {}

  readonly getSnapshot = (): DashboardState => this.store.getSnapshot()

  readonly subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  private get state(): DashboardState {
    return this.store.getSnapshot()
  }

  /** Build plain callbacks and one observable for a Slot registration. */
  inject(): DashboardInjected {
    return {
      hooks: { aiDaily: this.store },
      open: () => { this.open() },
      close: () => { this.close() },
      dismissArticle: () => { this.dismissArticle() },
      dismissMessage: () => { this.dismissMessage() },
      load: date => this.load(date),
      loadMore: () => this.loadMore(),
      openArticle: id => this.openArticle(id),
      reanalyzeArticle: id => this.reanalyzeArticle(id),
      crawl: date => this.crawl(date),
      summarize: date => this.summarize(date),
      retryFailures: date => this.retryFailures(date),
      setTrigger: element => { this.setTrigger(element) },
    }
  }

  setTrigger(element: HTMLButtonElement | null): void {
    this.trigger = element
  }

  open(): void {
    this.patch({ open: true, error: undefined })
    if (this.state.snapshot === undefined && this.state.activity === undefined && this.state.operation === undefined) {
      void this.load()
    }
  }

  close(): void {
    this.patch({ open: false, selected: undefined })
    queueMicrotask(() => { this.trigger?.focus() })
  }

  /** Detach the controller when its Harness client contribution is unloaded. */
  dispose(): void {
    this.requestVersion++
    this.operationVersion++
    this.stopProgressPolling()
    this.clearToast()
    this.patch({
      open: false,
      operation: undefined,
      reanalyzingArticleId: undefined,
      activity: undefined,
      progress: undefined,
      selected: undefined,
    })
    this.trigger = null
  }

  dismissArticle(): void {
    this.patch({ selected: undefined })
  }

  dismissMessage(): void {
    this.clearToast()
    this.patch({ error: undefined })
  }

  async load(date?: string): Promise<void> {
    if (this.state.activity !== undefined) return
    this.clearToast()
    const version = ++this.requestVersion
    this.patch({
      activity: 'loading',
      error: undefined,
      ...(date === undefined ? {} : { selected: undefined }),
    })
    try {
      const value = await this.call('snapshot', this.snapshotPayload(date))
      if (version !== this.requestVersion) return
      const snapshot = snapshotSchema.parse(value) as DashboardSnapshot
      this.patch({ snapshot, activity: undefined })
    } catch (error) {
      if (version !== this.requestVersion) return
      this.patch({ activity: undefined, error: this.message(error) })
    }
  }

  async crawl(date?: string): Promise<void> {
    if (this.state.operation !== undefined || this.state.activity !== undefined) return
    const viewDate = date ?? this.state.snapshot?.digest.date
    const version = this.beginOperation('crawl', date)
    try {
      const value = await this.call('crawl', this.snapshotPayload(date))
      if (version !== this.operationVersion) return
      const result = crawlResultSchema.parse(value) as DashboardCrawlResult
      this.patch({
        ...(this.isCurrentView(viewDate) ? { snapshot: result.snapshot } : {}),
        operation: undefined,
        progress: undefined,
      })
      this.showToast({ kind: 'crawl', discoveredCount: result.crawl.discoveredCount })
    } catch (error) {
      this.finishOperationWithError(version, error)
    } finally {
      if (version === this.operationVersion) this.stopProgressPolling()
    }
  }

  summarize(date?: string): Promise<void> {
    return this.runQueueOperation('summarize', date)
  }

  retryFailures(date?: string): Promise<void> {
    return this.runQueueOperation('retry-failures', date)
  }

  async reanalyzeArticle(id: string): Promise<void> {
    if (this.state.operation !== undefined || this.state.activity !== undefined) return
    const date = this.state.snapshot?.digest.date
    const version = this.beginOperation('reanalyze', date, id)
    try {
      const value = await this.call('reanalyze', { id, ...this.snapshotPayload(date) })
      if (version !== this.operationVersion) return
      const snapshot = snapshotSchema.parse(value) as DashboardSnapshot
      this.patch({
        ...(this.isCurrentView(date) ? { snapshot } : {}),
        operation: undefined,
        reanalyzingArticleId: undefined,
        progress: undefined,
      })
      if (this.state.selected?.id === id) await this.openArticle(id)
    } catch (error) {
      this.finishOperationWithError(version, error)
    } finally {
      if (version === this.operationVersion) this.stopProgressPolling()
    }
  }

  async openArticle(id: string): Promise<void> {
    if (this.state.activity !== undefined) return
    this.clearToast()
    const version = ++this.requestVersion
    this.patch({ activity: 'opening-article', error: undefined })
    try {
      const value = await this.call('article', { id })
      if (version !== this.requestVersion) return
      const selected = detailSchema.parse(value) as DashboardArticleDetail
      this.patch({ selected, activity: undefined })
    } catch (error) {
      if (version !== this.requestVersion) return
      this.patch({ activity: undefined, error: this.message(error) })
    }
  }

  async loadMore(): Promise<void> {
    const current = this.state.snapshot
    if (
      current === undefined
      || current.articles.length >= current.totalProcessed
      || this.state.activity !== undefined
      || this.state.operation !== undefined
    ) return
    this.clearToast()
    const version = ++this.requestVersion
    this.patch({ activity: 'loading', error: undefined })
    try {
      const value = await this.call('snapshot', {
        date: current.digest.date,
        offset: current.articles.length,
        limit: PAGE_INCREMENT,
      })
      if (version !== this.requestVersion) return
      const page = snapshotSchema.parse(value) as DashboardSnapshot
      const known = new Set(current.articles.map(article => article.id))
      const appended = page.articles.filter(article => !known.has(article.id))
      this.patch({
        activity: undefined,
        snapshot: { ...page, articles: [...current.articles, ...appended] },
      })
    } catch (error) {
      if (version !== this.requestVersion) return
      this.patch({ activity: undefined, error: this.message(error) })
    }
  }

  private async runQueueOperation(
    operation: 'summarize' | 'retry-failures',
    date?: string,
  ): Promise<void> {
    if (this.state.operation !== undefined || this.state.activity !== undefined) return
    const viewDate = date ?? this.state.snapshot?.digest.date
    const version = this.beginOperation(operation, date)
    try {
      const value = await this.call(operation, this.snapshotPayload(date))
      if (version !== this.operationVersion) return
      const result = analysisResultSchema.parse(value) as DashboardAnalysisResult
      this.patch({
        ...(this.isCurrentView(viewDate) ? { snapshot: result.snapshot } : {}),
        operation: undefined,
        progress: undefined,
      })
      this.showToast({
        kind: 'analysis',
        processedCount: result.analysis.processedCount,
        failedCount: result.analysis.failedCount,
      })
    } catch (error) {
      this.finishOperationWithError(version, error)
    } finally {
      if (version === this.operationVersion) this.stopProgressPolling()
    }
  }

  private beginOperation(operation: DashboardOperation, date?: string, articleId?: string): number {
    const version = ++this.operationVersion
    this.clearToast()
    this.patch({
      operation,
      reanalyzingArticleId: articleId,
      progress: undefined,
      error: undefined,
    })
    this.startProgressPolling(version, date)
    return version
  }

  private finishOperationWithError(version: number, error: unknown): void {
    if (version !== this.operationVersion) return
    this.patch({
      operation: undefined,
      reanalyzingArticleId: undefined,
      progress: undefined,
      error: this.message(error),
    })
  }

  private snapshotPayload(date?: string): { date?: string; offset: number; limit: number } {
    return {
      ...(date === undefined ? {} : { date }),
      offset: 0,
      limit: INITIAL_PAGE_SIZE,
    }
  }

  private async call(endpoint: string, payload: object): Promise<unknown> {
    const result = await this.rpc.call(RPC_CHANNEL, endpoint, payload)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }

  private startProgressPolling(version: number, date?: string): void {
    this.stopProgressPolling()
    const poll = async (): Promise<void> => {
      if (version !== this.operationVersion || this.state.operation === undefined) return
      try {
        const observedDate = this.state.snapshot?.digest.date ?? date
        const value = await this.call('operation-status', this.snapshotPayload(observedDate))
        if (version !== this.operationVersion || this.state.operation === undefined) return
        const status = operationStatusSchema.parse(value) as DashboardOperationStatus
        this.patch({
          ...(this.isCurrentView(observedDate) ? { snapshot: status.snapshot } : {}),
          progress: status.progress ?? undefined,
        })
      } catch {
        // The primary operation request owns user-visible errors. A transient
        // observation failure must not interrupt the background operation.
      }
      if (version !== this.operationVersion || this.state.operation === undefined) return
      this.progressTimer = setTimeout(() => { void poll() }, PROGRESS_POLL_INTERVAL_MS)
    }
    this.progressTimer = setTimeout(() => { void poll() }, 100)
  }

  private stopProgressPolling(): void {
    if (this.progressTimer === undefined) return
    clearTimeout(this.progressTimer)
    this.progressTimer = undefined
  }

  private showToast(toast: DashboardToast): void {
    this.clearToast()
    this.patch({ toast })
    this.toastTimer = setTimeout(() => {
      this.toastTimer = undefined
      this.patch({ toast: undefined })
    }, 3_200)
  }

  private clearToast(): void {
    if (this.toastTimer !== undefined) clearTimeout(this.toastTimer)
    this.toastTimer = undefined
    if (this.state.toast !== undefined) this.patch({ toast: undefined })
  }

  private patch(change: Partial<DashboardState>): void {
    this.store.set({ ...this.state, ...change })
  }

  private isCurrentView(date: string | undefined): boolean {
    return date === undefined || this.state.snapshot?.digest.date === date
  }

  private message(error: unknown): string {
    return error instanceof Error && error.message.trim() !== '' ? error.message : ''
  }
}

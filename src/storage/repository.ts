import type { Domain, DomainFacility, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { aiDailyDomainSpec, articleRecordSchema } from './spec.js'
import type {
  ArticleAnalysis,
  ArticleId,
  ArticleRecord,
  ArticleSource,
  DiscoveredArticle,
  DiscoveryRegistration,
} from '../types.js'
import { articleIdFor, canonicalizeArticleUrl } from '../url.js'

/** Filters supported by the durable article list. */
export interface ArticleListFilter {
  readonly source?: ArticleSource
  readonly status?: ArticleRecord['status']
}

type ArticleTable = KvTable<ArticleId, ArticleRecord>

/** Durable article repository with serialized read-modify-write operations. */
export class ArticleRepository {
  private operationTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly table: ArticleTable,
    private readonly closeDomain: () => Promise<void> = async () => {},
  ) {}

  /** Open the plugin-owned storage domain. */
  static async open(storageDomain: Pick<DomainFacility, 'open'>): Promise<ArticleRepository> {
    const domain: Domain<typeof aiDailyDomainSpec> = await storageDomain.open(aiDailyDomainSpec)
    return new ArticleRepository(domain.table('articles'), () => domain.close())
  }

  /** Close the owned domain after queued work settles. */
  async close(): Promise<void> {
    await this.operationTail
    await this.closeDomain()
  }

  /** Return one article by opaque id. */
  get(id: ArticleId): ArticleRecord | undefined {
    return this.table.get(id)
  }

  /** Return a stable newest-first snapshot of stored articles. */
  list(filter: ArticleListFilter = {}): readonly ArticleRecord[] {
    return [...this.table.entries()]
      .map(([, article]) => article)
      .filter(article => filter.source === undefined || article.source === filter.source)
      .filter(article => filter.status === undefined || article.status === filter.status)
      .sort((left, right) => {
        const leftTime = left.publishedAt ?? left.discoveredAt
        const rightTime = right.publishedAt ?? right.discoveredAt
        return rightTime.localeCompare(leftTime) || left.id.localeCompare(right.id)
      })
  }

  /** Register a discovery batch while preserving existing processing results. */
  registerDiscovered(
    articles: readonly DiscoveredArticle[],
    observedAt: Date = new Date(),
  ): Promise<DiscoveryRegistration> {
    return this.enqueue(async () => {
      const timestamp = observedAt.toISOString()
      const added: ArticleRecord[] = []
      const existing: ArticleRecord[] = []

      for (const article of articles) {
        const canonicalUrl = canonicalizeArticleUrl(article.canonicalUrl)
        const id = articleIdFor(article.source, canonicalUrl)
        const current = this.table.get(id)
        if (current === undefined) {
          const record: ArticleRecord = {
            ...article,
            id,
            canonicalUrl,
            status: 'discovered',
            discoveredAt: timestamp,
            lastSeenAt: timestamp,
          }
          const validated = articleRecordSchema.parse(record)
          await this.table.put(id, validated)
          added.push(validated)
          continue
        }

        const refreshed: ArticleRecord = {
          ...current,
          url: article.url,
          canonicalUrl,
          title: article.title,
          lastSeenAt: timestamp,
          ...(article.publishedAt === undefined ? {} : { publishedAt: article.publishedAt }),
          ...(article.author === undefined ? {} : { author: article.author }),
          ...(article.excerpt === undefined ? {} : { excerpt: article.excerpt }),
        }
        const validated = articleRecordSchema.parse(refreshed)
        await this.table.put(id, validated)
        existing.push(validated)
      }

      return { added, existing }
    })
  }

  /** Persist model-derived analysis and mark one article as processed. */
  markProcessed(
    id: ArticleId,
    analysis: ArticleAnalysis,
    processedAt: Date = new Date(),
  ): Promise<ArticleRecord> {
    return this.enqueue(() => this.table.update(id, current => {
      const {
        category: _category,
        detailedSummary: _detailedSummary,
        error: _error,
        importanceReason: _importanceReason,
        importanceScore: _importanceScore,
        keyPoints: _keyPoints,
        summary: _summary,
        ...record
      } = current
      const uniqueFields = 'summary' in analysis
        ? {
          category: analysis.category,
          summary: analysis.summary,
          detailedSummary: analysis.detailedSummary,
          importanceScore: analysis.importanceScore,
          importanceReason: analysis.importanceReason,
        }
        : {}
      return articleRecordSchema.parse({
        ...record,
        status: 'processed',
        processedAt: processedAt.toISOString(),
        contentHash: analysis.contentHash,
        duplicateOfArticleIds: [...analysis.duplicateOfArticleIds],
        ...uniqueFields,
        modelProvider: analysis.modelProvider,
        model: analysis.model,
      })
    }))
  }

  /** Persist a processing failure without discarding discovery metadata. */
  async markFailed(id: ArticleId, error: string): Promise<ArticleRecord> {
    const message = error.trim()
    if (message === '') throw new TypeError('failure message must not be empty')
    return this.enqueue(() => this.table.update(id, current => articleRecordSchema.parse({
      ...current,
      status: 'failed',
      error: message,
    })))
  }

  /** Permanently remove a bounded set of article records. */
  remove(ids: readonly ArticleId[]): Promise<number> {
    const uniqueIds = [...new Set(ids)]
    return this.enqueue(async () => {
      let removed = 0
      for (const id of uniqueIds) {
        if (await this.table.delete(id)) removed++
      }
      return removed
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => {}, () => {})
    return result
  }
}

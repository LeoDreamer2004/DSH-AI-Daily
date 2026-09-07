import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ArticleId, ArticleRecord } from '../../src/types.js'

/** In-memory KvTable test double with synchronous reads and durable-style writes. */
export class MemoryArticleTable implements KvTable<ArticleId, ArticleRecord> {
  private readonly records = new Map<ArticleId, ArticleRecord>()

  get size(): number {
    return this.records.size
  }

  get(key: ArticleId): ArticleRecord | undefined {
    return this.records.get(key)
  }

  entries(): IterableIterator<[ArticleId, ArticleRecord]> {
    return new Map(this.records).entries()
  }

  keys(): IterableIterator<ArticleId> {
    return new Map(this.records).keys()
  }

  async put(key: ArticleId, value: ArticleRecord): Promise<void> {
    this.records.set(key, value)
  }

  async delete(key: ArticleId): Promise<boolean> {
    return this.records.delete(key)
  }

  async update(
    key: ArticleId,
    transform: (current: ArticleRecord) => ArticleRecord,
  ): Promise<ArticleRecord> {
    const current = this.records.get(key)
    if (current === undefined) throw new Error(`missing article '${key}'`)
    const next = transform(current)
    this.records.set(key, next)
    return next
  }
}

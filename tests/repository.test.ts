import { describe, expect, it } from 'vitest'
import { ArticleRepository } from '../src/storage/repository.js'
import { articleRecordSchema } from '../src/storage/spec.js'
import type { DiscoveredArticle } from '../src/types.js'
import { MemoryArticleTable } from './helpers/memory-article-table.js'

function discovered(overrides: Partial<DiscoveredArticle> = {}): DiscoveredArticle {
  return {
    source: 'aiera',
    url: 'https://aiera.com.cn/story/?utm_source=feed',
    canonicalUrl: 'https://aiera.com.cn/story/?utm_source=feed',
    title: 'Initial title',
    publishedAt: '2026-09-05T00:30:00.000Z',
    ...overrides,
  }
}

describe('ArticleRepository', () => {
  it('deduplicates canonical URLs and refreshes metadata without resetting state', async () => {
    const table = new MemoryArticleTable()
    const repository = new ArticleRepository(table)
    const firstSeen = new Date('2026-09-05T01:00:00.000Z')
    const secondSeen = new Date('2026-09-06T01:00:00.000Z')

    const firstBatch = await repository.registerDiscovered([discovered()], firstSeen)
    const id = firstBatch.added[0]?.id
    if (id === undefined) throw new Error('article was not registered')
    await repository.markProcessed(id, {
      contentHash: 'a'.repeat(64),
      category: 'latest-papers',
      duplicateOfArticleIds: [],
      summary: 'Short model summary.',
      detailedSummary: 'A detailed model summary with supporting context.',
      importanceScore: 82,
      importanceReason: 'Material research impact.',
      modelProvider: 'test-provider',
      model: 'test-model',
    }, firstSeen)

    const secondBatch = await repository.registerDiscovered([
      discovered({
        url: 'https://aiera.com.cn/story?ref=frontpage',
        canonicalUrl: 'https://aiera.com.cn/story?ref=frontpage',
        title: 'Updated title',
      }),
    ], secondSeen)

    expect(table.size).toBe(1)
    expect(secondBatch.added).toHaveLength(0)
    expect(secondBatch.existing).toHaveLength(1)
    expect(repository.get(id)).toMatchObject({
      title: 'Updated title',
      status: 'processed',
      summary: 'Short model summary.',
      category: 'latest-papers',
      discoveredAt: firstSeen.toISOString(),
      lastSeenAt: secondSeen.toISOString(),
    })
    expect(repository.get(id)).not.toHaveProperty('keyPoints')
    expect(articleRecordSchema.safeParse(repository.get(id)).success).toBe(true)
  })

  it('rejects durable processed or failed states missing their required fields', () => {
    const base = {
      ...discovered(),
      id: 'a'.repeat(64),
      canonicalUrl: 'https://aiera.com.cn/story',
      discoveredAt: '2026-09-05T01:00:00.000Z',
      lastSeenAt: '2026-09-05T01:00:00.000Z',
    }
    expect(articleRecordSchema.safeParse({ ...base, status: 'processed' }).success).toBe(false)
    expect(articleRecordSchema.safeParse({ ...base, status: 'failed' }).success).toBe(false)
  })

  it('removes prior summaries and scores when reanalysis marks an article as duplicate', async () => {
    const repository = new ArticleRepository(new MemoryArticleTable())
    const registration = await repository.registerDiscovered([
      discovered({ canonicalUrl: 'https://aiera.com.cn/earliest', title: 'Earliest report' }),
      discovered({ canonicalUrl: 'https://aiera.com.cn/follow-up', title: 'Follow-up report' }),
    ])
    const earliestId = registration.added.find(article => article.title === 'Earliest report')?.id
    const followUpId = registration.added.find(article => article.title === 'Follow-up report')?.id
    if (earliestId === undefined || followUpId === undefined) throw new Error('articles were not registered')

    await repository.markProcessed(followUpId, {
      contentHash: 'b'.repeat(64),
      category: 'other',
      duplicateOfArticleIds: [],
      summary: 'A summary that must be removed.',
      detailedSummary: 'Detailed content that must be removed.',
      importanceScore: 76,
      importanceReason: 'A reason that must be removed.',
      modelProvider: 'test-provider',
      model: 'test-model',
    })
    const duplicate = await repository.markProcessed(followUpId, {
      contentHash: 'c'.repeat(64),
      duplicateOfArticleIds: [earliestId],
      modelProvider: 'test-provider',
      model: 'test-model',
    })

    expect(duplicate).toMatchObject({
      status: 'processed',
      duplicateOfArticleIds: [earliestId],
      contentHash: 'c'.repeat(64),
    })
    expect(duplicate).not.toHaveProperty('category')
    expect(duplicate).not.toHaveProperty('summary')
    expect(duplicate).not.toHaveProperty('detailedSummary')
    expect(duplicate).not.toHaveProperty('importanceScore')
    expect(duplicate).not.toHaveProperty('importanceReason')
    expect(articleRecordSchema.safeParse(duplicate).success).toBe(true)
  })

  it('serializes concurrent registrations and returns newest articles first', async () => {
    const repository = new ArticleRepository(new MemoryArticleTable())
    await Promise.all([
      repository.registerDiscovered([
        discovered({ canonicalUrl: 'https://aiera.com.cn/older', publishedAt: '2026-09-01T00:00:00.000Z' }),
      ]),
      repository.registerDiscovered([
        discovered({ canonicalUrl: 'https://aiera.com.cn/newer', publishedAt: '2026-09-02T00:00:00.000Z' }),
      ]),
    ])

    expect(repository.list().map(article => article.canonicalUrl)).toEqual([
      'https://aiera.com.cn/newer',
      'https://aiera.com.cn/older',
    ])
  })

  it('records failures and validates the failure message', async () => {
    const repository = new ArticleRepository(new MemoryArticleTable())
    const registration = await repository.registerDiscovered([discovered()])
    const id = registration.added[0]?.id
    if (id === undefined) throw new Error('article was not registered')

    await expect(repository.markFailed(id, '  ')).rejects.toThrow(/must not be empty/)
    await expect(repository.markFailed(id, 'Model timeout')).resolves.toMatchObject({
      status: 'failed',
      error: 'Model timeout',
    })
  })
})

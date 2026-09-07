import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { ArticleId, ArticleRecord } from '../types.js'

const utcInstantSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/,
  'expected an RFC 3339 UTC instant',
)

/** Durable validation schema for one article record. */
export const articleRecordSchema: z.ZodType<ArticleRecord> = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/).transform(value => value as ArticleId),
  source: z.enum(['aiera', 'jiqizhixin', 'qbitai']),
  url: z.url(),
  canonicalUrl: z.url(),
  title: z.string().min(1).max(500),
  publishedAt: utcInstantSchema.optional(),
  author: z.string().min(1).max(500).optional(),
  excerpt: z.string().min(1).max(1_000).optional(),
  status: z.enum(['discovered', 'processed', 'failed']),
  discoveredAt: utcInstantSchema,
  lastSeenAt: utcInstantSchema,
  processedAt: utcInstantSchema.optional(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  summary: z.string().min(1).max(280).optional(),
  detailedSummary: z.string().min(1).max(4_000).optional(),
  keyPoints: z.array(z.string().min(1).max(300)).min(1).max(8).optional(),
  importanceScore: z.number().min(0).max(100).optional(),
  importanceReason: z.string().min(1).max(500).optional(),
  modelProvider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  error: z.string().min(1).max(1_000).optional(),
  category: z.enum(['latest-papers', 'major-companies', 'ai-applications', 'other']).optional(),
  duplicateOfArticleIds: z.array(
    z.string().regex(/^[a-f0-9]{64}$/).transform(value => value as ArticleId),
  ).max(20).optional(),
}).strict().superRefine((record, context) => {
  if (record.status === 'failed' && record.error === undefined) {
    context.addIssue({ code: 'custom', path: ['error'], message: 'failed articles require an error' })
  }
  if (record.duplicateOfArticleIds !== undefined) {
    if (new Set(record.duplicateOfArticleIds).size !== record.duplicateOfArticleIds.length) {
      context.addIssue({ code: 'custom', path: ['duplicateOfArticleIds'], message: 'duplicate references must be unique' })
    }
    if (record.duplicateOfArticleIds.includes(record.id)) {
      context.addIssue({ code: 'custom', path: ['duplicateOfArticleIds'], message: 'an article cannot duplicate itself' })
    }
  }
  if (record.status !== 'processed') return
  const requiredBaseFields = [
    'processedAt',
    'contentHash',
    'modelProvider',
    'model',
  ] as const
  for (const field of requiredBaseFields) {
    if (record[field] === undefined) {
      context.addIssue({
        code: 'custom',
        path: [field],
        message: `processed articles require ${field}`,
      })
    }
  }
  if ((record.duplicateOfArticleIds?.length ?? 0) === 0) {
    const requiredUniqueFields = [
      'summary',
      'detailedSummary',
      'importanceScore',
      'importanceReason',
    ] as const
    for (const field of requiredUniqueFields) {
      if (record[field] === undefined) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `processed non-duplicate articles require ${field}`,
        })
      }
    }
  }
  if (record.error !== undefined) {
    context.addIssue({ code: 'custom', path: ['error'], message: 'processed articles must not retain an error' })
  }
})

/** Durable domain for article discovery and processing state. */
export const aiDailyDomainSpec = defineDomain({
  name: 'ai_daily',
  version: 1,
  tables: {
    articles: domainTable<ArticleId, ArticleRecord>(articleRecordSchema),
  },
})

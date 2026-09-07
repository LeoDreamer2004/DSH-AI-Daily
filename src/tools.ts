import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AiDailyService } from './service.js'
import type { ArticleId, DailyDigest } from './types.js'

const DIGEST_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    source: { type: 'string', required: true, enum: ['aiera', 'jiqizhixin', 'qbitai'] },
    title: { type: 'string', required: true },
    url: { type: 'string', required: true },
    publishedAt: { type: 'string' },
    category: { type: 'string', required: true, enum: ['latest-papers', 'major-companies', 'ai-applications', 'other'] },
    summary: { type: 'string', required: true },
    importanceScore: { type: 'integer', required: true },
    importanceReason: { type: 'string', required: true },
  },
} as const

const DIGEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    date: { type: 'string', required: true },
    generatedAt: { type: 'string', required: true },
    timeZone: { type: 'string', required: true },
    articles: { type: 'array', required: true, items: DIGEST_ITEM_SCHEMA },
  },
} as const

const FAILURE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    error: { type: 'string', required: true },
  },
} as const

const REFRESH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    discoveredCount: { type: 'integer', required: true },
    existingCount: { type: 'integer', required: true },
    processedCount: { type: 'integer', required: true },
    failedCount: { type: 'integer', required: true },
    failures: { type: 'array', required: true, items: FAILURE_SCHEMA },
    digest: { ...DIGEST_SCHEMA, required: true },
  },
} as const

const ARTICLE_DETAIL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    source: { type: 'string', required: true, enum: ['aiera', 'jiqizhixin', 'qbitai'] },
    title: { type: 'string', required: true },
    url: { type: 'string', required: true },
    publishedAt: { type: 'string' },
    processedAt: { type: 'string', required: true },
    category: { type: 'string', required: true, enum: ['latest-papers', 'major-companies', 'ai-applications', 'other'] },
    duplicateOfArticleIds: { type: 'array', required: true, items: { type: 'string' } },
    summary: { type: 'string', required: true },
    detailedSummary: { type: 'string', required: true },
    importanceScore: { type: 'integer', required: true },
    importanceReason: { type: 'string', required: true },
    modelProvider: { type: 'string', required: true },
    model: { type: 'string', required: true },
  },
} as const

interface RenderableDigest {
  readonly date: string
  readonly timeZone: string
  readonly articles: readonly {
    readonly id: string
    readonly title: string
    readonly url: string
    readonly summary: string
    readonly importanceScore: number
    readonly importanceReason: string
  }[]
}

function digestContent(digest: RenderableDigest): ContentBlock[] {
  if (digest.articles.length === 0) {
    return [{ type: 'text', text: `AI daily digest for ${digest.date}: no processed articles.` }]
  }
  const entries = digest.articles.map((article, index) => [
    `${index + 1}. ${article.title} (${article.importanceScore}/100)`,
    article.summary,
    `Why it matters: ${article.importanceReason}`,
    `Article ID: ${article.id}`,
    `Source: ${article.url}`,
  ].join('\n'))
  return [{
    type: 'text',
    text: `AI daily digest for ${digest.date} (${digest.timeZone})\n\n${entries.join('\n\n')}`,
  }]
}

function digestValue(digest: DailyDigest) {
  return {
    date: digest.date,
    generatedAt: digest.generatedAt,
    timeZone: digest.timeZone,
    articles: digest.articles.map(article => ({
      id: article.id,
      source: article.source,
      title: article.title,
      url: article.url,
      ...(article.publishedAt === undefined ? {} : { publishedAt: article.publishedAt }),
      category: article.category,
      summary: article.summary,
      importanceScore: article.importanceScore,
      importanceReason: article.importanceReason,
    })),
  }
}

function articleId(input: string): ArticleId {
  if (!/^[a-f0-9]{64}$/.test(input)) {
    throw new TypeError('article_id must be a lowercase SHA-256 identifier')
  }
  return input as ArticleId
}

function assertOnlyKeys(args: object, allowed: readonly string[]): void {
  const unexpected = Object.keys(args).find(key => !allowed.includes(key))
  if (unexpected !== undefined) throw new TypeError(`unexpected argument '${unexpected}'`)
}

/**
 * Register refresh, digest, and detailed-reading tools.
 * @param ctx - Context carrying the Harness tool registry.
 * @param service - AI Daily service used by tool executions.
 * @param maxArticlesPerRefresh - Configured upper bound exposed in the refresh description.
 */
export function registerAiDailyTools(
  ctx: Context,
  service: AiDailyService,
  maxArticlesPerRefresh: number,
): void {
  ctx.tools.register(defineTool({
    name: 'ai_daily_refresh',
    description: 'Fetch current AI media entries, analyze newly discovered articles with the configured model, and return today\'s importance-ranked digest. '
      + `The optional max_articles value must be a positive integer no greater than ${maxArticlesPerRefresh}.`,
    parameters: {
      max_articles: { type: 'integer', description: 'Maximum newly discovered articles to analyze in this refresh.' },
    },
    output: {
      schema: REFRESH_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: [
          `Refresh completed: ${value.discoveredCount} discovered, ${value.processedCount} processed, ${value.failedCount} failed.`,
          ...digestContent(value.digest).map(block => block.type === 'text' ? block.text : ''),
        ].join('\n\n'),
      }],
    },
    execute: async (args, exec) => {
      assertOnlyKeys(args, ['max_articles'])
      const result = await service.refresh(args.max_articles, exec.signal)
      return {
        discoveredCount: result.discoveredCount,
        existingCount: result.existingCount,
        processedCount: result.processedCount,
        failedCount: result.failedCount,
        failures: result.failures.map(failure => ({ ...failure })),
        digest: digestValue(result.digest),
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Refresh AI daily digest',
      kind: 'search',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'ai_daily_digest',
    description: 'Read an already-generated AI daily digest, sorted from highest to lowest importance. '
      + 'Omit date for today or provide an exact YYYY-MM-DD date in the configured time zone.',
    parameters: {
      date: { type: 'string', description: 'Calendar date in YYYY-MM-DD form.' },
    },
    output: {
      schema: DIGEST_SCHEMA,
      render: (_args, value) => digestContent(value),
    },
    execute: (args) => {
      assertOnlyKeys(args, ['date'])
      return Promise.resolve(digestValue(service.dailyDigest(args.date)))
    },
    presentCall: args => ({
      card: 'generic',
      title: args.date === undefined ? 'Read today\'s AI digest' : `Read AI digest for ${args.date}`,
      kind: 'read',
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'ai_daily_read',
    description: 'Read the detailed AI analysis, importance rationale, model provenance, and source link for one article from ai_daily_digest.',
    parameters: {
      article_id: { type: 'string', required: true, description: 'Exact article ID returned by ai_daily_digest.' },
    },
    output: {
      schema: ARTICLE_DETAIL_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: [
          value.title,
          `Importance: ${value.importanceScore}/100 — ${value.importanceReason}`,
          value.detailedSummary,
          `Source: ${value.url}`,
        ].join('\n\n'),
      }],
    },
    execute: (args) => {
      assertOnlyKeys(args, ['article_id'])
      const record = service.getArticle(articleId(args.article_id))
      if (record === undefined) throw new Error(`unknown article id '${args.article_id}'`)
      if (
        record.status !== 'processed'
        || record.processedAt === undefined
        || record.summary === undefined
        || record.detailedSummary === undefined
        || record.importanceScore === undefined
        || record.importanceReason === undefined
        || record.modelProvider === undefined
        || record.model === undefined
      ) {
        throw new Error(`article '${args.article_id}' has not been processed successfully`)
      }
      return Promise.resolve({
        id: record.id,
        source: record.source,
        title: record.title,
        url: record.canonicalUrl,
        ...(record.publishedAt === undefined ? {} : { publishedAt: record.publishedAt }),
        processedAt: record.processedAt,
        category: record.category ?? 'other',
        duplicateOfArticleIds: [...(record.duplicateOfArticleIds ?? [])],
        summary: record.summary,
        detailedSummary: record.detailedSummary,
        importanceScore: record.importanceScore,
        importanceReason: record.importanceReason,
        modelProvider: record.modelProvider,
        model: record.model,
      })
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Read detailed AI article analysis',
      kind: 'read',
      rawInput: args.article_id,
    }),
  }))
}

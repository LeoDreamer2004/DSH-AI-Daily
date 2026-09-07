import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { AiDailyService } from '../src/service.js'
import type { ArticleRecord, DailyDigest } from '../src/types.js'
import { registerAiDailyTools } from '../src/tools.js'
import { articleIdFor } from '../src/url.js'

const canonicalUrl = 'https://aiera.com.cn/article'
const id = articleIdFor('aiera', canonicalUrl)
const record: ArticleRecord = {
  id,
  source: 'aiera',
  url: canonicalUrl,
  canonicalUrl,
  title: 'Important research',
  publishedAt: '2026-09-06T00:00:00.000Z',
  status: 'processed',
  discoveredAt: '2026-09-06T00:00:00.000Z',
  lastSeenAt: '2026-09-06T00:00:00.000Z',
  processedAt: '2026-09-06T01:00:00.000Z',
  contentHash: 'a'.repeat(64),
  category: 'latest-papers',
  summary: 'Concise summary.',
  detailedSummary: 'Detailed summary.',
  importanceScore: 90,
  importanceReason: 'High impact.',
  modelProvider: 'test-provider',
  model: 'test-model',
}
const digest: DailyDigest = {
  date: '2026-09-06',
  generatedAt: '2026-09-06T02:00:00.000Z',
  timeZone: 'Asia/Shanghai',
  articles: [{
    id,
    source: 'aiera',
    title: record.title,
    url: canonicalUrl,
    publishedAt: record.publishedAt,
    category: record.category ?? 'other',
    summary: record.summary ?? '',
    importanceScore: record.importanceScore ?? 0,
    importanceReason: record.importanceReason ?? '',
  }],
}

function toolHarness() {
  const tools = new Map<string, ToolDefinition>()
  const refresh = vi.fn(async () => ({
    discoveredCount: 1,
    existingCount: 0,
    processedCount: 1,
    failedCount: 0,
    failures: [],
    digest,
  }))
  const service = {
    refresh,
    dailyDigest: vi.fn(() => digest),
    getArticle: vi.fn(() => record),
  } as unknown as AiDailyService
  const ctx = {
    tools: {
      register: (definition: ToolDefinition) => {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  } as unknown as Context
  registerAiDailyTools(ctx, service, 20)
  return { tools, service, refresh }
}

describe('AI Daily tools', () => {
  it('registers stable names and returns a rendered ranked digest', async () => {
    const { tools, service } = toolHarness()
    expect([...tools.keys()]).toEqual(['ai_daily_refresh', 'ai_daily_digest', 'ai_daily_read'])

    const definition = tools.get('ai_daily_digest')
    if (definition === undefined) throw new Error('digest tool was not registered')
    const value = await definition.execute({ date: '2026-09-06' }, {
      signal: new AbortController().signal,
    } as never)
    const content = definition.output.render({ date: '2026-09-06' }, value as never)

    expect(service.dailyDigest).toHaveBeenCalledWith('2026-09-06')
    expect(content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Important research (90/100)'),
    })
  })

  it('forwards refresh cancellation and produces detailed article data', async () => {
    const { tools, refresh } = toolHarness()
    const signal = new AbortController().signal
    const refreshTool = tools.get('ai_daily_refresh')
    const readTool = tools.get('ai_daily_read')
    if (refreshTool === undefined || readTool === undefined) throw new Error('tools were not registered')

    await refreshTool.execute({ max_articles: 3 }, { signal } as never)
    expect(refresh).toHaveBeenCalledWith(3, signal)
    await expect(readTool.execute({ article_id: id }, { signal } as never)).resolves.toMatchObject({
      id,
      detailedSummary: 'Detailed summary.',
      category: 'latest-papers',
    })
    await expect(readTool.execute({ article_id: id }, { signal } as never)).resolves.not.toHaveProperty('keyPoints')
  })

  it('rejects malformed article identifiers before reading storage', async () => {
    const { tools, service } = toolHarness()
    const readTool = tools.get('ai_daily_read')
    if (readTool === undefined) throw new Error('read tool was not registered')

    await expect(readTool.execute({ article_id: 'invalid' }, {
      signal: new AbortController().signal,
    } as never)).rejects.toThrow(/SHA-256/)
    expect(service.getArticle).not.toHaveBeenCalled()
  })

  it('rejects unknown arguments at the open tool parameter root', async () => {
    const { tools } = toolHarness()
    const digestTool = tools.get('ai_daily_digest')
    if (digestTool === undefined) throw new Error('digest tool was not registered')

    await expect(digestTool.execute({ unexpected: true }, {
      signal: new AbortController().signal,
    } as never)).rejects.toThrow(/unexpected argument/)
  })
})

/** Integration evidence for persisted articles, live settings, and bounded tool execution. */
import { readFile } from 'node:fs/promises'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { WebFetchResult, WebRuntime } from '@deepseek-ai/dsh-web'
import { describe, expect, it, vi } from 'vitest'
import { AiDailyService, type AiDailyServiceConfig } from '../src/service.js'
import { ArticleRepository } from '../src/storage/repository.js'
import { MemoryArticleTable } from './helpers/memory-article-table.js'

const config: AiDailyServiceConfig = {
  aieraFeedUrl: 'https://aiera.com.cn/feed/', maxFeedItems: 10, maxArticleChars: 10000, requestTimeoutMs: 5000,
  modelProvider: 'test', model: 'test', maxAnalysisTokens: 500, modelTimeoutMs: 5000,
  maxArticlesPerRefresh: 2, timeZone: 'UTC', sourceSettings: { aiera: true, jiqizhixin: false, qbitai: false },
}
const settings = { aiera: true, jiqizhixin: false, qbitai: false, modelProvider: 'test', model: 'test', webSearchEnabled: true }
const answer = JSON.stringify({
  category: 'latest-papers', duplicateOfArticleIds: [], summary: 'Research summary.',
  detailedSummary: '## Result\n\nEvidence from [the paper](https://primary.example/paper).',
  importanceScore: 82, importanceReason: 'Research significance.',
})
async function fixture() {
  const feed = await readFile(new URL('./fixtures/aiera-feed.xml', import.meta.url), 'utf8')
  const article = await readFile(new URL('./fixtures/aiera-article.html', import.meta.url), 'utf8')
  const table = new MemoryArticleTable()
  const closeRepository = vi.fn(async () => {})
  const repository = new ArticleRepository(table, closeRepository)
  const result = (url: string, content: string, kind: 'html' | 'text'): WebFetchResult => ({
    url, statusCode: 200, body: { kind, content }, truncated: false,
  })
  const search = vi.fn<WebRuntime['search']>(async () => ({
    sources: [{ url: 'https://primary.example/paper', title: 'Primary evidence', snippet: 'Verified research evidence.' }], truncated: false,
  }))
  const fetch = vi.fn<WebRuntime['fetch']>(async request => {
    if (request.url === config.aieraFeedUrl) return result(request.url, feed, 'text')
    if (request.url === 'https://primary.example/paper') return result(request.url, 'Independent primary-source evidence.', 'text')
    return result(request.url, article, 'html')
  })
  const requests: GenerateOptions[] = []
  const stream: LlmRuntime['stream'] = async function* (options): AsyncGenerator<StreamChunk> {
    requests.push(options)
    if (options.tools !== undefined && options.messages.length === 1) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('search'), name: 'ai_daily_web_search', arguments: '{"query":"research primary source"}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else if (options.tools !== undefined && options.messages.length === 3) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('fetch'), name: 'ai_daily_web_fetch', arguments: '{"url":"https://primary.example/paper"}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'text-delta', index: 0, text: answer }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const service = new AiDailyService({ fetch, search }, { stream }, repository, config, undefined, () => new Date('2026-09-05T12:00:00Z'), logger)
  return { service, repository, table, search, fetch, requests, logger, closeRepository }
}

describe('research in the article processing pipeline', () => {
  it('aborts pending research and settles it before closing storage', async () => {
    const run = await fixture()
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    let requestSignal: AbortSignal | undefined
    run.search.mockImplementation((_request, activeSignal) => new Promise((_resolve, reject) => {
      if (activeSignal === undefined) throw new Error('Research must carry cancellation')
      requestSignal = activeSignal
      activeSignal.addEventListener('abort', () => { reject(activeSignal.reason) }, { once: true })
      entered()
    }))
    try {
      run.service.setSettings(settings)
      await run.service.crawl()
      const analysis = run.service.summarize()
      const rejected = expect(analysis).rejects.toThrow()
      await started
      expect(run.closeRepository).not.toHaveBeenCalled()
      await run.service.close()
      await rejected
      expect(requestSignal?.aborted).toBe(true)
      expect(run.closeRepository).toHaveBeenCalledOnce()
      expect(run.requests).toHaveLength(1)
      expect(run.service.operationProgress()).toBeUndefined()
    } finally { await run.service.close() }
  })

  it('keeps crawling separate, applies the switch, stores results, and never rereads processed articles implicitly', async () => {
    const run = await fixture()
    try {
      await run.service.crawl()
      expect(run.requests).toHaveLength(0)
      expect(run.search).not.toHaveBeenCalled()
      run.service.setSettings(settings)
      await expect(run.service.summarize()).resolves.toMatchObject({ processedCount: 1, failedCount: 0 })
      expect(run.search).toHaveBeenCalledOnce()
      expect(run.fetch.mock.calls.some(([request]) => request.url === 'https://primary.example/paper')).toBe(true)
      const saved = run.repository.list({ status: 'processed' })[0]
      expect(saved?.detailedSummary).toContain('https://primary.example/paper')
      expect(run.logger.info.mock.calls.some(([message]) => message.includes('research searching completed'))).toBe(true)
      expect(run.logger.info.mock.calls.some(([message]) => message.includes('research fetching completed'))).toBe(true)
      await run.service.summarize()
      expect(run.search).toHaveBeenCalledOnce()
      run.service.setSettings({ ...settings, webSearchEnabled: false })
      await run.service.summarize('2026-09-04')
      expect(run.requests.at(-1)).not.toHaveProperty('tools')
      expect(run.search).toHaveBeenCalledOnce()
      expect(run.repository.list({ status: 'processed' })).toHaveLength(2)
    } finally { await run.service.close() }
  })

  it('keeps failed searches in the queue and retries only through the explicit retry operation', async () => {
    const run = await fixture()
    run.search.mockRejectedValueOnce(new Error('Search balance exhausted'))
    try {
      run.service.setSettings(settings)
      await run.service.crawl()
      await expect(run.service.summarize()).resolves.toMatchObject({ processedCount: 0, failedCount: 1 })
      expect(run.service.listQueuedArticles()[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('Check Harness') })
      expect(run.repository.list({ status: 'processed' })).toHaveLength(0)
      await run.service.summarize()
      expect(run.search).toHaveBeenCalledTimes(1)
      await expect(run.service.retryFailures()).resolves.toMatchObject({ processedCount: 1, failedCount: 0 })
      expect(run.search).toHaveBeenCalledTimes(2)
    } finally { await run.service.close() }
  })

  it('publishes research progress while pending and preserves the old result on failed reanalysis', async () => {
    const run = await fixture()
    try {
      await run.service.crawl()
      await run.service.summarize()
      const saved = run.repository.list({ status: 'processed' })[0]
      if (saved === undefined) throw new Error('Expected processed fixture')
      run.service.setSettings(settings)
      let release!: () => void
      let entered!: () => void
      const pending = new Promise<void>(resolve => { release = resolve })
      const started = new Promise<void>(resolve => { entered = resolve })
      run.search.mockImplementationOnce(async () => { entered(); await pending; throw new Error('Provider unavailable') })
      const analysis = run.service.reanalyze(saved.id)
      const rejected = expect(analysis).rejects.toMatchObject({ code: 'SEARCH_FAILED' })
      await started
      try {
        expect(run.service.operationProgress()).toMatchObject({ phase: 'searching', currentArticleId: saved.id })
      } finally { release() }
      await rejected
      expect(run.repository.get(saved.id)).toEqual(saved)
      expect(run.service.operationProgress()).toBeUndefined()
    } finally { await run.service.close() }
  })
})

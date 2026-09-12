import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { describe, expect, it, vi } from 'vitest'
import { DashboardController } from '../src/client/controller.js'
import { AI_DAILY_RPC_CHANNEL, aiDailyRpcMethod } from '../src/dashboard/protocol.js'
import type { ArticleId } from '../src/types.js'

const emptySnapshot = {
  currentDate: '2026-09-06',
  digest: {
    date: '2026-09-06',
    generatedAt: '2026-09-06T02:00:00.000Z',
    timeZone: 'Asia/Shanghai',
    articles: [],
  },
  sourceSettings: { aiera: true, jiqizhixin: true, qbitai: true },
  articles: [],
  totalProcessed: 0,
  queue: [],
  totalQueued: 0,
  totalFailed: 0,
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

describe('DashboardController background requests', () => {
  it('retries every failed article through one background queue operation', async () => {
    const firstId = 'c'.repeat(64) as ArticleId
    const secondId = 'd'.repeat(64) as ArticleId
    const failures = [firstId, secondId].map((id, index) => ({
      id,
      source: 'aiera' as const,
      title: `Failure ${index + 1}`,
      url: `https://aiera.com.cn/failure-${index + 1}`,
      status: 'failed' as const,
      error: 'Model failed.',
    }))
    const failureSnapshot = { ...emptySnapshot, queue: failures, totalQueued: 2, totalFailed: 2 }
    const pending = deferred<unknown>()
    const rpc = {
      call: vi.fn(async (_channel: string, endpoint: string) => {
        if (endpoint === aiDailyRpcMethod('retry-failures')) return await pending.promise
        throw new Error(`unexpected endpoint: ${endpoint}`)
      }),
    } as unknown as ClientConnectionRpc
    const controller = new DashboardController(rpc)
    controller.store.set({ ...controller.getSnapshot(), snapshot: failureSnapshot })

    const retry = controller.retryFailures('2026-09-06')
    expect(controller.getSnapshot()).toMatchObject({ operation: 'retry-failures' })
    pending.resolve({
      ok: true,
      value: {
        analysis: { processedCount: 2, failedCount: 0, failures: [] },
        snapshot: emptySnapshot,
      },
    })
    await retry
    expect(controller.getSnapshot()).toMatchObject({
      operation: undefined,
      snapshot: { queue: [], totalFailed: 0 },
    })
    expect(rpc.call).toHaveBeenCalledWith(AI_DAILY_RPC_CHANNEL, aiDailyRpcMethod('retry-failures'), {
      date: '2026-09-06', offset: 0, limit: 50,
    })
  })

  it('runs one article reanalysis as a background request', async () => {
    const pending = deferred<unknown>()
    const rpc = {
      call: vi.fn(async (_channel: string, endpoint: string) => {
        if (endpoint === aiDailyRpcMethod('reanalyze')) return await pending.promise
        throw new Error(`unexpected endpoint: ${endpoint}`)
      }),
    } as unknown as ClientConnectionRpc
    const controller = new DashboardController(rpc)

    const operation = controller.reanalyzeArticle('a'.repeat(64))
    expect(controller.getSnapshot()).toMatchObject({
      operation: 'reanalyze',
      reanalyzingArticleId: 'a'.repeat(64),
    })
    pending.resolve({ ok: true, value: emptySnapshot })
    await operation
    expect(controller.getSnapshot()).toMatchObject({
      operation: undefined,
      reanalyzingArticleId: undefined,
      snapshot: emptySnapshot,
    })
  })

  it('keeps summary generation active after the dashboard closes and accepts its result', async () => {
    const pending = deferred<unknown>()
    const selectedSnapshot = {
      ...emptySnapshot,
      digest: { ...emptySnapshot.digest, date: '2026-09-05' },
    }
    const rpc = {
      call: vi.fn(async (_channel: string, endpoint: string) => {
        if (endpoint === aiDailyRpcMethod('snapshot')) return { ok: true, value: selectedSnapshot }
        if (endpoint === aiDailyRpcMethod('summarize')) return await pending.promise
        throw new Error(`unexpected endpoint: ${endpoint}`)
      }),
    } as unknown as ClientConnectionRpc
    const controller = new DashboardController(rpc)

    await controller.load('2026-09-05')
    const summary = controller.summarize('2026-09-05')
    expect(controller.getSnapshot()).toMatchObject({ operation: 'summarize' })

    controller.close()
    expect(controller.getSnapshot()).toMatchObject({ open: false, operation: 'summarize' })

    pending.resolve({
      ok: true,
      value: {
        analysis: {
          processedCount: 0,
          failedCount: 0,
          failures: [],
        },
        snapshot: selectedSnapshot,
      },
    })
    await summary

    expect(controller.getSnapshot()).toMatchObject({
      open: false,
      operation: undefined,
      snapshot: selectedSnapshot,
      toast: { kind: 'analysis', processedCount: 0, failedCount: 0 },
    })
    expect(rpc.call).toHaveBeenCalledWith(AI_DAILY_RPC_CHANNEL, aiDailyRpcMethod('summarize'), {
      date: '2026-09-05',
      offset: 0,
      limit: 50,
    })
  })

  it('keeps a newly selected date visible while another date finishes in the background', async () => {
    const pendingSummary = deferred<unknown>()
    const historicalSnapshot = {
      ...emptySnapshot,
      digest: { ...emptySnapshot.digest, date: '2026-09-05' },
    }
    const rpc = {
      call: vi.fn(async (_channel: string, endpoint: string) => {
        if (endpoint === aiDailyRpcMethod('summarize')) return await pendingSummary.promise
        if (endpoint === aiDailyRpcMethod('snapshot')) return { ok: true, value: historicalSnapshot }
        throw new Error(`unexpected endpoint: ${endpoint}`)
      }),
    } as unknown as ClientConnectionRpc
    const controller = new DashboardController(rpc)
    controller.store.set({ ...controller.getSnapshot(), snapshot: emptySnapshot })

    const summary = controller.summarize('2026-09-06')
    await controller.load('2026-09-05')
    expect(controller.getSnapshot()).toMatchObject({
      operation: 'summarize',
      snapshot: { digest: { date: '2026-09-05' } },
    })

    pendingSummary.resolve({
      ok: true,
      value: {
        analysis: { processedCount: 0, failedCount: 0, failures: [] },
        snapshot: emptySnapshot,
      },
    })
    await summary

    expect(controller.getSnapshot()).toMatchObject({
      operation: undefined,
      snapshot: { digest: { date: '2026-09-05' } },
    })
  })

  it('automatically dismisses completion toasts without changing dashboard content', async () => {
    vi.useFakeTimers()
    try {
      const rpc = {
        call: vi.fn(async (_channel: string, endpoint: string) => {
          if (endpoint === aiDailyRpcMethod('crawl')) {
            return {
              ok: true,
              value: {
                crawl: { discoveredCount: 3, existingCount: 1 },
                snapshot: emptySnapshot,
              },
            }
          }
          throw new Error(`unexpected endpoint: ${endpoint}`)
        }),
      } as unknown as ClientConnectionRpc
      const controller = new DashboardController(rpc)
      controller.store.set({ ...controller.getSnapshot(), snapshot: emptySnapshot })

      await controller.crawl('2026-09-06')
      expect(controller.getSnapshot()).toMatchObject({
        snapshot: emptySnapshot,
        toast: { kind: 'crawl', discoveredCount: 3 },
      })

      await vi.advanceTimersByTimeAsync(3_200)
      expect(controller.getSnapshot().toast).toBeUndefined()
      expect(controller.getSnapshot().snapshot).toEqual(emptySnapshot)
      controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('publishes completed articles while the remaining summary queue stays active', async () => {
    vi.useFakeTimers()
    try {
      const pendingSummary = deferred<unknown>()
      const id = 'a'.repeat(64)
      const processed = {
        id,
        source: 'aiera',
        title: 'Completed article',
        url: 'https://aiera.com.cn/completed',
        processedAt: '2026-09-06T02:00:00.000Z',
        category: 'other',
        duplicateOfCount: 0,
        summary: 'Ready to read.',
        importanceScore: 90,
      }
      const activeId = 'b'.repeat(64) as ArticleId
      const liveSnapshot = {
        ...emptySnapshot,
        articles: [processed],
        totalProcessed: 1,
        queue: [{
          id: activeId,
          source: 'aiera' as const,
          title: 'Article still being analyzed',
          url: 'https://aiera.com.cn/pending',
          status: 'pending' as const,
        }],
        totalQueued: 1,
      }
      const rpc = {
        call: vi.fn(async (_channel: string, endpoint: string) => {
          if (endpoint === aiDailyRpcMethod('summarize')) return await pendingSummary.promise
          if (endpoint === aiDailyRpcMethod('operation-status')) {
            return {
              ok: true,
              value: {
                progress: {
                  operation: 'summarize',
                  phase: 'analyzing',
                  startedAt: '2026-09-06T02:00:00.000Z',
                  completedArticles: 1,
                  totalArticles: 3,
                  currentArticleId: activeId,
                  currentArticleIndex: 2,
                  currentArticleTitle: 'Article still being analyzed',
                },
                snapshot: liveSnapshot,
              },
            }
          }
          if (endpoint === aiDailyRpcMethod('article')) {
            return {
              ok: true,
              value: {
                ...processed,
                detailedSummary: '## Completed',
                importanceReason: 'High impact.',
                modelProvider: 'test-provider',
                model: 'test-model',
              },
            }
          }
          throw new Error(`unexpected endpoint: ${endpoint}`)
        }),
      } as unknown as ClientConnectionRpc
      const controller = new DashboardController(rpc)

      const summary = controller.summarize()
      await vi.advanceTimersByTimeAsync(100)

      expect(controller.getSnapshot()).toMatchObject({
        operation: 'summarize',
        progress: { phase: 'analyzing', completedArticles: 1, totalArticles: 3 },
        snapshot: { totalProcessed: 1, articles: [{ title: 'Completed article' }] },
      })

      await controller.openArticle(id)
      expect(controller.getSnapshot()).toMatchObject({
        operation: 'summarize',
        selected: { title: 'Completed article', detailedSummary: '## Completed' },
      })

      pendingSummary.resolve({
        ok: true,
        value: {
          analysis: {
            processedCount: 3,
            failedCount: 0,
            failures: [],
          },
          snapshot: liveSnapshot,
        },
      })
      await summary
      expect(controller.getSnapshot()).toMatchObject({ operation: undefined, progress: undefined })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not duplicate an initial load when reopened while it is pending', async () => {
    const pending = deferred<unknown>()
    const rpc = {
      call: vi.fn(async () => await pending.promise),
    } as unknown as ClientConnectionRpc
    const controller = new DashboardController(rpc)

    controller.open()
    controller.close()
    controller.open()

    expect(rpc.call).toHaveBeenCalledOnce()
    expect(controller.getSnapshot()).toMatchObject({ open: true, activity: 'loading' })

    pending.resolve({ ok: true, value: emptySnapshot })
    await vi.waitFor(() => {
      expect(controller.getSnapshot()).toMatchObject({ open: true, activity: undefined })
    })
  })

  it('closes an open article before loading an explicitly selected date', async () => {
    const pendingDate = deferred<unknown>()
    const id = 'b'.repeat(64)
    let snapshotCalls = 0
    const rpc = {
      call: vi.fn(async (_channel: string, endpoint: string) => {
        if (endpoint === aiDailyRpcMethod('snapshot')) {
          snapshotCalls++
          if (snapshotCalls === 1) return { ok: true, value: emptySnapshot }
          return await pendingDate.promise
        }
        if (endpoint === aiDailyRpcMethod('article')) {
          return {
            ok: true,
            value: {
              id,
              source: 'aiera',
              title: 'Open article',
              url: 'https://aiera.com.cn/open-article',
              category: 'latest-papers',
              duplicateOfCount: 0,
              processedAt: '2026-09-06T02:00:00.000Z',
              summary: 'Short summary.',
              importanceScore: 80,
              detailedSummary: 'Detailed summary.',
              importanceReason: 'Important research.',
              modelProvider: 'test-provider',
              model: 'test-model',
            },
          }
        }
        throw new Error(`unexpected endpoint: ${endpoint}`)
      }),
    } as unknown as ClientConnectionRpc
    const controller = new DashboardController(rpc)

    await controller.load()
    await controller.openArticle(id)
    expect(controller.getSnapshot().selected?.id).toBe(id)

    const dateLoad = controller.load('2026-09-05')
    expect(controller.getSnapshot()).toMatchObject({ activity: 'loading', selected: undefined })
    pendingDate.resolve({
      ok: true,
      value: {
        ...emptySnapshot,
        digest: { ...emptySnapshot.digest, date: '2026-09-05' },
      },
    })
    await dateLoad
    expect(controller.getSnapshot()).toMatchObject({
      activity: undefined,
      selected: undefined,
      snapshot: { digest: { date: '2026-09-05' } },
    })
  })
})

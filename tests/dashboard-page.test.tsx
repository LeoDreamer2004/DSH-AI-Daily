// @vitest-environment jsdom

import { useSyncExternalStore, type ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardOverlay } from '../src/client/Dashboard.js'
import type { DashboardState } from '../src/client/controller.js'
import { zh } from '../src/client/locales.js'
import type { ArticleId } from '../src/types.js'

afterEach(cleanup)

function translate(key: keyof typeof zh, values?: Record<string, string | number>): string {
  let copy: string = zh[key]
  for (const [name, value] of Object.entries(values ?? {})) copy = copy.replace(`{${name}}`, String(value))
  return copy
}

function renderDashboard(state: DashboardState) {
  const store = createSnapshotStore(state)
  const useAiDaily = <Selected,>(selector: (snapshot: DashboardState) => Selected): Selected =>
    useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()))
  const crawl = vi.fn(async () => {})
  const summarize = vi.fn(async () => {})
  const retryFailures = vi.fn(async () => {})
  const props = {
    close: vi.fn(),
    crawl,
    dismissArticle: vi.fn(),
    dismissMessage: vi.fn(),
    load: vi.fn(),
    loadMore: vi.fn(),
    openArticle: vi.fn(),
    reanalyzeArticle: vi.fn(),
    retryFailures,
    setTrigger: vi.fn(),
    summarize,
    useAiDaily,
    t: translate,
  } as unknown as ComponentProps<typeof DashboardOverlay>
  render(<DashboardOverlay {...props} />)
  return { crawl, retryFailures, summarize }
}

function emptySnapshot(date = '2026-09-07') {
  return {
    currentDate: '2026-09-07',
    digest: {
      date,
      generatedAt: '2026-09-07T01:00:00.000Z',
      timeZone: 'Asia/Shanghai',
      articles: [],
    },
    sourceSettings: { aiera: true, jiqizhixin: true, qbitai: true },
    articles: [],
    totalProcessed: 0,
    queue: [],
    totalQueued: 0,
    totalFailed: 0,
  } as const
}

describe('AI Daily dashboard queue', () => {
  it('uses a natural completion message when a crawl finds no new articles', () => {
    renderDashboard({
      open: true,
      toast: { kind: 'crawl', discoveredCount: 0 },
      snapshot: emptySnapshot(),
    })

    expect(screen.getByRole('status').textContent).toContain('没有新增的文章。')
    expect(screen.getByRole('status').textContent).not.toContain('新增 0 篇')
  })

  it('keeps the selected date in the digest and starts crawling from the queue panel', () => {
    const { crawl } = renderDashboard({
      open: true,
      snapshot: emptySnapshot('2026-09-05'),
    })

    expect(screen.getByRole('dialog').textContent).not.toContain('刷新今天')
    expect((screen.getByLabelText('日报日期') as HTMLInputElement).value).toBe('2026-09-05')
    fireEvent.click(screen.getByRole('button', { name: '爬取所有文章' }))
    expect(crawl).toHaveBeenCalledWith('2026-09-05')
  })

  it('shows pending and failed articles together and retries all errors with one action', () => {
    const pendingId = 'a'.repeat(64) as ArticleId
    const failedId = 'b'.repeat(64) as ArticleId
    const { retryFailures, summarize } = renderDashboard({
      open: true,
      snapshot: {
        ...emptySnapshot(),
        queue: [{
          id: pendingId,
          source: 'qbitai',
          title: 'Pending article',
          url: 'https://www.qbitai.com/pending',
          excerpt: 'Rough metadata from the feed.',
          status: 'pending',
        }, {
          id: failedId,
          source: 'aiera',
          title: 'Failed article',
          url: 'https://aiera.com.cn/failed',
          status: 'failed',
          error: 'Model route was unavailable.',
        }],
        totalQueued: 2,
        totalFailed: 1,
      },
    })

    expect(screen.getByText('Rough metadata from the feed.')).toBeDefined()
    expect(screen.getByText('Model route was unavailable.')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '请求全部总结' }))
    expect(summarize).toHaveBeenCalledWith('2026-09-07')
    fireEvent.click(screen.getByRole('button', { name: '重试错误' }))
    expect(retryFailures).toHaveBeenCalledWith('2026-09-07')
  })

  it('renders model progress inside the active queue article', () => {
    const activeId = 'c'.repeat(64) as ArticleId
    renderDashboard({
      open: true,
      operation: 'summarize',
      progress: {
        operation: 'summarize',
        phase: 'analyzing',
        startedAt: '2026-09-07T01:00:00.000Z',
        completedArticles: 0,
        totalArticles: 1,
        currentArticleId: activeId,
        currentArticleIndex: 1,
        currentArticleTitle: 'Active article',
      },
      snapshot: {
        ...emptySnapshot(),
        queue: [{
          id: activeId,
          source: 'jiqizhixin',
          title: 'Active article',
          url: 'https://www.jiqizhixin.com/articles/active',
          status: 'pending',
        }],
        totalQueued: 1,
      },
    })

    const row = screen.getByText('Active article').closest('li')
    expect(row?.textContent).toContain('正在请求模型总结')
    expect(row?.querySelector('[aria-hidden="true"]')).not.toBeNull()
    expect((screen.getByLabelText('日报日期') as HTMLInputElement).disabled).toBe(false)
  })
})

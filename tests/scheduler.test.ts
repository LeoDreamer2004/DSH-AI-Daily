import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { AiDailyService } from '../src/service.js'
import { dueAutomaticRefreshDate, installAutomaticRefresh } from '../src/scheduler.js'

const config = {
  enabled: true,
  hour: 8,
  minute: 30,
  timeZone: 'Asia/Shanghai',
  maxArticles: 10,
  checkIntervalMs: 60_000,
}

describe('dueAutomaticRefreshDate', () => {
  it('becomes due at the configured local wall-clock time', () => {
    expect(dueAutomaticRefreshDate(new Date('2026-09-06T00:29:59.000Z'), config)).toBeUndefined()
    expect(dueAutomaticRefreshDate(new Date('2026-09-06T00:30:00.000Z'), config)).toBe('2026-09-06')
  })

  it('runs at most once per process-local date and honors disablement', () => {
    const now = new Date('2026-09-06T12:00:00.000Z')
    expect(dueAutomaticRefreshDate(now, config, '2026-09-06')).toBeUndefined()
    expect(dueAutomaticRefreshDate(now, { ...config, enabled: false })).toBeUndefined()
  })

  it('starts a due refresh once and registers a lifecycle timer', async () => {
    let check: (() => void) | undefined
    const dispose = vi.fn()
    const info = vi.fn()
    const error = vi.fn()
    const refresh = vi.fn(async () => ({ processedCount: 2, failedCount: 0 }))
    const ctx = {
      interval: (callback: () => void) => {
        check = callback
        return dispose
      },
      logger: { info, error },
    } as unknown as Context

    expect(installAutomaticRefresh(
      ctx,
      { refresh } as unknown as AiDailyService,
      config,
      () => new Date('2026-09-06T00:30:00.000Z'),
    )).toBe(dispose)
    await Promise.resolve()
    await Promise.resolve()

    expect(refresh).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledWith(10)
    expect(info).toHaveBeenCalledOnce()
    check?.()
    expect(refresh).toHaveBeenCalledOnce()
    expect(error).not.toHaveBeenCalled()
  })
})

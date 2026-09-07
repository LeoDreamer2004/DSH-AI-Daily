import type { Context } from '@deepseek-ai/cordis'
import { dateInTimeZone } from './digest.js'
import type { AiDailyService } from './service.js'

/** Automatic refresh timing and batch policy. */
export interface AutomaticRefreshConfig {
  readonly enabled: boolean
  readonly hour: number
  readonly minute: number
  readonly timeZone: string
  readonly maxArticles: number
  readonly checkIntervalMs: number
}

interface LocalClock {
  readonly date: string
  readonly hour: number
  readonly minute: number
}

function localClock(instant: Date, timeZone: string): LocalClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant)
  const value = (type: Intl.DateTimeFormatPartTypes): string => {
    const result = parts.find(part => part.type === type)?.value
    if (result === undefined) throw new Error(`ai-daily: clock formatter omitted '${type}'`)
    return result
  }
  return {
    date: dateInTimeZone(instant, timeZone),
    hour: Number(value('hour')),
    minute: Number(value('minute')),
  }
}

/**
 * Decide whether the configured daily wall-clock time has arrived.
 * @param instant - Current clock sample.
 * @param config - Resolved automatic refresh policy.
 * @param lastAttemptDate - Local date already attempted by this process.
 * @returns Local date to claim, or undefined when no run is due.
 */
export function dueAutomaticRefreshDate(
  instant: Date,
  config: AutomaticRefreshConfig,
  lastAttemptDate?: string,
): string | undefined {
  if (!config.enabled) return undefined
  const current = localClock(instant, config.timeZone)
  if (current.date === lastAttemptDate) return undefined
  if (current.hour < config.hour) return undefined
  if (current.hour === config.hour && current.minute < config.minute) return undefined
  return current.date
}

/**
 * Install a process-local daily refresh loop owned by the Cordis context.
 * @param ctx - Context providing lifecycle-bound timers and logging.
 * @param service - AI Daily service receiving refresh requests.
 * @param config - Resolved automatic refresh policy.
 * @param clock - Clock provider used by tests and production scheduling.
 * @returns Idempotent timer disposer.
 */
export function installAutomaticRefresh(
  ctx: Context,
  service: AiDailyService,
  config: AutomaticRefreshConfig,
  clock: () => Date = () => new Date(),
): () => void {
  if (!config.enabled) return () => {}
  let lastAttemptDate: string | undefined
  let running = false

  const check = (): void => {
    if (running) return
    const date = dueAutomaticRefreshDate(clock(), config, lastAttemptDate)
    if (date === undefined) return
    lastAttemptDate = date
    running = true
    void service.refresh(config.maxArticles).then((result) => {
      ctx.logger.info(
        `ai-daily: automatic refresh for ${date} completed with ${result.processedCount} processed and ${result.failedCount} failed`,
      )
    }, (error: unknown) => {
      ctx.logger.error(`ai-daily: automatic refresh for ${date} failed: ${String(error)}`)
    }).finally(() => {
      running = false
    })
  }

  check()
  return ctx.interval(check, config.checkIntervalMs)
}

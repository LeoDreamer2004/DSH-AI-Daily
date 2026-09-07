/** AI Daily service plugin for DeepSeek Harness. */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-client-connection'
import { registerDashboardRpc } from './dashboard/rpc.js'
import { installAutomaticRefresh } from './scheduler.js'
import {
  AI_DAILY_SETTINGS_NAMESPACE,
  AiDailySettingsSchema,
  sourceSettingsOf,
} from './settings.js'
import { AiDailyService } from './service.js'
import { ArticleRepository } from './storage/repository.js'
import { registerAiDailyTools } from './tools.js'

export * from './analysis/model.js'
export * from './digest.js'
export * from './dashboard/rpc.js'
export * from './dashboard/types.js'
export * from './scheduler.js'
export * from './settings.js'
export * from './service.js'
export * from './tools.js'
export * from './types.js'
export * from './url.js'
export * from './extraction/html.js'
export * from './sources/aiera.js'
export * from './sources/jiqizhixin.js'
export * from './sources/qbitai.js'
export * from './sources/types.js'
export * from './sources/wordpress-rss.js'
export * from './storage/repository.js'
export * from './storage/spec.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    aiDaily: AiDailyService
  }
}

/** Cordis plugin name. */
export const name = 'ai-daily'

/** Services required before the persistent source service can start. */
export const inject = ['web', 'storageDomain', 'settings', 'llm', 'tools', 'timer', 'connection'] as const

/** Plugin configuration. */
export interface Config {
  /** Aiera WordPress RSS feed URL. */
  readonly aieraFeedUrl?: string
  /** Whether Aiera discovery is enabled by default. */
  readonly aieraEnabled?: boolean
  /** Machine Heart public article-library listing API URL. */
  readonly jiqizhixinApiUrl?: string
  /** Whether Machine Heart discovery is enabled by default. */
  readonly jiqizhixinEnabled?: boolean
  /** QbitAI WordPress RSS feed URL. */
  readonly qbitFeedUrl?: string
  /** Whether QbitAI discovery is enabled by default. */
  readonly qbitaiEnabled?: boolean
  /** Maximum feed entries considered by one scan. */
  readonly maxFeedItems?: number
  /** Maximum normalized characters returned for one article. */
  readonly maxArticleChars?: number
  /** Timeout applied to each source request. */
  readonly requestTimeoutMs?: number
  /** Harness model-provider route used for article analysis. */
  readonly modelProvider?: string
  /** Harness model id used for article analysis. */
  readonly model?: string
  /** Maximum output tokens for one article analysis. */
  readonly maxAnalysisTokens?: number
  /** End-to-end timeout for one article analysis. */
  readonly modelTimeoutMs?: number
  /** Maximum articles analyzed by one refresh. */
  readonly maxArticlesPerRefresh?: number
  /** IANA time zone used to group articles into daily digests. */
  readonly timeZone?: string
  /** Whether to run one automatic refresh per local day. */
  readonly automaticRefresh?: boolean
  /** Local hour for automatic refresh. */
  readonly dailyHour?: number
  /** Local minute for automatic refresh. */
  readonly dailyMinute?: number
  /** Scheduler polling interval. */
  readonly schedulerCheckIntervalMs?: number
}

/** Runtime validation and defaults for plugin configuration. */
type ResolvedConfig = Required<Config>

const MAX_TIMER_DELAY_MS = 2_147_483_647

const DEFAULT_CONFIG: ResolvedConfig = {
  aieraFeedUrl: 'https://aiera.com.cn/feed/',
  aieraEnabled: true,
  jiqizhixinApiUrl: 'https://www.jiqizhixin.com/api/article_library/articles.json?sort=time&page=1',
  jiqizhixinEnabled: true,
  qbitFeedUrl: 'https://www.qbitai.com/feed/',
  qbitaiEnabled: true,
  maxFeedItems: 50,
  maxArticleChars: 50_000,
  requestTimeoutMs: 30_000,
  modelProvider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  maxAnalysisTokens: 16_384,
  modelTimeoutMs: 120_000,
  maxArticlesPerRefresh: 20,
  timeZone: 'Asia/Shanghai',
  automaticRefresh: true,
  dailyHour: 8,
  dailyMinute: 0,
  schedulerCheckIntervalMs: 60_000,
}

export const Config: Schema<Config> = Schema.object({
  aieraFeedUrl: Schema.string().default(DEFAULT_CONFIG.aieraFeedUrl),
  aieraEnabled: Schema.boolean().default(DEFAULT_CONFIG.aieraEnabled),
  jiqizhixinApiUrl: Schema.string().default(DEFAULT_CONFIG.jiqizhixinApiUrl),
  jiqizhixinEnabled: Schema.boolean().default(DEFAULT_CONFIG.jiqizhixinEnabled),
  qbitFeedUrl: Schema.string().default(DEFAULT_CONFIG.qbitFeedUrl),
  qbitaiEnabled: Schema.boolean().default(DEFAULT_CONFIG.qbitaiEnabled),
  maxFeedItems: Schema.number().default(DEFAULT_CONFIG.maxFeedItems),
  maxArticleChars: Schema.number().default(DEFAULT_CONFIG.maxArticleChars),
  requestTimeoutMs: Schema.number().default(DEFAULT_CONFIG.requestTimeoutMs),
  modelProvider: Schema.string().default(DEFAULT_CONFIG.modelProvider),
  model: Schema.string().default(DEFAULT_CONFIG.model),
  maxAnalysisTokens: Schema.number().default(DEFAULT_CONFIG.maxAnalysisTokens),
  modelTimeoutMs: Schema.number().default(DEFAULT_CONFIG.modelTimeoutMs),
  maxArticlesPerRefresh: Schema.number().default(DEFAULT_CONFIG.maxArticlesPerRefresh),
  timeZone: Schema.string().default(DEFAULT_CONFIG.timeZone),
  automaticRefresh: Schema.boolean().default(DEFAULT_CONFIG.automaticRefresh),
  dailyHour: Schema.number().default(DEFAULT_CONFIG.dailyHour),
  dailyMinute: Schema.number().default(DEFAULT_CONFIG.dailyMinute),
  schedulerCheckIntervalMs: Schema.number().default(DEFAULT_CONFIG.schedulerCheckIntervalMs),
})

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`ai-daily: ${name} must be a positive safe integer`)
  }
}

/** Open durable state and provide the AI Daily service. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved: ResolvedConfig = { ...DEFAULT_CONFIG, ...config }
  assertPositiveInteger('maxFeedItems', resolved.maxFeedItems)
  assertPositiveInteger('maxArticleChars', resolved.maxArticleChars)
  assertPositiveInteger('requestTimeoutMs', resolved.requestTimeoutMs)
  assertPositiveInteger('maxAnalysisTokens', resolved.maxAnalysisTokens)
  assertPositiveInteger('modelTimeoutMs', resolved.modelTimeoutMs)
  assertPositiveInteger('maxArticlesPerRefresh', resolved.maxArticlesPerRefresh)
  assertPositiveInteger('schedulerCheckIntervalMs', resolved.schedulerCheckIntervalMs)
  assertMaximum('requestTimeoutMs', resolved.requestTimeoutMs, MAX_TIMER_DELAY_MS)
  assertMaximum('modelTimeoutMs', resolved.modelTimeoutMs, MAX_TIMER_DELAY_MS)
  assertMaximum('schedulerCheckIntervalMs', resolved.schedulerCheckIntervalMs, MAX_TIMER_DELAY_MS)
  assertRange('dailyHour', resolved.dailyHour, 0, 23)
  assertRange('dailyMinute', resolved.dailyMinute, 0, 59)
  assertNonEmpty('modelProvider', resolved.modelProvider)
  assertNonEmpty('model', resolved.model)
  assertTimeZone(resolved.timeZone)
  canonicalFeedUrl('aieraFeedUrl', resolved.aieraFeedUrl)
  canonicalFeedUrl('jiqizhixinApiUrl', resolved.jiqizhixinApiUrl)
  canonicalFeedUrl('qbitFeedUrl', resolved.qbitFeedUrl)

  const settings = ctx.settings.register(
    AI_DAILY_SETTINGS_NAMESPACE,
    AiDailySettingsSchema,
    {
      base: {
        aiera: resolved.aieraEnabled,
        jiqizhixin: resolved.jiqizhixinEnabled,
        qbitai: resolved.qbitaiEnabled,
        modelProvider: resolved.modelProvider,
        model: resolved.model,
      },
      applies: 'live',
    },
  )
  const repository = await ArticleRepository.open(ctx.storageDomain)
  const service = new AiDailyService(ctx.web, ctx.llm, repository, {
    ...resolved,
    sourceSettings: sourceSettingsOf(settings.get()),
  }, undefined, undefined, ctx.logger)
  service.setSettings(settings.get())
  ctx.provide('aiDaily', service)
  ctx.effect(() => () => service.close(), 'ai-daily.close()')
  ctx.effect(
    () => settings.watch(next => { service.setSettings(next) }),
    'ai-daily: live settings',
  )
  registerDashboardRpc(ctx, service)
  registerAiDailyTools(ctx, service, resolved.maxArticlesPerRefresh)
  installAutomaticRefresh(ctx, service, {
    enabled: resolved.automaticRefresh,
    hour: resolved.dailyHour,
    minute: resolved.dailyMinute,
    timeZone: resolved.timeZone,
    maxArticles: resolved.maxArticlesPerRefresh,
    checkIntervalMs: resolved.schedulerCheckIntervalMs,
  })
}

function assertMaximum(name: string, value: number, maximum: number): void {
  if (value > maximum) throw new RangeError(`ai-daily: ${name} must not exceed ${maximum}`)
}

function assertRange(name: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`ai-daily: ${name} must be an integer from ${minimum} through ${maximum}`)
  }
}

function assertNonEmpty(name: string, value: string): void {
  if (value.trim() === '') throw new TypeError(`ai-daily: ${name} must not be empty`)
}

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format()
  } catch (error) {
    throw new TypeError(`ai-daily: timeZone '${timeZone}' is not a valid IANA time zone`, { cause: error })
  }
}

function canonicalFeedUrl(name: string, input: string): void {
  const url = new URL(input)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`ai-daily: ${name} must use HTTP(S)`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError(`ai-daily: ${name} must not contain credentials`)
  }
}

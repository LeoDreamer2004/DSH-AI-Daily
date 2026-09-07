import type { ArticleSource } from './types.js'

/** Persistent Harness settings namespace owned by AI Daily. */
export const AI_DAILY_SETTINGS_NAMESPACE = 'ai-daily'

/** Live source-selection settings used by discovery and analysis. */
export interface AiDailySourceSettings {
  readonly aiera: boolean
  readonly jiqizhixin: boolean
  readonly qbitai: boolean
}

/** Harness model route used for news analysis. */
export interface AiDailyModelSelection {
  readonly modelProvider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Complete user-editable AI Daily settings. */
export interface AiDailySettings extends AiDailySourceSettings, AiDailyModelSelection {}

/** Default source selection when neither composition nor user settings override it. */
export const DEFAULT_SOURCE_SETTINGS: AiDailySourceSettings = {
  aiera: true,
  jiqizhixin: true,
  qbitai: true,
}

/** Return whether one publisher is enabled in a source-selection snapshot. */
export function sourceIsEnabled(settings: AiDailySourceSettings, source: ArticleSource): boolean {
  return settings[source]
}

/** Project source switches from the complete settings document. */
export function sourceSettingsOf(settings: AiDailySettings): AiDailySourceSettings {
  return {
    aiera: settings.aiera,
    jiqizhixin: settings.jiqizhixin,
    qbitai: settings.qbitai,
  }
}

/** Project the model route from the complete settings document. */
export function modelSelectionOf(settings: AiDailySettings): AiDailyModelSelection {
  return {
    modelProvider: settings.modelProvider,
    model: settings.model,
    ...(settings.reasoningEffort === undefined ? {} : { reasoningEffort: settings.reasoningEffort }),
  }
}

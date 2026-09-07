import Schema from '@deepseek-ai/schemastery'
import {
  DEFAULT_SOURCE_SETTINGS,
  type AiDailySettings,
} from './settings-contract.js'

export {
  AI_DAILY_SETTINGS_NAMESPACE,
  DEFAULT_SOURCE_SETTINGS,
  modelSelectionOf,
  sourceIsEnabled,
  sourceSettingsOf,
  type AiDailyModelSelection,
  type AiDailySettings,
  type AiDailySourceSettings,
} from './settings-contract.js'

/** Runtime schema exposed through the Harness Settings service. */
export const AiDailySettingsSchema: Schema<AiDailySettings> = Schema.object({
  aiera: Schema.boolean().default(DEFAULT_SOURCE_SETTINGS.aiera),
  jiqizhixin: Schema.boolean().default(DEFAULT_SOURCE_SETTINGS.jiqizhixin),
  qbitai: Schema.boolean().default(DEFAULT_SOURCE_SETTINGS.qbitai),
  modelProvider: Schema.string().required(),
  model: Schema.string().required(),
  reasoningEffort: Schema.string(),
})

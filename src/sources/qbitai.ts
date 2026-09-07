import type { WebRuntime } from '@deepseek-ai/dsh-web'
import type { DiscoveredArticle } from '../types.js'
import {
  parseWordPressFeed,
  WordPressRssSource,
  WordPressRssSourceError,
  type WordPressRssSourceConfig,
  type WordPressRssSourceErrorCode,
} from './wordpress-rss.js'

/** Source-specific configuration resolved from plugin config. */
export type QbitSourceConfig = WordPressRssSourceConfig

/** Stable failure codes exposed by the QbitAI adapter. */
export type QbitSourceErrorCode = WordPressRssSourceErrorCode

/** Error constructor exposed for QbitAI consumers. */
export type QbitSourceError = WordPressRssSourceError
export const QbitSourceError = WordPressRssSourceError

const QBIT_DESCRIPTOR = {
  source: 'qbitai',
  label: 'QbitAI',
  allowedHostnames: ['qbitai.com'],
} as const

/** Parse the QbitAI WordPress RSS feed into normalized discovery records. */
export function parseQbitFeed(xml: string, feedUrl: string, maxItems: number): readonly DiscoveredArticle[] {
  return parseWordPressFeed(xml, feedUrl, maxItems, QBIT_DESCRIPTOR)
}

/** QbitAI RSS discovery and article-reading adapter over the Harness web seam. */
export class QbitSource extends WordPressRssSource {
  constructor(web: Pick<WebRuntime, 'fetch'>, config: QbitSourceConfig) {
    super(web, config, QBIT_DESCRIPTOR)
  }
}

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
export type AieraSourceConfig = WordPressRssSourceConfig

/** Stable failure codes exposed by the Aiera adapter. */
export type AieraSourceErrorCode = WordPressRssSourceErrorCode

/** Backwards-compatible error constructor for Aiera consumers. */
export type AieraSourceError = WordPressRssSourceError
export const AieraSourceError = WordPressRssSourceError

const AIERA_DESCRIPTOR = {
  source: 'aiera',
  label: 'Aiera',
  allowedHostnames: ['aiera.com.cn'],
} as const

/** Parse the Aiera WordPress RSS feed into normalized discovery records. */
export function parseAieraFeed(xml: string, feedUrl: string, maxItems: number): readonly DiscoveredArticle[] {
  return parseWordPressFeed(xml, feedUrl, maxItems, AIERA_DESCRIPTOR)
}

/** Aiera RSS discovery and article-reading adapter over the Harness web seam. */
export class AieraSource extends WordPressRssSource {
  constructor(web: Pick<WebRuntime, 'fetch'>, config: AieraSourceConfig) {
    super(web, config, AIERA_DESCRIPTOR)
  }
}

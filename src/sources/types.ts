import type { ArticleDocument, ArticleSource, DiscoveredArticle } from '../types.js'

/** Common media-source adapter contract. */
export interface ArticleSourceAdapter {
  /** Stable source id owned by this adapter. */
  readonly source: ArticleSource
  /** Discover current article metadata without mutating durable state. */
  discover(signal?: AbortSignal): Promise<readonly DiscoveredArticle[]>
  /** Retrieve and normalize one discovered article. */
  read(article: DiscoveredArticle, signal?: AbortSignal): Promise<ArticleDocument>
}

import { XMLParser, XMLValidator } from 'fast-xml-parser'
import type { WebFetchResult, WebRuntime } from '@deepseek-ai/dsh-web'
import { extractHtmlArticle, htmlToText } from '../extraction/html.js'
import type { ArticleDocument, ArticleSource, DiscoveredArticle } from '../types.js'
import { canonicalizeArticleUrl } from '../url.js'
import type { ArticleSourceAdapter } from './types.js'

/** Shared limits for a public WordPress RSS source. */
export interface WordPressRssSourceConfig {
  readonly feedUrl: string
  readonly maxFeedItems: number
  readonly maxArticleChars: number
  readonly requestTimeoutMs: number
}

/** Stable failure codes exposed by WordPress RSS adapters. */
export type WordPressRssSourceErrorCode =
  | 'HTTP_ERROR'
  | 'INVALID_FEED'
  | 'EMPTY_CONTENT'
  | 'TRUNCATED_RESPONSE'

/** Error raised when a WordPress RSS source cannot be represented safely. */
export class WordPressRssSourceError extends Error {
  constructor(
    readonly code: WordPressRssSourceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'WordPressRssSourceError'
  }
}

/** Stable identity and trust boundary for one WordPress publisher. */
export interface WordPressRssSourceDescriptor {
  readonly source: ArticleSource
  readonly label: string
  readonly allowedHostnames: readonly string[]
}

type XmlRecord = Record<string, unknown>

function isRecord(value: unknown): value is XmlRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim()
    return text === '' ? undefined : text
  }
  if (Array.isArray(value)) return textOf(value[0])
  if (!isRecord(value)) return undefined
  return textOf(value['#text'])
}

function decodeXmlCharacterReferences(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([a-f0-9]+)|(amp|apos|gt|lt|quot));/gi,
    (reference, decimal: string | undefined, hexadecimal: string | undefined, named: string | undefined) => {
      const codePoint = decimal === undefined
        ? hexadecimal === undefined ? undefined : Number.parseInt(hexadecimal, 16)
        : Number.parseInt(decimal, 10)
      if (codePoint !== undefined) {
        try {
          return String.fromCodePoint(codePoint)
        } catch {
          return reference
        }
      }
      switch (named?.toLowerCase()) {
        case 'amp': return '&'
        case 'apos': return "'"
        case 'gt': return '>'
        case 'lt': return '<'
        case 'quot': return '"'
        default: return reference
      }
    },
  )
}

function normalizedInstant(value: unknown): string | undefined {
  const text = textOf(value)
  if (text === undefined) return undefined
  const timestamp = Date.parse(text)
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString()
}

function feedItems(document: unknown): readonly XmlRecord[] {
  if (!isRecord(document)) return []
  const rss = document.rss
  if (!isRecord(rss)) return []
  const channel = rss.channel
  if (!isRecord(channel)) return []
  const items = channel.item
  if (Array.isArray(items)) return items.filter(isRecord)
  return isRecord(items) ? [items] : []
}

function hasAllowedHostname(url: string, allowedHostnames: readonly string[]): boolean {
  const hostname = new URL(url).hostname.toLowerCase()
  return allowedHostnames.some(allowed => {
    const normalized = allowed.toLowerCase()
    return hostname === normalized || hostname.endsWith(`.${normalized}`)
  })
}

/** Parse an untrusted WordPress RSS document into source-scoped discovery records. */
export function parseWordPressFeed(
  xml: string,
  feedUrl: string,
  maxItems: number,
  descriptor: WordPressRssSourceDescriptor,
): readonly DiscoveredArticle[] {
  if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
    throw new RangeError('maxItems must be a positive safe integer')
  }

  let parsed: unknown
  const validation = XMLValidator.validate(xml)
  if (validation !== true) {
    throw new WordPressRssSourceError(
      'INVALID_FEED',
      `${descriptor.label} feed is not valid XML: ${validation.err.msg}`,
    )
  }
  try {
    parsed = new XMLParser({
      ignoreAttributes: false,
      processEntities: false,
      trimValues: false,
    }).parse(xml)
  } catch (error) {
    throw new WordPressRssSourceError(
      'INVALID_FEED',
      `${descriptor.label} feed is not valid XML`,
      { cause: error },
    )
  }

  const results: DiscoveredArticle[] = []
  for (const item of feedItems(parsed)) {
    if (results.length >= maxItems) break
    const titleHtml = textOf(item.title)
    const link = textOf(item.link)
    if (titleHtml === undefined || link === undefined) continue

    let canonicalUrl: string
    let url: string
    try {
      url = new URL(decodeXmlCharacterReferences(link), feedUrl).href
      canonicalUrl = canonicalizeArticleUrl(url)
      if (!hasAllowedHostname(canonicalUrl, descriptor.allowedHostnames)) continue
    } catch {
      continue
    }

    const title = htmlToText(titleHtml, 500)
    if (title === '') continue
    const publishedAt = normalizedInstant(item.pubDate)
    const author = textOf(item['dc:creator'])?.slice(0, 500)
    const description = textOf(item.description)
    const excerpt = description === undefined ? undefined : htmlToText(description, 1_000)

    results.push({
      source: descriptor.source,
      url,
      canonicalUrl,
      title,
      ...(publishedAt === undefined ? {} : { publishedAt }),
      ...(author === undefined ? {} : { author }),
      ...(excerpt === undefined || excerpt === '' ? {} : { excerpt }),
    })
  }

  if (results.length === 0) {
    throw new WordPressRssSourceError(
      'INVALID_FEED',
      `${descriptor.label} feed contains no valid article entries`,
    )
  }
  return results
}

function containsCompleteArticleElement(html: string): boolean {
  const articleStart = html.search(/<article(?:\s|>)/i)
  if (articleStart < 0) return false
  return /<\/article\s*>/i.test(html.slice(articleStart))
}

function responseText(
  response: WebFetchResult,
  resource: string,
  allowCompleteTruncatedArticle = false,
): string {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new WordPressRssSourceError('HTTP_ERROR', `${resource} returned HTTP ${response.statusCode}`)
  }
  if (response.body.content.trim() === '') {
    throw new WordPressRssSourceError('EMPTY_CONTENT', `${resource} returned an empty body`)
  }
  const hasCompleteArticle = allowCompleteTruncatedArticle
    && response.body.kind === 'html'
    && containsCompleteArticleElement(response.body.content)
  if (response.truncated && !hasCompleteArticle) {
    throw new WordPressRssSourceError('TRUNCATED_RESPONSE', `${resource} response was truncated`)
  }
  return response.body.content
}

/** Public WordPress RSS discovery and article reader over the Harness web seam. */
export class WordPressRssSource implements ArticleSourceAdapter {
  readonly source: ArticleSource

  constructor(
    private readonly web: Pick<WebRuntime, 'fetch'>,
    private readonly config: WordPressRssSourceConfig,
    private readonly descriptor: WordPressRssSourceDescriptor,
  ) {
    this.source = descriptor.source
  }

  async discover(signal?: AbortSignal): Promise<readonly DiscoveredArticle[]> {
    const response = await this.fetch(this.config.feedUrl, signal)
    return parseWordPressFeed(
      responseText(response, `${this.descriptor.label} feed`),
      this.config.feedUrl,
      this.config.maxFeedItems,
      this.descriptor,
    )
  }

  async read(article: DiscoveredArticle, signal?: AbortSignal): Promise<ArticleDocument> {
    if (article.source !== this.source) {
      throw new TypeError(`${this.descriptor.label}Source cannot read source '${article.source}'`)
    }
    if (!hasAllowedHostname(article.canonicalUrl, this.descriptor.allowedHostnames)) {
      throw new TypeError(`${this.descriptor.label}Source cannot read an article outside its publisher domain`)
    }
    const response = await this.fetch(article.canonicalUrl, signal)
    const extracted = extractHtmlArticle(
      responseText(response, `${this.descriptor.label} article`, true),
      this.config.maxArticleChars,
    )
    if (extracted.content === '') {
      throw new WordPressRssSourceError(
        'EMPTY_CONTENT',
        `${this.descriptor.label} article contains no readable text`,
      )
    }

    return {
      ...article,
      title: extracted.title ?? article.title,
      ...(extracted.author === undefined ? {} : { author: extracted.author }),
      ...(extracted.publishedAt === undefined ? {} : { publishedAt: extracted.publishedAt }),
      content: extracted.content,
      contentHash: extracted.contentHash,
    }
  }

  private fetch(url: string, signal?: AbortSignal): Promise<WebFetchResult> {
    const timeoutSignal = AbortSignal.timeout(this.config.requestTimeoutMs)
    const combinedSignal = signal === undefined
      ? timeoutSignal
      : AbortSignal.any([signal, timeoutSignal])
    return this.web.fetch({ url }, combinedSignal)
  }
}

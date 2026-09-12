import { createHash } from 'node:crypto'
import type { WebRuntime } from '@deepseek-ai/dsh-web'
import { z } from 'zod'
import { htmlToText } from '../extraction/html.js'
import type { ArticleDocument, DiscoveredArticle } from '../types.js'
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

const AIERA_ORIGIN = 'https://aiera.com.cn'

const aieraPostSchema = z.object({
  id: z.number().int().positive(),
  date: z.string().optional(),
  date_gmt: z.string().optional(),
  title: z.object({ rendered: z.string().min(1) }),
  content: z.object({ rendered: z.string().min(1) }),
  _embedded: z.object({
    author: z.array(z.object({ name: z.string().trim().min(1).max(500) })).optional(),
  }).optional(),
})

function aieraPostId(urlValue: string): number | undefined {
  let url: URL
  try {
    url = new URL(urlValue)
  } catch {
    return undefined
  }
  const hostname = url.hostname.toLowerCase()
  if (hostname !== 'aiera.com.cn' && !hostname.endsWith('.aiera.com.cn')) return undefined

  const queryId = url.searchParams.get('id')
  const pathId = /\/(?:admin|editor)\/(\d+)(?:\/|$)/i.exec(url.pathname)?.[1]
  const idText = queryId ?? pathId
  if (idText === undefined || !/^\d+$/.test(idText)) return undefined
  const id = Number(idText)
  return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

function normalizedPostInstant(dateGmt: string | undefined, date: string | undefined): string | undefined {
  const gmt = dateGmt?.trim()
  const local = date?.trim()
  const raw = gmt || local
  if (raw === undefined || raw === '') return undefined
  const hasTimeZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)
  if ((gmt === undefined || gmt === '') && !hasTimeZone) return undefined
  const value = hasTimeZone ? raw : `${raw}Z`
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString()
}

/** Return whether an extracted Aiera body is only the site's client-rendering placeholder. */
export function isAieraPlaceholderContent(content: string): boolean {
  const normalized = content.replace(/\s+/g, '')
  return /^正在(?:取|获取|加载)这篇(?:稿子|文章)(?:\.{3}|…|。)*$/u.test(normalized)
}

/** Parse an official Aiera WordPress post response into a model-safe document. */
export function parseAieraPost(
  json: string,
  article: DiscoveredArticle,
  expectedPostId: number,
  maxArticleChars: number,
): ArticleDocument {
  if (!Number.isSafeInteger(maxArticleChars) || maxArticleChars < 1) {
    throw new RangeError('maxArticleChars must be a positive safe integer')
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(json)
  } catch (error) {
    throw new WordPressRssSourceError(
      'INVALID_RESPONSE',
      'Aiera article API did not return valid JSON',
      { cause: error },
    )
  }
  const parsed = aieraPostSchema.safeParse(decoded)
  if (!parsed.success || parsed.data.id !== expectedPostId) {
    throw new WordPressRssSourceError(
      'INVALID_RESPONSE',
      `Aiera article API returned an unsupported response: ${parsed.success ? 'post id mismatch' : z.prettifyError(parsed.error)}`,
      { cause: parsed.success ? undefined : parsed.error },
    )
  }

  const completeContent = htmlToText(parsed.data.content.rendered, Number.MAX_SAFE_INTEGER)
  if (completeContent === '' || isAieraPlaceholderContent(completeContent)) {
    throw new WordPressRssSourceError(
      'EMPTY_CONTENT',
      'Aiera article API contains no readable article text',
    )
  }
  const title = htmlToText(parsed.data.title.rendered, 500)
  if (title === '') {
    throw new WordPressRssSourceError('INVALID_RESPONSE', 'Aiera article API contains no readable title')
  }
  const author = parsed.data._embedded?.author?.[0]?.name
  const publishedAt = normalizedPostInstant(parsed.data.date_gmt, parsed.data.date)

  return {
    ...article,
    title,
    ...(author === undefined ? {} : { author }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
    content: completeContent.slice(0, maxArticleChars),
    contentHash: createHash('sha256').update(completeContent).digest('hex'),
  }
}

/** Parse the Aiera WordPress RSS feed into normalized discovery records. */
export function parseAieraFeed(xml: string, feedUrl: string, maxItems: number): readonly DiscoveredArticle[] {
  return parseWordPressFeed(xml, feedUrl, maxItems, AIERA_DESCRIPTOR)
}

/** Aiera RSS discovery and article reader with a fallback for its client-rendered article pages. */
export class AieraSource {
  readonly source = 'aiera' as const
  private readonly htmlSource: WordPressRssSource

  constructor(
    private readonly web: Pick<WebRuntime, 'fetch'>,
    private readonly config: AieraSourceConfig,
  ) {
    this.htmlSource = new WordPressRssSource(web, config, AIERA_DESCRIPTOR)
  }

  discover(signal?: AbortSignal): Promise<readonly DiscoveredArticle[]> {
    return this.htmlSource.discover(signal)
  }

  async read(article: DiscoveredArticle, signal?: AbortSignal): Promise<ArticleDocument> {
    if (article.source !== this.source) {
      throw new TypeError(`AieraSource cannot read source '${article.source}'`)
    }
    const htmlDocument = await this.htmlSource.read(article, signal)
    if (!isAieraPlaceholderContent(htmlDocument.content)) return htmlDocument

    const postId = aieraPostId(article.canonicalUrl) ?? aieraPostId(article.url)
    if (postId === undefined) {
      throw new WordPressRssSourceError(
        'INVALID_RESPONSE',
        'Aiera article page contains a loading placeholder but its WordPress post id is unavailable',
      )
    }
    const response = await this.fetch(`${AIERA_ORIGIN}/wp-json/wp/v2/posts/${postId}?_embed=1`, signal)
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new WordPressRssSourceError(
        'HTTP_ERROR',
        `Aiera article API returned HTTP ${response.statusCode}`,
      )
    }
    if (response.body.content.trim() === '') {
      throw new WordPressRssSourceError('EMPTY_CONTENT', 'Aiera article API returned an empty body')
    }
    if (response.truncated) {
      throw new WordPressRssSourceError('TRUNCATED_RESPONSE', 'Aiera article API response was truncated')
    }
    return parseAieraPost(response.body.content, article, postId, this.config.maxArticleChars)
  }

  private fetch(url: string, signal?: AbortSignal) {
    const timeoutSignal = AbortSignal.timeout(this.config.requestTimeoutMs)
    const combinedSignal = signal === undefined
      ? timeoutSignal
      : AbortSignal.any([signal, timeoutSignal])
    return this.web.fetch({ url }, combinedSignal)
  }
}

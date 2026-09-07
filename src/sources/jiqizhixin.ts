import { createHash } from 'node:crypto'
import type { WebFetchResult, WebRuntime } from '@deepseek-ai/dsh-web'
import { z } from 'zod'
import { htmlToText } from '../extraction/html.js'
import type { ArticleDocument, DiscoveredArticle } from '../types.js'
import { canonicalizeArticleUrl } from '../url.js'
import type { ArticleSourceAdapter } from './types.js'

const PUBLIC_ORIGIN = 'https://www.jiqizhixin.com'
const ARTICLE_PATH_PREFIX = '/articles/'
const ARTICLE_API_PATH_PREFIX = '/api/article_library/articles/'

/** Source-specific configuration for the Machine Heart article-library API. */
export interface JiqizhixinSourceConfig {
  readonly listUrl: string
  readonly maxItems: number
  readonly maxArticleChars: number
  readonly requestTimeoutMs: number
}

/** Stable failure codes exposed by the Machine Heart adapter. */
export type JiqizhixinSourceErrorCode =
  | 'HTTP_ERROR'
  | 'INVALID_RESPONSE'
  | 'EMPTY_CONTENT'
  | 'TRUNCATED_RESPONSE'

/** Error raised when a Machine Heart response cannot be represented safely. */
export class JiqizhixinSourceError extends Error {
  constructor(
    readonly code: JiqizhixinSourceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'JiqizhixinSourceError'
  }
}

const listArticleSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().trim().min(1).max(500),
  slug: z.string().trim().min(1).max(300),
  publishedAt: z.string().max(100).optional(),
  author: z.string().trim().min(1).max(500).optional(),
  content: z.string().max(20_000).optional(),
})

const listResponseSchema = z.object({
  success: z.literal(true),
  articles: z.array(listArticleSchema),
})

const detailResponseSchema = z.object({
  title: z.string().trim().min(1).max(500),
  author: z.object({
    name: z.string().trim().min(1).max(500),
  }).optional(),
  published_at: z.string().max(100).optional(),
  content: z.string().min(1),
})

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
}

function responseText(response: WebFetchResult, resource: string): string {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new JiqizhixinSourceError('HTTP_ERROR', `${resource} returned HTTP ${response.statusCode}`)
  }
  if (response.body.content.trim() === '') {
    throw new JiqizhixinSourceError('EMPTY_CONTENT', `${resource} returned an empty body`)
  }
  if (response.truncated) {
    throw new JiqizhixinSourceError('TRUNCATED_RESPONSE', `${resource} response was truncated`)
  }
  return response.body.content
}

function parseJson(text: string, resource: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new JiqizhixinSourceError(
      'INVALID_RESPONSE',
      `${resource} did not return valid JSON`,
      { cause: error },
    )
  }
}

function parseWithSchema<T>(schema: z.ZodType<T>, text: string, resource: string): T {
  const result = schema.safeParse(parseJson(text, resource))
  if (!result.success) {
    throw new JiqizhixinSourceError(
      'INVALID_RESPONSE',
      `${resource} returned an unsupported response structure: ${z.prettifyError(result.error)}`,
      { cause: result.error },
    )
  }
  return result.data
}

function normalizedShanghaiInstant(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const match = /^(\d{4})[/-](\d{2})[/-](\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim())
  if (match === null) return undefined

  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '00'] = match
  if (
    yearText === undefined
    || monthText === undefined
    || dayText === undefined
    || hourText === undefined
    || minuteText === undefined
  ) return undefined
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return undefined
  }

  const instant = new Date(`${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}+08:00`)
  if (Number.isNaN(instant.getTime())) return undefined
  const shanghaiWallClock = new Date(instant.getTime() + 8 * 60 * 60 * 1_000)
  if (
    shanghaiWallClock.getUTCFullYear() !== year
    || shanghaiWallClock.getUTCMonth() + 1 !== month
    || shanghaiWallClock.getUTCDate() !== day
    || shanghaiWallClock.getUTCHours() !== hour
    || shanghaiWallClock.getUTCMinutes() !== minute
    || shanghaiWallClock.getUTCSeconds() !== second
  ) return undefined
  return instant.toISOString()
}

function safeSlug(value: string): string | undefined {
  const slug = value.trim()
  if (slug === '' || slug === '.' || slug === '..' || slug.includes('/') || slug.includes('\\')) {
    return undefined
  }
  return slug
}

function publicArticleUrl(slug: string): string {
  return canonicalizeArticleUrl(new URL(`${ARTICLE_PATH_PREFIX}${encodeURIComponent(slug)}`, PUBLIC_ORIGIN).href)
}

function slugFromArticle(article: DiscoveredArticle): string {
  const url = new URL(article.canonicalUrl)
  if (url.origin !== PUBLIC_ORIGIN || !url.pathname.startsWith(ARTICLE_PATH_PREFIX)) {
    throw new TypeError('JiqizhixinSource cannot read an article outside the Machine Heart article library')
  }
  const encodedSlug = url.pathname.slice(ARTICLE_PATH_PREFIX.length).replace(/\/$/, '')
  if (encodedSlug === '' || encodedSlug.includes('/')) {
    throw new TypeError('JiqizhixinSource received an invalid Machine Heart article URL')
  }
  let decodedSlug: string
  try {
    decodedSlug = decodeURIComponent(encodedSlug)
  } catch (error) {
    throw new TypeError('JiqizhixinSource received an invalid encoded article slug', { cause: error })
  }
  const slug = safeSlug(decodedSlug)
  if (slug === undefined) throw new TypeError('JiqizhixinSource received an unsafe article slug')
  return slug
}

/** Parse the public article-library listing into normalized discovery records. */
export function parseJiqizhixinListing(
  json: string,
  maxItems: number,
): readonly DiscoveredArticle[] {
  assertPositiveInteger('maxItems', maxItems)
  const response = parseWithSchema(listResponseSchema, json, 'Machine Heart article listing')
  const articles: DiscoveredArticle[] = []
  const seenUrls = new Set<string>()

  for (const item of response.articles) {
    if (articles.length >= maxItems) break
    const slug = safeSlug(item.slug)
    if (slug === undefined) continue
    const canonicalUrl = publicArticleUrl(slug)
    if (seenUrls.has(canonicalUrl)) continue
    seenUrls.add(canonicalUrl)
    const publishedAt = normalizedShanghaiInstant(item.publishedAt)
    const excerpt = item.content === undefined ? undefined : htmlToText(item.content, 1_000)

    articles.push({
      source: 'jiqizhixin',
      url: canonicalUrl,
      canonicalUrl,
      title: item.title.trim(),
      ...(publishedAt === undefined ? {} : { publishedAt }),
      ...(item.author === undefined ? {} : { author: item.author.trim() }),
      ...(excerpt === undefined || excerpt === '' ? {} : { excerpt }),
    })
  }
  return articles
}

/** Parse one article-detail response into a model-safe document. */
export function parseJiqizhixinArticle(
  json: string,
  article: DiscoveredArticle,
  maxArticleChars: number,
): ArticleDocument {
  assertPositiveInteger('maxArticleChars', maxArticleChars)
  const response = parseWithSchema(detailResponseSchema, json, 'Machine Heart article')
  const completeContent = htmlToText(response.content, Number.MAX_SAFE_INTEGER)
  if (completeContent === '') {
    throw new JiqizhixinSourceError('EMPTY_CONTENT', 'Machine Heart article contains no readable text')
  }
  const publishedAt = normalizedShanghaiInstant(response.published_at)

  return {
    ...article,
    title: response.title.trim(),
    ...(response.author === undefined ? {} : { author: response.author.name.trim() }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
    content: completeContent.slice(0, maxArticleChars),
    contentHash: createHash('sha256').update(completeContent).digest('hex'),
  }
}

/** Anonymous Machine Heart discovery and article reader over the Harness web seam. */
export class JiqizhixinSource implements ArticleSourceAdapter {
  readonly source = 'jiqizhixin' as const

  constructor(
    private readonly web: Pick<WebRuntime, 'fetch'>,
    private readonly config: JiqizhixinSourceConfig,
  ) {}

  async discover(signal?: AbortSignal): Promise<readonly DiscoveredArticle[]> {
    const response = await this.fetch(this.config.listUrl, signal)
    return parseJiqizhixinListing(
      responseText(response, 'Machine Heart article listing'),
      this.config.maxItems,
    )
  }

  async read(article: DiscoveredArticle, signal?: AbortSignal): Promise<ArticleDocument> {
    if (article.source !== this.source) {
      throw new TypeError(`JiqizhixinSource cannot read source '${article.source}'`)
    }
    const slug = slugFromArticle(article)
    const detailUrl = new URL(`${ARTICLE_API_PATH_PREFIX}${encodeURIComponent(slug)}`, PUBLIC_ORIGIN).href
    const response = await this.fetch(detailUrl, signal)
    return parseJiqizhixinArticle(
      responseText(response, 'Machine Heart article'),
      article,
      this.config.maxArticleChars,
    )
  }

  private fetch(url: string, signal?: AbortSignal): Promise<WebFetchResult> {
    const timeoutSignal = AbortSignal.timeout(this.config.requestTimeoutMs)
    const combinedSignal = signal === undefined
      ? timeoutSignal
      : AbortSignal.any([signal, timeoutSignal])
    return this.web.fetch({ url }, combinedSignal)
  }
}

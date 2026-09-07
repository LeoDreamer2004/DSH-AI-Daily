import { createHash } from 'node:crypto'
import { load } from 'cheerio'

const REMOVED_ELEMENTS = [
  'script',
  'style',
  'noscript',
  'svg',
  'canvas',
  'iframe',
  'form',
  'nav',
  'footer',
  'aside',
].join(',')

const CONTENT_SELECTORS = [
  'article .entry-content',
  '.entry-content',
  '.post-content',
  '.article-content',
  'article',
  'main',
  'body',
]

/** Metadata and normalized text extracted from one article page. */
export interface ExtractedHtmlArticle {
  readonly title?: string
  readonly author?: string
  readonly publishedAt?: string
  readonly content: string
  readonly contentHash: string
  readonly truncated: boolean
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim()
  return normalized === '' ? undefined : normalized
}

function normalizeInstant(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString()
}

function assertCharacterLimit(maxChars: number): void {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new RangeError('maxChars must be a positive safe integer')
  }
}

function textWithBlocks(html: string): string {
  const $ = load(html)
  $(REMOVED_ELEMENTS).remove()
  $('[hidden], [aria-hidden="true"]').remove()

  let contentSelector = 'body'
  for (const selector of CONTENT_SELECTORS) {
    const candidate = $(selector).first()
    if (candidate.length > 0 && nonEmpty(candidate.text()) !== undefined) {
      contentSelector = selector
      break
    }
  }
  const content = $(contentSelector).first()

  content.find('br').replaceWith('\n')
  content.find('p, div, section, article, h1, h2, h3, h4, h5, h6, li, blockquote, pre').each((_, element) => {
    $(element).append('\n')
  })

  return content
    .text()
    .replace(/\r/g, '')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Convert an HTML fragment to compact plain text.
 *
 * @param html - Untrusted HTML source.
 * @param maxChars - Maximum returned character count.
 * @returns Normalized plain text.
 */
export function htmlToText(html: string, maxChars: number): string {
  assertCharacterLimit(maxChars)
  return textWithBlocks(html).slice(0, maxChars)
}

/**
 * Extract model-safe plain text and metadata from one article page.
 *
 * @param html - Untrusted article HTML.
 * @param maxChars - Maximum returned article body length.
 * @returns Extracted metadata, content, and a hash of the complete normalized body.
 */
export function extractHtmlArticle(html: string, maxChars: number): ExtractedHtmlArticle {
  assertCharacterLimit(maxChars)
  const $ = load(html)
  const completeContent = textWithBlocks(html)
  const title = nonEmpty(
    $('meta[property="og:title"]').attr('content')
      ?? $('article h1, main h1, h1').first().text(),
  )
  const author = nonEmpty(
    $('meta[name="author"]').attr('content')
      ?? $('[rel="author"], .author, .post-author').first().text(),
  )
  const publishedAt = normalizeInstant(
    $('meta[property="article:published_time"]').attr('content')
      ?? $('time[datetime]').first().attr('datetime'),
  )
  const content = completeContent.slice(0, maxChars)

  return {
    ...(title === undefined ? {} : { title }),
    ...(author === undefined ? {} : { author }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
    content,
    contentHash: createHash('sha256').update(completeContent).digest('hex'),
    truncated: content.length < completeContent.length,
  }
}

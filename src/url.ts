import { createHash } from 'node:crypto'
import type { ArticleId, ArticleSource } from './types.js'

const TRACKING_PARAMETERS = new Set([
  'from',
  'fromurl',
  'ref',
  'source',
  'sourcetype',
  'spm',
  'timestamp',
])

/**
 * Normalize one public article URL for durable identity and deduplication.
 *
 * @param input - Absolute HTTP(S) URL.
 * @returns A stable URL without fragments or known tracking parameters.
 */
export function canonicalizeArticleUrl(input: string): string {
  const url = new URL(input)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`article URL must use HTTP(S), received ${url.protocol}`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('article URL must not contain credentials')
  }

  url.hash = ''
  url.hostname = url.hostname.toLowerCase()

  const parameterNames = Array.from(url.searchParams.keys())
  for (const name of parameterNames) {
    if (name.toLowerCase().startsWith('utm_') || TRACKING_PARAMETERS.has(name.toLowerCase())) {
      url.searchParams.delete(name)
    }
  }
  url.searchParams.sort()

  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '')
  return url.href
}

/**
 * Derive a stable opaque article id.
 *
 * @param source - Media source owning the article URL.
 * @param canonicalUrl - URL returned by {@link canonicalizeArticleUrl}.
 * @returns A source-scoped SHA-256 identifier.
 */
export function articleIdFor(source: ArticleSource, canonicalUrl: string): ArticleId {
  return createHash('sha256').update(`${source}\0${canonicalUrl}`).digest('hex') as ArticleId
}

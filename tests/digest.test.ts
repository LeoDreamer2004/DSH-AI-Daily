import { describe, expect, it } from 'vitest'
import { buildDailyDigest, dateInTimeZone, parseCalendarDate } from '../src/digest.js'
import type { ArticleRecord } from '../src/types.js'
import { articleIdFor } from '../src/url.js'

function processed(title: string, score: number, publishedAt: string): ArticleRecord {
  const canonicalUrl = `https://aiera.com.cn/${encodeURIComponent(title)}`
  return {
    id: articleIdFor('aiera', canonicalUrl),
    source: 'aiera',
    url: canonicalUrl,
    canonicalUrl,
    title,
    publishedAt,
    status: 'processed',
    discoveredAt: '2026-09-05T00:00:00.000Z',
    lastSeenAt: '2026-09-05T00:00:00.000Z',
    processedAt: '2026-09-05T01:00:00.000Z',
    contentHash: 'a'.repeat(64),
    summary: `${title} summary`,
    detailedSummary: `${title} detailed summary`,
    keyPoints: [`${title} point`],
    importanceScore: score,
    importanceReason: `${title} reason`,
    modelProvider: 'test-provider',
    model: 'test-model',
  }
}

describe('daily digest', () => {
  it('groups by configured time zone and ranks by importance', () => {
    const digest = buildDailyDigest([
      processed('lower', 60, '2026-09-05T17:00:00.000Z'),
      processed('higher', 90, '2026-09-05T16:30:00.000Z'),
      processed('previous day', 100, '2026-09-05T15:59:59.000Z'),
    ], '2026-09-06', 'Asia/Shanghai', new Date('2026-09-06T02:00:00.000Z'))

    expect(digest.articles.map(article => article.title)).toEqual(['higher', 'lower'])
    expect(digest.articles.map(article => article.category)).toEqual(['other', 'other'])
    expect(digest.generatedAt).toBe('2026-09-06T02:00:00.000Z')
  })

  it('uses a lower inclusion threshold for latest papers', () => {
    const digest = buildDailyDigest([
      { ...processed('general below threshold', 59, '2026-09-06T04:00:00.000Z'), category: 'other' },
      { ...processed('general at threshold', 60, '2026-09-06T03:00:00.000Z'), category: 'ai-applications' },
      { ...processed('paper below threshold', 49, '2026-09-06T02:00:00.000Z'), category: 'latest-papers' },
      { ...processed('paper at threshold', 50, '2026-09-06T01:00:00.000Z'), category: 'latest-papers' },
    ], '2026-09-06', 'UTC')

    expect(digest.articles.map(article => article.title)).toEqual([
      'general at threshold',
      'paper at threshold',
    ])
  })

  it('keeps duplicate articles out of the digest', () => {
    const canonical = processed('canonical', 80, '2026-09-06T00:00:00.000Z')
    const duplicate = {
      ...processed('duplicate', 90, '2026-09-06T01:00:00.000Z'),
      duplicateOfArticleIds: [canonical.id],
    }

    const digest = buildDailyDigest([duplicate, canonical], '2026-09-06', 'UTC')
    expect(digest.articles.map(article => article.title)).toEqual(['canonical'])
  })

  it('projects instants and rejects invalid calendar dates', () => {
    expect(dateInTimeZone(new Date('2026-09-05T16:00:00.000Z'), 'Asia/Shanghai'))
      .toBe('2026-09-06')
    expect(parseCalendarDate('2024-02-29')).toBe('2024-02-29')
    expect(() => parseCalendarDate('2026-02-30')).toThrow(/valid calendar date/)
    expect(() => parseCalendarDate('09/06/2026')).toThrow(/YYYY-MM-DD/)
  })

  it('fails loudly when a processed record has incomplete analysis', () => {
    const incomplete = { ...processed('incomplete', 50, '2026-09-06T00:00:00.000Z') }
    delete incomplete.summary
    expect(() => buildDailyDigest([incomplete], '2026-09-06', 'UTC')).toThrow(/incomplete analysis/)
  })
})

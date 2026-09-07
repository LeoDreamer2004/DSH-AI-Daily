import type { ArticleRecord, DailyDigest, DailyDigestItem } from './types.js'

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MINIMUM_IMPORTANCE_SCORE = 60
const MINIMUM_PAPER_IMPORTANCE_SCORE = 50

/**
 * Return the calendar date for an instant in an IANA time zone.
 * @param instant - Instant to project.
 * @param timeZone - IANA time-zone identifier.
 * @returns Calendar date in YYYY-MM-DD form.
 */
export function dateInTimeZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant)
  const field = (type: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find(part => part.type === type)?.value
    if (value === undefined) throw new Error(`ai-daily: date formatter omitted '${type}'`)
    return value
  }
  return `${field('year')}-${field('month')}-${field('day')}`
}

/**
 * Validate a calendar date string.
 * @param input - Candidate YYYY-MM-DD value.
 * @returns The unchanged valid date.
 */
export function parseCalendarDate(input: string): string {
  if (!DATE_PATTERN.test(input)) throw new TypeError('date must use YYYY-MM-DD format')
  const parsed = new Date(`${input}T00:00:00.000Z`)
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== input) {
    throw new TypeError('date must be a valid calendar date')
  }
  return input
}

function digestItem(record: ArticleRecord): DailyDigestItem {
  if (
    record.summary === undefined
    || record.importanceScore === undefined
    || record.importanceReason === undefined
  ) {
    throw new Error(`ai-daily: processed article '${record.id}' has incomplete analysis`)
  }
  return {
    id: record.id,
    source: record.source,
    title: record.title,
    url: record.canonicalUrl,
    ...(record.publishedAt === undefined ? {} : { publishedAt: record.publishedAt }),
    category: record.category ?? 'other',
    summary: record.summary,
    importanceScore: record.importanceScore,
    importanceReason: record.importanceReason,
  }
}

function meetsDigestThreshold(article: DailyDigestItem): boolean {
  const minimum = article.category === 'latest-papers'
    ? MINIMUM_PAPER_IMPORTANCE_SCORE
    : MINIMUM_IMPORTANCE_SCORE
  return article.importanceScore >= minimum
}

/**
 * Build one importance-ranked daily digest from durable article records.
 * @param records - Complete article snapshot.
 * @param date - Target date in the configured time zone.
 * @param timeZone - IANA time-zone identifier.
 * @param generatedAt - Clock sample recorded in the result.
 * @returns Processed articles for the date, highest importance first.
 */
export function buildDailyDigest(
  records: readonly ArticleRecord[],
  date: string,
  timeZone: string,
  generatedAt: Date = new Date(),
): DailyDigest {
  const validDate = parseCalendarDate(date)
  const articles = records
    .filter(record => record.status === 'processed')
    .filter(record => (record.duplicateOfArticleIds?.length ?? 0) === 0)
    .filter((record) => {
      const instant = new Date(record.publishedAt ?? record.discoveredAt)
      return dateInTimeZone(instant, timeZone) === validDate
    })
    .map(digestItem)
    .filter(meetsDigestThreshold)
    .sort((left, right) =>
      right.importanceScore - left.importanceScore
      || (right.publishedAt ?? '').localeCompare(left.publishedAt ?? '')
      || left.id.localeCompare(right.id))

  return {
    date: validDate,
    generatedAt: generatedAt.toISOString(),
    timeZone,
    articles,
  }
}

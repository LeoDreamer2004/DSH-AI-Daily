import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from 'react'
import clsx from 'clsx'
import {
  IconCloseOutline16,
  LinkIcon,
  MarkdownText,
  type MarkdownLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  InjectFace,
  PropsLocale,
  PropsRuntime,
  TranslateNS,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {
  DashboardArticleDetail,
  DashboardArticleItem,
  DashboardDuplicateTarget,
  DashboardQueueItem,
} from '../dashboard/types.js'
import type { ArticleCategory, ArticleSource } from '../types.js'
import type { DashboardInjected, DashboardState } from './controller.js'
import { NS } from './locales.js'
import { NewsIcon } from './NewsIcon.js'
import css from './Dashboard.module.css'

type DashboardActions = Omit<DashboardInjected, 'hooks'>
type DashboardTriggerProps =
  PropsRuntime<'sidebar.footer.action'> & InjectFace<DashboardInjected> & PropsLocale<typeof NS>
type DashboardOverlayProps =
  PropsRuntime<'shell.overlay'> & InjectFace<DashboardInjected> & PropsLocale<typeof NS>

function sourceName(source: DashboardArticleItem['source'], t: TranslateNS<typeof NS>): string {
  if (source === 'aiera') return t('source.aiera')
  if (source === 'jiqizhixin') return t('source.jiqizhixin')
  return t('source.qbitai')
}

type DigestCategory = ArticleCategory | 'all'

const DIGEST_CATEGORIES: readonly DigestCategory[] = [
  'all',
  'latest-papers',
  'major-companies',
  'ai-applications',
  'other',
]

function categoryName(category: DigestCategory, t: TranslateNS<typeof NS>): string {
  if (category === 'all') return t('category.all')
  if (category === 'latest-papers') return t('category.latestPapers')
  if (category === 'major-companies') return t('category.majorCompanies')
  if (category === 'ai-applications') return t('category.aiApplications')
  return t('category.other')
}

function OriginalLink({ url, compact = false, t }: {
  readonly url: string
  readonly compact?: boolean
  readonly t: TranslateNS<typeof NS>
}) {
  return (
    <a className={clsx(css.link, css.originalLink, compact && css.originalLinkCompact)} href={url} target="_blank" rel="noopener noreferrer">
      <LinkIcon kind="url" size={12} />
      {t('article.original')}
    </a>
  )
}

function ScoreBadge({ score, t }: {
  readonly score: number
  readonly t: TranslateNS<typeof NS>
}) {
  const style = {
    '--ai-daily-score-red-yellow': `${Math.min(100, Math.max(0, (score - 50) * 4))}%`,
    '--ai-daily-score-yellow-green': `${Math.min(100, Math.max(0, (score - 75) * 4))}%`,
  } as CSSProperties
  return <span className={clsx(css.score, css.scoreValue)} style={style}>{t('article.score', { score })}</span>
}

function DuplicateStatus({ count, t }: {
  readonly count: number
  readonly t: TranslateNS<typeof NS>
}) {
  return (
    <span className={css.duplicateStatus}>
      <small>{t('library.duplicates', { count })}</small>
      <span className={clsx(css.score, css.scoreDuplicate)}>{t('article.duplicate')}</span>
    </span>
  )
}

function EarliestReportLink({ target, openArticle, includeTitle = false, t }: {
  readonly target: DashboardDuplicateTarget
  readonly openArticle: DashboardActions['openArticle']
  readonly includeTitle?: boolean
  readonly t: TranslateNS<typeof NS>
}) {
  return (
    <button
      type="button"
      className={clsx(css.link, css.navigationLink)}
      onClick={() => { void openArticle(target.id) }}
    >
      {includeTitle ? t('article.earliest', { title: target.title }) : t('article.earliestShort')}
    </button>
  )
}

function ReanalyzeButton({ article, reanalyzeArticle, state, t }: {
  readonly article: { readonly id: string; readonly source: ArticleSource }
  readonly reanalyzeArticle: DashboardActions['reanalyzeArticle']
  readonly state: DashboardState
  readonly t: TranslateNS<typeof NS>
}) {
  const active = state.reanalyzingArticleId === article.id
  return (
    <button
      type="button"
      className={css.reanalyze}
      disabled={
        state.operation !== undefined
        || state.activity !== undefined
        || state.snapshot?.sourceSettings[article.source] === false
      }
      onClick={() => { void reanalyzeArticle(article.id) }}
    >
      {active ? <span className={css.spinner} aria-hidden="true" /> : null}
      {t(active ? 'article.reanalyzing' : 'article.reanalyze')}
    </button>
  )
}

function displayTime(value: string | undefined, t: TranslateNS<typeof NS>): string {
  if (value === undefined) return t('date.unknown')
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat(document.documentElement.lang || undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date)
}

function MarkdownContent({ className, text, t }: {
  readonly className: string
  readonly text: string
  readonly t: TranslateNS<typeof NS>
}) {
  const labels = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel: t('markdown.copy'), copiedLabel: t('markdown.copied') },
    footnotes: t('markdown.footnotes'),
  }), [t])
  return <div className={className}><MarkdownText text={text} labels={labels} /></div>
}

/** Sidebar entry that opens the dashboard overlay. */
export function DashboardTrigger({ open, setTrigger, useAiDaily, wide, t }: DashboardTriggerProps) {
  const state = useAiDaily(snapshot => snapshot)
  const running = state.operation !== undefined
  return (
    <button
      ref={setTrigger}
      type="button"
      className={clsx(css.trigger, !wide && css.triggerRail, running && css.triggerRunning)}
      aria-label={t(running ? 'background.running' : 'open')}
      aria-busy={running}
      title={t(running ? 'background.running' : 'name')}
      onClick={open}
    >
      <span className={css.triggerIcon} aria-hidden="true"><NewsIcon />{running ? <i /> : null}</span>
      {wide ? <span className={css.triggerLabel}>{t('name')}</span> : null}
      {wide && running ? <span className={css.triggerState} aria-hidden="true">{t('background.short')}</span> : null}
    </button>
  )
}

function EmptyState({ hasHistory, t }: {
  readonly hasHistory: boolean
  readonly t: TranslateNS<typeof NS>
}) {
  return (
    <div className={css.empty}>
      <strong>{t(hasHistory ? 'empty.date.title' : 'empty.none.title')}</strong>
      <span>{t(hasHistory ? 'empty.date.body' : 'empty.none.body')}</span>
    </div>
  )
}

function ArticleDetail({ article, actions, state, onClose, t }: {
  readonly article: DashboardArticleDetail
  readonly actions: DashboardActions
  readonly state: DashboardState
  readonly onClose: () => void
  readonly t: TranslateNS<typeof NS>
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { closeRef.current?.focus() }, [])
  const stop = (event: MouseEvent<HTMLElement>): void => { event.stopPropagation() }
  const duplicate = article.duplicateOfCount > 0
  return (
    <div className={css.detailBackdrop} onClick={onClose}>
      <article className={css.detail} onClick={stop}>
        <header className={css.detailHead}>
          <div>
            <div className={clsx(css.meta, css.detailMeta)}>
              <span>{sourceName(article.source, t)}</span>
              {duplicate
                ? <DuplicateStatus count={article.duplicateOfCount} t={t} />
                : <span>{categoryName(article.category ?? 'other', t)}</span>}
              {!duplicate && article.importanceScore !== undefined ? <ScoreBadge score={article.importanceScore} t={t} /> : null}
              <span>{displayTime(article.publishedAt, t)}</span>
            </div>
            <h2 className={css.detailTitle}>{article.title}</h2>
          </div>
          <div className={css.detailActions}>
            <button ref={closeRef} type="button" className={clsx(css.button, css.close)} aria-label={t('article.close')} onClick={onClose}><IconCloseOutline16 /></button>
          </div>
        </header>
        {duplicate
          ? (
            <section className={css.duplicateDetail}>
              <p>{t('article.duplicateDescription')}</p>
              {article.duplicateTarget === undefined
                ? null
                : <EarliestReportLink target={article.duplicateTarget} openArticle={actions.openArticle} includeTitle t={t} />}
            </section>
          )
          : (
            <>
              {article.detailedSummary === undefined ? null : <MarkdownContent className={clsx(css.detailSummary, css.markdown)} text={article.detailedSummary} t={t} />}
              <section className={css.detailSection}>
                <h3>{t('article.why')}</h3>
                {article.importanceReason === undefined ? null : <MarkdownContent className={clsx(css.detailSummary, css.markdown)} text={article.importanceReason} t={t} />}
              </section>
            </>
          )}
        <footer className={css.detailFooter}>
          <span>{t('article.model', { provider: article.modelProvider, model: article.model })}</span>
          <div className={css.rowFooterActions}>
            <ReanalyzeButton article={article} reanalyzeArticle={actions.reanalyzeArticle} state={state} t={t} />
            <OriginalLink url={article.url} t={t} />
          </div>
        </footer>
      </article>
    </div>
  )
}

function DigestPanel({ state, actions, t }: {
  readonly state: DashboardState
  readonly actions: DashboardActions
  readonly t: TranslateNS<typeof NS>
}) {
  const [category, setCategory] = useState<DigestCategory>('all')
  const snapshot = state.snapshot
  const digest = snapshot?.digest
  const articles = digest?.articles.filter(article => category === 'all' || article.category === category) ?? []
  return (
    <section className={css.panel}>
      <header className={css.panelHead}>
        <h2 id="ai-daily-title" className={css.panelTitle}>{t('digest.title')}</h2>
        <input
          className={css.date}
          type="date"
          aria-label={t('digest.date')}
          value={digest?.date ?? ''}
          disabled={state.activity !== undefined}
          onChange={(event) => {
            const value = event.currentTarget.value
            if (value !== '') void actions.load(value)
          }}
        />
      </header>
      <div className={css.categoryTabs} role="tablist" aria-label={t('category.tabs')}>
        {DIGEST_CATEGORIES.map(value => {
          const count = digest?.articles.filter(article => value === 'all' || article.category === value).length ?? 0
          return (
            <button
              type="button"
              role="tab"
              aria-selected={category === value}
              className={clsx(css.categoryTab, category === value && css.categoryTabActive)}
              key={value}
              onClick={() => { setCategory(value) }}
            >
              <span>{categoryName(value, t)}</span>
              <small>{count}</small>
            </button>
          )
        })}
      </div>
      {digest === undefined || digest.articles.length === 0
        ? <EmptyState hasHistory={(snapshot?.totalProcessed ?? 0) > 0} t={t} />
        : articles.length === 0
          ? <div className={css.empty}><strong>{t('empty.category.title')}</strong><span>{t('empty.category.body')}</span></div>
        : (
          <ol className={css.list}>
            {articles.map((article, index) => (
              <li className={css.row} key={article.id}>
                <button className={css.cardButton} type="button" onClick={() => { void actions.openArticle(article.id) }}>
                  <div className={css.rowTop}>
                    <span className={css.rank}>{index + 1}</span>
                    <h3 className={css.rowTitle}>{article.title}</h3>
                    <ScoreBadge score={article.importanceScore} t={t} />
                  </div>
                  <p className={css.summary}>{article.summary}</p>
                </button>
                <div className={css.rowFooter}>
                  <div className={css.meta}><span>{sourceName(article.source, t)}</span><span>{displayTime(article.publishedAt, t)}</span></div>
                  <div className={css.rowFooterActions}>
                    <ReanalyzeButton article={article} reanalyzeArticle={actions.reanalyzeArticle} state={state} t={t} />
                    <OriginalLink url={article.url} t={t} />
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
    </section>
  )
}

function LibraryPanel({ state, actions, t }: {
  readonly state: DashboardState
  readonly actions: DashboardActions
  readonly t: TranslateNS<typeof NS>
}) {
  const [summaryPreview, setSummaryPreview] = useState<{
    readonly articleId: string
    readonly summary: string
    readonly left: number
    readonly top: number
    readonly width: number
    readonly above: boolean
  }>()
  const snapshot = state.snapshot
  const articles = snapshot?.articles ?? []
  const showSummary = (element: HTMLElement, article: DashboardArticleItem): void => {
    if (article.summary === undefined) {
      setSummaryPreview(undefined)
      return
    }
    const rect = element.getBoundingClientRect()
    const width = Math.min(Math.max(rect.width - 24, 240), 420, window.innerWidth - 24)
    const left = Math.min(Math.max(rect.left + 12, 12), window.innerWidth - width - 12)
    const above = window.innerHeight - rect.bottom < 160 && rect.top > 160
    setSummaryPreview({
      articleId: article.id,
      summary: article.summary,
      left,
      top: above ? rect.top - 8 : rect.bottom + 8,
      width,
      above,
    })
  }
  return (
    <section className={css.panel}>
      <header className={css.panelHead}>
        <h2 className={css.panelTitle}>{t('library.title')}</h2>
        <span className={css.score}>{t('library.count', { count: snapshot?.totalProcessed ?? 0 })}</span>
      </header>
      {articles.length === 0
        ? <EmptyState hasHistory={false} t={t} />
        : (
          <ul className={css.list}>
            {articles.map(article => (
              <li
                className={clsx(css.row, css.libraryRow)}
                key={article.id}
                onMouseEnter={event => { showSummary(event.currentTarget, article) }}
                onMouseLeave={() => { setSummaryPreview(undefined) }}
              >
                <button
                  className={css.cardButton}
                  type="button"
                  aria-describedby={summaryPreview?.articleId === article.id ? 'ai-daily-library-summary-preview' : undefined}
                  onFocus={event => { showSummary(event.currentTarget, article) }}
                  onBlur={() => { setSummaryPreview(undefined) }}
                  onClick={() => { void actions.openArticle(article.id) }}
                >
                  <div className={css.rowTop}>
                    <h3 className={css.rowTitle}>{article.title}</h3>
                    {article.duplicateOfCount > 0
                      ? <DuplicateStatus count={article.duplicateOfCount} t={t} />
                      : article.importanceScore === undefined ? null : <ScoreBadge score={article.importanceScore} t={t} />}
                  </div>
                </button>
                <div className={css.rowFooter}>
                  <div className={css.meta}>
                    {article.category === undefined ? null : <span className={css.categoryBadge}>{categoryName(article.category, t)}</span>}
                    <span className={css.readBadge}>{t('library.badge')}</span>
                    <span>{sourceName(article.source, t)}</span>
                    <span>{t('library.analyzed', { time: displayTime(article.processedAt, t) })}</span>
                  </div>
                  <div className={css.rowFooterActions}>
                    {article.duplicateTarget === undefined
                      ? null
                      : <EarliestReportLink target={article.duplicateTarget} openArticle={actions.openArticle} t={t} />}
                    <ReanalyzeButton article={article} reanalyzeArticle={actions.reanalyzeArticle} state={state} t={t} />
                    <OriginalLink url={article.url} compact t={t} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      {snapshot !== undefined && articles.length < snapshot.totalProcessed
        ? <button type="button" className={clsx(css.button, css.more)} disabled={state.activity !== undefined || state.operation !== undefined} onClick={() => { void actions.loadMore() }}>{t('library.more')}</button>
        : null}
      {summaryPreview === undefined
        ? null
        : (
          <div
            id="ai-daily-library-summary-preview"
            className={clsx(css.summaryPreview, summaryPreview.above && css.summaryPreviewAbove)}
            role="tooltip"
            style={{ left: summaryPreview.left, top: summaryPreview.top, width: summaryPreview.width }}
          >
            {summaryPreview.summary}
          </div>
        )}
    </section>
  )
}

function queueProgressLabel(state: DashboardState, t: TranslateNS<typeof NS>): string {
  const phase = state.progress?.phase
  if (phase === 'reading') return t('queue.phase.reading')
  if (phase === 'analyzing') return t('queue.phase.analyzing')
  if (phase === 'saving') return t('queue.phase.saving')
  return t('queue.phase.waiting')
}

function QueueRow({ article, state, t }: {
  readonly article: DashboardQueueItem
  readonly state: DashboardState
  readonly t: TranslateNS<typeof NS>
}) {
  const active = state.progress?.currentArticleId === article.id
  const queued = (
    (state.operation === 'summarize' && article.status === 'pending')
    || (state.operation === 'retry-failures' && article.status === 'failed')
  )
  return (
    <li className={clsx(css.queueRow, article.status === 'failed' && css.queueRowFailed, active && css.queueRowActive)}>
      <div className={css.queueRowTop}>
        <h3>{article.title}</h3>
        <span className={clsx(css.queueState, article.status === 'failed' && !active && css.queueStateFailed)}>
          {active ? <span className={css.queueWave} aria-hidden="true"><i /><i /><i /></span> : null}
          {active
            ? queueProgressLabel(state, t)
            : queued
              ? t('queue.status.queued')
              : t(article.status === 'failed' ? 'queue.status.failed' : 'queue.status.pending')}
        </span>
      </div>
      {article.excerpt === undefined ? null : <p className={css.queueExcerpt}>{article.excerpt}</p>}
      {article.status === 'failed' ? <p className={css.queueError}>{article.error}</p> : null}
      <div className={css.queueFooter}>
        <div className={css.meta}>
          <span>{sourceName(article.source, t)}</span>
          <span>{displayTime(article.publishedAt, t)}</span>
        </div>
        <a className={clsx(css.link, css.originalLinkCompact)} href={article.url} target="_blank" rel="noopener noreferrer">
          <LinkIcon kind="url" size={12} />{t('article.original')}
        </a>
      </div>
      {active ? <span className={css.queueProgress} aria-hidden="true" /> : null}
    </li>
  )
}

function QueuePanel({ state, actions, t }: {
  readonly state: DashboardState
  readonly actions: DashboardActions
  readonly t: TranslateNS<typeof NS>
}) {
  const snapshot = state.snapshot
  const queue = snapshot?.queue ?? []
  const pendingCount = queue.filter(article => article.status === 'pending').length
  const selectedDate = snapshot?.digest.date
  const busy = state.operation !== undefined || state.activity !== undefined
  const crawling = state.operation === 'crawl'
  return (
    <section className={clsx(css.panel, css.queuePanel)}>
      <header className={clsx(css.panelHead, css.queueHead)}>
        <div className={css.queueHeading}>
          <h2 className={css.panelTitle}>{t('queue.title')}</h2>
          <span className={css.score}>{t('queue.count', { count: snapshot?.totalQueued ?? 0 })}</span>
        </div>
        <div className={css.queueActions}>
          <button type="button" className={css.button} disabled={busy} onClick={() => { void actions.crawl(selectedDate) }}>
            {t(crawling ? 'queue.crawling' : 'queue.crawl')}
          </button>
          <button type="button" className={clsx(css.button, css.buttonPrimary)} disabled={busy || pendingCount === 0} onClick={() => { void actions.summarize(selectedDate) }}>
            {t(state.operation === 'summarize' ? 'queue.summarizing' : 'queue.summarize')}
          </button>
          <button type="button" className={css.button} disabled={busy || (snapshot?.totalFailed ?? 0) === 0} onClick={() => { void actions.retryFailures(selectedDate) }}>
            {t(state.operation === 'retry-failures' ? 'queue.retrying' : 'queue.retryFailures')}
          </button>
        </div>
      </header>
      {queue.length === 0 && !crawling
        ? <div className={css.empty}><strong>{t('queue.empty.title')}</strong><span>{t('queue.empty.body')}</span></div>
        : (
          <ul className={css.list}>
            {crawling
              ? (
                <li className={css.queueCrawl} role="status" aria-live="polite">
                  <span className={css.queueWave} aria-hidden="true"><i /><i /><i /></span>
                  <span>{t('queue.crawling')}</span>
                </li>
              )
              : null}
            {queue.map(article => <QueueRow article={article} state={state} t={t} key={article.id} />)}
          </ul>
        )}
    </section>
  )
}

function SkeletonPanel() {
  return (
    <section className={clsx(css.panel, css.skeletonPanel)} aria-hidden="true">
      <header className={css.panelHead}>
        <span className={clsx(css.skeleton, css.skeletonHeading)} />
        <span className={clsx(css.skeleton, css.skeletonControl)} />
      </header>
      <div className={css.skeletonRows}>
        {[0, 1, 2, 3].map(index => (
          <div className={css.skeletonRow} key={index}>
            <span className={clsx(css.skeleton, css.skeletonTitle)} />
            <span className={clsx(css.skeleton, css.skeletonLine)} />
            <span className={clsx(css.skeleton, css.skeletonLine, css.skeletonLineShort)} />
          </div>
        ))}
      </div>
    </section>
  )
}

function InitialLoading({ t }: { readonly t: TranslateNS<typeof NS> }) {
  return (
    <div className={css.loading} role="status" aria-live="polite">
      <div className={css.loadingLabel}><span className={css.spinner} aria-hidden="true" />{t('loading')}</div>
      <div className={css.grid}><SkeletonPanel /><div className={css.rightColumn}><SkeletonPanel /><SkeletonPanel /></div></div>
    </div>
  )
}

/** Full dashboard rendered in the layout's additive overlay seat. */
export function DashboardOverlay(props: DashboardOverlayProps) {
  const { close, dismissArticle, dismissMessage, t, useAiDaily } = props
  const actions: DashboardActions = props
  const state = useAiDaily(snapshot => snapshot)
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!state.open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (state.selected !== undefined) dismissArticle()
      else close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [close, dismissArticle, state.open, state.selected])

  if (!state.open) return null
  const snapshot = state.snapshot
  const busy = state.activity !== undefined || state.operation !== undefined
  const closeDashboard = (): void => { close() }
  const toast = state.toast === undefined
    ? undefined
    : state.toast.kind === 'crawl'
      ? state.toast.discoveredCount === 0
        ? t('queue.crawlNoChanges')
        : t('queue.crawlSuccess', { discovered: state.toast.discoveredCount })
      : state.toast.failedCount === 0
        ? t('queue.analysisSuccess', { processed: state.toast.processedCount })
        : t('queue.analysisFailures', { failed: state.toast.failedCount })
  return (
    <div className={css.backdrop} onClick={closeDashboard}>
      <section className={css.dialog} role="dialog" aria-modal="true" aria-labelledby="ai-daily-title" onClick={(event) => { event.stopPropagation() }}>
        {state.selected === undefined
          ? <button ref={closeRef} type="button" className={clsx(css.button, css.close, css.dialogClose)} aria-label={t('close')} onClick={closeDashboard}><IconCloseOutline16 /></button>
          : null}
        <main className={css.main} aria-busy={busy}>
          {state.error !== undefined
            ? (
              <div className={clsx(css.message, css.messageError)} role="alert">
                <span>{state.error === '' ? t('error.generic') : state.error}</span><button type="button" aria-label={t('message.dismiss')} onClick={dismissMessage}><IconCloseOutline16 /></button>
              </div>
            )
            : null}
          {toast === undefined
            ? null
            : (
              <div className={clsx(css.message, css.toast)} role="status" aria-live="polite">
                <span>{toast}</span><button type="button" aria-label={t('message.dismiss')} onClick={dismissMessage}><IconCloseOutline16 /></button>
              </div>
            )}
          {state.activity === 'loading' && snapshot === undefined
            ? <InitialLoading t={t} />
            : (
              <div className={css.grid}>
                <DigestPanel state={state} actions={actions} t={t} />
                <div className={css.rightColumn}>
                  <QueuePanel state={state} actions={actions} t={t} />
                  <LibraryPanel state={state} actions={actions} t={t} />
                </div>
              </div>
            )}
        </main>
        {state.selected === undefined ? null : <ArticleDetail article={state.selected} actions={actions} state={state} onClose={dismissArticle} t={t} />}
      </section>
    </div>
  )
}

import { useEffect, useId, useMemo } from 'react'
import { IconRefreshOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ArticleSource } from '../types.js'
import type { SettingsPageInjected } from './settings-page-controller.js'
import { NS } from './locales.js'
import css from './SettingsPage.module.css'

const SOURCES = ['jiqizhixin', 'qbitai', 'aiera'] as const satisfies readonly ArticleSource[]

type SettingsPageProps =
  PropsRuntime<'settings.section'> & InjectFace<SettingsPageInjected> & PropsLocale<typeof NS>

function sourceName(source: ArticleSource, t: TranslateNS<typeof NS>): string {
  if (source === 'aiera') return t('source.aiera')
  if (source === 'jiqizhixin') return t('source.jiqizhixin')
  return t('source.qbitai')
}

function sourceDescription(source: ArticleSource, t: TranslateNS<typeof NS>): string {
  if (source === 'aiera') return t('settings.source.aiera')
  if (source === 'jiqizhixin') return t('settings.source.jiqizhixin')
  return t('settings.source.qbitai')
}

function modelKey(provider: string, model: string): string {
  return JSON.stringify([provider, model])
}

/** Render AI Daily preferences as a first-class Harness settings page. */
export function SettingsPage(props: SettingsPageProps) {
  const { loadCatalog, selectModel, setSourceEnabled, t } = props
  const state = props.useAiDailySettings(snapshot => snapshot)
  const pageTitleId = useId()
  const sourceLegendId = useId()
  const modelLabelId = useId()
  const effortLabelId = useId()

  useEffect(() => { loadCatalog() }, [loadCatalog])

  const choices = useMemo(() => state.catalog?.groups.flatMap(group => group.models.map(model => ({
    key: modelKey(group.id, model.id),
    groupId: group.id,
    groupName: group.name,
    model,
  }))) ?? [], [state.catalog])
  const settings = state.settings
  const currentKey = settings === undefined ? '' : modelKey(settings.modelProvider, settings.model)
  const currentChoice = choices.find(choice => choice.key === currentKey)
  const currentReasoning = currentChoice?.model.reasoning
  const controlsDisabled = settings === undefined || !state.writable
  const modelDisabled = controlsDisabled || state.catalogStatus !== 'ready'

  const chooseModel = (key: string): void => {
    const choice = choices.find(candidate => candidate.key === key)
    if (choice === undefined) return
    selectModel({ provider: choice.groupId, model: choice.model.id })
  }

  const chooseEffort = (effort: string): void => {
    if (settings === undefined) return
    const selection: ModelSelection = {
      provider: settings.modelProvider,
      model: settings.model,
      ...(effort === '' ? {} : { reasoningEffort: effort }),
    }
    selectModel(selection)
  }

  return (
    <section className={css.page} aria-labelledby={pageTitleId}>
      <header className={css.pageHeader}>
        <h2 id={pageTitleId}>{t('settings.page.title')}</h2>
        {state.writeFailed || state.status === 'unavailable'
          ? <span className={css.saveState} aria-live="polite">
            {state.writeFailed
              ? t('settings.saveFailed')
              : t('settings.unavailable')}
          </span>
          : null}
      </header>

      <section className={css.card} aria-labelledby={sourceLegendId}>
        <div className={css.cardHeader}>
          <h3 id={sourceLegendId}>{t('settings.sources.title')}</h3>
        </div>
        <div className={css.sourceList}>
          {SOURCES.map((source, index) => {
            const enabled = settings?.[source] ?? false
            const label = sourceName(source, t)
            return (
              <div className={css.source} key={source}>
                <span className={css.rank} aria-hidden="true">{index + 1}</span>
                <span className={css.sourceCopy}>
                  <strong>{label}</strong>
                  <small>{sourceDescription(source, t)}</small>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  aria-label={label}
                  className={css.switch}
                  data-active={enabled ? 'true' : undefined}
                  disabled={controlsDisabled}
                  onClick={() => { setSourceEnabled(source, !enabled) }}
                >
                  <span className={css.thumb} />
                </button>
              </div>
            )
          })}
        </div>
      </section>

      <section className={css.card} aria-labelledby={modelLabelId}>
        <div className={css.cardHeader}>
          <h3 id={modelLabelId}>{t('settings.model.title')}</h3>
        </div>

        <div className={css.fields}>
          <label className={css.field}>
            <span>{t('settings.model.route')}</span>
            <select
              value={currentKey}
              disabled={modelDisabled}
              onChange={event => { chooseModel(event.currentTarget.value) }}
            >
              {currentChoice === undefined && settings !== undefined
                ? <option value={currentKey}>{t('settings.model.unlisted', {
                  provider: settings.modelProvider,
                  model: settings.model,
                })}</option>
                : null}
              {state.catalog?.groups.map(group => (
                <optgroup label={group.name} key={group.id}>
                  {group.models.map(model => (
                    <option value={modelKey(group.id, model.id)} key={model.id}>{model.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          {currentReasoning !== undefined
            ? (
              <label className={css.field}>
                <span id={effortLabelId}>{t('settings.model.effort')}</span>
                <select
                  aria-labelledby={effortLabelId}
                  value={settings?.reasoningEffort ?? ''}
                  disabled={modelDisabled}
                  onChange={event => { chooseEffort(event.currentTarget.value) }}
                >
                  <option value="">{t('settings.model.effortAutomatic')}</option>
                  {currentReasoning.efforts.map(effort => (
                    <option value={effort.id} key={effort.id}>{effort.name}</option>
                  ))}
                </select>
              </label>
            )
            : null}
          <button
            type="button"
            className={css.reload}
            disabled={state.catalogStatus === 'loading'}
            onClick={loadCatalog}
          >
            <IconRefreshOutline16 />
            {t('settings.model.reload')}
          </button>
        </div>

        {state.catalogStatus === 'loading'
          ? <p className={css.notice} role="status">{t('settings.model.loading')}</p>
          : null}
        {state.catalogStatus === 'error'
          ? (
            <p className={css.error} role="alert">
              {t('settings.model.loadFailed', { message: state.catalogError ?? t('error.generic') })}
            </p>
          )
          : null}
        {(state.catalog?.failures.length ?? 0) > 0
          ? <p className={css.notice}>{t('settings.model.partial')}</p>
          : null}
        {state.catalogStatus === 'ready' && choices.length === 0
          ? <p className={css.notice}>{t('settings.model.empty')}</p>
          : null}

        <aside className={css.credentialNote}>
          <strong>{t('settings.credentials.title')}</strong>
          <p>{t('settings.credentials.description')}</p>
        </aside>
      </section>
    </section>
  )
}

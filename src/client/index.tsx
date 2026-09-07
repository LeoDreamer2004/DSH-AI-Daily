/** Browser contribution for the AI Daily dashboard. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { AiDailySettings } from '../settings-contract.js'
import { AI_DAILY_SETTINGS_NAMESPACE } from '../settings-contract.js'
import { DashboardController } from './controller.js'
import { DashboardOverlay, DashboardTrigger } from './Dashboard.js'
import { en, NS, zh } from './locales.js'
import { SettingsPage } from './SettingsPage.js'
import { SettingsPageController } from './settings-page-controller.js'

/** Client services and slots required by the dashboard contribution. */
export const inject = ['connection', 'slots', 'locale', 'remote', 'remote.session', 'settingsScope']

/** Register the sidebar trigger and full-screen dashboard overlay. */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const controller = new DashboardController(connection.rpc)
  const settings = new SettingsPageController(
    ctx.settingsScope.bind<AiDailySettings>({ namespace: AI_DAILY_SETTINGS_NAMESPACE }),
    ctx.remote.session,
  )
  const injectDashboard = () => controller.inject()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ai-daily: dictionaries')
  ctx.effect(() => () => { controller.dispose() }, 'ai-daily: dashboard controller')
  ctx.effect(() => () => { settings.dispose() }, 'ai-daily: settings controller')
  ctx.effect(
    () => ctx.remote.$on('llm/adapters-updated', () => { settings.refreshCatalog() }),
    'ai-daily: model catalog changes',
  )
  ctx.effect(
    () => ctx.remote.$on('credentials/reference-updated', () => { settings.refreshCatalog() }),
    'ai-daily: model credential changes',
  )
  ctx.effect(
    () => ctx.on('connection/reset', () => { settings.refreshCatalog() }),
    'ai-daily: model catalog connection generation',
  )
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'ai-daily',
    order: 10,
    locale: NS,
    inject: injectDashboard,
  }, DashboardTrigger))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'ai-daily-dashboard',
    order: 10,
    locale: NS,
    inject: injectDashboard,
  }, DashboardOverlay))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'ai-daily',
    order: 20,
    label: () => ctx.locale.bind(NS)('settings.nav'),
    locale: NS,
    inject: () => settings.inject(),
  }, SettingsPage))
}

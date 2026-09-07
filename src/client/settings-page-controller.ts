import type { ClientRemote, ModelCatalog, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { AiDailySettings } from '../settings-contract.js'
import type { ArticleSource } from '../types.js'

/** State rendered by the dedicated AI Daily settings page. */
export interface SettingsPageState {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly settings?: AiDailySettings
  readonly writable: boolean
  readonly writeFailed: boolean
  readonly catalogStatus: 'idle' | 'loading' | 'ready' | 'error'
  readonly catalog?: ModelCatalog
  readonly catalogError?: string
}

/** Slot-injected business face for the AI Daily settings page. */
export interface SettingsPageInjected {
  readonly hooks: {
    readonly aiDailySettings: SnapshotStore<SettingsPageState>
  }
  readonly loadCatalog: () => void
  readonly setSourceEnabled: (source: ArticleSource, enabled: boolean) => void
  readonly selectModel: (selection: ModelSelection) => void
}

type ModelCatalogRemote = Pick<ClientRemote['session'], 'modelCatalog'>

/** Bridge Harness's settings scope and global model directory into one page state. */
export class SettingsPageController {
  readonly store: SnapshotStore<SettingsPageState>
  private readonly unsubscribe: () => void
  private catalogStatus: SettingsPageState['catalogStatus'] = 'idle'
  private catalog: ModelCatalog | undefined
  private catalogError: string | undefined
  private optimisticSettings: AiDailySettings | undefined
  private writeFailed = false
  private writeGeneration = 0
  private catalogGeneration = 0
  private disposed = false

  constructor(
    private readonly scope: SettingsScope<AiDailySettings>,
    private readonly remote: ModelCatalogRemote,
  ) {
    this.store = createSnapshotStore(this.project())
    this.unsubscribe = scope.subscribe(() => { this.publish() })
  }

  /** Build the stable functions and observable consumed by the Slot renderer. */
  inject(): SettingsPageInjected {
    return {
      hooks: { aiDailySettings: this.store },
      loadCatalog: () => { void this.loadCatalog() },
      setSourceEnabled: (source, enabled) => {
        const current = this.currentSettings()
        if (current === undefined) return
        void this.write(
          { ...current, [source]: enabled },
          () => this.scope.set(source, enabled),
          settings => settings[source] === enabled,
        )
      },
      selectModel: (selection) => {
        const current = this.currentSettings()
        if (current === undefined) return
        const { reasoningEffort: _previousEffort, ...rest } = current
        void this.write(
          {
            ...rest,
            modelProvider: selection.provider,
            model: selection.model,
            ...(selection.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: selection.reasoningEffort }),
          },
          () => this.scope.mutate([
            { op: 'set', path: ['modelProvider'], value: selection.provider },
            { op: 'set', path: ['model'], value: selection.model },
            ...(selection.reasoningEffort === undefined
              ? [{ op: 'unset' as const, path: ['reasoningEffort'] }]
              : [{ op: 'set' as const, path: ['reasoningEffort'], value: selection.reasoningEffort }]),
          ]),
          settings => settings.modelProvider === selection.provider
            && settings.model === selection.model
            && settings.reasoningEffort === selection.reasoningEffort,
        )
      },
    }
  }

  /** Load the Host's current provider-grouped model catalog. */
  async loadCatalog(): Promise<void> {
    if (this.disposed || this.catalogStatus === 'loading') return
    const generation = ++this.catalogGeneration
    this.catalogStatus = 'loading'
    this.catalogError = undefined
    this.publish()
    try {
      const response = await this.remote.modelCatalog()
      if (this.disposed || generation !== this.catalogGeneration) return
      if (!response.ok) throw new Error(response.error.message)
      this.catalog = response.value
      this.catalogStatus = 'ready'
    } catch (error) {
      if (this.disposed || generation !== this.catalogGeneration) return
      this.catalogStatus = 'error'
      this.catalogError = error instanceof Error ? error.message : String(error)
    }
    this.publish()
  }

  /** Invalidate Host-generation model facts and reload while the page is resident. */
  refreshCatalog(): void {
    if (this.disposed) return
    this.catalogGeneration += 1
    this.catalogStatus = 'idle'
    this.catalog = undefined
    this.catalogError = undefined
    this.publish()
    void this.loadCatalog()
  }

  /** Release subscriptions and prevent late operations from publishing. */
  dispose(): void {
    this.disposed = true
    this.catalogGeneration += 1
    this.writeGeneration += 1
    this.unsubscribe()
  }

  private async write(
    optimistic: AiDailySettings,
    operation: () => Promise<void>,
    accepted: (settings: AiDailySettings) => boolean,
  ): Promise<void> {
    if (this.disposed || !this.scope.getSnapshot().writable) return
    const generation = ++this.writeGeneration
    this.optimisticSettings = optimistic
    this.writeFailed = false
    this.publish()
    try {
      await operation()
      if (this.disposed || generation !== this.writeGeneration) return
      const value = this.scope.getSnapshot().value
      this.writeFailed = value === undefined || !accepted(value)
    } catch {
      if (this.disposed || generation !== this.writeGeneration) return
      this.writeFailed = true
    }
    this.optimisticSettings = undefined
    this.publish()
  }

  private project(): SettingsPageState {
    const settings = this.scope.getSnapshot()
    const value = this.optimisticSettings ?? settings.value
    return {
      status: settings.status,
      ...(value === undefined ? {} : { settings: value }),
      writable: settings.writable,
      writeFailed: this.writeFailed,
      catalogStatus: this.catalogStatus,
      ...(this.catalog === undefined ? {} : { catalog: this.catalog }),
      ...(this.catalogError === undefined ? {} : { catalogError: this.catalogError }),
    }
  }

  private publish(): void {
    if (!this.disposed) this.store.set(this.project())
  }

  private currentSettings(): AiDailySettings | undefined {
    return this.optimisticSettings ?? this.scope.getSnapshot().value
  }
}

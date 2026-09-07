import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { describe, expect, it, vi } from 'vitest'
import { SettingsPageController } from '../src/client/settings-page-controller.js'
import type { AiDailySettings } from '../src/settings-contract.js'

function memoryScope(initial: AiDailySettings): SettingsScope<AiDailySettings> {
  let snapshot: SettingsScopeSnapshot<AiDailySettings> = {
    status: 'ready',
    value: initial,
    base: initial,
    user: {},
    revision: 1,
    writable: true,
    mode: 'host',
  }
  const listeners = new Set<() => void>()
  const publish = (value: AiDailySettings): void => {
    snapshot = { ...snapshot, value, revision: (snapshot.revision ?? 0) + 1 }
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: async (field, value) => { publish({ ...snapshot.value, [field]: value } as AiDailySettings) },
    unset: async (field) => {
      const next = { ...snapshot.value } as Record<string, unknown>
      delete next[field]
      publish(next as unknown as AiDailySettings)
    },
    mutate: async (ops) => {
      const next = { ...snapshot.value } as Record<string, unknown>
      for (const op of ops) {
        const field = op.path[0]
        if (field === undefined) continue
        if (op.op === 'set') next[field] = op.value
        else delete next[field]
      }
      publish(next as unknown as AiDailySettings)
    },
  }
}

describe('SettingsPageController', () => {
  it('keeps source changes visible while persistence is pending', async () => {
    const initial: AiDailySettings = {
      aiera: true,
      jiqizhixin: true,
      qbitai: true,
      modelProvider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    }
    const base = memoryScope(initial)
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const originalSet = base.set.bind(base)
    const scope: SettingsScope<AiDailySettings> = {
      ...base,
      set: async (field, value) => {
        await pending
        await originalSet(field, value)
      },
    }
    const controller = new SettingsPageController(scope, {
      modelCatalog: vi.fn(),
    } as never)

    controller.inject().setSourceEnabled('qbitai', false)

    expect(controller.store.getSnapshot().settings?.qbitai).toBe(false)
    expect(controller.store.getSnapshot()).not.toHaveProperty('saving')
    expect(base.getSnapshot().value?.qbitai).toBe(true)

    release()
    await vi.waitFor(() => { expect(base.getSnapshot().value?.qbitai).toBe(false) })
    expect(controller.store.getSnapshot().settings?.qbitai).toBe(false)
    controller.dispose()
  })

  it('loads the Harness model catalog and persists an atomic model selection', async () => {
    const scope = memoryScope({
      aiera: true,
      jiqizhixin: true,
      qbitai: true,
      modelProvider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    const modelCatalog = vi.fn(async () => ({
      ok: true as const,
      value: {
        default: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        routableProviders: ['deepseek-official'],
        groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [] }],
        failures: [],
      },
    }))
    const controller = new SettingsPageController(scope, { modelCatalog } as never)

    await controller.loadCatalog()
    expect(controller.store.getSnapshot()).toMatchObject({ catalogStatus: 'ready' })

    controller.inject().selectModel({
      provider: 'deepseek-official',
      model: 'deepseek-v4',
      reasoningEffort: 'high',
    })
    await vi.waitFor(() => {
      expect(controller.store.getSnapshot()).toMatchObject({
        writeFailed: false,
        settings: {
          modelProvider: 'deepseek-official',
          model: 'deepseek-v4',
          reasoningEffort: 'high',
        },
      })
    })
    controller.dispose()
  })
})

// @vitest-environment jsdom

import { useSyncExternalStore, type ComponentProps } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { describe, expect, it, vi } from 'vitest'
import { SettingsPage } from '../src/client/SettingsPage.js'
import type { SettingsPageState } from '../src/client/settings-page-controller.js'
import { zh } from '../src/client/locales.js'

function translate(key: keyof typeof zh, values?: Record<string, string>): string {
  let copy: string = zh[key]
  for (const [name, value] of Object.entries(values ?? {})) copy = copy.replace(`{${name}}`, value)
  return copy
}

describe('AI Daily settings page', () => {
  it('renders sources and submits catalog-backed model choices', () => {
    const store = createSnapshotStore<SettingsPageState>({
      status: 'ready',
      settings: {
        aiera: true,
        jiqizhixin: true,
        qbitai: true,
        modelProvider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      },
      writable: true,
      writeFailed: false,
      catalogStatus: 'ready',
      catalog: {
        default: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        routableProviders: ['deepseek-official', 'openai-news'],
        groups: [{
          id: 'deepseek-official',
          name: 'DeepSeek',
          models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
        }, {
          id: 'openai-news',
          name: 'News account',
          models: [{
            id: 'gpt-news',
            name: 'GPT News',
            reasoning: {
              efforts: [{ id: 'high', name: 'High' }],
              defaultEffort: 'high',
            },
          }],
        }],
        failures: [],
      },
    })
    const useAiDailySettings = <Selected,>(selector: (state: SettingsPageState) => Selected): Selected =>
      useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()))
    const setSourceEnabled = vi.fn()
    const selectModel = vi.fn()
    const props = {
      close: vi.fn(),
      useAiDailySettings,
      loadCatalog: vi.fn(),
      setSourceEnabled,
      selectModel,
      t: translate,
    } as unknown as ComponentProps<typeof SettingsPage>

    render(<SettingsPage {...props} />)

    expect(screen.getByRole('heading', { name: 'AI 日报设置' }).parentElement?.querySelector('svg'))
      .toBeNull()
    expect(screen.getAllByRole('switch').map(control => control.getAttribute('aria-label'))).toEqual([
      '机器之心',
      '量子位',
      '新智元',
    ])
    expect(screen.getByText(/若要让日报使用独立密钥/)).toBeTruthy()
    const modelSelect = screen.getByLabelText('模型')
    const reloadButton = screen.getByRole('button', { name: '刷新模型' })
    expect(modelSelect.parentElement?.parentElement).toBe(reloadButton.parentElement)

    fireEvent.click(screen.getAllByRole('switch')[1] as HTMLElement)
    expect(setSourceEnabled).toHaveBeenCalledWith('qbitai', false)

    fireEvent.change(modelSelect, {
      target: { value: JSON.stringify(['openai-news', 'gpt-news']) },
    })
    expect(selectModel).toHaveBeenCalledWith({ provider: 'openai-news', model: 'gpt-news' })
  })
})

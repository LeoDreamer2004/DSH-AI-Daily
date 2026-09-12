import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import * as plugin from '../src/index.js'
import { MemoryArticleTable } from './helpers/memory-article-table.js'

describe('AI Daily plugin lifecycle', () => {
  it('opens its domain, provides the service, and closes the domain on disposal', async () => {
    const ctx = new Context()
    const table = new MemoryArticleTable()
    const registeredTools: string[] = []
    const registeredRoutes: string[] = []
    let domainClosed = false
    const registerSettings = vi.fn(() => ({
      get: () => ({
        aiera: true,
        jiqizhixin: true,
        qbitai: true,
        modelProvider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      }),
      watch: () => () => {},
      update: async () => {},
    }))
    type AiDailyDomain = Domain<typeof plugin.aiDailyDomainSpec>
    const domain: AiDailyDomain = {
      name: plugin.aiDailyDomainSpec.name,
      global: undefined as never,
      table: (() => table) as AiDailyDomain['table'],
      close: async () => { domainClosed = true },
    }

    ctx.provide('web', { fetch: async () => { throw new Error('unexpected fetch') } } as never)
    ctx.provide('llm', { stream: () => { throw new Error('unexpected model call') } } as never)
    ctx.provide('storageDomain', { open: async () => domain } as never)
    ctx.provide('settings', { register: registerSettings } as never)
    ctx.provide('tools', {
      register: (definition: { name: string }) => {
        registeredTools.push(definition.name)
        return () => {}
      },
    } as never)
    ctx.provide('timer', {} as never)
    ctx.provide('connection', {
      fetch: {
        register: (route: { readonly path: string }) => {
          registeredRoutes.push(route.path)
          return async () => {}
        },
      },
    } as never)
    const fiber = await ctx.plugin(plugin, { automaticRefresh: false })

    expect(ctx.aiDaily.dailyDigest('2026-09-06').articles).toEqual([])
    expect(registerSettings).toHaveBeenCalledWith(
      'ai-daily',
      expect.anything(),
      {
        base: {
          aiera: true,
          jiqizhixin: true,
          qbitai: true,
          modelProvider: 'deepseek-official',
          model: 'deepseek-v4-flash',
        },
        applies: 'live',
      },
    )
    expect(registeredTools).toEqual(['ai_daily_refresh', 'ai_daily_digest', 'ai_daily_read'])
    expect(registeredRoutes).toEqual(plugin.AI_DAILY_RPC_ENDPOINTS.map(plugin.aiDailyRpcPath))
    await fiber.dispose()
    expect(domainClosed).toBe(true)
    await ctx.fiber.dispose()
  })
})

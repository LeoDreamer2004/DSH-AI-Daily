import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { load } from 'cheerio'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

describe('plugin display resources', () => {
  it('exports localized metadata and includes it in the published package', () => {
    const manifest = JSON.parse(readFileSync(require.resolve('dsh-ai-daily/package.json'), 'utf8'))
    expect(manifest.files).toContain('locale/*.json')
    for (const language of ['en', 'zh']) {
      const dictionary = JSON.parse(readFileSync(require.resolve(`dsh-ai-daily/locale/${language}.json`), 'utf8'))
      expect(dictionary.meta.title.trim()).not.toBe('')
      expect(dictionary.meta.description.trim()).not.toBe('')
    }
  })

  it('ships a self-contained SVG within the official icon size limit', () => {
    const manifestPath = require.resolve('dsh-ai-daily/package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    expect(manifest.icon).toBe('./icon.svg')
    expect(manifest.files).toContain('icon.svg')
    const iconPath = new URL('../icon.svg', import.meta.url)
    expect(statSync(iconPath).size).toBeLessThanOrEqual(256 * 1024)
    const svg = load(readFileSync(iconPath, 'utf8'), { xmlMode: true })
    expect(svg('svg').attr('viewBox')).toBe('0 0 36 36')
    expect(svg('script, foreignObject, image').length).toBe(0)
    for (const element of svg('[fill^="url("]').toArray()) {
      const id = svg(element).attr('fill')?.match(/^url\(#(.+)\)$/)?.[1]
      expect(id).toBeDefined()
      expect(svg(`[id="${id}"]`).length).toBe(1)
    }
  })
})

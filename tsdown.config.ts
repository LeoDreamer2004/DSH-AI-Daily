import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'

const packageId = 'dsh-ai-daily'
const cssPrefix = '\0dsh-ai-daily-css:'
const cssSuffix = '.mjs'
const externalModules = new Set([
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-primitives',
])

function cssExportName(local: string): string {
  const unprefixed = local.startsWith('ai-daily-') ? local.slice('ai-daily-'.length) : local
  return unprefixed.replace(/-([a-z])/g, (_match, character: string) => character.toUpperCase())
}

function cssInjection(file: string, code: string, classMap: Readonly<Record<string, string>>): string {
  const tagId = `${packageId}/${basename(file)}`
  return [
    `const css = ${JSON.stringify(code)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    'if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${tagId}"]`) === null) {',
    '  const tag = document.createElement("style");',
    `  tag.dataset.plugin = ${JSON.stringify(packageId)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
}

export default defineConfig({
  name: `${packageId}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: specifier => externalModules.has(specifier),
    alwaysBundle: specifier => !externalModules.has(specifier),
  },
  plugins: [{
    name: 'dsh-ai-daily-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const file = importer === undefined ? source : resolve(dirname(importer), source)
      return cssPrefix + file + cssSuffix
    },
    async load(id: string) {
      if (!id.startsWith(cssPrefix)) return null
      const file = id.slice(cssPrefix.length, -cssSuffix.length)
      this.addWatchFile(file)
      const source = await readFile(file)
      const result = transform({
        filename: file,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, exported] of Object.entries(result.exports ?? {})) {
        classMap[cssExportName(local)] = exported.name
      }
      return cssInjection(file, result.code.toString(), classMap)
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    sourcemapExcludeSources: false,
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageId)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})

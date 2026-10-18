import { defineConfig } from 'tsdown'

// Browser half of the settings card. This repo sits outside the harness
// monorepo, so it reproduces the lazy-CJS factory artifact the client module
// system serves (cookbook: docs/cookbook/adding-a-settings-card.md): the bundle
// calls window.__ModuleLoader__.load({ id, factory }) with the id equal to the
// package name, and resolves every external through the injected require —
// only the loader module-table baseline words may stay external, everything
// else must inline (a require() the table cannot answer throws at runtime).
// `scripts/check-client-bundle.mjs` asserts both after the build.

const ID = '@artomyuan/dsh-a2a-server'

/** The module-table baseline the shell seeds for every dynamic bundle. */
const BASELINE_EXTERNALS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

export default defineConfig({
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'client',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  tsconfig: 'tsconfig.client.json',
  dts: false,
  sourcemap: true,
  clean: true,
  deps: {
    neverBundle: (specifier: string) => BASELINE_EXTERNALS.has(specifier),
    alwaysBundle: (specifier: string) => !BASELINE_EXTERNALS.has(specifier),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    sourcemapExcludeSources: false,
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})

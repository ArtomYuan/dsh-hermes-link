/**
 * Build-gate for the client bundle, wired into `pnpm run build`. Asserts:
 *  1. client/client.js and client/client.js.map exist;
 *  2. the banner carries the loader handoff with the exact package id;
 *  3. every require() specifier in the bundle sits in the module-table
 *     baseline — anything else would throw at runtime when the browser's
 *     module table cannot answer it.
 * Any failure exits non-zero.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = resolve(root, 'client', 'client.js')
const mapPath = resolve(root, 'client', 'client.js.map')

/** The shell's platform module table (packages/client/web/src/platform.ts). */
const BASELINE = new Set([
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

let failed = false
function fail(message) {
  console.error(`[check-client-bundle] ${message}`)
  failed = true
}

const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const id = manifest.name

if (!existsSync(bundlePath)) fail('client/client.js is missing')
if (!existsSync(mapPath)) fail('client/client.js.map is missing')

const source = readFileSync(bundlePath, 'utf8')
// tsdown pretty-prints the CJS wrapper, so the handoff is matched
// whitespace-insensitively (the multi-line banner form is equally valid).
const squeeze = text => text.replace(/\s+/g, '')
const expectedBanner = squeeze(`window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`)
if (!squeeze(source.slice(0, 200)).startsWith(expectedBanner)) {
  fail(`banner does not carry the loader handoff for id ${JSON.stringify(id)}`)
}
if (!squeeze(source.slice(-200)).includes('returnmodule.exports;}});')) {
  fail('bundle is missing the loader factory footer')
}

const requires = [...source.matchAll(/\brequire\((["'])([^"']+)\1\)/g)].map(match => match[2])
const unique = [...new Set(requires)]
const outside = unique.filter(spec => !BASELINE.has(spec))
if (outside.length > 0) {
  fail(`require() specifiers outside the module-table baseline: ${outside.join(', ')}`)
}

if (failed) process.exit(1)
console.log(`[check-client-bundle] ok: client/client.js + client.js.map present, banner id ${JSON.stringify(id)}, requires: ${unique.join(', ') || '(none)'}`)

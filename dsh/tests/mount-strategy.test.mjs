/**
 * src/client/mount-strategy.ts 的纯函数单测（node:test + node:assert/strict，
 * 无 DOM、无 dsh 类型依赖）。
 *
 * 运行：`pnpm test`（先 `pnpm run build:host` 产出 lib/mount-strategy.js 再跑）。
 * 覆盖 pickClientMount 的决策表：
 *  - 两者都有 → legacy（0.1.5 优先，保证不回归）；
 *  - 只有 settingsScope → legacy；
 *  - 只有 configForms → modern；
 *  - 都没有 / 缺省 / undefined 边界 → none。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickClientMount } from '../lib/client/mount-strategy.js'

test('pickClientMount: 两者都有 → legacy（0.1.5 优先，不回归）', () => {
  assert.equal(pickClientMount({ hasSettingsScope: true, hasConfigForms: true }), 'legacy')
})

test('pickClientMount: 只有 settingsScope → legacy', () => {
  assert.equal(pickClientMount({ hasSettingsScope: true, hasConfigForms: false }), 'legacy')
  assert.equal(pickClientMount({ hasSettingsScope: true }), 'legacy')
})

test('pickClientMount: 只有 configForms → modern', () => {
  assert.equal(pickClientMount({ hasSettingsScope: false, hasConfigForms: true }), 'modern')
  assert.equal(pickClientMount({ hasConfigForms: true }), 'modern')
})

test('pickClientMount: 都没有 → none', () => {
  assert.equal(pickClientMount({ hasSettingsScope: false, hasConfigForms: false }), 'none')
})

test('pickClientMount: 空对象 / 整体缺省 → none', () => {
  assert.equal(pickClientMount({}), 'none')
  assert.equal(pickClientMount(), 'none')
})

test('pickClientMount: undefined 边界按不存在处理', () => {
  assert.equal(pickClientMount({ hasSettingsScope: undefined, hasConfigForms: undefined }), 'none')
  assert.equal(pickClientMount({ hasSettingsScope: undefined, hasConfigForms: true }), 'modern')
  assert.equal(pickClientMount({ hasSettingsScope: true, hasConfigForms: undefined }), 'legacy')
})

test('pickClientMount: 缺省参数对象非布尔值不误判', () => {
  // 只认 truthy；非布尔 truthy/falsy 值不影响「能力存在与否」的语义（调用方只传 boolean）
  assert.equal(pickClientMount({ hasSettingsScope: true, hasConfigForms: 0 }), 'legacy')
  assert.equal(pickClientMount({ hasSettingsScope: 0, hasConfigForms: true }), 'modern')
})

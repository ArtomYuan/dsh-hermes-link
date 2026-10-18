/**
 * 跨版本宿主符号解析的回归测试。
 *
 * 背景：浏览器半边与宿主包是 bundle external 关系，静态按名导入一个宿主没有的
 * 导出**不会构建失败**，只会在运行时得到 `undefined`，当组件渲染即 React #130。
 * 2026-10-05 浏览器实测即因此崩溃：0.2.0 的 `dsh-client-ui-primitives` 把图标命名
 * 从尺寸后缀（`IconChevronDownOutline14`）换成变体后缀
 * （`IconChevronDownOutlineRegular` / `…Medium`），`…14` 在 0.2.0 全树零命中。
 *
 * 本文件锁住：① 解析顺序与「全缺失返回 undefined」；② 候选名列表**同时覆盖两版**
 * 命名（删掉任一版的名字都会让对应宿主上退化为本地兜底，这里会失败提醒）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CHEVRON_DOWN_CANDIDATES,
  TAG_CANDIDATES,
  isComponentType,
  resolveComponent,
} from '../lib/client/primitive-symbols.js'

test('isComponentType: 函数组件与内置标签字符串可渲染', () => {
  assert.equal(isComponentType(() => null), true)
  assert.equal(isComponentType('div'), true)
})

test('isComponentType: memo/forwardRef 包装对象（带 $$typeof）可渲染', () => {
  assert.equal(isComponentType({ $$typeof: Symbol.for('react.memo') }), true)
})

test('isComponentType: undefined/null/普通对象/数字不可渲染（React #130 的来源）', () => {
  assert.equal(isComponentType(undefined), false)
  assert.equal(isComponentType(null), false)
  assert.equal(isComponentType({ type: 'Tag' }), false)
  assert.equal(isComponentType(42), false)
})

test('resolveComponent: 按候选名顺序取第一个可用者', () => {
  const Chevron14 = () => null
  const ChevronRegular = () => null
  const source = { IconChevronDownOutline14: Chevron14, IconChevronDownOutlineRegular: ChevronRegular }
  assert.equal(resolveComponent(source, CHEVRON_DOWN_CANDIDATES), Chevron14, '0.1.5 命名优先')
})

test('resolveComponent: 0.2.0 宿主（无 …14）取到变体命名', () => {
  const ChevronRegular = () => null
  const ChevronMedium = () => null
  const source = { IconChevronDownOutlineRegular: ChevronRegular, IconChevronDownOutlineMedium: ChevronMedium }
  assert.equal(resolveComponent(source, CHEVRON_DOWN_CANDIDATES), ChevronRegular)
})

test('resolveComponent: 候选名存在但值为 undefined（external 缺导出的真实形态）时继续降级', () => {
  const ChevronBase = () => null
  const source = {
    IconChevronDownOutline14: undefined,
    IconChevronDownOutlineRegular: undefined,
    IconChevronDownOutlineMedium: undefined,
    IconChevronDownOutline: ChevronBase,
  }
  assert.equal(resolveComponent(source, CHEVRON_DOWN_CANDIDATES), ChevronBase)
})

test('resolveComponent: 全部缺失返回 undefined（调用方走本地兜底，而非渲染 undefined）', () => {
  assert.equal(resolveComponent({}, CHEVRON_DOWN_CANDIDATES), undefined)
  assert.equal(resolveComponent(undefined, CHEVRON_DOWN_CANDIDATES), undefined)
  assert.equal(resolveComponent(null, TAG_CANDIDATES), undefined)
})

test('resolveComponent: 非组件值不被误当作组件', () => {
  const source = { Tag: { note: 'not a component' } }
  assert.equal(resolveComponent(source, TAG_CANDIDATES), undefined)
})

test('候选名列表覆盖两版命名（删掉任一版的名字都会在此失败）', () => {
  assert.ok(CHEVRON_DOWN_CANDIDATES.includes('IconChevronDownOutline14'), '必须含 0.1.5 的尺寸后缀命名')
  assert.ok(
    CHEVRON_DOWN_CANDIDATES.some((name) => name === 'IconChevronDownOutlineRegular' || name === 'IconChevronDownOutlineMedium'),
    '必须含 0.2.0 的变体命名',
  )
  assert.deepEqual([...TAG_CANDIDATES], ['Tag'])
})

test('候选名列表无重复且顺序稳定（顺序即优先级）', () => {
  assert.equal(new Set(CHEVRON_DOWN_CANDIDATES).size, CHEVRON_DOWN_CANDIDATES.length)
  assert.equal(CHEVRON_DOWN_CANDIDATES[0], 'IconChevronDownOutline14')
})

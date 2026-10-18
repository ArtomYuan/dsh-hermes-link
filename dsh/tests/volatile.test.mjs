/**
 * `volatileIfSupported` 的回归测试：0.1.5 宿主把裸标识符
 * `@deepseek-ai/schemastery` 解析到自带 vendor 的 3.18.2（**无 `.volatile()`**），
 * 并盖过插件自带的依赖副本。直接调用 `.volatile()` 会让插件在 0.1.5 上
 * **加载即崩**（实测：`A2A_FIELD_SHAPES.port.volatile is not a function`），
 * 故必须特性探测。这里用桩对象锁住两种宿主形态。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isVolatile, volatileIfSupported } from '../lib/compat.js'

test('volatileIfSupported: 宿主支持 .volatile() 时返回被标记的新字段', () => {
  const marked = { kind: 'marked' }
  const shape = { volatile: () => marked }
  assert.equal(volatileIfSupported(shape), marked)
})

test('volatileIfSupported: 宿主不支持时原样返回入参（0.1.5 vendor schemastery 形态）', () => {
  const shape = { type: 'number', meta: { step: 1 } }
  assert.equal(volatileIfSupported(shape), shape, '必须返回同一个对象，不得抛错、不得新建')
})

test('volatileIfSupported: volatile 不是函数时同样原样返回', () => {
  const shape = { type: 'string', volatile: true }
  assert.equal(volatileIfSupported(shape), shape)
})

test('volatileIfSupported: 标量/undefined 入参不抛，原样返回', () => {
  assert.equal(volatileIfSupported(undefined), undefined)
  assert.equal(volatileIfSupported(null), null)
  assert.equal(volatileIfSupported('plain'), 'plain')
})

test('volatileIfSupported: 标记结果不是 volatile 引用（避免把 schema 与取值混淆）', () => {
  const shape = { volatile: () => ({ type: 'number' }) }
  assert.equal(isVolatile(volatileIfSupported(shape)), false)
})

test('volatileIfSupported: 探测失败路径下 unwrapVolatile 对 plain 值幂等', async () => {
  const { unwrapVolatile } = await import('../lib/compat.js')
  const plain = { port: 8091, nested: { host: '127.0.0.1' } }
  assert.deepEqual(unwrapVolatile(plain), plain)
})

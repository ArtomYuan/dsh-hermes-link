/**
 * dsh/src/link-binding.ts（§2.2 首选定 ＋ §2.3 绑定记忆，服务端侧）纯单测。
 *
 * 覆盖：绑定账本（内存/落盘/损坏/版本）、首选定选项构造（去重/重名/上限）、
 * 作答→绑定转换（现有工作区/手输新名/选空）、以及「显式 > 绑定 > 缺省」优先级。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LINK_STATE_VERSION,
  bindingFromAnswers,
  createBindingStore,
  effectiveRequestOptions,
  firstUseQuestions,
  loadBindingStore,
} from '../lib/link-binding.js'
import { FIRST_USE_WORKSPACE_OPTIONS } from '../lib/link-binding.js'

const choices = [
  { title: '我的书', path: '/books/我的书' },
  { title: '她的书', path: '/books/她的书' },
  { title: 'dup', path: '/a/dup' },
  { title: 'dup', path: '/b/dup' },
]

test('createBindingStore · get/set/snapshot 与落盘串联', async () => {
  const writes = []
  const store = createBindingStore({}, async (all) => { writes.push(all) })
  store.set('ctx-1', { answered: true, workspace: { kind: 'name', name: '甲' }, updatedAt: 1 })
  store.set('ctx-2', { answered: true, updatedAt: 2 })
  await store.flush()
  assert.equal(store.get('ctx-1').workspace.name, '甲')
  assert.equal(store.get('nope'), undefined)
  assert.deepEqual(Object.keys(store.snapshot()).sort(), ['ctx-1', 'ctx-2'])
  assert.equal(writes.length, 2)
  assert.equal(writes.at(-1)['ctx-2'].updatedAt, 2)
})

test('loadBindingStore · 缺文件/坏文件/版本不符都按空表启动且告警', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'link-state-'))
  const warn = []
  assert.deepEqual((await loadBindingStore(join(dir, 'missing.json'), (m) => warn.push(m))).snapshot(), {})

  const broken = join(dir, 'broken.json')
  await writeFile(broken, '{not json', 'utf8')
  await loadBindingStore(broken, (m) => warn.push(m))
  assert.ok(warn.some((line) => line.includes('读取失败')), warn.join('|'))

  const oldVersion = join(dir, 'old.json')
  await writeFile(oldVersion, JSON.stringify({ version: 0, bindings: { x: { answered: true, updatedAt: 1 } } }), 'utf8')
  const oldStore = await loadBindingStore(oldVersion, (m) => warn.push(m))
  assert.deepEqual(oldStore.snapshot(), {})
  assert.ok(warn.some((line) => line.includes('版本不符')), warn.join('|'))
})

test('loadBindingStore · 读写 round-trip 且文件带版本号', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'link-state-'))
  const path = join(dir, 'a2a-link-state.json')
  const store = await loadBindingStore(path)
  store.set('feishu/oc_x/omt_y', {
    answered: true,
    workspace: { kind: 'path', path: '/books/甲' },
    sandbox: 'workspace-write',
    updatedAt: 7,
  })
  await store.flush()
  const raw = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(raw.version, LINK_STATE_VERSION)
  const reloaded = await loadBindingStore(path)
  assert.deepEqual(reloaded.get('feishu/oc_x/omt_y'), {
    answered: true,
    workspace: { kind: 'path', path: '/books/甲' },
    sandbox: 'workspace-write',
    updatedAt: 7,
  })
})

test('firstUseQuestions · 选项去重、重名区分、上限与沙箱三档', () => {
  const { items, labels } = firstUseQuestions(choices)
  assert.equal(items.length, 2)
  const workspace = items[0]
  const sandbox = items[1]
  assert.equal(workspace.id, 'workspace')
  assert.equal(workspace.options.length, 4)
  // 重名标题**全部**加父目录后缀（不留「光名」歧义项）
  assert.deepEqual(workspace.options.map((o) => o.label), ['我的书', '她的书', 'dup（a）', 'dup（b）'])
  assert.deepEqual(labels.get('我的书'), { kind: 'path', path: '/books/我的书' })
  assert.deepEqual(labels.get('dup（a）'), { kind: 'path', path: '/a/dup' })
  assert.deepEqual(labels.get('dup（b）'), { kind: 'path', path: '/b/dup' })
  assert.equal(sandbox.id, 'sandbox')
  assert.deepEqual(sandbox.options.map((o) => o.label), ['read-only', 'workspace-write', 'danger-full-access'])
  assert.ok(sandbox.options[1].description.includes('建议'))

  // 上限：第 9 个起不再进选项（仍可用手输）
  const many = Array.from({ length: FIRST_USE_WORKSPACE_OPTIONS + 3 }, (_, i) => ({ title: `书${i}`, path: `/b/${i}` }))
  const capped = firstUseQuestions(many)
  assert.equal(capped.items[0].options.length, FIRST_USE_WORKSPACE_OPTIONS)
  assert.equal(capped.labels.size, FIRST_USE_WORKSPACE_OPTIONS)
  assert.equal(capped.labels.get('书8'), undefined)
})

test('bindingFromAnswers · 现有工作区按路径绑、手输新名按名绑、选空只记 answered', () => {
  const { labels } = firstUseQuestions(choices)

  const byOption = bindingFromAnswers(
    [
      { id: 'workspace', selected: ['她的书'] },
      { id: 'sandbox', selected: ['workspace-write'] },
    ],
    labels,
  )
  assert.equal(byOption.answered, true)
  assert.deepEqual(byOption.workspace, { kind: 'path', path: '/books/她的书' })
  assert.equal(byOption.sandbox, 'workspace-write')

  const byCustom = bindingFromAnswers(
    [{ id: 'workspace', selected: [], custom: ' 新书 ' }],
    labels,
  )
  assert.deepEqual(byCustom.workspace, { kind: 'name', name: '新书' })
  assert.equal(byCustom.sandbox, undefined)

  const skipped = bindingFromAnswers([], labels)
  assert.deepEqual(skipped.workspace, undefined)
  assert.deepEqual(skipped.sandbox, undefined)
  assert.equal(skipped.answered, true)

  // 未知标签/未知档位被忽略（异常令牌不误绑）
  const junk = bindingFromAnswers(
    [{ id: 'workspace', selected: ['不存在的书'] }, { id: 'sandbox', selected: ['sudo'] }],
    labels,
  )
  assert.equal(junk.workspace, undefined)
  assert.equal(junk.sandbox, undefined)
})

test('effectiveRequestOptions · 显式 > 绑定 > 缺省', () => {
  const binding = {
    answered: true,
    workspace: { kind: 'path', path: '/books/甲' },
    sandbox: 'workspace-write',
    updatedAt: 1,
  }
  // 无显式 → 全用绑定
  assert.deepEqual(effectiveRequestOptions({}, binding), {
    workspace: { kind: 'path', path: '/books/甲' },
    sandbox: 'workspace-write',
  })
  // 显式覆盖绑定（逐项）
  assert.deepEqual(
    effectiveRequestOptions({ sandbox: 'read-only' }, binding),
    { workspace: { kind: 'path', path: '/books/甲' }, sandbox: 'read-only' },
  )
  assert.deepEqual(
    effectiveRequestOptions({ workspace: { kind: 'name', name: '乙' } }, binding),
    { workspace: { kind: 'name', name: '乙' }, sandbox: 'workspace-write' },
  )
  // 无绑定 → 只有显式（等价升级前缺省）
  assert.deepEqual(effectiveRequestOptions({}, undefined), {})
  assert.deepEqual(effectiveRequestOptions({ sandbox: 'danger-full-access' }, undefined), { sandbox: 'danger-full-access' })
})

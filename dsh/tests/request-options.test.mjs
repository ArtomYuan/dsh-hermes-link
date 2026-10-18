/**
 * src/request-options.ts（§2.1 工作区选择 ＋ §2.4 沙箱档）的纯单测。
 *
 * 运行：`pnpm test`（先 build:host 产出 lib/request-options.js 再跑）。
 *
 * 覆盖三条最容易坏的面：
 *  - **解析**：metadata 缺省＝空选项（现状）；出现即校验，非法一律响亮抛错（绝不静默降级）；
 *  - **工作区解析**：现有命中（title / 目录名，去重）、歧义拒绝、查无则建、绝对路径形态；
 *  - **档位落地**：宿主缺插件 / 预设表无此档 / 已是该档 / 正常写入 / 写入抛错的五种出口，
 *    任何一种都要么如实生效、要么响亮告警并保持现状。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SANDBOX_META_KEY,
  SANDBOX_TIERS,
  WORKSPACE_META_KEY,
  applySandboxTier,
  parseSandboxTier,
  parseWorkspaceSpec,
  readRequestOptions,
  resolveWorkspaceTarget,
} from '../lib/request-options.js'

// ── 线上键字面量锁（桥侧 Python 也各钉一份；任一侧改名都会在本地测试炸） ──────

test('线上键字面量锁：与服务端/桥约定逐字一致', () => {
  assert.equal(WORKSPACE_META_KEY, 'x-dsh-workspace')
  assert.equal(SANDBOX_META_KEY, 'x-dsh-sandbox')
  assert.deepEqual([...SANDBOX_TIERS], ['read-only', 'workspace-write', 'danger-full-access'])
})

// ── 解析 ──────────────────────────────────────────────────────────────────

test('readRequestOptions · 缺省＝空选项（现状不动）', () => {
  assert.deepEqual(readRequestOptions(undefined), {})
  assert.deepEqual(readRequestOptions(null), {})
  assert.deepEqual(readRequestOptions('junk'), {})
  assert.deepEqual(readRequestOptions([]), {})
  assert.deepEqual(readRequestOptions({}), {})
  assert.deepEqual(readRequestOptions({ other: 1 }), {})
})

test('readRequestOptions · 两个键各自解析，值非法即抛（不静默）', () => {
  assert.deepEqual(
    readRequestOptions({ [WORKSPACE_META_KEY]: '我的书', [SANDBOX_META_KEY]: 'workspace-write' }),
    { workspace: { kind: 'name', name: '我的书' }, sandbox: 'workspace-write' },
  )
  assert.deepEqual(
    readRequestOptions({ [WORKSPACE_META_KEY]: '/tmp/book-x' }),
    { workspace: { kind: 'path', path: '/tmp/book-x' } },
  )
  assert.throws(() => readRequestOptions({ [SANDBOX_META_KEY]: 'sudo' }), /未知沙箱档/)
  assert.throws(() => readRequestOptions({ [SANDBOX_META_KEY]: 7 }), /必须是字符串/)
  // 两个键对 null 的处理对称：都当「未设置」
  assert.deepEqual(readRequestOptions({ [WORKSPACE_META_KEY]: null, [SANDBOX_META_KEY]: null }), {})
  assert.throws(() => readRequestOptions({ [WORKSPACE_META_KEY]: '' }), /不能为空/)
  assert.throws(() => readRequestOptions({ [WORKSPACE_META_KEY]: 'a/b' }), /路径分隔符/)
})

test('parseSandboxTier · 只认三档精确值（trim 容忍空白）', () => {
  for (const tier of SANDBOX_TIERS) {
    assert.equal(parseSandboxTier(tier), tier)
    assert.equal(parseSandboxTier(` ${tier}\n`), tier)
  }
  assert.throws(() => parseSandboxTier('Workspace-Write'), /未知沙箱档/)
  assert.throws(() => parseSandboxTier('readonly'), /未知沙箱档/)
  assert.throws(() => parseSandboxTier(undefined), /必须是字符串/)
})

test('parseWorkspaceSpec · 名字与路径两形态的纪律', () => {
  assert.deepEqual(parseWorkspaceSpec('我的书'), { kind: 'name', name: '我的书' })
  assert.deepEqual(parseWorkspaceSpec('  我的书  '), { kind: 'name', name: '我的书' })
  assert.deepEqual(parseWorkspaceSpec('/home/artom/书'), { kind: 'path', path: '/home/artom/书' })
  // 尾斜杠会被 normalize 掉；但 `..` 段一律拒绝（见下方反例）——两者别混为一谈
  assert.deepEqual(parseWorkspaceSpec('/home/artom/书/'), { kind: 'path', path: '/home/artom/书' })
  assert.equal(parseWorkspaceSpec(undefined), undefined)
  assert.equal(parseWorkspaceSpec(null), undefined)

  for (const bad of [
    '', '   ', '.', '..', 'a/b', 'a\\b', 'a\u0000b', 'x'.repeat(65),
    // C1 控制字符与 bidi 控制符（核验指出：文档称"控制字符拒绝"，需真的拒）
    'a\u0085b', 'a\u202eb', 'a\u2066b',
  ]) {
    assert.throws(() => parseWorkspaceSpec(bad), /workspace/, `应拒绝 ${JSON.stringify(bad)}`)
  }
  assert.throws(() => parseWorkspaceSpec(42), /必须是字符串/)
  assert.throws(() => parseWorkspaceSpec('/tmp/../etc'), /\.\. 段/)
})

// ── 工作区解析 ────────────────────────────────────────────────────────────

/** 造一套可控的解析依赖：记录建目录调用，canonicalize 原样返回（测试里不做真 realpath） */
function makeDeps(workspaces = [], defaultCwd = '/base') {
  const mkdirs = []
  return {
    mkdirs,
    deps: {
      defaultCwd,
      ...(workspaces.length > 0 ? { listWorkspaces: () => workspaces } : {}),
      canonicalize: async (path) => path,
      ensureDir: async (path) => { mkdirs.push(path) },
    },
  }
}

test('resolveWorkspaceTarget · 名字命中现有工作区（title 或目录名，按 path 去重）', async () => {
  const { mkdirs, deps } = makeDeps([
    { path: '/home/artom/books/甲书', title: '甲书' },
    { path: '/home/artom/other/乙书', title: '乙书（别名）' },
    { path: '/home/artom/dup', title: '重名' },
    { path: '/home/artom/dup', title: '重名' },
  ])
  assert.deepEqual(await resolveWorkspaceTarget({ kind: 'name', name: '甲书' }, deps), {
    cwd: '/home/artom/books/甲书', via: 'existing', title: '甲书',
  })
  // 目录名匹配（title 不同也能命中）
  assert.deepEqual(await resolveWorkspaceTarget({ kind: 'name', name: '乙书' }, deps), {
    cwd: '/home/artom/other/乙书', via: 'existing', title: '乙书（别名）',
  })
  // 同 path 的多条记录去重后不算歧义
  assert.equal((await resolveWorkspaceTarget({ kind: 'name', name: '重名' }, deps)).via, 'existing')
  assert.deepEqual(mkdirs, [], '命中现有工作区不应建目录')
})

test('resolveWorkspaceTarget · 名字歧义 → 响亮拒绝（不替人猜）', async () => {
  const { deps } = makeDeps([
    { path: '/a/同名', title: '同名' },
    { path: '/b/同名', title: '同名' },
  ])
  await assert.rejects(
    () => resolveWorkspaceTarget({ kind: 'name', name: '同名' }, deps),
    /名字歧义.*\/a\/同名.*\/b\/同名/s,
  )
})

test('resolveWorkspaceTarget · 查无 → 在服务端 cwd 下建目录（「不存在就建」）', async () => {
  const { mkdirs, deps } = makeDeps([], '/home/artom/.dsh/workspace')
  assert.deepEqual(await resolveWorkspaceTarget({ kind: 'name', name: '新书' }, deps), {
    cwd: '/home/artom/.dsh/workspace/新书', via: 'created', title: '新书',
  })
  assert.deepEqual(mkdirs, ['/home/artom/.dsh/workspace/新书'])
})

test('resolveWorkspaceTarget · 绝对路径形态直接采用（不存在就建）；无注册表也能解析', async () => {
  const { mkdirs, deps } = makeDeps([]) // 无 listWorkspaces → headless 降级
  assert.deepEqual(await resolveWorkspaceTarget({ kind: 'path', path: '/srv/books/丙' }, deps), {
    cwd: '/srv/books/丙', via: 'path', title: '丙',
  })
  assert.deepEqual(mkdirs, ['/srv/books/丙'])
})

// ── 档位落地 ──────────────────────────────────────────────────────────────

/** 造一个可控的 permissionPresets 假件 */
function makePresets({ known = [...SANDBOX_TIERS], current = 'danger-full-access', setThrows = false } = {}) {
  const calls = []
  return {
    calls,
    presets: {
      resolve: (name) => {
        if (!known.includes(name)) throw new Error(`unknown permission preset ${name}`)
        return { sandbox: name, approval: 'ask' }
      },
      current: () => current,
      set: (session, name) => {
        if (setThrows) throw new Error('append failed')
        calls.push({ session, name })
      },
    },
  }
}

test('applySandboxTier · 正常写入 / 已是该档 / 宿主缺插件 / 预设表无此档 / 写入抛错', () => {
  const warnings = []
  const session = { id: 's1' }

  // ① 正常
  let fake = makePresets({ current: 'danger-full-access' })
  assert.equal(applySandboxTier({ presets: fake.presets, warn: (m) => warnings.push(m) }, session, 'workspace-write'), 'applied')
  assert.deepEqual(fake.calls, [{ session, name: 'workspace-write' }])

  // ② 已是该档 → 不写事件
  fake = makePresets({ current: 'workspace-write' })
  assert.equal(applySandboxTier({ presets: fake.presets, warn: (m) => warnings.push(m) }, session, 'workspace-write'), 'unchanged')
  assert.deepEqual(fake.calls, [])

  // ③ 宿主缺 permissionPresets → 响亮告警 + 保持现状
  assert.equal(applySandboxTier({ warn: (m) => warnings.push(m) }, session, 'read-only'), 'unavailable')
  assert.match(warnings.at(-1), /permissionPresets/)

  // ④ 本部署预设表无此档
  fake = makePresets({ known: ['safe'] })
  assert.equal(applySandboxTier({ presets: fake.presets, warn: (m) => warnings.push(m) }, session, 'read-only'), 'unavailable')
  assert.match(warnings.at(-1), /没有.*read-only/)
  assert.deepEqual(fake.calls, [])

  // ⑤ 写入抛错 → 告警不冒泡
  fake = makePresets({ setThrows: true })
  assert.equal(applySandboxTier({ presets: fake.presets, warn: (m) => warnings.push(m) }, session, 'read-only'), 'unavailable')
  assert.match(warnings.at(-1), /落沙箱档失败/)
})

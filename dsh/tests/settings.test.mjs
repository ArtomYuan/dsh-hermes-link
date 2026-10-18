/**
 * A2AConfigSchema（= 运行时 Config）与导出契约测试（node:test + node:assert/strict）。
 *
 * 运行：`pnpm test`（先 `pnpm run build:host` 产出 lib/index.js + lib/compat.js）。
 * 覆盖：
 *  - `Config`（构建产物 lib/index.js 导出，等于 A2AConfigSchema）：
 *    未知键保留 / 默认值 / authToken role('secret') / volatile vs plain；
 *  - 导出契约：`Config` 有 `toJSON`，且复刻 0.2.0 `volatileForm` 的收集逻辑能
 *    收集到全部 9 个字段——这是「0.2.0 设置区会出现」的可测代理。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config, SettingsSchema } from '../lib/index.js'

/** 9 个配置字段（与 src/settings.ts 单一事实来源一致） */
const ALL_FIELDS = [
  'port',
  'host',
  'authToken',
  'provider',
  'model',
  'preset',
  'cwd',
  'contextMapPath',
  'contextMapTtlDays',
  'settleCapMs',
]

// ── A2AConfigSchema（= Config）校验行为 ──────────────────────────────────

test('Config: 校验含未知键的输入后未知键保留（不剥离）', () => {
  const out = Config({
    port: 8092,
    host: '127.0.0.1',
    authToken: 'stub-token',
    unknownKey: 'kept',
  })
  assert.equal(out.unknownKey, 'kept')
})

test('Config: 默认值正确（缺失字段回落 schema default）', () => {
  const out = Config({})
  assert.equal(out.provider.get(), 'deepseek-official')
  assert.equal(out.model.get(), 'deepseek-v4-flash')
  assert.equal(out.preset.get(), 'standard')
  assert.equal(out.contextMapTtlDays.get(), 7)
  // v0.5.1：释放前等子代理结算的上限，默认 30 分钟（0 = 关闭等待）
  assert.equal(out.settleCapMs.get(), 1_800_000)
  // 无 default 的可选字段缺失时为 undefined 引用（volatile 一律变成引用对象）
  assert.equal(out.port.get(), undefined)
  assert.equal(out.host.get(), undefined)
  assert.equal(out.authToken.get(), undefined)
  assert.equal(out.cwd.get(), undefined)
  assert.equal(out.contextMapPath.get(), undefined)
})

test('Config: authToken 保留 role(secret)', () => {
  assert.equal(Config.dict.authToken.meta.role, 'secret')
})

test('Config: .volatile() 字段产出引用对象，plain SettingsSchema 产出标量', () => {
  const raw = { port: 8092, host: '127.0.0.1', provider: 'deepseek-official' }
  const vol = Config(raw)
  const plain = SettingsSchema(raw)
  // volatile 输出是引用对象（含 get()）
  assert.equal(typeof vol.port.get, 'function')
  assert.equal(vol.port.get(), 8092)
  assert.equal(typeof vol.host.get, 'function')
  assert.equal(vol.host.get(), '127.0.0.1')
  // plain 输出是标量
  assert.equal(typeof plain.port, 'number')
  assert.equal(plain.port, 8092)
  assert.equal(typeof plain.host, 'string')
  assert.equal(plain.host, '127.0.0.1')
  assert.equal(plain.provider, 'deepseek-official')
})

test('单一事实来源不漂移: Config 与 SettingsSchema 同 10 字段', () => {
  assert.deepEqual(Object.keys(SettingsSchema.dict).sort(), [...ALL_FIELDS].sort())
  assert.deepEqual(Object.keys(Config.dict).sort(), [...ALL_FIELDS].sort())
})

// ── 导出契约：0.2.0 volatileForm 收集逻辑 ────────────────────────────────

/**
 * 复刻 0.2.0 dsh-settings `volatileForm(schema)` 的收集逻辑：
 * `schema.meta.volatile` → 命中；`schema.type === 'object'` → 递归 `schema.dict`。
 * 只关心「是否被收集」，用于断言字段是否全部进入派生表单。
 */
function collectVolatileFields(schema) {
  if (schema.meta.volatile) return { leaf: true }
  if (schema.type === 'object') {
    const dict = Object.fromEntries(
      Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
        const field = collectVolatileFields(child)
        return field === undefined ? [] : [[key, field]]
      }),
    )
    return Object.keys(dict).length === 0 ? undefined : dict
  }
  return undefined
}

test('导出契约: Config 有 toJSON（0.2.0 schema(entry) 的门槛）', () => {
  assert.equal(typeof Config.toJSON, 'function')
})

test('导出契约: 复刻 volatileForm 收集逻辑能收集到全部 10 个字段', () => {
  const fields = collectVolatileFields(Config)
  assert.ok(fields !== undefined, 'volatileForm 不应返回 undefined（有 volatile 字段）')
  assert.deepEqual(Object.keys(fields).sort(), [...ALL_FIELDS].sort())
})

test('导出契约: 每个字段 meta.volatile 均为 true（volatileForm 收集门槛）', () => {
  for (const key of ALL_FIELDS) {
    assert.equal(Config.dict[key].meta.volatile, true, `字段 ${key} 应带 meta.volatile`)
  }
})

test('导出契约: authToken role(secret) 供 0.2.0 redactSecrets 只写不显', () => {
  // 0.2.0 的 redactSecrets(form, value) 遍历 schema，对 meta.role === 'secret'
  // 的字段产出 secrets: [{ path: ['authToken'], set }]，据此只写不显；这里只断言
  // schema 契约（role 标记），明文脱敏由 0.2.0 负责。
  assert.equal(Config.dict.authToken.meta.role, 'secret')
  // 运行时值仍可读（供服务鉴权），但绝不从本插件透出明文到设置区 value。
  const out = Config({ authToken: 'stub-secret' })
  assert.equal(out.authToken.get(), 'stub-secret')
})

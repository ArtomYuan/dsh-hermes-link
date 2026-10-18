/**
 * src/compat.ts 的纯 stdlib 单测（node:test + node:assert/strict，无新框架）。
 *
 * 运行：`pnpm test`（先 `pnpm run build:host` 产出 lib/compat.js 再跑）。
 * 覆盖：
 *  - supportsNamespacedMessageSource 的版本判定（0.1.5-rc.2 / 0.2.0-rc.2 /
 *    0.2.0 / 未知）；
 *  - readToolResult 对 v3 夹具与 v4 夹具（同一语义、两种形状）的双形状读取；
 *  - pluginMessageSource 在两种判定下的 source 形状与探测一致性；
 *  - A6 助手实时增量双事件面：版本谓词、start/chunk/end 三态、text 与
 *    reasoning 各自 block-end 落地、空块不落地、双路径去重不重复落地。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyAssistantStreamFrame,
  applySessionAssistantChunk,
  assistantStreamTurnStep,
  createAssistantIngestState,
  dshRuntimeVersion,
  isVolatile,
  supportsAssistantStreamEvents,
  supportsNamespacedMessageSource,
  pluginMessageSource,
  pluginMessageSourceFor,
  readToolResult,
  sourceModeForSessionVersion,
  unwrapVolatile,
} from '../lib/compat.js'

// ── supportsNamespacedMessageSource：版本判定 ────────────────────────────

test('supportsNamespacedMessageSource: 0.1.x 一律为假', () => {
  assert.equal(supportsNamespacedMessageSource('0.1.5-rc.2'), false)
  assert.equal(supportsNamespacedMessageSource('0.1.2-rc.1'), false)
  assert.equal(supportsNamespacedMessageSource('0.1.99'), false)
})

test('supportsNamespacedMessageSource: 0.2.0 起（含预发布）为真', () => {
  assert.equal(supportsNamespacedMessageSource('0.2.0-rc.2'), true)
  assert.equal(supportsNamespacedMessageSource('0.2.0-rc.1'), true)
  assert.equal(supportsNamespacedMessageSource('0.2.0'), true)
  assert.equal(supportsNamespacedMessageSource('0.2.1'), true)
  assert.equal(supportsNamespacedMessageSource('0.3.0'), true)
  assert.equal(supportsNamespacedMessageSource('1.0.0'), true)
})

test('supportsNamespacedMessageSource: 未知/无法解析按假处理（回落 0.1.5）', () => {
  assert.equal(supportsNamespacedMessageSource(undefined), false)
  assert.equal(supportsNamespacedMessageSource(''), false)
  assert.equal(supportsNamespacedMessageSource('garbage'), false)
  assert.equal(supportsNamespacedMessageSource('0.2'), false)
})

// ── readToolResult：同一语义、两种形状的对照夹具 ────────────────────────

/** 两种形状共同语义：callId='call-42'，结果文本='stdout line' */
const CALL_ID = 'call-42'
const RESULT_TEXT = 'stdout line'

/** v3（0.1.5）：toolCallId 与文本都嵌在 content[0] 的 tool-result 包装块里 */
const TOOL_RESULT_V3 = {
  turn: 1,
  step: 3,
  message: {
    content: [
      {
        toolCallId: CALL_ID,
        content: [{ type: 'text', text: RESULT_TEXT }],
      },
    ],
  },
}

/** v4（0.2.0 实测形状）：data 键 ['error','message','step','turn']；
 *  toolCallId 在 message 层、content 已展平、role='tool' */
const TOOL_RESULT_V4 = {
  error: undefined,
  step: 3,
  turn: 1,
  message: {
    id: 'msg-7',
    isError: false,
    role: 'tool',
    source: { kind: 'tool', toolCallId: CALL_ID },
    toolCallId: CALL_ID,
    content: [{ type: 'text', text: RESULT_TEXT }],
  },
}

test('readToolResult: v3 夹具读出 callId 与 text', () => {
  assert.deepEqual(readToolResult(TOOL_RESULT_V3), { callId: CALL_ID, text: RESULT_TEXT })
})

test('readToolResult: v4 夹具读出与 v3 相同的 callId 与 text（同一语义）', () => {
  assert.deepEqual(readToolResult(TOOL_RESULT_V4), { callId: CALL_ID, text: RESULT_TEXT })
})

test('readToolResult: v3/v4 夹具结果完全一致（对照用例）', () => {
  assert.deepEqual(readToolResult(TOOL_RESULT_V3), readToolResult(TOOL_RESULT_V4))
})

test('readToolResult: v4 展平多文本块按出现顺序拼接，非 text 块忽略', () => {
  const read = readToolResult({
    message: {
      toolCallId: 'c1',
      content: [
        { type: 'text', text: 'line1' },
        { type: 'image', text: 'not-a-text-block' },
        { type: 'text', text: 'line2' },
      ],
    },
  })
  assert.deepEqual(read, { callId: 'c1', text: 'line1\nline2' })
})

test('readToolResult: v3 无 text 块时 text 为 undefined（不抛）', () => {
  assert.deepEqual(readToolResult({ message: { content: [{ toolCallId: 'c2', content: [] }] } }), {
    callId: 'c2',
    text: undefined,
  })
})

test('readToolResult: 回落 data.callId', () => {
  assert.deepEqual(readToolResult({ callId: 'c3' }), { callId: 'c3', text: undefined })
})

test('readToolResult: 任何形状都取不到 → 双 undefined（不抛）', () => {
  assert.deepEqual(readToolResult({}), { callId: undefined, text: undefined })
  assert.deepEqual(readToolResult(undefined), { callId: undefined, text: undefined })
  assert.deepEqual(readToolResult(null), { callId: undefined, text: undefined })
  assert.deepEqual(readToolResult('garbage'), { callId: undefined, text: undefined })
})

// ── pluginMessageSource：source 形状选择 ─────────────────────────────────

test('pluginMessageSource: 0.1.5 判定给出 legacy 形状', () => {
  assert.deepEqual(pluginMessageSource('0.1.5-rc.2'), {
    kind: 'plugin',
    plugin: '@artomyuan/dsh-a2a-server',
  })
})

test('pluginMessageSource: 0.2.0 判定给出命名空间化形状', () => {
  assert.deepEqual(pluginMessageSource('0.2.0-rc.2'), { kind: 'plugin:@artomyuan/dsh-a2a-server' })
  assert.deepEqual(pluginMessageSource('0.2.0'), { kind: 'plugin:@artomyuan/dsh-a2a-server' })
})

test('pluginMessageSource: 探测一致性（不抛，形状与显式版本判定一致）', () => {
  // 本仓库 devDep 的 dsh-agent exports 含 ./package.json，探测应成功返回
  // 版本串；无参调用（真实探测）与按探测版本显式判定的形状一致。
  const version = dshRuntimeVersion()
  assert.equal(typeof version, 'string')
  assert.match(version, /^\d+\.\d+\.\d+/)
  assert.deepEqual(pluginMessageSource(), pluginMessageSource(version))
})

test('pluginMessageSource: 无法解析的显式版本回落 legacy 形状（不抛）', () => {
  assert.deepEqual(pluginMessageSource('garbage'), {
    kind: 'plugin',
    plugin: '@artomyuan/dsh-a2a-server',
  })
})

test('sourceModeForSessionVersion: v4 起为 namespaced，v3 及未知为 legacy', () => {
  assert.equal(sourceModeForSessionVersion(4), 'namespaced')
  assert.equal(sourceModeForSessionVersion(5), 'namespaced')
  assert.equal(sourceModeForSessionVersion(3), 'legacy')
  assert.equal(sourceModeForSessionVersion(0), 'legacy')
  assert.equal(sourceModeForSessionVersion(undefined), 'legacy')
})

test('pluginMessageSourceFor: 显式 mode 给出对应形状（重试兜底用）', () => {
  assert.deepEqual(pluginMessageSourceFor('legacy'), { kind: 'plugin', plugin: '@artomyuan/dsh-a2a-server' })
  assert.deepEqual(pluginMessageSourceFor('namespaced'), { kind: 'plugin:@artomyuan/dsh-a2a-server' })
})

// ── unwrapVolatile：volatile 引用对象解包（纯函数、双版本都要） ──────────

test('unwrapVolatile: plain 标量原样返回（幂等）', () => {
  assert.equal(unwrapVolatile(42), 42)
  assert.equal(unwrapVolatile('str'), 'str')
  assert.equal(unwrapVolatile(true), true)
  assert.equal(unwrapVolatile(null), null)
})

test('unwrapVolatile: undefined 原样返回', () => {
  assert.equal(unwrapVolatile(undefined), undefined)
})

test('unwrapVolatile: 引用对象取 get()', () => {
  assert.equal(unwrapVolatile({ get: () => 'value' }), 'value')
})

test('unwrapVolatile: 引用对象内嵌引用对象递归 get()', () => {
  assert.equal(unwrapVolatile({ get: () => ({ get: () => 'inner' }) }), 'inner')
})

test('unwrapVolatile: 嵌套对象/数组逐层解包，普通值不丢', () => {
  const nested = {
    port: { get: () => 8092 },
    deep: { host: { get: () => '127.0.0.1' } },
    list: [{ get: () => 'a' }, 2, null],
  }
  assert.deepEqual(unwrapVolatile(nested), {
    port: 8092,
    deep: { host: '127.0.0.1' },
    list: ['a', 2, null],
  })
})

test('isVolatile: 结构判定（typeof v?.get === "function"）', () => {
  assert.equal(isVolatile({ get: () => 1 }), true)
  assert.equal(isVolatile({ get: 1 }), false)
  assert.equal(isVolatile(null), false)
  assert.equal(isVolatile(undefined), false)
  assert.equal(isVolatile('x'), false)
  assert.equal(isVolatile([1, 2]), false)
  assert.equal(isVolatile(42), false)
})

// ── A6：助手实时增量双事件面（版本谓词 + 帧/chunk 缓冲状态机） ──────────

test('supportsAssistantStreamEvents: 明确读到 0.1.x 才为假', () => {
  assert.equal(supportsAssistantStreamEvents('0.1.5-rc.2'), false)
  assert.equal(supportsAssistantStreamEvents('0.1.2-rc.1'), false)
  assert.equal(supportsAssistantStreamEvents('0.1.99'), false)
})

test('supportsAssistantStreamEvents: 0.2.0 起为真', () => {
  assert.equal(supportsAssistantStreamEvents('0.2.0-rc.2'), true)
  assert.equal(supportsAssistantStreamEvents('0.2.0'), true)
  assert.equal(supportsAssistantStreamEvents('0.3.0'), true)
  assert.equal(supportsAssistantStreamEvents('1.0.0'), true)
})

test('supportsAssistantStreamEvents: 探测失败按真（方向与 A1 相反：漏订代价远大于多订）', () => {
  assert.equal(supportsAssistantStreamEvents(undefined), true)
  assert.equal(supportsAssistantStreamEvents(''), true)
  assert.equal(supportsAssistantStreamEvents('garbage'), true)
})

/** 0.2.0 帧构造器：start（带 turn/step）/ chunk（带 StreamChunk）/ end */
const frameStart = (turn = 1, step = 2) => ({ type: 'start', turn, step, attemptId: 'a', revision: 1 })
const frameChunk = (chunk) => ({ type: 'chunk', index: 0, chunk })
const frameEnd = () => ({ type: 'end', index: 3, outcome: { kind: 'committed' } })

test('applyAssistantStreamFrame: start/chunk/end 三态——仅 chunk 帧走缓冲，任意帧置去重门', () => {
  const state = createAssistantIngestState()
  assert.equal(state.runtimeStreamSeen, false)
  assert.deepEqual(applyAssistantStreamFrame(state, frameStart()), [])
  assert.equal(state.runtimeStreamSeen, true)
  assert.deepEqual(applyAssistantStreamFrame(state, frameChunk({ type: 'block-start', index: 0, blockType: 'text' })), [])
  assert.deepEqual(applyAssistantStreamFrame(state, frameChunk({ type: 'text-delta', index: 0, text: '你' })), [])
  assert.deepEqual(
    applyAssistantStreamFrame(state, frameChunk({ type: 'block-end', index: 0, block: { type: 'text' } })),
    [{ kind: 'text', text: '你' }],
  )
  assert.deepEqual(applyAssistantStreamFrame(state, frameEnd()), [])
})

test('applyAssistantStreamFrame: text 与 reasoning 各自在 block-end 落地', () => {
  const state = createAssistantIngestState()
  applyAssistantStreamFrame(state, frameChunk({ type: 'block-start', index: 0, blockType: 'text' }))
  applyAssistantStreamFrame(state, frameChunk({ type: 'text-delta', index: 0, text: 'hello' }))
  assert.deepEqual(
    applyAssistantStreamFrame(state, frameChunk({ type: 'block-end', index: 0, block: { type: 'text' } })),
    [{ kind: 'text', text: 'hello' }],
  )
  applyAssistantStreamFrame(state, frameChunk({ type: 'block-start', index: 1, blockType: 'reasoning' }))
  applyAssistantStreamFrame(state, frameChunk({ type: 'reasoning-delta', index: 1, text: '想一下' }))
  assert.deepEqual(
    applyAssistantStreamFrame(state, frameChunk({ type: 'block-end', index: 1, block: { type: 'reasoning' } })),
    [{ kind: 'thinking', text: '想一下' }],
  )
})

test('applyAssistantStreamFrame: 空块（无 delta）不落地', () => {
  const state = createAssistantIngestState()
  applyAssistantStreamFrame(state, frameChunk({ type: 'block-start', index: 0, blockType: 'text' }))
  assert.deepEqual(
    applyAssistantStreamFrame(state, frameChunk({ type: 'block-end', index: 0, block: { type: 'text' } })),
    [],
  )
  // 连 block-start 都没有的裸 block-end 同样不落地
  assert.deepEqual(
    applyAssistantStreamFrame(state, frameChunk({ type: 'block-end', index: 7, block: { type: 'text' } })),
    [],
  )
})

test('0.1.5 路径：未见过进程内帧时 session/event 的 assistant/chunk 正常落地', () => {
  const state = createAssistantIngestState()
  assert.deepEqual(applySessionAssistantChunk(state, { type: 'block-start', index: 0, blockType: 'text' }), [])
  assert.deepEqual(applySessionAssistantChunk(state, { type: 'text-delta', index: 0, text: 'legacy' }), [])
  assert.deepEqual(
    applySessionAssistantChunk(state, { type: 'block-end', index: 0, block: { type: 'text' } }),
    [{ kind: 'text', text: 'legacy' }],
  )
  assert.equal(state.runtimeStreamSeen, false)
})

test('去重：见过进程内帧后，同一任务的 session assistant/chunk 全部静默', () => {
  const state = createAssistantIngestState()
  applyAssistantStreamFrame(state, frameStart())
  assert.deepEqual(applySessionAssistantChunk(state, { type: 'block-start', index: 0, blockType: 'text' }), [])
  assert.deepEqual(applySessionAssistantChunk(state, { type: 'text-delta', index: 0, text: 'dup' }), [])
  assert.deepEqual(
    applySessionAssistantChunk(state, { type: 'block-end', index: 0, block: { type: 'text' } }),
    [],
  )
})

test('去重：同一 block-end 重复投喂只落地一次（缓冲随块清空）', () => {
  const state = createAssistantIngestState()
  applySessionAssistantChunk(state, { type: 'block-start', index: 0, blockType: 'text' })
  applySessionAssistantChunk(state, { type: 'text-delta', index: 0, text: 'once' })
  const blockEnd = { type: 'block-end', index: 0, block: { type: 'text' } }
  assert.deepEqual(applySessionAssistantChunk(state, blockEnd), [{ kind: 'text', text: 'once' }])
  assert.deepEqual(applySessionAssistantChunk(state, blockEnd), [])
})

test('assistantStreamTurnStep: 仅 start 帧携带 turn/step，chunk/end/未知帧返回空对象', () => {
  assert.deepEqual(assistantStreamTurnStep(frameStart(3, 4)), { turn: 3, step: 4 })
  assert.deepEqual(assistantStreamTurnStep(frameChunk({ type: 'finish' })), {})
  assert.deepEqual(assistantStreamTurnStep(frameEnd()), {})
  assert.deepEqual(assistantStreamTurnStep(undefined), {})
})

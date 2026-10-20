/**
 * §2.6 问答桥接的**A2A 侧契约回归测试**（2026-10-17 先以 spike 实证，后固化为本条）。
 *
 * 只依赖已装 `@a2a-js/sdk@1.1.0`，不起 dsh 运行时；三条命题：
 *  1. executor 在任务中途 publish `statusUpdate(INPUT_REQUIRED)` → 首条
 *     `SendStreamingMessage` 流**主动收束**（等待期不占长连接）；
 *  2. 携带同一 `message.taskId` 的续投请求能在**非终态**任务上被受理，
 *     并拿到**同一条事件总线**（`keepBusAliveStates` 默认含 INPUT_REQUIRED）；
 *  3. 首跳 executor 解挂后继续 publish 的 artifact/completed 会流向**续投那条流**
 *     （即"挂起可恢复"）。
 *
 * 外加一条运行期才暴露的硬约束与一条变体：
 *  4. **续投分支必须先补一个 task 快照**——新流首帧若不是 task/message，SDK 的
 *     `_advanceStreamPattern` 直接抛 `UnsupportedOperationError`（反证用例）；
 *  5. 补了快照之后，"解挂即返回"也能跑通（总线因 INPUT_REQUIRED 保活）；生产实现的
 *     **作答**路径仍取保守形态"补快照 + 等本任务终态"，不吃这个保活细节（变体用例）。
 *     注意：生产另一条路径——"误用续投（没带作答载荷而任务正等作答）以 INPUT_REQUIRED
 *     收束本次流"——**确实依赖**该保活（否则会清掉首跳总线）。
 *
 * 运行：`node --test tests/qna-continuation.test.mjs`（`pnpm test` 已含）。
 * 与生产实现的距离：只用 SDK 的 `JsonRpcTransportHandler` + 自写 executor 假件，
 * 报文形状与桥侧 `_streaming_message_body` 逐字一致（role=ROLE_USER / parts[].text）。
 * 第 4 条是**刻意保留的绊线**：SDK 若升级到允许"裸续投"，用例会失败，提醒重新核对
 * src/index.ts 续投分支对 task 快照的依赖。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
} from '@a2a-js/sdk/server'
import { A2A_PROTOCOL_VERSION, TaskState } from '@a2a-js/sdk'
// 用**生产实现**构造提问载荷：这样"问题形状经 SDK 线上编解码仍完好"才真的被断言
import { questionPayload } from '../lib/questions.js'

/** 与 src/index.ts buildAgentCard 同形的最小卡（只取 handler 运行期会读的字段） */
function spikeAgentCard() {
  return {
    name: 'dsh-spike',
    description: 'qna continuation spike',
    supportedInterfaces: [
      {
        url: 'http://127.0.0.1:0/',
        protocolBinding: 'JSONRPC',
        tenant: '',
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    provider: { organization: 'deepseek', url: 'https://github.com/deepseek-ai' },
    version: '0.0.0-spike',
    capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text'],
    defaultOutputModes: ['text', 'task-status'],
    skills: [],
    documentationUrl: '',
    signatures: [],
  }
}

function textPart(value) {
  return { content: { $case: 'text', value }, metadata: undefined, filename: '', mediaType: 'text/plain' }
}

function dataPart(value) {
  return { content: { $case: 'data', value }, metadata: undefined, filename: '', mediaType: 'application/json' }
}

/** 报文：与 dsh-hermes-link `_streaming_message_body` 同形 */
function streamingEnvelope({ messageId, text, contextId, taskId }) {
  const message = {
    role: 'ROLE_USER',
    parts: [{ text, mediaType: 'text/plain' }],
    messageId,
  }
  if (contextId) message.contextId = contextId
  if (taskId) message.taskId = taskId
  return { jsonrpc: '2.0', id: `spike-${messageId}`, method: 'SendStreamingMessage', params: { message } }
}

/** 调一次 JSON-RPC：流式返回帧数组，非流式返回单体 */
async function rpc(transport, envelope) {
  const context = new ServerCallContext({ requestedVersion: A2A_PROTOCOL_VERSION })
  const result = await transport.handle(JSON.stringify(envelope), context)
  if (typeof result?.[Symbol.asyncIterator] === 'function') {
    const frames = []
    for await (const frame of result) frames.push(frame)
    return frames
  }
  return result
}

/**
 * `JsonRpcTransportHandler` yield 的是 **JSON-RPC 信封**（`{jsonrpc,id,result}`），
 * 且 `result` 里是**字符串**枚举（`TASK_STATE_*`）——与 SSE 线上形态一致。
 */
const SUBMITTED = 'TASK_STATE_SUBMITTED'
const WORKING = 'TASK_STATE_WORKING'
const COMPLETED = 'TASK_STATE_COMPLETED'
const INPUT_REQUIRED = 'TASK_STATE_INPUT_REQUIRED'

function resultOf(frame) {
  return frame?.result ?? frame
}

function stateOf(frame) {
  const result = resultOf(frame)
  return result?.statusUpdate?.status?.state ?? result?.task?.status?.state
}

function statesOf(frames) {
  return frames.map(stateOf).filter((s) => s !== undefined)
}

function taskIdOf(frames) {
  for (const frame of frames) {
    const result = resultOf(frame)
    if (result?.task?.id) return result.task.id
    if (result?.statusUpdate?.taskId) return result.statusUpdate.taskId
  }
  return undefined
}

function framesContainText(frames, needle) {
  return frames.some((frame) => JSON.stringify(frame).includes(needle))
}

/**
 * 假 executor：实现"提问挂起 → input-required → 续投解挂 → 跑完"的契约。
 *
 * resume 分支三态（spike 的对照变量）：
 *  - `snapshot+await`（保守推荐）：先补 task 快照 → 解挂 → 等本任务终态再返回；
 *  - `snapshot+return`：先补 task 快照 → 解挂 → 立即返回；
 *  - `bare`（反证）：不补快照就解挂返回。
 */
function makeExecutor({ resume = 'snapshot+await' } = {}) {
  const pending = new Map() // taskId -> { resolve }
  const completion = new Map() // taskId -> { promise, resolve }
  const trace = []
  let seenMetadata

  return {
    pending,
    trace,
    get seenMetadata() {
      return seenMetadata
    },
    async cancelTask() {},
    async execute(requestContext, eventBus) {
      const taskId = requestContext.taskId
      // 续投判定：同一任务已在等答
      if (pending.has(taskId)) {
        const entry = pending.get(taskId)
        pending.delete(taskId)
        const answer = requestContext.userMessage?.parts
          ?.map((p) => (p.content?.$case === 'text' ? p.content.value : ''))
          .join('')
        trace.push(`resume:${taskId}:${answer}`)
        if (resume !== 'bare') {
          // 关键一：续投这条**新流**必须以 task 快照开头（SDK stream pattern 校验），
          // 否则首帧 artifactUpdate 直接报 UnsupportedOperationError。
          const snapshot = requestContext.task
          eventBus.publish(
            AgentEvent.task({
              id: taskId,
              contextId: requestContext.contextId,
              status: snapshot?.status ?? {
                state: TaskState.TASK_STATE_INPUT_REQUIRED,
                timestamp: new Date().toISOString(),
              },
              artifacts: snapshot?.artifacts ?? [],
              history: snapshot?.history ?? [],
              metadata: snapshot?.metadata,
            }),
          )
        }
        entry.resolve(answer)
        if (resume === 'snapshot+await') {
          // 关键二（保守形态）：活到本任务终态再返回，避免续投这次 _settleBus 在
          // 状态跟踪器为空时提前 finished() + 清总线。
          await completion.get(taskId).promise
        }
        return
      }

      // 首跳
      seenMetadata = requestContext.userMessage?.metadata
      trace.push(`start:${taskId}`)
      const done = Promise.withResolvers()
      completion.set(taskId, done)
      eventBus.publish(
        AgentEvent.task({
          id: taskId,
          contextId: requestContext.contextId,
          status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date().toISOString() },
          artifacts: [],
          history: [],
          metadata: undefined,
        }),
      )
      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId: requestContext.contextId,
          status: { state: TaskState.TASK_STATE_WORKING, timestamp: new Date().toISOString() },
          metadata: {},
        }),
      )

      const answer = Promise.withResolvers()
      pending.set(taskId, answer)
      // 提问载荷随 input-required 状态消息一起送出（正式实现用它承载 question 事件面）
      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId: requestContext.contextId,
          status: {
            state: TaskState.TASK_STATE_INPUT_REQUIRED,
            timestamp: new Date().toISOString(),
            message: {
              messageId: `${taskId}-q`,
              role: 'ROLE_AGENT',
              taskId,
              contextId: requestContext.contextId,
              parts: [dataPart(questionPayload('ask-1', taskId, requestContext.contextId, [
              { id: 'q1', question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] },
            ]))],
            },
          },
          metadata: {},
        }),
      )

      const value = await answer.promise
      trace.push(`answered:${taskId}:${value}`)
      eventBus.publish(
        AgentEvent.artifactUpdate({
          taskId,
          contextId: requestContext.contextId,
          artifact: {
            artifactId: 'spike-result',
            name: 'Result',
            description: 'spike final',
            parts: [textPart(`ANSWER=${value} DONE`)],
            metadata: undefined,
            extensions: [],
          },
          append: false,
          lastChunk: true,
          metadata: undefined,
        }),
      )
      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId: requestContext.contextId,
          status: { state: TaskState.TASK_STATE_COMPLETED, timestamp: new Date().toISOString() },
          metadata: undefined,
        }),
      )
      completion.delete(taskId)
      done.resolve()
    },
  }
}

function makeHandler(executor) {
  const taskStore = new InMemoryTaskStore()
  const requestHandler = new DefaultRequestHandler(spikeAgentCard(), taskStore, executor)
  return { transport: new JsonRpcTransportHandler(requestHandler), taskStore }
}

test('qna-continuation · 正路（snapshot+await）：input-required 收束首流，taskId 续投拿到续流与终态', async () => {
  const executor = makeExecutor({ resume: 'snapshot+await' })
  const { transport, taskStore } = makeHandler(executor)

  // ① 首投
  const first = await rpc(transport, streamingEnvelope({ messageId: 'm1', text: '开工', contextId: 'ctx-spike-1' }))
  const firstStates = statesOf(first)
  assert.ok(firstStates.includes(SUBMITTED), `首流应含 SUBMITTED，实得 ${JSON.stringify(firstStates)}`)
  assert.ok(firstStates.includes(WORKING), `首流应含 WORKING，实得 ${JSON.stringify(firstStates)}`)
  assert.equal(
    firstStates.at(-1),
    INPUT_REQUIRED,
    `首流应以 INPUT_REQUIRED 收束（主动断流＝等待期不占 socket），实得 ${JSON.stringify(firstStates)}`,
  )
  assert.ok(
    framesContainText(first, '"kind":"question"') && framesContainText(first, 'ask-1'),
    'INPUT_REQUIRED 状态消息应承载 question 载荷（data part）',
  )
  // 生产载荷（lib/questions.js questionPayload）经 JSON-RPC 编解码后逐字段仍在
  assert.ok(framesContainText(first, '选哪个？'), '题干应完好到达线上')
  assert.ok(framesContainText(first, '甲') && framesContainText(first, '乙'), '选项应完好到达线上')
  assert.ok(framesContainText(first, `"taskId":"${taskIdOf(first)}"`), '载荷应自带 taskId')
  const taskId = taskIdOf(first)
  assert.ok(taskId, '首流应可读出 taskId')

  // 任务已落 store 且非终态（续投的受理前提）
  const stored = await taskStore.load(taskId, new ServerCallContext({ requestedVersion: A2A_PROTOCOL_VERSION }))
  assert.equal(stored?.status?.state, 6, 'store 内任务应为 INPUT_REQUIRED')

  // ② 续投：同一 taskId
  const second = await rpc(
    transport,
    streamingEnvelope({ messageId: 'm2', text: '甲', taskId, contextId: 'ctx-spike-1' }),
  )
  const secondStates = statesOf(second)
  assert.deepEqual(
    secondStates,
    [INPUT_REQUIRED, COMPLETED],
    `续投流应先补 INPUT_REQUIRED 快照、再收首跳跑完的 COMPLETED，实得 ${JSON.stringify(secondStates)}`,
  )
  assert.ok(framesContainText(second, 'ANSWER=甲 DONE'), '续投流应收到首跳解挂后产出的最终 artifact')
  assert.ok(framesContainText(second, '甲'), '续投流应携带答案报文（答案随续投 message 到达）')
  assert.deepEqual(
    executor.trace,
    [`start:${taskId}`, `resume:${taskId}:甲`, `answered:${taskId}:甲`],
    `执行轨迹应符合"首跳挂起 → 续投解挂 → 首跳跑完"，实得 ${JSON.stringify(executor.trace)}`,
  )
  console.log(`[qna-continuation] 正路通过：首流=${JSON.stringify(firstStates)} 续投流=${JSON.stringify(secondStates)}`)
})

test('qna-continuation · 能力声明：message.metadata 可穿透到 executor（认领闸的依据）', async () => {
  // §2.6 的服务端认领闸读的是 requestContext.userMessage.metadata["x-dsh-user-questions"]；
  // 该键必须原样穿过 JSON-RPC/transport 解码，否则桥声明了也白声明（提问永远不被认领）。
  const executor = makeExecutor({ resume: 'snapshot+await' })
  const { transport } = makeHandler(executor)
  const envelope = streamingEnvelope({ messageId: 'meta-1', text: '开工', contextId: 'ctx-meta' })
  envelope.params.message.metadata = { 'x-dsh-user-questions': true, nested: { a: 1 } }
  await rpc(transport, envelope)
  assert.deepEqual(
    executor.seenMetadata,
    { 'x-dsh-user-questions': true, nested: { a: 1 } },
    '能力声明必须原样到达 executor',
  )
})

test('qna-continuation · 反证（bare）：续投不吃 task 快照 → 续投流以 SDK 校验错误收场', async () => {
  const executor = makeExecutor({ resume: 'bare' })
  const { transport } = makeHandler(executor)

  const first = await rpc(transport, streamingEnvelope({ messageId: 'n1', text: '开工', contextId: 'ctx-spike-2' }))
  const taskId = taskIdOf(first)
  assert.ok(taskId)

  await assert.rejects(
    () => rpc(transport, streamingEnvelope({ messageId: 'n2', text: '乙', taskId, contextId: 'ctx-spike-2' })),
    (err) => {
      assert.match(String(err?.message ?? err), /before initial 'Message'\/'Task' event/)
      return true
    },
    '反证预期：不补 task 快照时，续投流首帧校验直接失败',
  )
  console.log('[qna-continuation] 反证成立：bare 续投被 stream pattern 校验拒绝（已证实必须补 task 快照）')
})

test('qna-continuation · 变体（snapshot+return）：补了快照即可，无须占住第二次 execute', async () => {
  const executor = makeExecutor({ resume: 'snapshot+return' })
  const { transport } = makeHandler(executor)

  const first = await rpc(transport, streamingEnvelope({ messageId: 'r1', text: '开工', contextId: 'ctx-spike-3' }))
  const taskId = taskIdOf(first)
  assert.ok(taskId)

  const second = await rpc(
    transport,
    streamingEnvelope({ messageId: 'r2', text: '丙', taskId, contextId: 'ctx-spike-3' }),
  )
  const secondStates = statesOf(second)
  assert.deepEqual(
    secondStates,
    [INPUT_REQUIRED, COMPLETED],
    `补快照后即使立即返回，续投流仍应收到完成事件（bus 因 INPUT_REQUIRED 保活），实得 ${JSON.stringify(secondStates)}`,
  )
  assert.ok(framesContainText(second, 'ANSWER=丙 DONE'), '续投流应收到最终 artifact')
  console.log(`[qna-continuation] 变体成立：续投流=${JSON.stringify(secondStates)}（快照是充分条件）`)
})


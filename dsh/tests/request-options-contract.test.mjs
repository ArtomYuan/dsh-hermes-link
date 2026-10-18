/**
 * §2.1/§2.4 的**线上契约回归测试**：请求级选项随 `message.metadata` 过 SDK 的
 * JSON-RPC 编解码后，必须原样到达 executor（服务端解析它们的唯一入口）。
 *
 * 为什么单独一条：上一轮 §2.6 的教训是「我方返回 → 对方消费」的形状没对一遍就上线，
 * 结果消费方 `.map` 炸了。这里先把「桥发 metadata → 服务端收到」这段契约钉死：
 * `@a2a-js/sdk` 的 transport 会把 JSON 解成 Message，`metadata` 是否原样保留、
 * 嵌套值是否会变形，用真实 transport 断言，而不是靠读代码推断。
 *
 * 运行：`node --test tests/request-options-contract.test.mjs`（`pnpm test` 已含）。
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
import { SANDBOX_META_KEY, WORKSPACE_META_KEY } from '../lib/request-options.js'

/** 与 src/index.ts buildAgentCard 同形的最小卡 */
function card() {
  return {
    name: 'dsh',
    description: 'request-options contract',
    supportedInterfaces: [
      { url: 'http://127.0.0.1:0/', protocolBinding: 'JSONRPC', tenant: '', protocolVersion: A2A_PROTOCOL_VERSION },
    ],
    provider: { organization: 'deepseek', url: 'https://github.com/deepseek-ai' },
    version: '0.0.0-test',
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

/** 假 executor：只记录首投消息的 metadata，然后直接 COMPLETED */
function makeExecutor() {
  let seen
  return {
    get seenMetadata() { return seen },
    async cancelTask() {},
    async execute(requestContext, eventBus) {
      seen = requestContext.userMessage?.metadata
      eventBus.publish(AgentEvent.task({
        id: requestContext.taskId,
        contextId: requestContext.contextId,
        status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date().toISOString() },
        artifacts: [],
        history: [],
        metadata: undefined,
      }))
      eventBus.publish(AgentEvent.statusUpdate({
        taskId: requestContext.taskId,
        contextId: requestContext.contextId,
        status: { state: TaskState.TASK_STATE_COMPLETED, timestamp: new Date().toISOString() },
        metadata: {},
      }))
    },
  }
}

/** 发一条首投：message.metadata 由调用方给出 */
async function send(transport, metadata) {
  const message = {
    role: 'ROLE_USER',
    parts: [{ text: '开工', mediaType: 'text/plain' }],
    messageId: `m-${Math.random().toString(16).slice(2)}`,
    contextId: 'feishu/oc_x/omt_y',
  }
  if (metadata !== undefined) message.metadata = metadata
  const body = { jsonrpc: '2.0', id: '1', method: 'SendStreamingMessage', params: { message } }
  const context = new ServerCallContext({ requestedVersion: A2A_PROTOCOL_VERSION })
  const stream = await transport.handle(JSON.stringify(body), context)
  for await (const _frame of stream) { /* 排空 */ }
}

test('合同 · 请求级选项随 metadata 原样到达 executor（桥 → 服务端）', async () => {
  const executor = makeExecutor()
  const transport = new JsonRpcTransportHandler(new DefaultRequestHandler(card(), new InMemoryTaskStore(), executor))
  await send(transport, {
    [WORKSPACE_META_KEY]: '我的书',
    [SANDBOX_META_KEY]: 'workspace-write',
    'x-dsh-user-questions': true,
  })
  assert.deepEqual(executor.seenMetadata, {
    [WORKSPACE_META_KEY]: '我的书',
    [SANDBOX_META_KEY]: 'workspace-write',
    'x-dsh-user-questions': true,
  })
})

test('合同 · 不带 metadata 时 executor 看到 undefined（缺省＝现状）', async () => {
  const executor = makeExecutor()
  const transport = new JsonRpcTransportHandler(new DefaultRequestHandler(card(), new InMemoryTaskStore(), executor))
  await send(transport, undefined)
  assert.equal(executor.seenMetadata, undefined)
})

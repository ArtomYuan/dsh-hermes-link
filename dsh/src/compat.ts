/**
 * dsh 0.1.x / 0.2.x 双版本兼容适配（集中版本探测与双形状读取，便于单测）。
 *
 * 背景见 CONFIGURATION「dsh 0.1.5 / 0.2.0 双版本兼容」：
 *  - A1：0.2.0 的 `MessageSourceMap` 删除了 `kind:'plugin'` 种类，插件消息改为
 *    命名空间化 `kind:'plugin:<name>'`；0.1.5 仍是
 *    `{ kind:'plugin', plugin:'<name>' }`。
 *  - A2：0.2.0（v4 会话格式）的 `tool/result` 事件把 `toolCallId` 上移到 message
 *    层并把 `content` 展平为文本块数组；0.1.5（v3）是
 *    `message.content[0].toolCallId` + `message.content[0].content[0].text`。
 *  - A6：助手实时增量的双事件面。0.1.5 在 `session/event` 上发布
 *    `assistant/chunk`（按 block index 缓冲的会话事件）；0.2.0 删除该事件，改由
 *    进程内 cordis 事件 `agent/assistant-stream`（payload `{ agent, frame }`）
 *    发布。两者消费同一 `StreamChunk` 联合类型，故缓冲/落地状态机共用。
 *
 * 本模块只依赖 node 内置模块，不耦合 dsh 类型，可在任意 node 环境独立单测。
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

/** 插件名（也是 0.2.0 命名空间 source 的 kind 后缀） */
const PLUGIN_NAME = '@artomyuan/dsh-a2a-server'

/**
 * 结构判定一个值是否为 volatile 引用对象（schemastery `.volatile()` 的校验输出，
 * 由 cosmokit `createVolatile` 生成：`{ get(): T, [write]: … }`）。
 *
 * 用结构判定 `typeof v?.get === 'function'` 而非 cosmokit 的 `isVolatile`
 * （后者要求 `write` Symbol 在场），避免引入对 cosmokit 的运行时依赖；
 * 任意兼容的 `{ get() }` 引用对象都能被解包。
 */
export function isVolatile(value: unknown): value is { get(): unknown } {
  return typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function'
}

/**
 * 深度解包 volatile 引用对象为普通标量/对象（纯函数、零依赖，可独立单测）。
 *
 * 导出运行时 `Config`（volatile schema）后，cordis 会用 `Config['~standard']`
 * 校验 entry config，每个带 `.volatile()` 的字段都会变成 `{ get() }` 引用对象
 * （即使该字段带 default，校验输出也是引用对象），因此 0.1.5 / 0.2.0 双版本
 * 的运行时读配置都**必须**先解包。对普通值幂等（标量直接返回，对象/数组逐层
 * 深拷贝并递归解包）。
 *
 * @param value - 任意待解包值（volatile 引用、普通标量、嵌套对象/数组、undefined）
 * @returns 解包后的普通值
 */
export function unwrapVolatile(value: unknown): unknown {
  if (isVolatile(value)) return unwrapVolatile(value.get())
  if (Array.isArray(value)) return value.map(unwrapVolatile)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, unwrapVolatile(child)]))
  }
  return value
}

/**
 * 尽力把一个 schemastery 字段标记为 volatile（`.volatile()`），宿主不支持时
 * **原样返回该字段**。
 *
 * 为什么必须特性探测而不是直接调用：0.2.0 的宿主 schemastery 有 `.volatile()`
 * （3.18.4 起），而 0.1.5 的源码版宿主会把裸标识符 `@deepseek-ai/schemastery`
 * 解析到它自带的 `vendor/schemastery`（3.18.2，**无此方法**），并**盖过**插件
 * 自带的依赖副本 —— 于是「package.json 声明的版本」并不等于「运行时实得的
 * 版本」。直接调用会让插件在 0.1.5 上加载即崩
 * （`A2A_FIELD_SHAPES.port.volatile is not a function`，实测于 0.1.5 沙盒实例）。
 *
 * 探测失败的后果是良性的：0.1.5 上 schema 退回 plain 形状，`installSection`
 * 路径与未导出 `Config` 时完全一致；0.2.0 上必然存在 `.volatile()`，设置区照常派生。
 *
 * @param shape - 待标记的 schemastery 字段
 * @returns 标记后的字段；宿主不支持时返回入参本身
 */
export function volatileIfSupported<S>(shape: S): S {
  const candidate = shape as { volatile?: () => S }
  return typeof candidate?.volatile === 'function' ? candidate.volatile() : shape
}

/** 版本探测缓存哨兵：null = 尚未探测 */
let probed: string | undefined | null = null

/**
 * 探测当前运行时 `@deepseek-ai/dsh-agent` 的真实版本号。
 *
 * 0.1.x 与 0.2.0 的 `exports` 都含 `"./package.json"`（沙盒实测），因此用
 * `createRequire` 解析该子路径再读 `version` 即可；任何一步失败（包不存在、
 * 子路径未导出、JSON 损坏）返回 `undefined`，不抛。
 */
export function dshRuntimeVersion(): string | undefined {
  if (probed !== null) return probed
  try {
    const require = createRequire(import.meta.url)
    const pkgPath = require.resolve('@deepseek-ai/dsh-agent/package.json')
    const version = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown }).version
    probed = typeof version === 'string' ? version : undefined
  } catch {
    probed = undefined
  }
  return probed
}

/** 解析 `major.minor.patch[-pre]` 数字三元组（忽略预发布后缀）；失败返回 undefined */
function versionTriple(version: string): [number, number, number] | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  if (!m) return undefined
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/**
 * 判定当前运行时是否使用 0.2.0 的命名空间化消息 source 形状。
 *
 * 只比较数字三元组、忽略预发布后缀：`0.2.0-rc.2` / `0.2.0` / `0.2.x` / `1.x`
 * 为真，`0.1.5-rc.2` 与一切 0.1.x 为假；无法解析（含 `undefined`）按假处理，
 * 即回落到 0.1.5 形状（当前生产环境）。
 */
export function supportsNamespacedMessageSource(version: string | undefined): boolean {
  const t = version === undefined ? undefined : versionTriple(version)
  if (t === undefined) return false
  if (t[0] !== 0) return t[0] > 0
  if (t[1] !== 2) return t[1] > 2
  return t[2] >= 0
}

/**
 * 判定宿主是否可能发布 0.2.0 的「进程内助手实时增量」事件
 * `agent/assistant-stream`。
 *
 * 0.1.5 把 text/reasoning 增量作为 `session/event` 的 `assistant/chunk` 发布；
 * 0.2.0-rc.2 删除了该会话事件，实时增量只走进程内 cordis 事件
 * `agent/assistant-stream`（payload `{ agent, frame }`）。本谓词用于决定是否
 * 订阅后者：订阅一个宿主从不发布的事件在 cordis 上是无害的（实测 0.1.2 注册
 * 未知事件名正常返回 disposer，但 0.1.x 版本上直接不订更干净）。
 *
 * **兜底方向与 {@link supportsNamespacedMessageSource} 刻意相反：无法解析
 * （含 `undefined`）时按真处理。** 理由是失败代价不对称——漏订会让 0.2.0 静默
 * 丢掉全部 text/thinking 帧（本包 0.4.0 的真实缺陷），而多订一个惰性监听器零
 * 代价；只有「明确读到 0.1.x 版本号」才判假。
 *
 * @param version - `@deepseek-ai/dsh-agent` 版本（一般来自 {@link dshRuntimeVersion}）
 */
export function supportsAssistantStreamEvents(version: string | undefined): boolean {
  const t = version === undefined ? undefined : versionTriple(version)
  if (t === undefined) return true
  if (t[0] !== 0) return t[0] > 0
  return t[1] >= 2
}

/** 0.1.5 形状：独立 `plugin` 种类 + 插件名字段 */
export interface PluginMessageSourceLegacy {
  kind: 'plugin'
  plugin: string
}

/** 0.2.0 形状：命名空间化 kind，无独立 plugin 字段 */
export interface PluginMessageSourceNamespaced {
  kind: `plugin:${string}`
}

export type PluginMessageSource = PluginMessageSourceLegacy | PluginMessageSourceNamespaced

/**
 * 按运行时版本给出用户消息 source 形状：
 *  - 0.2.x：`{ kind: 'plugin:@artomyuan/dsh-a2a-server' }`；
 *  - 0.1.x 或版本探测失败：`{ kind: 'plugin', plugin: '@artomyuan/dsh-a2a-server' }`。
 *
 * 探测失败时回落到 0.1.5 形状并 `console.warn` 一行明确警告（当前生产是
 * 0.1.5，宁可保住现状也不静默改行为）。
 *
 * @param version - 显式版本号（测试注入）；省略时用 {@link dshRuntimeVersion} 探测
 */
export function pluginMessageSource(
  version: string | undefined = dshRuntimeVersion(),
): PluginMessageSource {
  if (version === undefined) {
    console.warn(
      '[dsh-a2a-server] cannot detect @deepseek-ai/dsh-agent runtime version; ' +
        'using 0.1.x plugin message source shape (fallback)',
    )
  }
  if (supportsNamespacedMessageSource(version)) {
    return { kind: `plugin:${PLUGIN_NAME}` }
  }
  return { kind: 'plugin', plugin: PLUGIN_NAME }
}

/** tool/result 双形状读取结果：取不到时字段为 undefined（不抛） */
export interface ToolResultRead {
  callId?: string
  text?: string
}

/** 用户消息 source 的两种形状（显式选择：运行时判定 + 首选未生效时重试兜底） */
export type PluginMessageSourceMode = 'legacy' | 'namespaced'

/**
 * 活会话的格式版本 → 消息 source 形状。
 *
 * 这是**运行时信号**：dsh 0.2.0 起会话格式为 v4，其 `MessageSourceMap` 只认
 * 命名空间化 kind；0.1.x 是 v3 + legacy 形状。用活会话 header 的版本判定，
 * 比读插件自己 node_modules 里可能滞后的 `@deepseek-ai/dsh-agent` 版本可靠。
 *
 * @param version - 活会话 header 的 `version`（取不到时为 undefined → legacy）
 */
export function sourceModeForSessionVersion(version: number | undefined): PluginMessageSourceMode {
  return typeof version === 'number' && version >= 4 ? 'namespaced' : 'legacy'
}

/**
 * 按显式 mode 构造用户消息 source（不做探测）。
 *
 * @param mode - `namespaced`（dsh 0.2.x）或 `legacy`（dsh 0.1.x）
 */
export function pluginMessageSourceFor(mode: PluginMessageSourceMode): PluginMessageSource {
  return mode === 'namespaced'
    ? { kind: `plugin:${PLUGIN_NAME}` }
    : { kind: 'plugin', plugin: PLUGIN_NAME }
}

/** v3/v4 共用的宽容块结构（所有字段可选，运行时形状由上层判定） */
interface ToolResultBlock {
  type?: string
  text?: string
  toolCallId?: string
  content?: ToolResultBlock[]
}

interface ToolResultMessage {
  toolCallId?: string
  content?: ToolResultBlock[]
}

interface ToolResultData {
  callId?: string
  message?: ToolResultMessage
}

/** 拼接块数组里的全部 text 块（保持出现顺序，`\n` 连接）；无 text 块返回 undefined */
function concatTextBlocks(blocks: unknown): string | undefined {
  if (!Array.isArray(blocks)) return undefined
  const texts: string[] = []
  for (const block of blocks) {
    if (block && typeof block === 'object' && (block as ToolResultBlock).type === 'text') {
      const text = (block as ToolResultBlock).text
      if (typeof text === 'string') texts.push(text)
    }
  }
  return texts.length > 0 ? texts.join('\n') : undefined
}

/**
 * v3/v4 双形状读取 `tool/result` 事件的 callId 与文本：
 *  1. 优先 v4（0.2.0）：`message.toolCallId` 在 message 层，`message.content`
 *     已展平为文本块数组；
 *  2. 回落 v3（0.1.5）：`message.content[0].toolCallId` +
 *     `message.content[0].content[0].text`（content[0] 是 tool-result 包装块）；
 *  3. 再回落 `data.callId`（部分旧事件把 callId 放在 data 层）。
 *
 * 任何形状都取不到时返回 `{ callId: undefined, text: undefined }`，不抛。
 */
export function readToolResult(data: ToolResultData | undefined | null): ToolResultRead {
  const message = data?.message
  if (message && typeof message === 'object') {
    const m = message as ToolResultMessage
    // v4：toolCallId 在 message 层
    if (typeof m.toolCallId === 'string') {
      return { callId: m.toolCallId, text: concatTextBlocks(m.content) }
    }
    const first = m.content?.[0]
    if (first && typeof first === 'object') {
      const f = first as ToolResultBlock
      // v3：content[0] 是 tool-result 包装块（toolCallId + 嵌套 content）
      if (typeof f.toolCallId === 'string' || Array.isArray(f.content)) {
        return {
          callId: typeof f.toolCallId === 'string' ? f.toolCallId : undefined,
          text: concatTextBlocks(f.content),
        }
      }
      // 展平块但 message 层无 toolCallId（病态 v4）：文本仍可读
      if (f.type !== undefined || typeof f.text === 'string') {
        return { callId: undefined, text: concatTextBlocks(m.content) }
      }
    }
  }
  // 最后回落 data.callId
  return {
    callId: typeof data?.callId === 'string' ? data.callId : undefined,
    text: undefined,
  }
}

// ── A6：助手实时增量的双事件面（0.1.5 `assistant/chunk` / 0.2.0 帧） ─────

/**
 * `StreamChunk` 中本状态机关心字段的宽容视图（不 import dsh 类型，字段全可选，
 * 运行时形状由宿主保证）。
 */
export interface AssistantChunkView {
  type?: string
  blockType?: string
  index?: number
  text?: string
  block?: { type?: string }
}

/** `agent/assistant-stream` 帧的宽容视图：start / chunk / end 三态 */
export interface AssistantStreamFrameView {
  type?: string
  turn?: number
  step?: number
  chunk?: AssistantChunkView
}

/** 在 `block-end` 落地的一条高信号增量（与对外 descriptor 的 kind 同名） */
export interface AssistantDelta {
  kind: 'text' | 'thinking'
  text: string
}

/**
 * 每个 dsh 任务一份的助手增量缓冲状态。
 *
 * 两条事件面都投喂同一个状态机：0.1.5 的 `session/event`→`assistant/chunk`
 * 与 0.2.0 的 `agent/assistant-stream`→`frame.chunk`，其 chunk 是同一
 * `StreamChunk` 联合类型，故按 block index 缓冲、`block-end` 整块落地的逻辑
 * 完全复用（整块语义：文本/思考只在块结束时且非空才 emit）。
 */
export interface AssistantIngestState {
  /** index → 累积文本（text 块） */
  text: Record<number, string>
  /** index → 累积思考（reasoning 块） */
  reasoning: Record<number, string>
  /** 本任务是否已见过 0.2.0 的进程内增量帧（去重门，见 {@link applySessionAssistantChunk}） */
  runtimeStreamSeen: boolean
}

/** 新建一份空的助手增量缓冲状态（任务级生命周期） */
export function createAssistantIngestState(): AssistantIngestState {
  return { text: {}, reasoning: {}, runtimeStreamSeen: false }
}

/**
 * 缓冲一个 `StreamChunk`，返回本次调用需要落地的高信号增量（通常为空；仅
 * 非空块的 `block-end` 产出一条）。
 *
 * 语义与 0.4.0 内联在 index.ts 的缓冲逻辑逐条等价：`text-delta` 挂到已开启的
 * text 块，旧形状偶发把它挂到 reasoning 块 index 上时沿用既有兜底；
 * `block-end` 无论 block 类型都清掉该 index 的两个缓冲（避免残留串块），只有
 * block 类型匹配且累积非空才 emit。
 */
function bufferAssistantChunk(
  state: AssistantIngestState,
  chunk: AssistantChunkView | undefined,
): AssistantDelta[] {
  if (chunk === undefined || chunk.index === undefined) return []
  const index = chunk.index
  const deltas: AssistantDelta[] = []
  switch (chunk.type) {
    case 'block-start':
      if (chunk.blockType === 'text') state.text[index] = ''
      else if (chunk.blockType === 'reasoning') state.reasoning[index] = ''
      return deltas
    case 'text-delta':
      if (state.text[index] !== undefined) state.text[index] += chunk.text ?? ''
      else if (state.reasoning[index] !== undefined) state.reasoning[index] += chunk.text ?? ''
      return deltas
    case 'reasoning-delta':
      if (state.reasoning[index] !== undefined) state.reasoning[index] += chunk.text ?? ''
      return deltas
    case 'block-end': {
      const text = state.text[index]
      delete state.text[index]
      if (chunk.block?.type === 'text' && text !== undefined && text.length > 0) {
        deltas.push({ kind: 'text', text })
      }
      const reasoning = state.reasoning[index]
      delete state.reasoning[index]
      if (chunk.block?.type === 'reasoning' && reasoning !== undefined && reasoning.length > 0) {
        deltas.push({ kind: 'thinking', text: reasoning })
      }
      return deltas
    }
    default:
      return deltas
  }
}

/**
 * 0.1.5 路径：消费 `session/event` 的 `assistant/chunk`。
 *
 * 去重门：本任务一旦收到过 0.2.0 的进程内帧，就静默忽略后续会话事件增量。
 * 0.2.0-rc.2 已不再发布 `assistant/chunk`，该门是为「同一宿主同时/先后发布两
 * 面」的过渡或未来情形兜底，保证同一 block 不会因两条路径各落地一次。
 * 反向不设门（先来会话增量不屏蔽进程内帧）：0.1.5 根本不发布进程内帧，反向门
 * 只在两面对发时有意义，而进程内帧是更早、更全的那一面，让后者始终生效可避免
 * 丢失低延迟帧。
 */
export function applySessionAssistantChunk(
  state: AssistantIngestState,
  chunk: AssistantChunkView | undefined,
): AssistantDelta[] {
  if (state.runtimeStreamSeen) return []
  return bufferAssistantChunk(state, chunk)
}

/**
 * 0.2.0 路径：消费一帧 `agent/assistant-stream`。
 *
 * 任意帧（start/chunk/end）都置 {@link AssistantIngestState.runtimeStreamSeen}，
 * 即「见过进程内面」以启用去重门；只有 `chunk` 帧携带 `StreamChunk`，交给同一
 * 状态机缓冲。调用方须先按 `payload.agent === handle.agent` 过滤（插件 ctx 非
 * agent-scoped，会收到同一宿主内所有 agent 的帧）。
 */
export function applyAssistantStreamFrame(
  state: AssistantIngestState,
  frame: AssistantStreamFrameView | undefined,
): AssistantDelta[] {
  state.runtimeStreamSeen = true
  if (frame?.type !== 'chunk') return []
  return bufferAssistantChunk(state, frame.chunk)
}

/**
 * 取帧自带的 turn/step。只有 `start` 帧携带这两个字段；`chunk`/`end` 帧返回空
 * 对象，调用方沿用最近一次 `start` 帧的值（与旧路径按 `data.turn/step` 取值
 * 语义一致）。
 */
export function assistantStreamTurnStep(
  frame: AssistantStreamFrameView | undefined,
): { turn?: number; step?: number } {
  if (frame?.type !== 'start') return {}
  return {
    ...(typeof frame.turn === 'number' ? { turn: frame.turn } : {}),
    ...(typeof frame.step === 'number' ? { step: frame.step } : {}),
  }
}

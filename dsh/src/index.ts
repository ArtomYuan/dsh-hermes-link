/**
 * dsh-a2a-server — 在 dsh profile 内启动 A2A (Agent2Agent) server，把 dsh
 * agent 会话通过 A2A 协议暴露给远端 agent（如 Hermes）。
 *
 * P0 最小闭环：
 *   - node:http 常驻 listener（Bearer token 认证 + 路由），挂
 *     `@a2a-js/sdk` v1.1.0 的 `JsonRpcTransportHandler`。
 *   - `AgentExecutor` 把 A2A task 的文本同步投给 dsh agent 会话执行，最终
 *     assistant 输出作为 A2A artifact 返回。
 *
 * P1 contextId 会话映射：
 *   - A2A `message.contextId`（Hermes 传 origin 派生）→ dsh 会话键。同
 *     contextId 复用同一 dsh 会话（上下文连续），异 contextId 隔离。
 *   - 两级接管：持久映射命中 → `ctx.agents.resume`；未命中 → 新建 + 写映射。
 *     映射持久化到 `$DSH_HOME/storages/a2a-context-map.json`，跨重启续接。
 *
 * P2a 流式中间事件 + 映射清理：
 *   - `SendStreamingMessage` 流式模式下，订阅 dsh agent 的事件面，把思考/工具/
 *     状态/文本等中间事件作为 A2A `artifactUpdate`（文本用 text Part、非文本用
 *     data Part 私有扩展）实时推给客户端。助手增量有双事件面（A6，见
 *     `src/compat.ts`）：0.1.5 走 `session/event` 的 `assistant/chunk`，0.2.0 走
 *     进程内事件 `agent/assistant-stream`，两面共用同一缓冲状态机并单向去重。
 *   - contextMap 每条目记 lastUsedAt，TTL（默认 7 天）清理过期孤儿条目。
 *
 * P3 工作区自动归组：
 *   - 新建会话后自动登记到其 cwd 对应的工作区；启动时对存量未分组会话批量捞回补挂。
 */

import type { Context } from '@deepseek-ai/cordis'
// 类型声明合并：让 ctx.agents / ctx.agentPresets 在 Context 上有类型
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
// 注（A5）：0.2.0 侧的 preset 服务包 @deepseek-ai/dsh-agent-preset-registry
// 已列为 optional peer + devDependency，但这里刻意不做 `import type {}`——
// 实测其 0.2.0 类型链会把 schemastery 的 Schema/Mode 全局增强进 0.1.x 的
// 类型检查程序，导致本包 settings schema 声明不再通过 typecheck（两个版本的
// 类型增强冲突）。运行时无类型需求（0.2.0 上该包提供同名 agentPresets 服务），
// 保留依赖仅为版本门/锁文件准备，详见 IMPL-STATUS。
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_PATH,
  TaskState,
  formatSSEEvent,
} from '@a2a-js/sdk'
import type { AgentCard, Part } from '@a2a-js/sdk'
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
} from '@a2a-js/sdk/server'
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server'
import {
  applySandboxTier,
  readRequestOptions,
  resolveWorkspaceTarget,
} from './request-options.ts'
import {
  FIRST_USE_WORKSPACE_OPTIONS,
  bindingFromAnswers,
  effectiveRequestOptions,
  firstUseQuestions,
  loadBindingStore,
} from './link-binding.ts'
import type { FirstUseMode, LinkBindingStore, WorkspaceChoice } from './link-binding.ts'
import { USER_QUESTIONS_META_KEY } from './link-protocol.ts'
import type { RequestOptions, SandboxPresetService } from './request-options.ts'
import { installA2ASettings, A2AConfigSchema, A2ASettingsSchema, DEFAULT_SETTLE_CAP_MS } from './settings.ts'
import type { A2ASettings } from './settings.ts'
import {
  abandonQuestions,
  claimQuestion,
  continuationDisposition,
  pendingQuestionCount,
  readQuestionAnswer,
  resolveQuestion,
  toQuestionItems,
} from './questions.ts'
import type { OwnedTask, UserQuestionRequest } from './questions.ts'
import { waitForSubagentQuiescence } from './settle.ts'
import type { SettleHost, SettleOutcome, SubagentChildrenSource, SubagentSignal } from './settle.ts'
import {
  applyAssistantStreamFrame,
  applySessionAssistantChunk,
  assistantStreamTurnStep,
  createAssistantIngestState,
  dshRuntimeVersion,
  pluginMessageSourceFor,
  readToolResult,
  sourceModeForSessionVersion,
  supportsAssistantStreamEvents,
  unwrapVolatile,
  type AssistantStreamFrameView,
  type PluginMessageSourceMode,
} from './compat.ts'

/** 投递后等待 turn/start 的宽限期；超时即换另一种消息 source 形状重试（A1 兜底） */
const TURN_START_GRACE_MS = 2000

/** Cordis 插件名 */
export const name = '@artomyuan/dsh-a2a-server'

/** 声明依赖的核心服务（必须与代码里的 ctx.get / 直接调用对齐） */
export const inject = ['agents', 'agentPresets', 'sessions']

/** 插件配置（运行时 schema + 同名类型导出） */
export const Config = A2AConfigSchema
/**
 * plain schema（0.1.5 `installSection` 用）。随 `Config` 一并导出，供测试与
 * 消费方对照：其字段为 plain 标量（无 `.volatile()`），与 `Config` 的 volatile
 * 引用对象输出形成对照。
 */
export const SettingsSchema = A2ASettingsSchema
/**
 * 插件配置类型（plain 形状）。0.2.0 的 settings 服务用运行时 `Config` schema
 * 派生设置区，cordis 在双版本都用它解析 entry config；解析后每个字段会变成
 * volatile 引用对象（`{ get() }`），故运行时读配置一律经 `unwrapVolatile` 解包。
 * 本类型保持 plain 标量形状以免破坏既有引用与类型声明。
 */
export type Config = A2ASettings

/** 逐请求携带执行模式（同步 / 流式）：HTTP 层写入，execute 内读取 */
const executionMode = new AsyncLocalStorage<{ streaming: boolean }>()

/**
 * §2.6 问答能力的客户端声明键：仅当来消息的 ``metadata`` 显式带上
 * ``{"x-dsh-user-questions": true}`` 时，本插件才认领该会话的提问。
 *
 * 为什么必须显式声明：「认领」＝由本插件接手作答，如果调用方根本没能力作答（不是
 * hermes-a2a-bridge，或桥没跑），提问就会被挂到一个永远收不到答案的地方——而问答
 * 全程零超时，等于无声挂死。声明制让**缺省行为与今天一致**（提问照旧以 NO_PROVIDER
 * 立刻失败），只有声明过的调用方才进入问答桥接。
 */
const QNA_OPT_IN_KEY = USER_QUESTIONS_META_KEY

/** 读客户端问答能力声明（缺省 false＝不认领） */
function readsQuestionOptIn(message: { metadata?: unknown } | undefined): boolean {
  const metadata = message?.metadata as Record<string, unknown> | undefined
  return metadata?.[QNA_OPT_IN_KEY] === true
}

/** 运行时配置（apply 时从 config / settings / 环境初始化，提供安全默认值） */
const runtimeConfig = {
  provider: 'deepseek-official',
  // 空字符串 = 不覆盖 model，跟随 dsh 的用户/默认设置；显式配置则覆盖
  model: 'deepseek-v4-flash',
  preset: 'standard',
  authToken: '',
  cwd: '',
  port: undefined as number | undefined,
  host: undefined as string | undefined,
  contextMapPath: undefined as string | undefined,
  contextMapTtlDays: 7,
  // 释放 Lead 前等待活跃 continuable 子代理结算的上限（毫秒）；0 = 关闭等待
  settleCapMs: DEFAULT_SETTLE_CAP_MS,
  // §2.2 首选定：off（缺省＝现状，不干预）/ ask（对话首投发「选工作区+沙箱档」卡）
  firstUseSelection: 'off' as FirstUseMode,
}

/** 构造一个纯文本 Part */
function textPart(value: string): Part {
  return {
    content: { $case: 'text', value },
    metadata: undefined,
    filename: '',
    mediaType: 'text/plain',
  }
}

/** 构造一个结构化 data Part（私有扩展：承载思考/工具/状态等中间事件） */
function dataPart(value: unknown): Part {
  return {
    content: { $case: 'data', value },
    metadata: undefined,
    filename: '',
    mediaType: 'application/json',
  }
}

/** 从 A2A user message 提取文本（拼接所有 text part） */
function userMessageText(message: { parts: Part[] }): string {
  return message.parts
    .map((p) => (p.content?.$case === 'text' ? p.content.value : ''))
    .join('\n')
    .trim()
}

/** cwd realpath 规范化（解析符号链接与 .. 段），失败回退 resolve */
async function canonicalCwd(raw: string): Promise<string> {
  try {
    return await realpath(raw)
  } catch {
    return resolve(raw)
  }
}

/** 工作区视图（ctx.get('workspaceRegistry')）：可选依赖，headless / 无 workspace 插件的环境自动跳过 */
interface WorkspaceView {
  id: string
  path: string
  /** 展示名（注册表 Workspace.title；缺省为路径末段） */
  title?: string
  sessionIds: readonly SessionId[]
  attachSession?: (sessionId: SessionId) => Promise<void>
}
interface WorkspaceRegistryView {
  create?: (path: string) => Promise<WorkspaceView>
  resolveByPath?: (path: string) => Promise<WorkspaceView | undefined>
  list?: () => WorkspaceView[]
}

/** resolveByPath ?? create，幂等；无 workspaceRegistry 时返回 undefined */
async function ensureWorkspace(ctx: Context, canonical: string): Promise<WorkspaceView | undefined> {
  const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryView | undefined
  if (!registry) return undefined
  return (await registry.resolveByPath?.(canonical)) ?? (await registry.create?.(canonical))
}

/**
 * 把会话挂名到其 cwd 对应的工作区。官方 attachSession 强校验 realpath(header.cwd)
 * 精确等于 workspace.path，所以 canonical 必须是 header.cwd 的 realpath 规范化值；
 * 失败仅告警不阻断任务（分组是锦上添花）。
 */
async function attachToWorkspace(ctx: Context, canonical: string, sessionId: SessionId): Promise<void> {
  try {
    const ws = await ensureWorkspace(ctx, canonical)
    if (ws?.attachSession) await ws.attachSession(sessionId)
  } catch (e) {
    console.warn('[dsh-a2a-server] workspace attach failed:', (e as Error)?.message ?? e)
  }
}

/** 按会话 header 的 cwd（realpath 规范化后）补挂工作区；header 无 cwd 时静默跳过 */
async function attachSessionCwd(ctx: Context, sessionId: SessionId, cwd: string | undefined): Promise<void> {
  if (cwd === undefined) return
  await attachToWorkspace(ctx, await canonicalCwd(cwd), sessionId)
}

/** 读取 HTTP 请求体为 UTF-8 字符串 */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectBody)
  })
}

/** 探测端口是否空闲（check-then-listen 的 dev 级探测，竞态可忽略） */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolveFree) => {
    const probe = http.createServer()
    probe.once('error', () => resolveFree(false))
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolveFree(true))
    })
  })
}

// ── contextId 会话映射（P1）────────────────────────────────────────────
// 键 `${contextId}\0${cwd}` → sessionId（同 harness-mcp-server 的 origin-map
// 格式）。同 contextId 复用同一 dsh 会话；映射持久化跨重启 resume。

/** 映射条目：sessionId + 最近使用时间戳（TTL 清理依据） */
interface ContextMapEntry {
  sessionId: string
  lastUsedAt: number
}

/** 常驻内存映射：复合键（contextId\0cwd）→ { sessionId, lastUsedAt } */
const contextMap = new Map<string, ContextMapEntry>()

/** 映射落盘路径；apply() 解析 dshHomePath 服务后赋值 */
let contextMapPath: string | null = null

/** 映射落盘串行链（避免并发写交错） */
let contextMapWriteChain = Promise.resolve()

/** 清理超期条目（lastUsedAt 超过 TTL 天）；返回清理数 */
function cleanupContextMap(): number {
  const ttlMs = runtimeConfig.contextMapTtlDays * 24 * 60 * 60 * 1000
  const now = Date.now()
  let removed = 0
  for (const [k, entry] of contextMap) {
    if (now - entry.lastUsedAt > ttlMs) {
      contextMap.delete(k)
      removed++
    }
  }
  if (removed > 0) console.log(`[dsh-a2a-server] context-map cleanup: removed ${removed} expired entries`)
  return removed
}

/** 读 a2a-context-map.json 回填 contextMap 并清理过期条目（ENOENT 静默空映射） */
async function loadContextMap(): Promise<void> {
  if (contextMapPath === null) return
  try {
    const raw = await readFile(contextMapPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        // 向后兼容：旧格式 v 为 string（sessionId）；新格式为 { sessionId, lastUsedAt }
        if (typeof v === 'string') {
          contextMap.set(k, { sessionId: v, lastUsedAt: Date.now() })
        } else if (v && typeof v === 'object' && typeof (v as { sessionId?: unknown }).sessionId === 'string') {
          const entry = v as { sessionId: string; lastUsedAt?: unknown }
          contextMap.set(k, {
            sessionId: entry.sessionId,
            lastUsedAt: typeof entry.lastUsedAt === 'number' ? entry.lastUsedAt : Date.now(),
          })
        }
      }
    }
    cleanupContextMap()
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') {
      console.warn('[dsh-a2a-server] context-map load failed:', (e as Error)?.message ?? e)
    }
  }
}

/** 串行落盘 contextMap（先清理过期 → 快照 → mkdir → tmp 写 → rename 原子覆盖）；失败仅 warn 不阻断 */
function persistContextMap(): Promise<void> {
  contextMapWriteChain = contextMapWriteChain.then(async () => {
    if (contextMapPath === null) return
    cleanupContextMap()
    const snapshot = JSON.stringify(Object.fromEntries(contextMap), null, 2)
    const tmp = `${contextMapPath}.tmp`
    try {
      await mkdir(dirname(contextMapPath), { recursive: true })
      await writeFile(tmp, snapshot)
      await rename(tmp, contextMapPath)
    } catch (e) {
      console.warn('[dsh-a2a-server] context-map persist failed:', (e as Error)?.message ?? e)
    }
  })
  return contextMapWriteChain
}

/** 会话解析结果：disposeAfter = true 表示任务毕须 flush + dispose 释放句柄 */
interface ResolvedSession {
  sessionId: SessionId
  handle: AgentHandle
}

/** 流式中间事件描述符（dsh 会话事件 → 高信号映射，见 runDshTask 的订阅器） */
interface StreamEventDescriptor {
  kind: 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'turn_start' | 'turn_end'
  turn?: number
  step?: number
  text?: string
  name?: string
  arguments?: string
  reason?: string
}

/** 组装 agent 的 provider/model/preset 选项（创建与 resume 共用的 agentOptions + setup） */
function agentComposition(ctx: Context) {
  return {
    agentOptions: {
      provider: runtimeConfig.provider,
      // model 为空则省略，让 dsh 跟随用户/默认设置
      ...(runtimeConfig.model ? { model: runtimeConfig.model } : {}),
    },
    setup: async (agentCtx: Context) => {
      // dsh rc.6 bug 兜底：setup 收到的 agent ctx 可能丢 scope tag，
      // 无 scope 时跳过挂载（降级为无工具 agent），避免整体崩溃
      if (scopeOf(agentCtx) === undefined) {
        console.warn('[dsh-a2a-server] agent ctx unscoped; preset mount skipped')
        return
      }
      await ctx.agentPresets.mount(agentCtx, runtimeConfig.preset)
    },
  }
}

/**
 * 组装「释放 Lead 前等子代理结算」所需的宿主能力。
 *
 * 数据面 = `ctx.subagents.listChildren`（0.2.0 的 durable 子代理目录；0.1.5 无此面 →
 * 不等待、降级到旧语义，由 dsh-subagent 队列补丁兜底）；
 * 事件面 = cordis 事件 `subagent/start` / `subagent/end`（子代理生命周期）与本 Lead 的
 * `agent/status`（本 agent 被回传唤醒 / 再次 idle）。两面都由结构判定取用，不做版本硬编码。
 *
 * 监听**只在等待期间**存在（`subscribe` 注册、退订函数注销）；`waitForSignal` 用单次
 * 定时器（`unref()`）而非轮询。
 *
 * @param ctx - 插件 context
 * @param parentSessionId - 本次请求的 Lead 会话 id（目录的键；事件按它过滤）
 * @returns 供 {@link waitForSubagentQuiescence} 使用的宿主能力
 */
function settleHostOf(ctx: Context, parentSessionId: string): SettleHost {
  const subagents = ctx.get('subagents') as { listChildren?: unknown } | undefined
  const listChildren = subagents?.listChildren
  const subagentChildren: SubagentChildrenSource | undefined =
    typeof listChildren === 'function'
      ? {
          listChildren: (parentId: string) =>
            (listChildren as (this: unknown, id: string) => Promise<readonly unknown[]>).call(
              subagents,
              parentId,
            ),
        }
      : undefined
  const agents = ctx.agents as unknown as { get(id: string): unknown }
  const onEvent = ctx.on as unknown as (
    event: string,
    listener: (payload: unknown) => void,
  ) => () => void
  // 订阅回调与 waitForSignal 之间的唤醒桥：信号到达即唤醒当前等待者（无等待者时无需动作）
  let wake: (() => void) | undefined
  return {
    ...(subagentChildren === undefined ? {} : { subagentChildren }),
    isChildResident: (childId) => agents.get(childId) !== undefined,
    subscribe: (onSignal) => {
      const dispatch = (signal: SubagentSignal): void => {
        onSignal(signal)
        const woken = wake
        wake = undefined
        woken?.()
      }
      const listeners = [
        onEvent('subagent/end', (info) => {
          const payload = info as { local?: unknown; id?: unknown } | undefined
          if (payload?.local === false) return
          dispatch({ kind: 'end', ...(payload?.id === undefined ? {} : { childId: String(payload.id) }) })
        }),
        onEvent('subagent/start', (info) => {
          const payload = info as { local?: unknown; id?: unknown } | undefined
          if (payload?.local === false) return
          dispatch({ kind: 'start', ...(payload?.id === undefined ? {} : { childId: String(payload.id) }) })
        }),
        onEvent('agent/status', (payload) => {
          const view = payload as { agent?: { id?: unknown } } | undefined
          if (view?.agent === undefined || String(view.agent.id) !== parentSessionId) return
          dispatch({ kind: 'parent' })
        }),
      ]
      return () => {
        for (const off of listeners) {
          try {
            off()
          } catch {
            /* 退订失败不影响等待结果 */
          }
        }
      }
    },
    waitForSignal: (timeoutMs) =>
      new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        let done = false
        const finish = (): void => {
          if (done) return
          done = true
          if (timer !== undefined) clearTimeout(timer)
          if (wake === finish) wake = undefined
          resolve()
        }
        wake = finish
        timer = setTimeout(finish, Math.max(1, timeoutMs))
        ;(timer as unknown as { unref?: () => void }).unref?.()
      }),
    now: () => Date.now(),
    warn: (message) => {
      console.warn(message)
    },
  }
}

/** 按等待结果输出明确日志（超限回落 / 能力缺失都不静默） */
function logSettleOutcome(sessionId: string, outcome: SettleOutcome): void {
  switch (outcome.outcome) {
    case 'quiesced':
      if (outcome.rounds > 0) {
        console.log(
          `[dsh-a2a-server] lead ${sessionId} 静默：子代理已全部结算（等待 ${outcome.waitedMs}ms，`
            + `${outcome.rounds} 轮），现在释放句柄`,
        )
      }
      return
    case 'cap':
      console.warn(
        `[dsh-a2a-server] lead ${sessionId} 等待子代理结算超上限（${outcome.waitedMs}ms，仍有 `
          + `${outcome.liveChildren} 个活跃 continuable 子代理）：按兜底释放句柄；`
          + '晚到回传将由 dsh-subagent 队列补丁入队并在下次激活补投',
      )
      return
    case 'unavailable':
      console.warn(
        `[dsh-a2a-server] lead ${sessionId} 无法判定子代理活口（listChildren 缺失或查询失败）：`
          + '不等待，直接释放；回传兜底由 dsh-subagent 队列补丁承担',
      )
      return
    case 'disabled':
      console.log(`[dsh-a2a-server] lead ${sessionId} 未启用结算等待（settleCapMs=0）：直接释放`)
      return
  }
}

/**
 * 解析（或新建）contextId 对应的 dsh 会话。两级接管：
 * 映射命中 → `ctx.agents.resume`（失败懒删映射落到新建分支）；未命中 → 新建 + 写映射。
 */
async function resolveSession(
  ctx: Context,
  cwd: string,
  contextId: string,
): Promise<ResolvedSession> {
  const key = `${contextId}\u0000${cwd}`
  const mapped = contextMap.get(key)
  if (mapped !== undefined) {
    const sid = SessionId(mapped.sessionId)
    try {
      const handle = await ctx.agents.resume({
        resumeSessionId: sid,
        ...agentComposition(ctx),
      })
      // 命中：刷新最近使用时间戳（TTL 依据）
      mapped.lastUsedAt = Date.now()
      // 接管：幂等补挂工作区（attachToWorkspace 内部已 try/catch 仅 warn）
      await attachSessionCwd(ctx, sid, handle.agent.session.header.cwd)
      return { sessionId: sid, handle }
    } catch (e) {
      // resume 失败（会话已删/损坏/版本不兼容）：懒删映射，落到下方新建分支（不抛错）。
      // A9 诊断：打印真实异常（name/code/message/stack 头 3 行）并明确降级语义，
      // 便于定位 0.2.0 的 v3→v4 resume 失败原因；降级行为不变（删映射 + 新建）。
      contextMap.delete(key)
      void persistContextMap()
      const err = e as { name?: string; code?: string; message?: string; stack?: string }
      const stackHead = String(err.stack ?? '')
        .split('\n')
        .slice(0, 3)
        .join('\n  ')
      console.warn(
        `[dsh-a2a-server] contextId resume failed — falling back to a NEW session (contextId mapping dropped)` +
          `\n  name: ${err.name ?? '(unknown)'}, code: ${err.code ?? '(none)'}, message: ${err.message ?? String(e)}` +
          (stackHead ? `\n  stack:\n  ${stackHead}` : ''),
      )
    }
  }
  const newSessionId = SessionId(randomUUID())
  const handle = await ctx.agents.create({
    sessionId: newSessionId,
    ...agentComposition(ctx),
    meta: { cwd, agentPreset: runtimeConfig.preset },
  })
  contextMap.set(key, { sessionId: String(newSessionId), lastUsedAt: Date.now() })
  void persistContextMap()
  // 分组：把会话归属到 cwd 对应的工作区（resolveByPath ?? create + attachSession；可选依赖；headless 环境自动跳过）
  void (async () => {
    try {
      const ws = await ensureWorkspace(ctx, cwd)
      if (ws?.attachSession) await ws.attachSession(newSessionId)
    } catch (e) {
      console.warn('[dsh-a2a-server] workspace attach failed:', (e as Error)?.message ?? e)
    }
  })()
  return { sessionId: newSessionId, handle }
}

// ─── §2.6 交互问答桥接 ─────────────────────────────────────────────────────
// 提问的规范化 / 载荷构造 / 挂起-解挂-放弃等纯逻辑在 ./questions.ts（可纯单测）；
// 本文件负责接线：认领者注册、续投识别、任务生命周期与事件流。

/** agent → 名下任务（WeakMap 无法枚举，故用 Map 并在任务收场时显式清） */
const ownedTaskByAgent = new Map<object, OwnedTask>()
/** taskId → 首跳跑完信号：续投分支等它，避免提前返回时 SDK 收掉仍在跑的总线 */
const taskDrains = new Map<string, { promise: Promise<void>; release: () => void }>()
/** §2.2/§2.3：对话级绑定账本（首选定结果 + 记忆）；apply 时按 statePath 载入 */
let bindingStore: LinkBindingStore | undefined

/**
 * 把 A2A task 映射为一次 dsh agent 同步执行（最小版：每次新建独立会话）。
 * `execute` 按 A2A 规范发布 task → statusUpdate(working) → artifact →
 * statusUpdate(completed) 事件流；dsh 执行抛错时异常向上传播，由
 * DefaultRequestHandler 合成 FAILED 状态返回给客户端。
 */
class DshAgentExecutor implements AgentExecutor {
  private readonly cancelled = new Set<string>()

  constructor(private readonly ctx: Context) {}

  async cancelTask(taskId: string, _eventBus: ExecutionEventBus): Promise<void> {
    this.cancelled.add(taskId)
    // §2.6：任务被取消时未决提问一律放行——宁可让提问方收到中止，也不悬挂到天荒地老。
    abandonQuestions(taskId)
  }

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const taskId = requestContext.taskId
    const contextId = requestContext.contextId
    const userMessage = requestContext.userMessage
    const text = userMessageText(userMessage)
    // 同步 SendMessage 与流式 SendStreamingMessage 复用本 execute；同步时只应
    // 返回最终结果文本，中间事件不得作为 artifact 泄露进 task.artifacts
    const streaming = executionMode.getStore()?.streaming ?? false

    // §2.6：带 taskId 的请求＝对已有任务的续投（`_createRequestContext` 只在报文带
    // taskId 时填 requestContext.task）。问答桥接的作答正是走这条路，不能重开一轮。
    if (requestContext.task !== undefined) {
      await this.resumeTask(requestContext, eventBus)
      return
    }

    // §2.1/§2.4：请求级选项（工作区 / 沙箱档）从 `message.metadata` 取；缺省＝现状。
    // 不合法时**在这里抛**（尚未发布任何任务事件）→ SDK 合成 task + FAILED，客户端拿到
    // 明确报错；绝不静默改用默认值。
    const requestOptions: RequestOptions = readRequestOptions(
      (userMessage as { metadata?: unknown }).metadata,
    )

    try {
      // 1. 每个执行流必须以 task 事件开头
      eventBus.publish(
        AgentEvent.task({
          id: taskId,
          contextId,
          status: {
            state: TaskState.TASK_STATE_SUBMITTED,
            timestamp: new Date().toISOString(),
            message: undefined,
          },
          artifacts: [],
          history: [userMessage],
          metadata: userMessage.metadata,
        }),
      )

      // 2. working 状态
      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: {
            state: TaskState.TASK_STATE_WORKING,
            timestamp: new Date().toISOString(),
            message: undefined,
          },
          metadata: {},
        }),
      )

      // 2.5 §2.2 首选定：对话首次投递、未显式带参、且调用方声明了问答能力时，发
      //     「选工作区 + 选沙箱档」卡（§2.6 通道）；不选＝照旧通用区/当前档（记账后不再问）。
      //     优先级：显式参数 > 绑定 > 缺省；首选定只补缺省，绝不覆盖显式值。
      const qnaDeclared = streaming && readsQuestionOptIn(userMessage)
      const effectiveOptions = await this.applyFirstUseSelection(
        requestContext, eventBus, qnaDeclared, requestOptions,
      )

      // 3. dsh 真实执行（按 contextId 复用/新建会话 → followup → whenIdle → 读最终文本），
      //    期间把高信号中间事件实时推为 A2A 流式 artifactUpdate
      const resultText = await this.runDshTask(text, contextId, (desc) => {
        // 仅流式模式 emit 中间 artifactUpdate；同步模式直接丢弃，避免污染 artifacts
        if (!streaming) return
        if (desc.kind === 'text') {
          // 文本块：append 到共享 'stream-text' artifact（客户端拼接成连续文本流）
          eventBus.publish(
            AgentEvent.artifactUpdate({
              taskId,
              contextId,
              artifact: {
                artifactId: 'stream-text',
                name: 'StreamText',
                description: '流式文本块',
                parts: [textPart(desc.text ?? '')],
                metadata: undefined,
                extensions: [],
              },
              append: true,
              lastChunk: false,
              metadata: undefined,
            }),
          )
        } else {
          // 思考/工具/状态：data Part 私有扩展（JSON 描述符）
          eventBus.publish(
            AgentEvent.artifactUpdate({
              taskId,
              contextId,
              artifact: {
                artifactId: randomUUID(),
                name: 'StreamEvent',
                description: '流式中间事件',
                parts: [dataPart(desc)],
                metadata: undefined,
                extensions: [],
              },
              append: false,
              lastChunk: false,
              metadata: undefined,
            }),
          )
        }
      }, { taskId, contextId, eventBus, qna: qnaDeclared }, effectiveOptions)

      if (this.cancelled.has(taskId)) {
        eventBus.publish(
          AgentEvent.statusUpdate({
            taskId,
            contextId,
            status: {
              state: TaskState.TASK_STATE_CANCELED,
              timestamp: new Date().toISOString(),
              message: undefined,
            },
            metadata: {},
          }),
        )
        return
      }

      // 4. artifact（最终输出）
      eventBus.publish(
        AgentEvent.artifactUpdate({
          taskId,
          contextId,
          artifact: {
            artifactId: randomUUID(),
            name: 'Result',
            description: 'dsh agent 的最终输出',
            parts: [textPart(resultText)],
            metadata: undefined,
            extensions: [],
          },
          append: false,
          lastChunk: true,
          metadata: undefined,
        }),
      )

      // 5. completed
      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: {
            state: TaskState.TASK_STATE_COMPLETED,
            timestamp: new Date().toISOString(),
            message: undefined,
          },
          metadata: undefined,
        }),
      )
    } finally {
      this.cancelled.delete(taskId)
    }
  }

  /**
   * §2.2/§2.3：首选定与绑定记忆（**服务端唯一权威**）。
   *
   * 触发条件（全部满足）：`firstUseSelection=ask`、该对话无绑定、调用方未显式带
   * workspace/sandbox、且声明了问答能力。发「选工作区 + 选沙箱档」一卡组；作答后
   * 记绑定（选空＝记 answered、不改缺省），之后同对话不再问。
   *
   * 失败纪律：卡片没送达 / 用户跳过 / 任务中止 → **回落缺省，绝不把任务卡死**；
   * 用户跳过记 `answered=true`（不再打扰），投递失败不记账（下次可重试）。
   *
   * @returns 本次生效选项（显式 > 绑定 > 缺省）
   */
  private async applyFirstUseSelection(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
    qnaDeclared: boolean,
    explicit: RequestOptions,
  ): Promise<RequestOptions> {
    const store = bindingStore
    const contextId = requestContext.contextId
    const binding = store?.get(contextId)
    const shouldAsk = store !== undefined
      && binding === undefined
      && runtimeConfig.firstUseSelection === 'ask'
      && explicit.workspace === undefined
      && explicit.sandbox === undefined
      && qnaDeclared
    if (!shouldAsk) return effectiveRequestOptions(explicit, binding)

    const { items, labels } = firstUseQuestions(this.workspaceChoices())
    // 作答期间续投流必须能持续接收 → 先登记首跳完成信号（runDshTask 会沿用同一份）
    if (!taskDrains.has(requestContext.taskId)) {
      const drain = Promise.withResolvers<void>()
      taskDrains.set(requestContext.taskId, { promise: drain.promise, release: () => { drain.resolve() } })
    }
    try {
      const answers = await claimQuestion(
        { taskId: requestContext.taskId, contextId, eventBus, qna: true }, items, undefined,
      )
      const next = bindingFromAnswers(answers, labels)
      store?.set(contextId, next)
      console.log(
        `[dsh-a2a-server] 首选定已记账: context=${contextId} ` +
        `workspace=${JSON.stringify(next.workspace ?? null)} sandbox=${next.sandbox ?? '(缺省)'}`,
      )
      return effectiveRequestOptions(explicit, next)
    } catch (e) {
      const message = String((e as { message?: unknown })?.message ?? e)
      // claimQuestion 的三种出口：用户跳过（记 answered，不再打扰）/ 中止·收场（不记账）
      if (message.includes('skipped') && store !== undefined) {
        store.set(contextId, { answered: true, updatedAt: Date.now() })
        console.log(`[dsh-a2a-server] 首选定被跳过，按缺省继续并记账（不再打扰）: context=${contextId}`)
      } else {
        console.warn(`[dsh-a2a-server] 首选定未完成，回落缺省（不记账）: ${message}`)
      }
      return effectiveRequestOptions(explicit, store?.get(contextId))
    }
  }

  /** 首选定选项来源：现有工作区名册（title + canonical path） */
  private workspaceChoices(): WorkspaceChoice[] {
    const registry = this.ctx.get('workspaceRegistry') as WorkspaceRegistryView | undefined
    return (registry?.list?.() ?? [])
      .filter((workspace) => typeof workspace.path === 'string')
      .map((workspace) => ({ title: workspace.title ?? '', path: workspace.path }))
  }

  /**
   * §2.1：把请求级工作区解析成**会话 cwd**；缺省（未带 workspace）原样返回服务端 cwd。
   *
   * 宿主无工作区注册表（headless profile）时名字形态仍能落地（建目录并使用该路径），
   * 只是不进名册；名册登记仍由既有的 `ensureWorkspace + attachSession` 在会话创建后做。
   */
  private async resolveRequestCwd(defaultCwd: string, requestOptions: RequestOptions): Promise<string> {
    if (requestOptions.workspace === undefined) return defaultCwd
    const registry = this.ctx.get('workspaceRegistry') as WorkspaceRegistryView | undefined
    const listWorkspaces = registry?.list === undefined
      ? undefined
      : () => (registry.list?.() ?? [])
        .filter((workspace) => typeof workspace.path === 'string')
        .map((workspace) => ({ path: workspace.path, title: workspace.title ?? '' }))
    const target = await resolveWorkspaceTarget(requestOptions.workspace, {
      defaultCwd,
      ...(listWorkspaces === undefined ? {} : { listWorkspaces }),
      canonicalize: canonicalCwd,
      ensureDir: async (path: string) => { await mkdir(path, { recursive: true }) },
    })
    console.log(
      `[dsh-a2a-server] 工作区请求=${JSON.stringify(requestOptions.workspace)} ` +
      `命中=${target.via} title=${JSON.stringify(target.title)} cwd=${target.cwd}`,
    )
    return target.cwd
  }

  /** 按 contextId 解析 dsh 会话执行任务，返回最终 assistant 文本；句柄任务毕 flush + 释放 */
  private async runDshTask(
    text: string,
    contextId: string,
    onEvent: (desc: StreamEventDescriptor) => void,
    questionSink: OwnedTask,
    requestOptions: RequestOptions,
  ): Promise<string> {
    const defaultCwd = await canonicalCwd(runtimeConfig.cwd || process.cwd())
    // §2.1 工作区：请求级 cwd。缺省＝服务端配置的 cwd（与升级前逐字一致）；
    // 带名字/路径时解析成会话 cwd——而会话复用键本就含 cwd（`${contextId}\0${cwd}`），
    // 故「同对话换工作区」自然落到新会话，同区自然复用（串区由键本身挡住）。
    const cwd = await this.resolveRequestCwd(defaultCwd, requestOptions)
    const { sessionId, handle } = await resolveSession(this.ctx, cwd, contextId)

    // §2.4 沙箱档：经 dsh 自己的 permissionPresets 写路径落成**会话级覆盖**（幂等）。
    // 缺省不传＝不动；宿主缺该插件/预设时响亮告警并保持现状。
    if (requestOptions.sandbox !== undefined) {
      const outcome = applySandboxTier(
        {
          presets: this.ctx.get('permissionPresets') as SandboxPresetService | undefined,
          warn: (message: string) => { console.warn(message) },
        },
        handle.agent.session as unknown as object,
        requestOptions.sandbox,
      )
      console.log(
        `[dsh-a2a-server] 沙箱档请求=${requestOptions.sandbox} 结果=${outcome} ` +
        `session=${String(sessionId)}`,
      )
      // 档位未落地必须让**调用方可见**（核验指出：此前只写服务端日志，回执却写着请求值，
      // 调用方会以为已生效）。流式任务在流里发一条文本告警；同步任务不污染 artifacts。
      if (outcome === 'unavailable' && (executionMode.getStore()?.streaming ?? false)) {
        questionSink.eventBus.publish(
          AgentEvent.artifactUpdate({
            taskId: questionSink.taskId,
            contextId: questionSink.contextId,
            artifact: {
              artifactId: randomUUID(),
              name: 'SandboxTierWarning',
              description: '沙箱档未能落地（告警）',
              parts: [textPart(
                `⚠️ 沙箱档 ${requestOptions.sandbox} 未能落地（本部署缺该权限预设或写入失败），` +
                '当前档位保持不变——详见服务端日志。',
              )],
              metadata: undefined,
              extensions: [],
            },
            append: false,
            lastChunk: false,
            metadata: undefined,
          }),
        )
      }
    }

    // §2.6：登记「首跳完成信号」（所有任务都登记——续投分支活到终态才返回，靠它避免
    // 提前返回时 SDK 收掉仍在跑的总线）；**认领表只在客户端声明过问答能力时登记**，
    // 未声明的调用方保持现状行为（提问以 NO_PROVIDER 立刻失败，绝不无声挂起）。
    const agentKey = handle.agent as unknown as object
    // 首选定在会话创建前就要保持续投流可接收 → 该已完成登记的沿用同一份（幂等复用）
    let drainEntry = taskDrains.get(questionSink.taskId)
    if (drainEntry === undefined) {
      const drain = Promise.withResolvers<void>()
      drainEntry = { promise: drain.promise, release: () => { drain.resolve() } }
      taskDrains.set(questionSink.taskId, drainEntry)
    }
    if (questionSink.qna === true) {
      ownedTaskByAgent.set(agentKey, questionSink)
    } else {
      console.warn(
        `[dsh-a2a-server] 调用方未声明问答能力（metadata.${QNA_OPT_IN_KEY}=true），` +
        `本任务不认领提问: task=${questionSink.taskId}`,
      )
    }

    try {
      const baseline = ((handle.agent.session as unknown as { log?: unknown[] }).log ?? []).length

      // 流式订阅（任务级，任务毕在 finally 释放）：
      //  - 0.1.5：`session/event`，按会话 id 过滤；`assistant/chunk` 与其他高信号
      //    事件都从这里取。
      //  - 0.2.0：实时助手增量改由进程内 cordis 事件 `agent/assistant-stream`
      //    发布（payload { agent, frame }），`session/event` 不再有
      //    `assistant/chunk`（这正是 0.4.0 直播流没有 thinking/text 帧的根因）。
      // 两面共用同一个缓冲状态机（chunk 是同一 StreamChunk 联合类型），并按
      // agent 对象身份过滤——插件 ctx 非 agent-scoped，会收到同一宿主内所有
      // agent 的帧。
      const ingest = createAssistantIngestState()
      const callNames = new Map<string, string>()
      // A1 兜底探测：投递后是否真的驱动出了 turn（见下方 deliver 的重试逻辑）
      let turnStarted = false
      // 活会话格式版本（v3=0.1.x / v4=0.2.0 起）既是 A1 选 source 形状的依据，
      // 也是「要不要订阅进程内增量面」的第二路运行时信号。
      const sessionVersion = (handle.agent.session as unknown as { header?: { version?: unknown } })
        .header?.version
      const sessionFormatVersion = typeof sessionVersion === 'number' ? sessionVersion : undefined
      // 0.2.0 起才有 agent/assistant-stream：版本谓词（探测失败按真，见 compat）
      // 或活会话 v4 任一命中即订阅，避免插件自身 node_modules 里的滞后版本误判。
      const useRuntimeStream =
        supportsAssistantStreamEvents(dshRuntimeVersion()) || (sessionFormatVersion ?? 0) >= 4
      // 进程内帧的 turn/step 只在 start 帧出现，chunk 帧沿用最近一次 start 的值。
      let streamTurn: number | undefined
      let streamStep: number | undefined
      // 0.1.x 的编译期类型里没有该事件（本包 devDep 按 0.1.x 做类型检查），
      // 局部收窄 ctx.on 的签名；该事件名在旧宿主上是否发布由宿主决定。
      const onRuntimeEvent = this.ctx.on as unknown as (
        event: string,
        listener: (payload: unknown) => void,
      ) => () => void
      const disposeStream = useRuntimeStream
        ? onRuntimeEvent('agent/assistant-stream', (payload) => {
            const { agent, frame } = (payload ?? {}) as {
              agent?: unknown
              frame?: AssistantStreamFrameView
            }
            if (agent !== handle.agent) return
            const turnStep = assistantStreamTurnStep(frame)
            if (turnStep.turn !== undefined) streamTurn = turnStep.turn
            if (turnStep.step !== undefined) streamStep = turnStep.step
            for (const delta of applyAssistantStreamFrame(ingest, frame)) {
              onEvent({ kind: delta.kind, turn: streamTurn, step: streamStep, text: delta.text })
            }
          })
        : () => {}
      const dispose = this.ctx.on('session/event', (session, event) => {
        const sid = (session as { header?: { id?: unknown }; id?: unknown }).header?.id
          ?? (session as { id?: unknown }).id
        if (String(sid) !== String(sessionId)) return
        const ev = event as { type?: string; data?: {
          turn?: number
          step?: number
          name?: string
          arguments?: string
          callId?: string
          reason?: { kind?: string }
          chunk?: { type?: string; blockType?: string; index?: number; text?: string; block?: { type?: string } }
          // v3：content[0] 是 tool-result 包装块（toolCallId + 嵌套 content）；
          // v4（0.2.0）：toolCallId 在 message 层、content 展平为文本块
          message?: { toolCallId?: string; content?: { type?: string; text?: string; toolCallId?: string; content?: { type?: string; text?: string }[] }[] }
        } }
        const data = ev.data ?? {}
        switch (ev.type) {
          case 'assistant/chunk': {
            // 0.1.5 路径；若本任务已收到 0.2.0 的进程内帧，状态机内部静默丢弃
            //（去重门，见 compat.applySessionAssistantChunk）。
            for (const delta of applySessionAssistantChunk(ingest, data.chunk)) {
              onEvent({ kind: delta.kind, turn: data.turn, step: data.step, text: delta.text })
            }
            return
          }
          case 'turn/start':
            // A1 兜底探测：turn 真的开始了 → 本次投递的 source 形状已被运行时接受
            turnStarted = true
            onEvent({ kind: 'turn_start', turn: data.turn, step: data.step })
            return
          case 'turn/end':
            onEvent({ kind: 'turn_end', turn: data.turn, step: data.step, reason: data.reason?.kind })
            return
          case 'tool/call':
            if (data.callId !== undefined && data.name !== undefined) callNames.set(data.callId, data.name)
            onEvent({ kind: 'tool_call', turn: data.turn, step: data.step, name: data.name, arguments: data.arguments })
            return
          case 'tool/result': {
            // tool/result 不带 name（在 tool/call 里）；用 toolCallId 关联名称。
            // A2：v3（0.1.5）/v4（0.2.0）双形状读取见 src/compat.ts readToolResult。
            const read = readToolResult(data)
            onEvent({
              kind: 'tool_result',
              turn: data.turn,
              step: data.step,
              name: read.callId !== undefined ? callNames.get(read.callId) : undefined,
              text: read.text,
            })
            return
          }
          default:
            return
        }
      })

      try {
        // A1：消息 source 形状按**活会话的格式版本**选择（运行时信号，不依赖插件
        // 自己 node_modules 里可能滞后的 dsh 版本）：v4（dsh 0.2.0 起）用命名空间化
        // `{ kind: 'plugin:dsh-a2a-server' }`，v3（0.1.x）用 `{ kind: 'plugin', plugin: … }`。
        // 旧形状在 0.2.0 上会让消息进不了 loop（任务静默不执行），故再加一层兜底：
        // 首选形状未驱动出 turn/start 时换另一种形状重试一次，仍无则响亮告警。
        const preferred = sourceModeForSessionVersion(sessionFormatVersion)

        const deliver = async (mode: PluginMessageSourceMode): Promise<boolean> => {
          turnStarted = false
          handle.agent.followup(
            createUserMessage({
              content: [{ type: 'text', text }],
              // 0.2.0 的命名空间 kind 不在 0.1.x 编译期类型里（本包 devDep 按 0.1.x
              // 做类型检查），此处做一处局部收窄；运行时形状由 compat 保证。
              source: pluginMessageSourceFor(mode) as unknown as { kind: 'plugin'; plugin: string },
            }),
          )
          const deadline = Date.now() + TURN_START_GRACE_MS
          while (!turnStarted && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 50))
          }
          return turnStarted
        }

        if (!(await deliver(preferred))) {
          const alternate: PluginMessageSourceMode = preferred === 'namespaced' ? 'legacy' : 'namespaced'
          console.warn(
            `[dsh-a2a-server] no turn started within ${TURN_START_GRACE_MS}ms with the ${preferred} ` +
              `message source shape (session format v${String(sessionVersion)}); retrying with ${alternate}`,
          )
          if (!(await deliver(alternate))) {
            console.warn(
              '[dsh-a2a-server] no turn started with either message source shape — the task will ' +
                'produce no assistant output; see CONFIGURATION dsh 0.1.5 / 0.2.0 compatibility',
            )
          }
        }
        // 释放前「彻底消窗」：等 Lead 自身 idle **且** 无活跃 continuable 子代理。
        // 旧行为（0.5.0 及以前）是 whenIdle() 后立即释放，于是 Lead 派发子代理后收口、
        // 子代理晚回传时父已不在注册表（dsh-subagent 会报 PARENT_UNAVAILABLE；虽已有
        // 队列补丁兜底，但主路要等下一次会话激活）。现在等到子代理结算才释放：回传到场
        // 时父仍在注册表 → 当场投递、当场续跑，窗口从源头不存在。上限见 settleCapMs。
        const settle = await waitForSubagentQuiescence(
          settleHostOf(this.ctx, String(sessionId)),
          handle.agent as unknown as { whenIdle(): Promise<unknown> },
          String(sessionId),
          runtimeConfig.settleCapMs,
        )
        logSettleOutcome(String(sessionId), settle)
      } finally {
        // 两条订阅同一生命周期：任务毕一并释放（进程内帧订阅可能为 no-op）
        disposeStream()
        dispose()
      }

      // 读本次任务的最终 assistant 文本
      const log = ((handle.agent.session as unknown as { log?: unknown[] }).log ?? []).slice(baseline)
      let out = ''
      for (const e of log) {
        const ev = e as { type?: string; data?: { message?: { content?: { type?: string; text?: string }[] } } }
        if (ev.type === 'assistant/message') {
          const content = ev.data?.message?.content
          if (content) {
            out += content.filter((c) => c.type === 'text' && c.text).map((c) => c.text).join('\n') + '\n'
          }
        }
      }
      return out.trim() || '(no text output)'
    } finally {
      // §2.6：先摘牌（此后新请求不再认领到本任务），再放行未决提问与续投等待者。
      // 顺序不能反：先放 drain 会让续投分支抢先返回，而此刻仍有未决提问可解。
      ownedTaskByAgent.delete(agentKey)
      taskDrains.delete(questionSink.taskId)
      abandonQuestions(questionSink.taskId)
      drainEntry?.release()
      // 跨重启 resume 依赖会话已持久化：任务毕 flush，再释放句柄
      try {
        await (this.ctx.get('sessions') as { flush?: (s: unknown) => Promise<unknown> } | undefined)?.flush?.(handle.agent.session)
      } catch {
        /* flush 失败不阻断结果返回 */
      }
      try {
        await handle.dispose()
      } catch {
        /* 释放失败不影响结果 */
      }
    }
  }

  /**
   * 续投分支（§2.6 作答归途）：先补 task 快照（新流首帧硬要求），再按 `askId` 解挂，
   * 最后保守地等首跳终态——只补快照已足够保活总线（spike 变体实证），但显式等待
   * 不依赖该细节。未命中未决提问时响亮报警并忽略，绝不静默吞掉作答。
   */
  private async resumeTask(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const taskId = requestContext.taskId
    const contextId = requestContext.contextId
    const snapshot = requestContext.task
    eventBus.publish(
      AgentEvent.task({
        id: taskId,
        contextId,
        status: snapshot?.status ?? {
          state: TaskState.TASK_STATE_INPUT_REQUIRED,
          timestamp: new Date().toISOString(),
          message: undefined,
        },
        artifacts: snapshot?.artifacts ?? [],
        history: snapshot?.history ?? [],
        metadata: snapshot?.metadata,
      }),
    )
    const answer = readQuestionAnswer(requestContext.userMessage as { parts?: Part[] } | undefined)
    const disposition = continuationDisposition(answer, pendingQuestionCount(taskId))
    if (disposition === 'input-required') {
        // 协议误用：该任务正等作答，而这条续投**没带作答载荷**（既不是 answer 也不是
        // skip）。若只是"放行"，本次流的首帧（task 快照）之后不会再有事件——客户端会
        // 拿到一条永远没有终态的流。这里**明确回一个 INPUT_REQUIRED**：SDK 在
        // input-required 处正常收束流，客户端据此知道「任务在等输入」，不再是静默悬挂。
        // 首跳不受影响：总线因 INPUT_REQUIRED 保活，原提问仍在等真正的作答。
        console.warn(
          `[dsh-a2a-server] 续投未带作答载荷但任务正等作答（${pendingQuestionCount(taskId)} 个未决）: ` +
          `task=${taskId}——以 INPUT_REQUIRED 收束本次流`,
        )
        eventBus.publish(
          AgentEvent.statusUpdate({
            taskId,
            contextId,
            status: {
              state: TaskState.TASK_STATE_INPUT_REQUIRED,
              timestamp: new Date().toISOString(),
              message: undefined,
            },
            metadata: {},
          }),
        )
        return
    }
    if (disposition === 'plain') {
      console.warn(`[dsh-a2a-server] 续投报文不含 question-answer data part: task=${taskId}——按普通续投放行`)
    } else if (answer !== undefined && !resolveQuestion(taskId, answer)) {
      console.warn(`[dsh-a2a-server] 续投作答未命中未决提问: task=${taskId} askId=${answer.askId ?? '(none)'}`)
    }
    const drain = taskDrains.get(taskId)
    if (drain !== undefined) await drain.promise
  }
}

/** 构造 agent card（url 用实际监听地址，JSONRPC binding，协议版本 1.0） */
function buildAgentCard(host: string, port: number): AgentCard {
  const base = `http://${host}:${port}/`
  return {
    name: 'dsh',
    description: 'DeepSeek Harness agent exposed over the A2A protocol.',
    supportedInterfaces: [
      {
        url: base,
        protocolBinding: 'JSONRPC',
        tenant: '',
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    provider: {
      organization: 'deepseek',
      url: 'https://github.com/deepseek-ai',
    },
    version: '0.7.0',
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text'],
    defaultOutputModes: ['text', 'task-status'],
    skills: [
      {
        id: 'dsh_task',
        name: 'dsh task',
        description: '执行编码 / 分析 / 命令类任务',
        tags: ['coding', 'task'],
        examples: ['列出当前目录前 5 个文件并告诉我总数'],
        inputModes: ['text'],
        outputModes: ['text', 'task-status'],
        securityRequirements: [],
      },
    ],
    documentationUrl: '',
    signatures: [],
  }
}

/**
 * 按整份 resolved 值覆盖 runtimeConfig（缺失字段回落安全默认，不做真值守卫：
 * 空串/空值也按其既有语义落库），再施加环境令牌的最高优先级。entry config
 * 初始化与 settings 每次 onChange 共用本函数，保证「清空字段/清除覆盖」之后
 * 行为与面板显示一致。
 */
function applyResolvedConfig(resolved: A2ASettings): void {
  // 导出运行时 Config（volatile）后，双版本的 entry config 字段都会变成
  // `{ get() }` 引用对象（0.1.5 的 settings onChange 则是 plain 标量）；统一
  // 深解包后按 plain 形状读取，缺失字段回落安全默认（不做真值守卫）。
  const r = unwrapVolatile(resolved) as A2ASettings
  runtimeConfig.provider = r.provider ?? 'deepseek-official'
  runtimeConfig.model = r.model ?? 'deepseek-v4-flash'
  runtimeConfig.preset = r.preset ?? 'standard'
  runtimeConfig.cwd = r.cwd ?? ''
  runtimeConfig.authToken = r.authToken ?? ''
  runtimeConfig.port = r.port
  runtimeConfig.host = r.host
  runtimeConfig.contextMapPath = r.contextMapPath
  runtimeConfig.contextMapTtlDays = r.contextMapTtlDays ?? 7
  runtimeConfig.settleCapMs = r.settleCapMs ?? DEFAULT_SETTLE_CAP_MS
  runtimeConfig.firstUseSelection = r.firstUseSelection === 'ask' ? 'ask' : 'off'
  // 环境变量是最简外部通道，优先级最高（settings 写入也压不过它）
  if (process.env.A2A_SERVER_TOKEN) runtimeConfig.authToken = process.env.A2A_SERVER_TOKEN
  // 每次配置被应用时打一行不含任何密钥的信息日志（authToken 只报有无）
  console.log(
    `[dsh-a2a-server] settings applied: provider=${runtimeConfig.provider} model=${runtimeConfig.model}` +
    ` preset=${runtimeConfig.preset} cwd=${runtimeConfig.cwd || '(process.cwd())'}` +
    ` port=${runtimeConfig.port ?? '(auto)'} host=${runtimeConfig.host ?? '(default 127.0.0.1)'}` +
    ` contextMapPath=${runtimeConfig.contextMapPath ?? '(default)'}` +
    ` contextMapTtlDays=${runtimeConfig.contextMapTtlDays}` +
    ` settleCapMs=${runtimeConfig.settleCapMs}` +
    ` firstUseSelection=${runtimeConfig.firstUseSelection}` +
    ` authToken=${runtimeConfig.authToken ? '<set>' : '<unset>'}`,
  )
}

/**
 * 存量捞回：把现存未分组的会话补挂到已注册工作区。
 * 由 ctx.inject(['workspaceRegistry', 'sessionPersistence']) 在两服务就绪后调用。
 * 条件：header.cwd 的 realpath 等于某已注册 workspace.path，且该 sessionId 不在其花名册里。
 * 只补挂到「已注册」工作区，不新建（避免把无关目录刷成新工作区）；单会话失败不影响其余。
 */
async function reattachOrphanSessions(ctx: Context): Promise<{ attached: number; failed: number }> {
  const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryView | undefined
  const byPath = new Map<string, WorkspaceView>()
  for (const ws of registry?.list?.() ?? []) byPath.set(ws.path, ws)
  if (byPath.size === 0) {
    console.warn('[dsh-a2a-server] 存量捞回: workspaceRegistry 无可注册工作区，跳过')
    return { attached: 0, failed: 0 }
  }

  // live + 持久化 header 合并（live 优先），按 id 去重
  const headers = new Map<string, SessionHeader>()
  const sessions = ctx.get('sessions') as { list?: () => { header: SessionHeader }[] } | undefined
  for (const session of sessions?.list?.() ?? []) headers.set(session.header.id, session.header)
  // sessionPersistence.list() 返回持久化快照（{ header, ... }），需解包出 header
  const persistence = ctx.get('sessionPersistence') as
    | { list?: () => Promise<readonly { header: SessionHeader }[]> }
    | undefined
  for (const snapshot of (await persistence?.list?.()) ?? []) {
    if (!headers.has(snapshot.header.id)) headers.set(snapshot.header.id, snapshot.header)
  }

  let attached = 0
  let failed = 0
  for (const header of headers.values()) {
    if (header.cwd === undefined) continue
    const canonical = await canonicalCwd(header.cwd)
    const ws = byPath.get(canonical)
    if (ws === undefined || !ws.attachSession) continue
    if (ws.sessionIds.includes(header.id)) continue
    try {
      await ws.attachSession(header.id)
      attached++
      console.log(`[dsh-a2a-server] 存量捞回: session ${header.id} -> workspace ${ws.path}`)
    } catch (e) {
      failed++
      console.warn(`[dsh-a2a-server] 存量捞回失败 session ${header.id}:`, (e as Error)?.message ?? e)
    }
  }
  return { attached, failed }
}

/**
 * 插件入口：初始化运行时配置，探测端口，启动 node:http listener 挂
 * JsonRpcTransportHandler，通过 ctx.effect 注册 dispose（关 server）。
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  // 1) entry config 先落 runtimeConfig（安全默认值 + 环境令牌优先级）
  applyResolvedConfig(config)

  // 2) 挂载 settings 命名空间：installSection attach 时会同步 apply 一次
  //    resolved 值（schema 默认 < base < user），之后每次 commit 都重新 apply；
  //    settings 缺失/注册失败时保持上面的 entry config 结果不变。
  installA2ASettings(ctx, config, applyResolvedConfig)

  // 3) settings 层就绪后才解析路径与监听地址，让用户层在首次 listen 前生效
  const dshHome = ctx.get('dshHomePath') as ((...segments: string[]) => string) | undefined
  contextMapPath = runtimeConfig.contextMapPath
    ?? (dshHome ? dshHome('storages', 'a2a-context-map.json') : join(homedir(), '.dsh', 'storages', 'a2a-context-map.json'))
  await loadContextMap()
  // §2.2/§2.3：绑定账本与 contextMap 同目录、独立文件（不动既有映射格式）
  const linkStatePath = join(dirname(contextMapPath ?? join(homedir(), '.dsh', 'storages', 'a2a-context-map.json')), 'a2a-link-state.json')
  bindingStore = await loadBindingStore(linkStatePath, (message: string) => { console.warn(message) })

  const host = runtimeConfig.host ?? '127.0.0.1'
  const port = runtimeConfig.port ?? (await probePort())

  const agentCard = buildAgentCard(host, port)
  const taskStore = new InMemoryTaskStore()
  const executor = new DshAgentExecutor(ctx)
  const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor)
  const transport = new JsonRpcTransportHandler(requestHandler)

  // §2.6 问答认领者：**prepend** 注册（线优先——A2A 名下会话的提问归飞书线，
  // 不被 GUI 的作答面抢走）；只认自己名下正在跑任务的 agent，其余一律 `next()`
  // 放行，故本插件之外的提问（含 GUI 会话）行为零变化。
  // 事件名由 dsh 侧 @deepseek-ai/dsh-user-questions 声明；本包不引该依赖，
  // 按本文件既有先例（`agent/assistant-stream`）局部收窄 ctx.on 的签名。
  const onUserQuestion = ctx.on as unknown as (
    event: string,
    listener: (request: UserQuestionRequest, next: () => Promise<unknown>) => Promise<unknown>,
    options?: { prepend?: boolean },
  ) => () => void
  ctx.effect(
    () => onUserQuestion('user-questions/request', (request, next) => {
      const agent = request?.agent as object | undefined
      const owned = agent === undefined ? undefined : ownedTaskByAgent.get(agent)
      if (owned === undefined) return next()
      const items = toQuestionItems(request?.questions)
      if (items.length === 0) return next()
      // dsh 的作答契约：waterfall 的返回必须是 `{ answers: [...] }`
      // （dsh-tool-ask-user 直接取 `result.answers.map`；裸投数组会炸 undefined.map）。
      return claimQuestion(owned, items, request?.signal)
        .then((answers) => ({ answers })) as unknown as Promise<unknown>
    }, { prepend: true }),
    'dsh-a2a-server: user-questions answerer',
  )

  const server = http.createServer(async (req, res) => {
    // Bearer token 认证（配置了 authToken 时强制所有请求校验）
    if (runtimeConfig.authToken) {
      const auth = req.headers.authorization
      if (auth !== `Bearer ${runtimeConfig.authToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }))
        return
      }
    }

    try {
      // agent card 公开端点
      if (req.method === 'GET' && (req.url === `/${AGENT_CARD_PATH}` || req.url === `/${AGENT_CARD_PATH}/`)) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(await requestHandler.getAgentCard()))
        return
      }

      // JSON-RPC 端点
      if (req.method === 'POST' && (req.url === '/' || req.url === '')) {
        const rawBody = await readBody(req)
        // 从 JSON-RPC method 判定是否流式，经 AsyncLocalStorage 传给 executor：
        // 同步 SendMessage 不 emit 中间 artifactUpdate，只返回最终结果文本
        let isStreaming = false
        try {
          const method = (JSON.parse(rawBody) as { method?: unknown }).method
          isStreaming = method === 'SendStreamingMessage' || method === 'SubscribeToTask'
        } catch {
          /* 非 JSON 请求体按非流式处理 */
        }
        const requestedVersion =
          (req.headers['a2a-version'] as string | undefined) ?? A2A_PROTOCOL_VERSION
        await executionMode.run({ streaming: isStreaming }, async () => {
          const context = new ServerCallContext({ requestedVersion })
          const rpcResult = await transport.handle(rawBody, context)
          if (typeof (rpcResult as unknown as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function') {
            // 流式（SendStreamingMessage / SubscribeToTask）→ SSE
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            })
            for await (const ev of rpcResult as AsyncGenerator<unknown, void, undefined>) {
              res.write(formatSSEEvent(ev))
            }
            res.end()
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(rpcResult))
          }
        })
        return
      }

      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
    } catch (e) {
      console.error('[dsh-a2a-server] request error:', (e as Error)?.message ?? e)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: String((e as Error)?.message ?? e) },
            id: null,
          }),
        )
      }
    }
  })

  server.on('error', (e) => {
    console.error('[dsh-a2a-server] HTTP server error:', (e as Error).message)
  })

  // listen 转 Promise：'error' 只作为本次 listen 的失败通道，成功后移除
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (e: Error) => rejectListen(e)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.removeListener('error', onError)
      resolveListen()
    })
  })
  console.log(`[dsh-a2a-server] A2A server listening on ${host}:${port}`)

  // 存量捞回：改为 ctx.inject 运行时依赖，等 workspaceRegistry / sessionPersistence 都就绪（ACTIVE）
  // 后再补挂，修复启动期 registry 尚未就绪时 ctx.get 返回 undefined 导致的静默 attached=0 竞态。
  // 不阻塞启动（apply 不 await），也不进入静态 inject 硬依赖（不推迟插件加载、不破坏 headless）。
  // 依赖重载会卸载并重跑本 callback；幂等性由 ws.sessionIds.includes(header.id) 跳过 + attachSession 幂等保证。
  ctx.inject(['workspaceRegistry', 'sessionPersistence'], () => {
    console.log('[dsh-a2a-server] 存量捞回: workspaceRegistry 就绪，开始补挂')
    // callback 同步返回；异步捞回内部 fire-and-forget，全程兜底 try/catch 防 unhandled rejection
    void (async () => {
      try {
        const { attached, failed } = await reattachOrphanSessions(ctx)
        console.log(`[dsh-a2a-server] 存量捞回: attached=${attached} failed=${failed}`)
      } catch (e) {
        console.warn('[dsh-a2a-server] 存量捞回异常:', (e as Error)?.message ?? e)
      }
    })()
  })

  // 标准 cordis 生命周期：卸载时关闭 server + 清空映射
  ctx.effect(() => {
    return () => {
      server.close()
      contextMap.clear()
      // 落盘未完成的绑定写入（幂等；失败只记日志）
      void bindingStore?.flush().catch((e: unknown) => { console.warn('[dsh-a2a-server] 绑定账本落盘失败:', e) })
    }
  }, 'dsh-a2a-server')
}

/** 探测 8092/8093/8094 首个空闲端口；全占用则报错（fail loud） */
async function probePort(): Promise<number> {
  for (const p of [8092, 8093, 8094]) {
    if (await isPortFree(p)) return p
  }
  throw new Error('[dsh-a2a-server] no free port among 8092/8093/8094')
}

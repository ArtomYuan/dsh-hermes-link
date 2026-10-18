/**
 * §2.6 交互问答桥接的**纯逻辑面**：提问规范化、载荷构造、挂起/解挂/放弃。
 *
 * 与 dsh 运行时零耦合——只依赖 A2A SDK 的事件工厂与 Part 类型，故可纯单测
 * （见 `tests/questions.test.mjs`）。事件流接线、任务生命周期与续投分支留在
 * `index.ts` 的 executor 里。
 *
 * 通道语义（2026-10-17 定型，详见 src/index.ts 顶部注释）：
 * 认领后发 `question` 事件（桥建卡）＋ `INPUT_REQUIRED` 状态（首流收束、挂起可查），
 * 作答沿 A2A 原生 `taskId` 续投回来，按 `askId` 解挂。**全程零超时**：只有
 * 「作答 / 调用方中止 / 任务收场」三种出口，任何一种都不留悬挂。
 *
 * @module dsh-a2a-server/questions
 */

import { randomUUID } from 'node:crypto'
import { Role, TaskState } from '@a2a-js/sdk'
import type { Part } from '@a2a-js/sdk'
import { AgentEvent } from '@a2a-js/sdk/server'
import type { ExecutionEventBus } from '@a2a-js/sdk/server'

/** 提问项（结构化透传；字段与 dsh `ask_user_question` 入参一一对应） */
export interface QuestionItem {
  id: string
  question: string
  header?: string
  detail?: string
  options?: { label: string; description?: string }[]
  multiSelect?: boolean
}

/** 单题作答（dsh `AskUserQuestionAnswerItem` 的结构等价物） */
export interface QuestionAnswerItem {
  id: string
  selected: string[]
  custom?: string
}

/** 一座"提问桥"：agent → 它当前正在跑的 A2A 任务（只认本插件名下 agent） */
export interface OwnedTask {
  taskId: string
  contextId: string
  eventBus: ExecutionEventBus
  /**
   * 该任务的调用方是否**声明过**问答能力（`metadata["x-dsh-user-questions"]=true`
   * 且走流式）。只有声明过的任务才登记进认领表——未声明者保持现状行为。
   */
  qna?: boolean
}

/** 一次挂起提问（settle 恰好生效一次：作答 / 中止 / 任务收场） */
export interface PendingQuestion {
  askId: string
  items: QuestionItem[]
  settle: (outcome: { answers?: QuestionAnswerItem[]; error?: Error }) => void
}

/**
 * dsh `user-questions/request` 入参的结构等价物。本包刻意不引
 * `@deepseek-ai/dsh-user-questions`（该包不在本包依赖面内），只按运行时形状收窄。
 */
export interface UserQuestionRequest {
  questions?: unknown
  agent?: unknown
  signal?: AbortSignal
}

/** taskId → askId → 未决提问（同任务实际串行，按 askId 索引以容并发余量） */
const pendingQuestions = new Map<string, Map<string, PendingQuestion>>()

/** 造一条纯文本 Part */
function textPart(value: string): Part {
  return { content: { $case: 'text', value }, metadata: undefined, filename: '', mediaType: 'text/plain' }
}

/** 造一条结构化 data Part（承载 question / question-answer 载荷） */
function dataPart(value: unknown): Part {
  return { content: { $case: 'data', value }, metadata: undefined, filename: '', mediaType: 'application/json' }
}

/** 规范化 dsh 提问项：只保留桥与卡片需要的字段，缺省不带键 */
export function toQuestionItems(raw: unknown): QuestionItem[] {
  if (!Array.isArray(raw)) return []
  const items: QuestionItem[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const q = entry as Record<string, unknown>
    const id = typeof q.id === 'string' ? q.id : ''
    const question = typeof q.question === 'string' ? q.question : ''
    if (id === '' || question === '') continue
    const options: { label: string; description?: string }[] = []
    if (Array.isArray(q.options)) {
      for (const rawOption of q.options) {
        if (typeof rawOption !== 'object' || rawOption === null) continue
        const option = rawOption as Record<string, unknown>
        if (typeof option.label !== 'string' || option.label === '') continue
        options.push({
          label: option.label,
          ...typeof option.description === 'string' && option.description !== ''
            ? { description: option.description }
            : {},
        })
      }
    }
    items.push({
      id,
      question,
      ...typeof q.header === 'string' && q.header !== '' ? { header: q.header } : {},
      ...typeof q.detail === 'string' && q.detail !== '' ? { detail: q.detail } : {},
      ...options.length > 0 ? { options } : {},
      ...q.multi_select === true || q.multiSelect === true ? { multiSelect: true } : {},
    })
  }
  return items
}

/** 提问载荷：桥的建卡依据，同时进 INPUT_REQUIRED 状态消息供 `tasks/get` 查挂起 */
export function questionPayload(askId: string, taskId: string, contextId: string, items: QuestionItem[]) {
  return { kind: 'question', askId, taskId, contextId, questions: items }
}

/** 造一条 agent 侧消息（状态消息载体；role/data part 形状与 dsh 侧一致） */
function agentMessage(
  messageId: string, parts: Part[], taskId: string, contextId: string,
): { messageId: string; role: number; parts: Part[]; taskId: string; contextId: string } {
  return { messageId, role: Role.ROLE_AGENT, parts, taskId, contextId }
}

/**
 * 认领一次提问：发 question 事件 + INPUT_REQUIRED，挂起到「作答 / 调用方中止 /
 * 任务收场」三者之一。**全程零超时**（任务书 §0.5 硬约束）。
 *
 * @param owned - 名下任务（taskId / contextId / eventBus）
 * @param items - 已规范化的提问项（调用方保证非空）
 * @param signal - dsh 侧中止信号；中止即放行，绝不悬挂
 * @returns 结构化作答；中止/收场时以错误 reject（由 dsh `ask()` 归一为 ASK_ABORTED）
 */
export function claimQuestion(
  owned: OwnedTask, items: QuestionItem[], signal: AbortSignal | undefined,
): Promise<QuestionAnswerItem[]> {
  const { taskId, contextId, eventBus } = owned
  const askId = randomUUID()
  const payload = questionPayload(askId, taskId, contextId, items)

  // ① 桥的建卡依据：沿用既有流事件通道（artifactUpdate + data part）
  eventBus.publish(
    AgentEvent.artifactUpdate({
      taskId,
      contextId,
      artifact: {
        artifactId: randomUUID(),
        name: 'StreamQuestion',
        description: '交互提问（等待作答）',
        parts: [dataPart(payload)],
        metadata: undefined,
        extensions: [],
      },
      append: false,
      lastChunk: false,
      metadata: undefined,
    }),
  )
  // ② 首条流以此收束；状态消息带上同一载荷，使挂起在任务视图里可见
  eventBus.publish(
    AgentEvent.statusUpdate({
      taskId,
      contextId,
      status: {
        state: TaskState.TASK_STATE_INPUT_REQUIRED,
        timestamp: new Date().toISOString(),
        message: agentMessage(
          `${taskId}-question-${askId}`,
          [dataPart(payload), textPart(`等待作答：${items.map((i) => i.question).join(' / ')}`)],
          taskId,
          contextId,
        ) as never,
      },
      metadata: {},
    }),
  )
  console.log(`[dsh-a2a-server] 提问挂起: task=${taskId} ask=${askId} 题数=${items.length}`)

  return new Promise<QuestionAnswerItem[]>((resolve, reject) => {
    let settled = false
    const settle = (outcome: { answers?: QuestionAnswerItem[]; error?: Error }): void => {
      if (settled) return
      settled = true
      const byAsk = pendingQuestions.get(taskId)
      byAsk?.delete(askId)
      if (byAsk !== undefined && byAsk.size === 0) pendingQuestions.delete(taskId)
      signal?.removeEventListener('abort', onAbort)
      if (outcome.error !== undefined) reject(outcome.error)
      else resolve(outcome.answers ?? [])
    }
    const onAbort = (): void => {
      settle({ error: new Error('ask_user_question was aborted before the user answered') })
    }
    const byAsk = pendingQuestions.get(taskId) ?? new Map<string, PendingQuestion>()
    byAsk.set(askId, { askId, items, settle })
    pendingQuestions.set(taskId, byAsk)
    // 调用方中止（turn/会话被取消）→ 立即放行，绝不悬挂
    if (signal !== undefined) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/** 从续投消息里读作答载荷（只认 data part；text part 仅供人读/留痕，不解析） */
export function readQuestionAnswer(
  message: { parts?: Part[] } | undefined,
): { askId?: string; answers: QuestionAnswerItem[]; skipped?: boolean } | undefined {
  for (const part of message?.parts ?? []) {
    const content = part?.content
    if (content?.$case !== 'data') continue
    const value = content.value as { kind?: unknown; askId?: unknown; answers?: unknown; skipped?: unknown } | null
    if (value === null || typeof value !== 'object' || value.kind !== 'question-answer') continue
    const answers: QuestionAnswerItem[] = []
    if (Array.isArray(value.answers)) {
      for (const raw of value.answers) {
        if (typeof raw !== 'object' || raw === null) continue
        const item = raw as { id?: unknown; selected?: unknown; custom?: unknown }
        if (typeof item.id !== 'string') continue
        answers.push({
          id: item.id,
          selected: Array.isArray(item.selected) ? item.selected.filter((s): s is string => typeof s === 'string') : [],
          ...typeof item.custom === 'string' && item.custom !== '' ? { custom: item.custom } : {},
        })
      }
    }
    return {
      ...typeof value.askId === 'string' ? { askId: value.askId } : {},
      answers,
      // 跳过：由桥在卡片上点「跳过」时带出；语义是「用户不答」，以中止收口
      ...value.skipped === true ? { skipped: true } : {},
    }
  }
  return undefined
}

/**
 * 解挂：优先按 `askId` 精确命中；只有一个未决提问时允许无 askId 的降级命中
 * （响亮报警）；其余情况一律响亮报警并忽略（异常令牌绝不静默）。
 *
 * @returns 是否真的解开了某个未决提问
 */
export function resolveQuestion(
  taskId: string, answer: { askId?: string; answers: QuestionAnswerItem[]; skipped?: boolean },
): boolean {
  const byAsk = pendingQuestions.get(taskId)
  if (byAsk === undefined || byAsk.size === 0) return false
  let entry = answer.askId !== undefined ? byAsk.get(answer.askId) : undefined
  if (entry === undefined && byAsk.size === 1 && answer.askId === undefined) {
    entry = [...byAsk.values()][0]
    console.warn(`[dsh-a2a-server] 问答续投未带 askId，按唯一未决提问降级命中: task=${taskId} ask=${entry.askId}`)
  }
  if (entry === undefined) {
    console.warn(
      `[dsh-a2a-server] 问答续投令牌不匹配: task=${taskId} askId=${answer.askId ?? '(none)'}` +
      ` 未决=${[...byAsk.keys()].join(',')}——已忽略本次作答`,
    )
    return false
  }
  if (answer.skipped === true) {
    // 用户点了「跳过」：如实以中止收口（dsh 侧 `ask()` 会把错误作为工具结果回报），
    // 不伪造一个空作答——空答对模型是「用户什么都没说」，与「明确不答」不是一回事。
    console.log(`[dsh-a2a-server] 问答跳过: task=${taskId} ask=${entry.askId}`)
    entry.settle({ error: new Error('the user skipped the question') })
    return true
  }
  console.log(`[dsh-a2a-server] 问答解挂: task=${taskId} ask=${entry.askId}`)
  entry.settle({ answers: answer.answers })
  return true
}

/** 任务收场：任何仍未决的提问一律放行（宁可报错，也绝不悬挂） */
export function abandonQuestions(taskId: string): void {
  const byAsk = pendingQuestions.get(taskId)
  if (byAsk === undefined || byAsk.size === 0) return
  console.warn(`[dsh-a2a-server] 任务收场仍存未决提问 ${byAsk.size} 个，全部放行: task=${taskId}`)
  for (const entry of [...byAsk.values()]) {
    entry.settle({ error: new Error('the task ended before the user answered') })
  }
}

/** 续投的处置类别（由纯函数判定，便于单测；`index.ts` 只负责按类别执行副作用） */
export type ContinuationDisposition = 'answer' | 'plain' | 'input-required'

/**
 * 判定一条带 `taskId` 的续投该走哪条路：
 * - `answer`：带了作答载荷 → 解挂；
 * - `input-required`：没带载荷、而该任务**正等作答**（有未决提问）→ 以 `INPUT_REQUIRED`
 *   收束本次流（否则客户端只会拿到一帧快照，然后是一条永远没有事件的流）；
 * - `plain`：没带载荷、也没有未决提问 → 当普通续投放行，等首跳终态。
 */
export function continuationDisposition(
  answer: { askId?: string; answers: QuestionAnswerItem[]; skipped?: boolean } | undefined,
  pendingCount: number,
): ContinuationDisposition {
  if (answer !== undefined) return 'answer'
  return pendingCount > 0 ? 'input-required' : 'plain'
}

/** 未决提问数（测试与诊断用） */
export function pendingQuestionCount(taskId: string): number {
  return pendingQuestions.get(taskId)?.size ?? 0
}

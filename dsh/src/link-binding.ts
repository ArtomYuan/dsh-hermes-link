/**
 * §2.2 首选定 ＋ §2.3 绑定的**服务端**实现（纯逻辑＋依赖注入，可纯单测）。
 *
 * 语义（2026-10-19 合并方案阶段 4 收口，绑定记忆不再放桥）：
 * - **绑定**按「对话」维度记（contextId → {workspace?, sandbox?, answered}），落
 *   `a2a-link-state.json`（与 contextMap 同目录，独立文件避免动既有映射格式）；
 * - **首选定**：对话第一次投递、且调用方未显式带 workspace/sandbox、且已声明问答能力时，
 *   发一张「选工作区 + 选沙箱档」的复用卡（§2.6 通道）；**不选＝照旧通用区/当前档**
 *   （answered=true 记账，之后不再问）；
 * - **优先级**：显式参数 > 绑定 > 缺省（现状）。换工作区＝换会话（复用键含 cwd 由既有
 *   逻辑保证，本模块只负责「记住选择」）。
 *
 * @module dsh-a2a-server/link-binding
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { QuestionAnswerItem, QuestionItem } from './questions.ts'
import type { SandboxTier, WorkspaceSpec } from './request-options.ts'
import { SANDBOX_TIERS } from './request-options.ts'

/** 首选定开关：off＝不干预（缺省＝现状）；ask＝对话首投时发选择卡 */
export type FirstUseMode = 'off' | 'ask'

/** 一条对话的绑定 */
export interface LinkBinding {
  /** 选定的工作区（绝对路径＝按路径绑；名字＝按名字解析并「不存在就建」） */
  workspace?: WorkspaceSpec
  /** 选定的沙箱档 */
  sandbox?: SandboxTier
  /** 是否已完成「首选定」记账（选空也算完成，避免反复打扰） */
  answered: boolean
  /** 最后更新（毫秒） */
  updatedAt: number
}

/** 绑定存储（落盘形态：`{version, bindings: {contextId: LinkBinding}}`） */
export interface LinkBindingStore {
  get(contextId: string): LinkBinding | undefined
  set(contextId: string, binding: LinkBinding): void
  /** 全量快照（诊断/测试） */
  snapshot(): Record<string, LinkBinding>
  /** 异步落盘（幂等；失败只告警不阻断任务） */
  flush(): Promise<void>
}

/** 磁盘状态文件版本（未来结构变更靠它迁移/忽略旧值） */
export const LINK_STATE_VERSION = 1

/** 内存存储 + 可注入的落盘回调（生产用文件，测试用内存） */
export function createBindingStore(initial: Record<string, LinkBinding> = {}, persist?: (all: Record<string, LinkBinding>) => Promise<void>): LinkBindingStore {
  const bindings: Record<string, LinkBinding> = { ...initial }
  let chain: Promise<void> = Promise.resolve()
  return {
    get: (contextId) => bindings[contextId],
    set: (contextId, binding) => {
      bindings[contextId] = binding
      if (persist !== undefined) chain = chain.then(() => persist({ ...bindings })).catch(() => undefined)
    },
    snapshot: () => ({ ...bindings }),
    flush: () => chain,
  }
}

/** 读取状态文件（不存在/损坏 → 空表 + 响亮告警；绝不因账本坏掉阻断任务） */
export async function loadBindingStore(path: string, warn: (message: string) => void = console.warn): Promise<LinkBindingStore> {
  let initial: Record<string, LinkBinding> = {}
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as { version?: unknown; bindings?: unknown }
    if (raw.version !== LINK_STATE_VERSION) {
      warn(`[dsh-a2a-server] 绑定账本版本不符（${String(raw.version)} ≠ ${LINK_STATE_VERSION}），按空表启动: ${path}`)
    } else if (typeof raw.bindings === 'object' && raw.bindings !== null && !Array.isArray(raw.bindings)) {
      initial = raw.bindings as Record<string, LinkBinding>
    }
  } catch (e) {
    const code = (e as { code?: unknown }).code
    if (code !== 'ENOENT') warn(`[dsh-a2a-server] 绑定账本读取失败，按空表启动: ${(e as Error)?.message ?? e}`)
  }
  return createBindingStore(initial, async (all) => {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify({ version: LINK_STATE_VERSION, bindings: all }, null, 2), 'utf8')
    await rename(tmp, path)
  })
}

/** 一个可选工作区（首选定选项来源） */
export interface WorkspaceChoice {
  /** 工作区展示名 */
  title: string
  /** canonical 路径（选定后按路径绑定，规避 title 重名歧义） */
  path: string
}

/** 首选定工作区选项的展示上限（避免卡片组件过多；多余的手输名字即可） */
export const FIRST_USE_WORKSPACE_OPTIONS = 8

/**
 * 构造首选定选项：**两题合一卡组**（§2.6 通道会逐题发卡、一次作答）。
 *
 * - 工作区题：选项＝现有工作区（按 path 去重、标题重名时附父目录名区分）＋手输框（新建名）；
 * - 沙箱题：三档枚举＋说明（书线建议 workspace-write）。
 */
export function firstUseQuestions(workspaces: readonly WorkspaceChoice[]): { items: QuestionItem[]; labels: Map<string, WorkspaceSpec> } {
  const labels = new Map<string, WorkspaceSpec>()
  const unique = workspaces.filter((workspace, index, all) => all.findIndex((candidate) => candidate.path === workspace.path) === index)
  // 标题重名的**全部**加父目录后缀（只给后来者加会留下一个「光名」歧义项）
  const titleCount = new Map<string, number>()
  for (const workspace of unique) {
    const title = workspace.title || workspace.path
    titleCount.set(title, (titleCount.get(title) ?? 0) + 1)
  }
  const options: { label: string; description?: string }[] = []
  for (const workspace of unique) {
    const title = workspace.title || workspace.path
    if (title === '') continue
    let label = title
    if ((titleCount.get(title) ?? 0) > 1) {
      const parent = workspace.path.split('/').slice(-2, -1)[0] ?? ''
      if (parent !== '') label = `${title}（${parent}）`
    }
    if (options.some((option) => option.label === label)) continue
    labels.set(label, { kind: 'path', path: workspace.path })
    options.push({ label, description: workspace.path })
  }
  const workspaceOptions = options.slice(0, FIRST_USE_WORKSPACE_OPTIONS)
  for (const dropped of options.slice(FIRST_USE_WORKSPACE_OPTIONS)) labels.delete(dropped.label)

  const items: QuestionItem[] = [
    {
      id: 'workspace',
      header: '工作区',
      question: '这条线用哪个工作区？（不选＝通用区；也可直接输入新名字）',
      ...workspaceOptions.length > 0 ? { options: workspaceOptions } : {},
    },
    {
      id: 'sandbox',
      header: '沙箱档',
      question: '这条线用哪档沙箱？（不选＝当前档）',
      options: SANDBOX_TIERS.map((tier) => ({
        label: tier,
        description: tier === 'workspace-write' ? '书线建议：只能写工作区内（读不受限）' : tier === 'read-only' ? '只能读，不能写' : '不限制（沙箱不圈写）',
      })),
    },
  ]
  return { items, labels }
}

/** 首选定作答 → 绑定（跳过/空答都记为 answered 但不改缺省） */
export function bindingFromAnswers(
  answers: readonly QuestionAnswerItem[],
  workspaceLabels: ReadonlyMap<string, WorkspaceSpec>,
  now: number = Date.now(),
): LinkBinding {
  const byId = new Map(answers.map((answer) => [answer.id, answer]))
  const binding: LinkBinding = { answered: true, updatedAt: now }

  const workspaceAnswer = byId.get('workspace')
  if (workspaceAnswer !== undefined) {
    const picked = workspaceAnswer.selected.find((label) => workspaceLabels.has(label))
    if (picked !== undefined) {
      binding.workspace = workspaceLabels.get(picked)
    } else if (workspaceAnswer.custom !== undefined && workspaceAnswer.custom.trim() !== '') {
      binding.workspace = { kind: 'name', name: workspaceAnswer.custom.trim() }
    }
  }

  const sandboxAnswer = byId.get('sandbox')
  const tier = sandboxAnswer?.selected.find((label) => (SANDBOX_TIERS as readonly string[]).includes(label))
  if (tier !== undefined) binding.sandbox = tier as SandboxTier
  return binding
}

/**
 * 合并优先级：显式参数 > 绑定 > 缺省。返回本次任务实际采用的选项。
 * （首选定/绑定只补**缺省**，绝不覆盖调用方显式给出的值。）
 */
export function effectiveRequestOptions(
  explicit: { workspace?: WorkspaceSpec; sandbox?: SandboxTier },
  binding: LinkBinding | undefined,
): { workspace?: WorkspaceSpec; sandbox?: SandboxTier } {
  return {
    ...explicit.workspace === undefined && binding?.workspace !== undefined ? { workspace: binding.workspace } : {},
    ...explicit.sandbox === undefined && binding?.sandbox !== undefined ? { sandbox: binding.sandbox } : {},
    ...explicit.workspace !== undefined ? { workspace: explicit.workspace } : {},
    ...explicit.sandbox !== undefined ? { sandbox: explicit.sandbox } : {},
  }
}

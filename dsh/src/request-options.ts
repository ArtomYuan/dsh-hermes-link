/**
 * §2.1 工作区选择 ＋ §2.4 沙箱档：A2A **请求级选项**的解析、工作区解析与档位落地。
 *
 * 通道：客户端在首投报文的 `message.metadata` 里带
 * ```json
 * {"x-dsh-workspace": "<名字或绝对路径>", "x-dsh-sandbox": "workspace-write"}
 * ```
 * 与 §2.6 的能力声明同一条 metadata 通道（键名见 {@link WORKSPACE_META_KEY} /
 * {@link SANDBOX_META_KEY}；请求级；**缺省不带＝现状**，服务端不碰任何东西）。
 *
 * 落点语义（2026-10-18 定型）：
 * - **工作区**：名字 → 现有工作区按 title / 目录名精确匹配（唯一命中即用）；无命中 →
 *   在服务端 cwd 下建同名目录并登记；绝对路径形态直接采用（不存在就建）。解析出的路径
 *   即会话 cwd，而会话复用键本就含 cwd（`${contextId}\0${cwd}`）⇒ 同对话换区自然换会话。
 * - **沙箱档**：经 dsh 自己的 `ctx.permissionPresets.set(session, 档名)` 落成**会话级
 *   覆盖**（与 GUI 手切沙箱走同一条写路径：`permission/preset` + `sandbox/mode` +
 *   `approval/policy` 三个 log-only 事件，幂等）。这同时把该部署里与该档配对的审批策略
 *   带上（本机配置：read-only/workspace-write → approval=ask；danger-full-access → never）。
 * - **「读」的圈定程度（2026-10-18 核验修正）**：三档都**不限制读**（bwrap 统一
 *   `--ro-bind / /`）；但「只圈写」只对 `read-only` / `workspace-write` 成立，
 *   `danger-full-access` **完全不圈**。`workspace-write` 的可写面**不止会话 cwd**：
 *   还有 `/tmp`（bwrap 下是私有 tmpfs，Landlock/Seatbelt 下是真实 `/tmp`）与
 *   `os.tmpdir()`（见 `sandbox/src/roots.ts` 的 `writableRoots`）。子代理由 dsh 原生
 *   继承（`child-agent.ts` 写 `sandbox/mode` 带 `source: 'delegation'`）。
 * - **路径形态是显式逃生门**：服务端不对绝对路径做 allowlist；若把 workspace 指到 `/`
 *   再配 `workspace-write`，写边界就变成整盘（慎用；文档已警示）。
 *
 * 本模块只做**纯逻辑 + 依赖注入**（注册表、落盘、权限服务都经接口传入），故可纯单测；
 * 与 dsh 运行时零耦合。
 *
 * @module dsh-hermes-link/request-options
 */

import { basename, isAbsolute, join, normalize, sep } from 'node:path'
import {
  SANDBOX_META_KEY,
  SANDBOX_TIERS,
  WORKSPACE_META_KEY,
} from './link-protocol.ts'
import type { SandboxTier } from './link-protocol.ts'

// 对外契约不变：键与档位仍从本模块导出（既有测试/调用方零改动），值来自协议单一来源。
export { SANDBOX_META_KEY, SANDBOX_TIERS, WORKSPACE_META_KEY }
export type { SandboxTier }

/** 工作区名长度上限（目录名片段，非路径） */
export const WORKSPACE_NAME_MAX = 64
/** 路径形态长度上限（防御性；远超任何真实路径） */
export const WORKSPACE_PATH_MAX = 4096

/** 一次请求带上的选项（都可缺省＝现状） */
export interface RequestOptions {
  workspace?: WorkspaceSpec
  sandbox?: SandboxTier
}

/** 请求级选项不合法（响亮失败：任务以 FAILED 收口，绝不静默改用默认值） */
export class RequestOptionError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'RequestOptionError'
  }
}

/** 工作区目标形态：名字（本部署相对服务端 cwd）或绝对路径 */
export type WorkspaceSpec =
  | { kind: 'name'; name: string }
  | { kind: 'path'; path: string }

/**
 * 控制字符判定：C0（含 NUL）、DEL、C1（U+0080–U+009F）与 bidi 控制符
 * （U+202A–U+202E、U+2066–U+2069）。它们不能穿越目录，但会污染日志/回执（核验指出）。
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/

/**
 * 解析 `metadata` 里的请求级选项。字段缺省即不设置；出现但不合法则抛
 * {@link RequestOptionError}（响亮失败，不静默降级）。
 *
 * @param metadata - A2A `userMessage.metadata`（不可信输入）
 */
export function readRequestOptions(metadata: unknown): RequestOptions {
  const record = typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {}
  const options: RequestOptions = {}
  if (record[WORKSPACE_META_KEY] !== undefined) {
    const spec = parseWorkspaceSpec(record[WORKSPACE_META_KEY])
    if (spec !== undefined) options.workspace = spec
  }
  // 两个键对 `null` 的处理对称：都当「未设置」（手写客户端常见 null 占位；不是非法值）
  if (record[SANDBOX_META_KEY] !== undefined && record[SANDBOX_META_KEY] !== null) {
    options.sandbox = parseSandboxTier(record[SANDBOX_META_KEY])
  }
  return options
}

/** 解析沙箱档：只接受三档精确字符串（trim 后）；其它一律抛错并列出合法值 */
export function parseSandboxTier(raw: unknown): SandboxTier {
  if (typeof raw !== 'string') {
    throw new RequestOptionError(
      `沙箱档必须是字符串（可选：${SANDBOX_TIERS.join(' / ')}），实际收到 ${typeof raw}`,
      'SANDBOX_NOT_STRING',
    )
  }
  const value = raw.trim()
  const tier = SANDBOX_TIERS.find((candidate) => candidate === value)
  if (tier === undefined) {
    throw new RequestOptionError(
      `未知沙箱档 ${JSON.stringify(raw)}（可选：${SANDBOX_TIERS.join(' / ')}）`,
      'SANDBOX_UNKNOWN',
    )
  }
  return tier
}

/**
 * 解析工作区目标：以 `/` 开头视为**绝对路径**形态，否则视为**名字**形态。
 *
 * 名字纪律（它要变成目录名片段）：非空、≤{@link WORKSPACE_NAME_MAX} 字符、不含路径
 * 分隔符、不是 `.`/`..`、不含控制字符。路径纪律：绝对、无 `..` 段、≤
 * {@link WORKSPACE_PATH_MAX}、无控制字符。
 *
 * @returns 缺省（undefined/null）返回 undefined；不合法抛 {@link RequestOptionError}
 */
export function parseWorkspaceSpec(raw: unknown): WorkspaceSpec | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') {
    throw new RequestOptionError(
      `workspace 必须是字符串（名字或绝对路径），实际收到 ${typeof raw}`,
      'WORKSPACE_NOT_STRING',
    )
  }
  const value = raw.trim()
  if (value === '') {
    throw new RequestOptionError('workspace 不能为空字符串', 'WORKSPACE_EMPTY')
  }
  if (CONTROL_CHARS.test(value)) {
    throw new RequestOptionError('workspace 含控制字符', 'WORKSPACE_CONTROL_CHARS')
  }
  if (value.length > WORKSPACE_PATH_MAX) {
    throw new RequestOptionError(`workspace 过长（>${WORKSPACE_PATH_MAX}）`, 'WORKSPACE_TOO_LONG')
  }
  if (isAbsolute(value)) {
    // 注意：必须在 normalize **之前**查 `..`——normalize 会把 `..` 消解掉，查了等于没查。
    const segments = value.split(/[\\/]/)
    if (segments.includes('..')) {
      throw new RequestOptionError(`workspace 路径不允许包含 .. 段: ${JSON.stringify(raw)}`, 'WORKSPACE_DOT_DOT')
    }
    // 去掉尾部分隔符（保留根 '/'）：cwd 形态统一，避免同一目录两种写法
    const normalized = normalize(value)
    const path = normalized.length > 1 && normalized.endsWith(sep) ? normalized.slice(0, -1) : normalized
    return { kind: 'path', path }
  }
  if (value.length > WORKSPACE_NAME_MAX) {
    throw new RequestOptionError(
      `workspace 名字过长（>${WORKSPACE_NAME_MAX} 字符）: ${JSON.stringify(raw)}`,
      'WORKSPACE_NAME_TOO_LONG',
    )
  }
  if (value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    throw new RequestOptionError(
      `workspace 名字不能含路径分隔符，也不能是 . / ..: ${JSON.stringify(raw)}（目录路径请用绝对路径形态）`,
      'WORKSPACE_BAD_NAME',
    )
  }
  return { kind: 'name', name: value }
}

/** 注册表里一条工作区记录的只读视图（`ctx.workspaceRegistry.list()` 的子集） */
export interface WorkspaceRecordView {
  path: string
  title: string
}

/** 解析工作区所需的宿主能力（全部注入，便于纯单测） */
export interface WorkspaceResolveDeps {
  /** 名字形态新建工作区的父目录（＝服务端配置的 cwd） */
  defaultCwd: string
  /** 现有工作区快照；宿主无工作区注册表时省略（headless 降级） */
  listWorkspaces?: () => WorkspaceRecordView[]
  /** 文件系统真实路径规范化（realpath；失败回退 lexical resolve） */
  canonicalize: (path: string) => Promise<string>
  /** 确保目录存在（mkdir -p） */
  ensureDir: (path: string) => Promise<void>
}

/** 工作区解析结果 */
export interface WorkspaceTarget {
  /** 会话 cwd（canonical） */
  cwd: string
  /** 命中方式：现有登记 / 名字新建 / 绝对路径 */
  via: 'existing' | 'created' | 'path'
  /** 用于日志与回执的展示名 */
  title: string
}

/**
 * 把一个工作区目标解析成会话 cwd。
 *
 * - 名字形态：先在本部署现有工作区里按 **title 精确匹配** 或 **目录名精确匹配**
 *   （去重后）找；唯一命中 → 采用；多命中 → 抛错（歧义绝不替你猜）；无命中 →
 *   `join(defaultCwd, name)` 建目录（「不存在就建」）。
 * - 路径形态：直接建目录并采用。
 *
 * @throws {RequestOptionError} 名字歧义时
 */
export async function resolveWorkspaceTarget(
  spec: WorkspaceSpec,
  deps: WorkspaceResolveDeps,
): Promise<WorkspaceTarget> {
  if (spec.kind === 'path') {
    await deps.ensureDir(spec.path)
    const cwd = await deps.canonicalize(spec.path)
    return { cwd, via: 'path', title: basename(cwd) || cwd }
  }
  const matches = dedupeByPath(
    (deps.listWorkspaces?.() ?? []).filter(
      (workspace) => workspace.title === spec.name || basename(workspace.path) === spec.name,
    ),
  )
  if (matches.length > 1) {
    throw new RequestOptionError(
      `工作区名字歧义：${JSON.stringify(spec.name)} 命中 ${matches.length} 个（` +
      `${matches.map((workspace) => workspace.path).join(' | ')}）——请改用绝对路径形态`,
      'WORKSPACE_AMBIGUOUS',
    )
  }
  if (matches.length === 1) {
    return { cwd: await deps.canonicalize(matches[0].path), via: 'existing', title: matches[0].title }
  }
  const target = join(deps.defaultCwd, spec.name)
  await deps.ensureDir(target)
  const cwd = await deps.canonicalize(target)
  return { cwd, via: 'created', title: spec.name }
}

/** 按 path 去重（保留首个），避免同名 title 的多条记录被误判成歧义 */
function dedupeByPath(workspaces: WorkspaceRecordView[]): WorkspaceRecordView[] {
  const seen = new Set<string>()
  const out: WorkspaceRecordView[] = []
  for (const workspace of workspaces) {
    if (seen.has(workspace.path)) continue
    seen.add(workspace.path)
    out.push(workspace)
  }
  return out
}

/**
 * dsh 权限预设服务的最小接口（`ctx.permissionPresets` 的子集）。
 * 本包不引 `@deepseek-ai/dsh-permission-presets`（不在依赖面内），只按运行时形状收窄。
 */
export interface SandboxPresetService {
  /** 把会话切到某个预设（写 `permission/preset` + 变更的沙箱/审批 knob；幂等） */
  set(session: object, name: string): void
  /** 会话当前生效的预设名（`custom` 表示不匹配任何预设） */
  current?(session: object): string
  /** 解析预设名（不存在会抛错）；用于提前校验本部署的预设表 */
  resolve?(name: string): unknown
}

/** 档位落地所需的宿主能力 */
export interface SandboxApplyDeps {
  /** 权限预设服务；宿主未挂该插件时省略 */
  presets?: SandboxPresetService
  /** 告警出口（注入以便断言；生产用 console.warn） */
  warn: (message: string) => void
}

/** 档位落地结果 */
export type SandboxApplyOutcome = 'applied' | 'unchanged' | 'unavailable'

/**
 * 把沙箱档落到一个**已存在**的会话上（会话级覆盖，幂等）。
 *
 * 缺省/降级语义（全程响亮，绝不静默假装生效）：
 * - 宿主没挂 `permissionPresets` → 告警 + `unavailable`（不改档＝现状）；
 * - 本部署的预设表里没有该档名（`resolve` 抛错）→ 告警 + `unavailable`；
 * - 会话当前已是该档 → `unchanged`（不写事件，不给 session log 添噪声）；
 * - `set` 抛错 → 告警 + `unavailable`。
 *
 * @param session - 目标会话（`handle.agent.session`）
 * @param tier - 请求的三档之一
 */
export function applySandboxTier(
  deps: SandboxApplyDeps,
  session: object,
  tier: SandboxTier,
): SandboxApplyOutcome {
  const presets = deps.presets
  if (presets === undefined) {
    deps.warn(
      `[dsh-hermes-link] 宿主未挂 permissionPresets（permission-presets 插件缺失），` +
      `本次不改沙箱档（请求档=${tier}，保持现状）`,
    )
    return 'unavailable'
  }
  if (typeof presets.resolve === 'function') {
    try {
      presets.resolve(tier)
    } catch (e) {
      deps.warn(
        `[dsh-hermes-link] 本部署的权限预设表里没有 ${JSON.stringify(tier)}（${(e as Error)?.message ?? e}）——` +
        `本次不改沙箱档，保持现状`,
      )
      return 'unavailable'
    }
  }
  if (typeof presets.current === 'function') {
    try {
      if (presets.current(session) === tier) return 'unchanged'
    } catch {
      /* 读不到当前档就照常尝试写入（幂等，重复写同档不会重复追加事件） */
    }
  }
  try {
    presets.set(session, tier)
    return 'applied'
  } catch (e) {
    deps.warn(`[dsh-hermes-link] 落沙箱档失败（${tier}）: ${(e as Error)?.message ?? e}`)
    return 'unavailable'
  }
}

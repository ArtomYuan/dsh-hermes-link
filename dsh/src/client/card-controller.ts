/**
 * A2A 设置卡片的表单控制器：把 `a2a-server` settings 命名空间的 scope
 * 快照、describe 镜像（secret 已设置状态）与本地草稿一起投影成卡片状态，
 * 并提供带 revision 乐观锁的保存动作。
 *
 * 卡片完全自持草稿/校验/时钟逻辑（官方 cookbook 禁止跨插件 value import，
 * 本仓库外的包不能复用 ui-settings-plugins 的 card-form）。
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  SettingsDescribeFace,
  SettingsScope,
} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** 命名空间名 = host 半边注册的名字（src/settings.ts 同值，客户端不能 import host） */
export const A2A_SETTINGS_NS = 'a2a-server'

/** 环境令牌变量：host 侧 applyResolvedConfig 里的最高优先级通道 */
const ENV_TOKEN = 'A2A_SERVER_TOKEN'

/** settings 段的值（authToken 在 wire 上被结构性脱敏，客户端永远收不到） */
export interface A2ASettingsValue {
  port?: number
  host?: string
  authToken?: string
  provider?: string
  model?: string
  preset?: string
  cwd?: string
  contextMapPath?: string
  contextMapTtlDays?: number
}

/**
 * 统一表单后端的快照契约：0.1.5 `SettingsScopeSnapshot<T>` 与 0.2.0
 * `ConfigFormSnapshot<T>` 字段完全一致（status/value/base/user/revision/
 * writable/mode），此处本地声明一份最小结构，避免引入 0.2.0 devDep。
 */
export interface A2AFormSnapshot<T> {
  status: 'loading' | 'ready' | 'unavailable'
  value: T | undefined
  base: unknown
  user: unknown
  revision: number | undefined
  writable: boolean
  mode: 'host' | 'memory'
}

/**
 * 统一表单后端的写读契约：0.1.5 `SettingsScope<T>` 与 0.2.0 `ConfigForm<T>`
 * 的交集面。写方法统一返回 `Promise<boolean>`（Host 是否接受）：0.2.0 原生如此；
 * 0.1.5 经 {@link legacyScopeSource} 适配（`Promise<void>` 包成 boolean）。
 */
export interface A2AFormSource<T> {
  getSnapshot(): A2AFormSnapshot<T>
  subscribe(listener: () => void): () => void
  mutate(ops: readonly SettingsPathOpView[], expectedRevision?: number): Promise<boolean>
  set(field: string, value: unknown): Promise<boolean>
  unset(field: string): Promise<boolean>
}

/**
 * 0.1.5 `SettingsScope` → {@link A2AFormSource} 适配器：把写方法的
 * `Promise<void>`（被拒时静默 recover 重读，不抛）包装成 `Promise<boolean>`。
 * 「被拒但已 recover」的情况由控制器保存后的 {@link A2ASettingsCardController.verifyLanded}
 * 读回 userLayer 判定，保持既有 0.1.5 行为不变；wire 层异常返回 false。
 */
export function legacyScopeSource(
  scope: SettingsScope<A2ASettingsValue>,
): A2AFormSource<A2ASettingsValue> {
  return {
    getSnapshot: () => scope.getSnapshot(),
    subscribe: (listener) => scope.subscribe(listener),
    mutate: async (ops, revision) => {
      try {
        await scope.mutate(ops, revision)
        return true
      } catch {
        return false
      }
    },
    set: async (field, value) => {
      try {
        await scope.set(field, value)
        return true
      } catch {
        return false
      }
    },
    unset: async (field) => {
      try {
        await scope.unset(field)
        return true
      } catch {
        return false
      }
    },
  }
}

/** 卡片上一个普通字段的渲染状态 */
export interface A2AFieldState {
  /** 控件展示的草稿文本（无草稿时 = 有效值） */
  text: string
  /** 清除覆盖后回落的配置层值文本（无 base 时为 ''） */
  baseText: string
  /** 用户层是否持有该字段（或草稿是否会写入覆盖） */
  overridden: boolean
  /** 草稿不可保存时的错误文案 key；合法时为 null */
  invalid: string | null
}

/** authToken 字段的渲染状态（只写不回显） */
export interface A2AAuthTokenState {
  /** 草稿文本（永远空起始；空白 = 不修改） */
  text: string
  /** 解析值（任意层）当前是否持有令牌（secret sidecar 的 set 标志） */
  configured: boolean
  /** 进程环境是否存在 A2A_SERVER_TOKEN（接管只读徽章） */
  envToken: boolean
}

/** 卡片整体状态（经 useSyncExternalStore 快照源绑定） */
export interface A2ASettingsCardState {
  /** scope 状态：loading/ready/unavailable；非 ready 时卡片带 hidden 渲染 */
  status: 'loading' | 'ready' | 'unavailable'
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
  fields: {
    provider: A2AFieldState
    model: A2AFieldState
    preset: A2AFieldState
    cwd: A2AFieldState
    port: A2AFieldState
    host: A2AFieldState
    contextMapPath: A2AFieldState
    contextMapTtlDays: A2AFieldState
    authToken: A2AAuthTokenState
  }
}

/** 可编辑的普通字段名 */
export type A2AEditableField =
  | 'provider' | 'model' | 'preset' | 'cwd'
  | 'port' | 'host' | 'contextMapPath' | 'contextMapTtlDays'

/** 卡片注册注入的业务面（hooks 被 renderer 绑定为 useA2aSettings） */
export interface A2ASettingsCardFace {
  hooks: {
    a2aSettings: HostObservable<A2ASettingsCardState>
  }
  /** 暂存一个字段的草稿文本 */
  edit: (field: A2AEditableField | 'authToken', text: string) => void
  /** 保存全部草稿（单个 mutate + revision 乐观锁） */
  save: () => void
  /** 丢弃全部草稿 */
  discard: () => void
  /** 清除一个普通字段的用户层覆盖（立即 unset，回落配置层） */
  clearOverride: (field: A2AEditableField) => void
  /** 清除 authToken 的用户层覆盖（立即 unset；二次确认在卡片里做） */
  clearAuthToken: () => void
}

/** credentials Remote 命名空间上本卡片用到的最小面（结构性声明） */
interface CredentialsDescribeRemote {
  describe(
    refs: string[],
  ): Promise<
    | { ok: true; value: Record<string, { configured: boolean; source?: string; writable: boolean }> }
    | { ok: false; error: { message: string } }
  >
}

/** 文本字段：空草稿 = 清除覆盖 */
interface TextFieldSpec {
  kind: 'text'
  field: A2AEditableField
}
/** 数字字段：空草稿 = 清除；非整数不可保存 */
interface NumberFieldSpec {
  kind: 'number'
  field: A2AEditableField
  min: number
  max: number
  invalidKey: 'invalidPort' | 'invalidTtl'
}

type FieldSpec = TextFieldSpec | NumberFieldSpec

const FIELD_SPECS: readonly FieldSpec[] = [
  { kind: 'text', field: 'provider' },
  { kind: 'text', field: 'model' },
  { kind: 'text', field: 'preset' },
  { kind: 'text', field: 'cwd' },
  { kind: 'text', field: 'contextMapPath' },
  { kind: 'number', field: 'port', min: 1, max: 65535, invalidKey: 'invalidPort' },
  { kind: 'text', field: 'host' },
  { kind: 'number', field: 'contextMapTtlDays', min: 1, max: 2147483647, invalidKey: 'invalidTtl' },
]

/** 一条已暂存的编辑 */
interface StagedEdit {
  text: string
}

/** 最小快照 store（getSnapshot/subscribe/set；替代 dsh-client-store 的 value import） */
class CardStore<T> implements HostObservable<T> {
  private snapshot: T
  private readonly listeners = new Set<() => void>()

  constructor(initial: T) {
    this.snapshot = initial
  }

  getSnapshot(): T {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  set(next: T): void {
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}

/**
 * 桥接 `a2a-server` scope：暂存草稿、投影卡片状态、带 revision 乐观锁保存。
 */
export class A2ASettingsCardController {
  private readonly store: CardStore<A2ASettingsCardState>
  private readonly staged = new Map<string, StagedEdit>()
  private readonly describe: SettingsDescribeFace
  private saving = false
  private failed = false
  /** 草稿起始时冻结的 revision（乐观锁栅栏）；保存后刷新为最新 revision */
  private fenceRevision: number | undefined
  private envToken = false

  /**
   * @param source - `a2a-server` 的统一表单后端（0.1.5 经 legacyScopeSource 适配，
   *   0.2.0 直接传 configForms.get 的结果）
   * @param describe - 共享 describe 镜像（读 secret 的 set 状态）
   * @param ctx - 卡片所在 fiber 的 context（用于可选地注入 credentials Remote）
   */
  constructor(
    private readonly source: A2AFormSource<A2ASettingsValue>,
    describe: SettingsDescribeFace,
    ctx: ClientContext,
  ) {
    this.describe = describe
    this.store = new CardStore(this.projection())
    source.subscribe(() => { this.publish() })
    describe.subscribe(() => { this.publish() })
    // 环境令牌徽章的可选数据源：credentials 域能描述 process.env 里的
    // A2A_SERVER_TOKEN（只读探测，令牌本身不回传）。Remote 缺失时徽章不显示。
    ctx.inject(['remote.credentials'], (credCtx) => {
      void this.readEnvToken(credCtx.remote.credentials as CredentialsDescribeRemote)
    })
  }

  /** 读取环境令牌状态（一次；环境在会话期内不变） */
  private async readEnvToken(credentials: CredentialsDescribeRemote): Promise<void> {
    try {
      const response = await credentials.describe([ENV_TOKEN])
      if (!response.ok) return
      const info = response.value[ENV_TOKEN]
      // 只有「继承的进程环境」层才算接管（file 层是 credentials 自己存的值，
      // 插件的 process.env 读不到它，显示徽章会撒谎）
      if (info?.configured === true && info.source === 'env') {
        this.envToken = true
        this.publish()
      }
    } catch {
      /* 探测失败只影响徽章，不阻塞卡片 */
    }
  }

  /** 保存当前 revision 快照里的 scope 数据 */
  private snapshot(): A2AFormSnapshot<A2ASettingsValue> {
    return this.source.getSnapshot()
  }

  /** 用户层（原始存储段）或 undefined */
  private userLayer(): Record<string, unknown> | undefined {
    const user = this.snapshot().user
    return user !== null && typeof user === 'object'
      ? user as Record<string, unknown>
      : undefined
  }

  /** 用户层是否持有该字段（overridden 标记的事实源） */
  private stored(field: string): boolean {
    const user = this.userLayer()
    return user !== undefined && Object.hasOwn(user, field)
  }

  /** 有效值（schema 默认 < base < user 解析后）里该字段的显示文本 */
  private effectiveText(field: string): string {
    const value = (this.snapshot().value as Record<string, unknown> | undefined)?.[field]
    return typeof value === 'number' || typeof value === 'string' ? String(value) : ''
  }

  /** base 层里该字段的回落文本 */
  private baseText(field: string): string {
    const base = this.snapshot().base as Record<string, unknown> | undefined
    const value = base?.[field]
    return typeof value === 'number' || typeof value === 'string' ? String(value) : ''
  }

  /** 草稿文本经 spec 解析后的写入意图；undefined = 不可保存 */
  private parse(field: A2AEditableField, text: string): { op: 'set'; value: string | number } | { op: 'clear' } | undefined {
    const spec = FIELD_SPECS.find(candidate => candidate.field === field)
    if (spec === undefined) throw new Error(`A2A settings card has no field ${field}`)
    const trimmed = text.trim()
    if (trimmed === '') return { op: 'clear' }
    if (spec.kind === 'number') {
      const parsed = Number(trimmed)
      if (!Number.isInteger(parsed) || parsed < spec.min || parsed > spec.max) return undefined
      return { op: 'set', value: parsed }
    }
    return { op: 'set', value: trimmed }
  }

  /** 一个普通字段的渲染状态 */
  private fieldState(field: A2AEditableField): A2AFieldState {
    const spec = FIELD_SPECS.find(candidate => candidate.field === field)!
    const staged = this.staged.get(field)
    if (staged === undefined) {
      return {
        text: this.effectiveText(field),
        baseText: this.baseText(field),
        overridden: this.stored(field),
        invalid: null,
      }
    }
    const write = this.parse(field, staged.text)
    if (staged.text.trim() === '') {
      // 空草稿 = 清除覆盖（显式空串才会撞 host 的非空校验，卡片不会写出空串）
      return {
        text: staged.text,
        baseText: this.baseText(field),
        overridden: false,
        invalid: null,
      }
    }
    return {
      text: staged.text,
      baseText: this.baseText(field),
      overridden: true,
      invalid: write === undefined ? spec.kind === 'number' ? spec.invalidKey : null : null,
    }
  }

  /** authToken 字段的渲染状态（草稿空白起始，只写不回显） */
  private authTokenState(): A2AAuthTokenState {
    return {
      text: this.staged.get('authToken')?.text ?? '',
      configured: this.secretConfigured(),
      envToken: this.envToken,
    }
  }

  /** describe 镜像里 authToken 槽位是否持有值（secret sidecar 的 set 标志） */
  private secretConfigured(): boolean {
    const view: SettingsNamespaceView | undefined = this.describeView()
    const secret = view?.secrets.find(entry => entry.path.length === 1 && entry.path[0] === 'authToken')
    return secret?.set === true
  }

  /** describe 镜像里本命名空间的行 */
  private describeView(): SettingsNamespaceView | undefined {
    const mirrored = this.describe.getSnapshot()
    return mirrored.view?.namespaces.find(row => row.ns === A2A_SETTINGS_NS)
  }

  /** 投影整个卡片状态 */
  private projection(): A2ASettingsCardState {
    const snapshot = this.snapshot()
    const plan = this.plan()
    const authStaged = this.staged.get('authToken')
    // 令牌空白草稿 = 不修改（不是清空），不产生写入、也不该让卡片变 dirty
    const authDirty = authStaged !== undefined && authStaged.text.trim() !== ''
    return {
      status: snapshot.status,
      writable: snapshot.writable,
      dirty: plan.ops.length > 0 || authDirty,
      invalid: plan.invalid,
      saving: this.saving,
      failed: this.failed,
      fields: {
        provider: this.fieldState('provider'),
        model: this.fieldState('model'),
        preset: this.fieldState('preset'),
        cwd: this.fieldState('cwd'),
        port: this.fieldState('port'),
        host: this.fieldState('host'),
        contextMapPath: this.fieldState('contextMapPath'),
        contextMapTtlDays: this.fieldState('contextMapTtlDays'),
        authToken: this.authTokenState(),
      },
    }
  }

  /** 广播最新投影 */
  private publish(): void {
    this.store.set(this.projection())
  }

  /** 注册注入的业务面 */
  inject(): A2ASettingsCardFace {
    return {
      hooks: { a2aSettings: this.store },
      edit: (field, text) => { this.stage(field, text) },
      save: () => { void this.save() },
      discard: () => {
        if (this.staged.size === 0 && !this.failed) return
        this.staged.clear()
        this.failed = false
        this.fenceRevision = undefined
        this.publish()
      },
      clearOverride: (field) => { void this.clear(field) },
      clearAuthToken: () => { void this.clear('authToken') },
    }
  }

  /** 暂存草稿；首个草稿落笔时冻结 revision 栅栏 */
  private stage(field: string, text: string): void {
    if (!this.staged.has(field)) this.fenceRevision = this.snapshot().revision
    this.staged.set(field, { text })
    this.failed = false
    this.publish()
  }

  /** 把全部草稿解析成一次 mutate 的 ops 序列（含 invalid 标志） */
  private plan(): { ops: SettingsPathOpView[]; invalid: boolean } {
    const ops: SettingsPathOpView[] = []
    let invalid = false
    for (const spec of FIELD_SPECS) {
      const staged = this.staged.get(spec.field)
      if (staged === undefined) continue
      const write = this.parse(spec.field, staged.text)
      if (write === undefined) {
        invalid = true
        continue
      }
      if (write.op === 'clear') {
        if (this.stored(spec.field)) ops.push({ op: 'unset', path: [spec.field] })
      } else if (staged.text.trim() !== this.effectiveText(spec.field)) {
        // 与有效值相同则跳过，避免制造无意义的覆盖层条目（与官方 CardForm 同语义）
        ops.push({ op: 'set', path: [spec.field], value: write.value })
      }
    }
    const authStaged = this.staged.get('authToken')
    if (authStaged !== undefined) {
      const trimmed = authStaged.text.trim()
      // 空白输入 = 不修改（不是清空）；authToken 只写不回显，无有效值可对比
      if (trimmed !== '') ops.push({ op: 'set', path: ['authToken'], value: trimmed })
    }
    return { ops, invalid }
  }

  /**
   * 保存全部草稿：一次 mutate + revision 乐观锁，然后按 host 接受的结果回读
   * 验证（host 是唯一权威）。失败保留草稿供修正/重试。
   */
  private async save(): Promise<void> {
    const plan = this.plan()
    if (plan.invalid || plan.ops.length === 0 || this.saving) return
    const revision = this.fenceRevision ?? this.snapshot().revision
    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    try {
      // 0.2.0 的 mutate 返回 Host 是否接受（false = 拒绝后已 recover 重读）；
      // 0.1.5 经适配器恒为 true（拒绝时静默 recover），此时靠下面的回读验证判定。
      const accepted = await this.source.mutate(plan.ops, revision)
      landed = accepted && this.verifyLanded(plan.ops)
    } catch {
      // wire 层异常（连接断开等）与拒绝同归 failed；scope 侧会触发恢复读取
      landed = false
    }
    this.saving = false
    if (landed) {
      this.staged.clear()
      this.failed = false
    } else {
      this.failed = true
    }
    // 无论成败，下一次保存都从 host 当前 revision 出发
    this.fenceRevision = this.snapshot().revision
    this.publish()
  }

  /**
   * 写后回读验证：host 是唯一权威，逐 op 核对 userLayer（或 secret 的 set 标志）
   * 是否已落到期望状态。全部落定返回 true。
   */
  private verifyLanded(ops: readonly SettingsPathOpView[]): boolean {
    const user = this.userLayer()
    let landed = true
    for (const op of ops) {
      if (op.op === 'set') {
        if (op.path[0] === 'authToken') {
          // 令牌明文不回传，唯一可验证的事实是「解析值已设置」
          landed = this.secretConfigured() && landed
        } else {
          landed = user?.[op.path[0]!] === op.value && landed
        }
      } else {
        landed = (user === undefined || !Object.hasOwn(user, op.path[0]!)) && landed
      }
    }
    return landed
  }

  /** 立即清除一个字段的用户层覆盖（回落配置层） */
  private async clear(field: string): Promise<void> {
    try {
      const accepted = await this.source.unset(field)
      // 0.2.0 拒绝（false）时显式置 failed；0.1.5 适配器恒为 true（拒绝时静默
      // recover），行为与既有实现一致（不额外置 failed）。
      if (!accepted) {
        this.failed = true
        this.publish()
      }
    } catch {
      this.failed = true
      this.publish()
    }
  }
}

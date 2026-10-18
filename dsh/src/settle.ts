/**
 * 「释放 Lead 前等活跃子代理结算」的等待原语（纯逻辑，零 dsh 依赖，可独立单测）。
 *
 * 背景：A2A 每次请求在 `whenIdle()` 后立即 `handle.dispose()` 释放 Lead。若 Lead 在
 * 派发子代理后收口，子代理完成时的回传就找不到父（`PARENT_UNAVAILABLE`），窗口虽已由
 * dsh-subagent 队列补丁兜底，但主路仍要等「下一次会话被激活」。本模块把等待条件前移：
 * **已 idle 且无活跃 continuable 子代理** 才允许释放，让回传到场时父仍在注册表。
 *
 * 判定口径（`ctx.subagents.listChildren` 提供 durable 子代理目录）：
 *  - 目录行 `mode === 'continuable'` 才是「会回传的」子代理（one-shot 不回传，不等）；
 *  - 目录是**durable 全量**（含历史已结算项），故用**基线 + 事件增量**求活跃集合：
 *    基线 = 进入等待时仍在本进程 Agent 注册表内的子代理；此后 `subagent/end` 标记结束、
 *    `subagent/start`（冷恢复的新 epoch）撤销结束标记；
 *  - 目录里不在注册表、且未观察到 start 的项 ⇒ 视为「本请求之前就已结算」。
 *
 * 等待是**事件驱动**的（每轮只挂一次监听并等待信号或超时），不做忙轮询；每轮重新
 * `whenIdle()`，因此子代理回传引发的新回合会被完整等到，且该回合再派生的子代理会被
 * 目录刷新捕获。
 */

/** 子代理目录数据源（由调用方从 dsh `ctx.subagents` 装配） */
export interface SubagentChildrenSource {
  /**
   * 读该父会话的直接子代理目录行。
   * @param parentSessionId - 父会话（Lead）id
   * @returns 目录行数组（每行含 `id` / `mode`；形状见 dsh `subagentCatalog` 投影）
   */
  listChildren(parentSessionId: string): Promise<readonly unknown[]> | readonly unknown[]
}

/** 一次「可能改变活跃子代理集合」的信号 */
export interface SubagentSignal {
  /** `end` = 子代理结算；`start` = 子代理开始/冷恢复新 epoch；`parent` = Lead 自身状态变化 */
  kind: 'end' | 'start' | 'parent'
  /** `end` / `start` 时的子代理 session id */
  childId?: string
}

/** 等待所需的最小宿主能力（便于单测注入；生产实现见 src/index.ts） */
export interface SettleHost {
  /** 子代理控制面；不可用（0.1.5 或未装 dsh-subagent）时省略 → 调用方不等待 */
  subagentChildren?: SubagentChildrenSource
  /** 子代理当前是否仍在本进程 Agent 注册表内（仅用于建立基线） */
  isChildResident(childId: string): boolean
  /**
   * 在**整个等待期间**订阅「可能改变活跃集合」的信号（等待期间到达的信号不会丢，
   * 即使此刻正卡在 `whenIdle()` 里）。返回退订函数。
   */
  subscribe(onSignal: (signal: SubagentSignal) => void): () => void
  /** 等到下一个信号到达或超时（信号内容由 `subscribe` 的回调处理） */
  waitForSignal(timeoutMs: number): Promise<void>
  /** 单调时钟（毫秒） */
  now(): number
  /** 告警日志（失败降级不静默） */
  warn(message: string): void
}

/** 等待结果 */
export interface SettleOutcome {
  /** `quiesced` 已 idle 且无活跃子代理；`cap` 超上限；`disabled` 未启用；`unavailable` 能力缺失/查询失败 */
  outcome: 'quiesced' | 'cap' | 'disabled' | 'unavailable'
  /** 进入等待到返回的耗时（毫秒） */
  waitedMs: number
  /** 事件等待轮数（0 = 未等待） */
  rounds: number
  /** 结束时仍活跃的子代理数 */
  liveChildren: number
}

/** 目录行 → continuable 子代理 id 列表（去重、保序、跳过坏行） */
export function continuableChildIds(rows: unknown): string[] {
  if (!Array.isArray(rows)) return []
  const ids: string[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const entry = row as { id?: unknown; mode?: unknown }
    if (entry.mode !== 'continuable') continue
    if (entry.id === undefined || entry.id === null) continue
    const id = String(entry.id)
    if (id.length > 0 && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/** 活跃集合 = 目录已知 − 已观察到结束（纯函数，便于单测） */
export function liveChildIds(known: readonly string[], ended: ReadonlySet<string>): string[] {
  return known.filter((id) => !ended.has(id))
}

/** 按事件更新「已结束」集合（`start` 撤销结束标记：冷恢复是新 epoch） */
export function applySignal(ended: Set<string>, signal: SubagentSignal | undefined): void {
  if (signal === undefined || signal.childId === undefined) return
  if (signal.kind === 'end') ended.add(signal.childId)
  else if (signal.kind === 'start') ended.delete(signal.childId)
}

/**
 * 等到「Lead 已 idle 且无活跃 continuable 子代理」，或到达上限。
 *
 * @param host - 宿主能力（查询 / 事件 / 时钟 / 日志）
 * @param agent - 被等待的 Lead（只需 `whenIdle()`）
 * @param parentSessionId - Lead 的 session id（子代理目录的键）
 * @param capMs - 上限（毫秒）；`<= 0` 表示关闭本行为（返回 `disabled`，调用方立即释放）
 * @returns 等待结果；调用方据 `outcome` 记录日志并决定释放
 */
export async function waitForSubagentQuiescence(
  host: SettleHost,
  agent: { whenIdle(): Promise<unknown> },
  parentSessionId: string,
  capMs: number,
): Promise<SettleOutcome> {
  const started = host.now()
  if (!(capMs > 0)) return { outcome: 'disabled', waitedMs: 0, rounds: 0, liveChildren: 0 }
  const source = host.subagentChildren
  if (source === undefined) {
    host.warn(
      '[dsh-a2a-server] 子代理活口不可查（ctx.subagents.listChildren 缺失）：'
        + '释放前不等子代理，回传兜底仍由 dsh-subagent 队列补丁承担',
    )
    return { outcome: 'unavailable', waitedMs: 0, rounds: 0, liveChildren: 0 }
  }

  const ended = new Set<string>()
  let baselineReady = false
  let rounds = 0
  // 全程订阅：等待期间（含卡在 whenIdle() 里）到达的信号必须被记账，否则「结算后又被
  // 冷恢复」的子代理会被漏判为已结束。pending 标志避免丢唤醒（信号早于 waitForSignal 到达）。
  let pendingSignal = false
  const unsubscribe = host.subscribe((signal) => {
    applySignal(ended, signal)
    pendingSignal = true
  })

  const readKnown = async (): Promise<string[] | undefined> => {
    try {
      return continuableChildIds(await source.listChildren(parentSessionId))
    } catch (error) {
      host.warn(
        '[dsh-a2a-server] 读取子代理目录失败，本次请求不等待子代理：'
          + `${(error as Error)?.message ?? String(error)}`,
      )
      return undefined
    }
  }

  try {
    for (;;) {
      await agent.whenIdle()
      const known = await readKnown()
      // 到此为止到达的信号都已被本次目录快照 + ended 集合吸收，清掉唤醒标志
      pendingSignal = false
      if (known === undefined) {
        return { outcome: 'unavailable', waitedMs: host.now() - started, rounds, liveChildren: 0 }
      }
      if (!baselineReady) {
        // 基线：进入等待时仍在本进程注册表内的 continuable 子代理才算「活跃」。
        baselineReady = true
        for (const id of known) if (!host.isChildResident(id)) ended.add(id)
      }
      const live = liveChildIds(known, ended)
      if (live.length === 0) {
        // 双检：拿一次新的 idle 边界与目录快照，收窄「刚投递尚未 claim」的竞态。
        await agent.whenIdle()
        const again = await readKnown()
        if (again === undefined) {
          return { outcome: 'unavailable', waitedMs: host.now() - started, rounds, liveChildren: 0 }
        }
        if (liveChildIds(again, ended).length === 0) {
          return { outcome: 'quiesced', waitedMs: host.now() - started, rounds, liveChildren: 0 }
        }
        continue
      }
      rounds += 1
      const remaining = capMs - (host.now() - started)
      if (remaining <= 0) {
        return { outcome: 'cap', waitedMs: host.now() - started, rounds, liveChildren: live.length }
      }
      // 目录快照之后、进入等待之前到达的信号 → 立即重判，避免丢唤醒后空等到超时
      if (pendingSignal) continue
      await host.waitForSignal(remaining)
    }
  } finally {
    unsubscribe()
  }
}

/**
 * src/settle.ts 的纯 stdlib 单测（node:test + node:assert/strict，无新框架）。
 *
 * 运行：`pnpm test`（先 `pnpm run build:host` 产出 lib/settle.js 再跑）。
 *
 * 覆盖「释放 Lead 前等活跃 continuable 子代理结算」这一等待原语：
 *  - 目录行解析（只认 mode==='continuable'、去重、跳过坏行）；
 *  - 活跃集合折返（基线 + end/start 增量）；
 *  - 四种出口：quiesced / cap / disabled / unavailable；
 *  - 事件驱动而非忙轮询：每轮只等一个信号（`waitForSignal` 调用次数 == 轮数）；
 *  - **不丢唤醒**：信号在 `whenIdle()` 期间到达（结算后又被冷恢复）也必须被记账，
 *    否则会把「正在跑的子代理」误判为已结束而提前释放。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applySignal,
  continuableChildIds,
  liveChildIds,
  waitForSubagentQuiescence,
} from '../lib/settle.js'

/**
 * 可控宿主：脚本化信号 + 可控时钟 + 可改写目录。
 * `deliver()` 模拟事件到达（`subscribe` 回调立即执行，并唤醒等待者）。
 */
function makeHost(options = {}) {
  const clock = { value: 0 }
  const warnings = []
  const state = {
    rows: options.rows ?? [],
    residents: new Set(options.residents ?? []),
    signals: [...(options.signals ?? [])],
    throwsOnList: options.throwsOnList ?? false,
  }
  let handler
  let waiter
  let waitCalls = 0
  const deliver = (signal) => {
    handler?.(signal)
    const woken = waiter
    waiter = undefined
    woken?.()
  }
  const host = {
    ...(options.noSource === true
      ? {}
      : {
          subagentChildren: {
            listChildren: async () => {
              if (state.throwsOnList) throw new Error('subagent control query unavailable')
              return state.rows
            },
          },
        }),
    isChildResident: (childId) => state.residents.has(childId),
    subscribe: (onSignal) => {
      handler = onSignal
      return () => {
        handler = undefined
      }
    },
    waitForSignal: (timeoutMs) => {
      waitCalls += 1
      const next = state.signals.shift()
      if (next !== undefined) {
        queueMicrotask(() => deliver(next))
        return Promise.resolve()
      }
      // 无信号 = 等到超时：把时钟推进 timeoutMs（真实实现里就是 setTimeout 到点）
      clock.value += timeoutMs
      return Promise.resolve()
    },
    now: () => clock.value,
    warn: (message) => warnings.push(message),
  }
  return { host, state, clock, warnings, deliver, waitCalls: () => waitCalls }
}

function makeAgent(onIdle) {
  const calls = { whenIdle: 0 }
  return {
    calls,
    agent: {
      whenIdle: async () => {
        calls.whenIdle += 1
        onIdle?.(calls.whenIdle)
      },
    },
  }
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------
test('continuableChildIds: 只认 continuable、去重、跳过坏行', () => {
  const rows = [
    { id: 'a', mode: 'continuable' },
    { id: 'b', mode: 'one-shot' },
    { id: 'a', mode: 'continuable' },
    { id: 'c', mode: 'continuable' },
    null,
    'nope',
    { mode: 'continuable' },
    { id: '', mode: 'continuable' },
  ]
  assert.deepEqual(continuableChildIds(rows), ['a', 'c'])
  assert.deepEqual(continuableChildIds(undefined), [])
  assert.deepEqual(continuableChildIds('not-array'), [])
})

test('liveChildIds / applySignal: end 移出、start 复位（冷恢复是新 epoch）', () => {
  const ended = new Set()
  assert.deepEqual(liveChildIds(['a', 'b'], ended), ['a', 'b'])
  applySignal(ended, { kind: 'end', childId: 'a' })
  assert.deepEqual(liveChildIds(['a', 'b'], ended), ['b'])
  applySignal(ended, { kind: 'start', childId: 'a' })
  assert.deepEqual(liveChildIds(['a', 'b'], ended), ['a', 'b'])
  applySignal(ended, undefined)
  applySignal(ended, { kind: 'end' })
  assert.deepEqual(liveChildIds(['a', 'b'], ended), ['a', 'b'])
})

// ---------------------------------------------------------------------------
// 出口：disabled / unavailable / 立即 quiesced
// ---------------------------------------------------------------------------
test('settleCapMs=0 → disabled，不等待也不查目录', async () => {
  const { host } = makeHost({ rows: [{ id: 'a', mode: 'continuable' }], residents: ['a'] })
  const { agent, calls } = makeAgent()
  const outcome = await waitForSubagentQuiescence(host, agent, 'lead', 0)
  assert.equal(outcome.outcome, 'disabled')
  assert.equal(outcome.waitedMs, 0)
  assert.equal(calls.whenIdle, 0)
})

test('控制面缺失（0.1.5 / 未装 dsh-subagent）→ unavailable + 告警', async () => {
  const { host, warnings } = makeHost({ noSource: true })
  const { agent } = makeAgent()
  const outcome = await waitForSubagentQuiescence(host, agent, 'lead', 60_000)
  assert.equal(outcome.outcome, 'unavailable')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /listChildren/)
})

test('目录查询失败 → unavailable（不静默、不误判为已静默）', async () => {
  const { host, warnings } = makeHost({ throwsOnList: true })
  const { agent } = makeAgent()
  const outcome = await waitForSubagentQuiescence(host, agent, 'lead', 60_000)
  assert.equal(outcome.outcome, 'unavailable')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /读取子代理目录失败/)
})

test('无子代理（空目录）→ 立即 quiesced，不进入等待', async () => {
  const { host, waitCalls } = makeHost({ rows: [] })
  const { agent, calls } = makeAgent()
  const outcome = await waitForSubagentQuiescence(host, agent, 'lead', 60_000)
  assert.equal(outcome.outcome, 'quiesced')
  assert.equal(outcome.rounds, 0)
  assert.equal(waitCalls(), 0)
  assert.equal(calls.whenIdle, 2, '退出前双检（两次 idle 边界）')
})

test('历史已结算的子代理（目录有、不在册）→ 视为不活跃，不等', async () => {
  const { host, waitCalls } = makeHost({
    rows: [
      { id: 'old-1', mode: 'continuable' },
      { id: 'old-2', mode: 'continuable' },
    ],
    residents: [],
  })
  const { agent } = makeAgent()
  const outcome = await waitForSubagentQuiescence(host, agent, 'lead', 60_000)
  assert.equal(outcome.outcome, 'quiesced')
  assert.equal(waitCalls(), 0)
})

test('one-shot 子代理不计入（不会回传，不等）', async () => {
  const { host, waitCalls } = makeHost({
    rows: [{ id: 'oneshot', mode: 'one-shot' }],
    residents: ['oneshot'],
  })
  const { agent } = makeAgent()
  const outcome = await waitForSubagentQuiescence(host, agent, 'lead', 60_000)
  assert.equal(outcome.outcome, 'quiesced')
  assert.equal(waitCalls(), 0)
})

// ---------------------------------------------------------------------------
// 主路：等活跃子代理结算
// ---------------------------------------------------------------------------
test('活跃子代理结算后 → quiesced（事件驱动，一轮）', async () => {
  const { host, clock, waitCalls } = makeHost({
    rows: [{ id: 'a', mode: 'continuable' }],
    residents: ['a'],
    signals: [{ kind: 'end', childId: 'a' }],
  })
  const { agent, calls } = makeAgent()
  const outcome = await waitForSubagentQuiescence(host, agent, 'lead', 60_000)
  assert.equal(outcome.outcome, 'quiesced')
  assert.equal(outcome.rounds, 1)
  assert.equal(waitCalls(), 1, '每轮只等一个信号（事件驱动，非忙轮询）')
  assert.equal(calls.whenIdle >= 3, true, '等待前 + 每轮 + 双检都建立 idle 边界')
  assert.equal(clock.value, 0, '信号即时到达，不应消耗时间')
})

test('子代理回传唤醒的新回合被等到，且该轮新派生的子代理不遗漏', async () => {
  const { host, waitCalls } = makeHost({
    residents: ['a'],
    signals: [
      { kind: 'end', childId: 'a' },
      { kind: 'end', childId: 'b' },
    ],
  })
  let reads = 0
  host.subagentChildren = {
    listChildren: async () => {
      reads += 1
      if (reads === 1) return [{ id: 'a', mode: 'continuable' }]
      return [
        { id: 'a', mode: 'continuable' },
        { id: 'b', mode: 'continuable' },
      ]
    },
  }
  const { agent } = makeAgent()
  const outcome = await waitForSubagentQuiescence(host, agent, 'lead', 60_000)
  assert.equal(outcome.outcome, 'quiesced')
  assert.equal(outcome.rounds, 2, 'a 与 b 各等一轮')
  assert.equal(waitCalls(), 2)
  assert.ok(reads >= 3, `目录至少读三轮（含双检）：${reads}`)
})

test('不丢唤醒：信号在 whenIdle() 期间到达（冷恢复）也计入，不提前放行', async () => {
  // 第 1 轮：a 活跃 → 等到 end(a)。此时回传唤醒 Lead，新回合冷恢复 a（start(a)）——
  // 该信号在下一轮 whenIdle() 期间到达，必须被记账（撤销 a 的结束标记），否则会误判静默。
  const { host, deliver, waitCalls } = makeHost({
    rows: [{ id: 'a', mode: 'continuable' }],
    residents: ['a'],
    signals: [{ kind: 'end', childId: 'a' }, { kind: 'end', childId: 'a' }],
  })
  const { agent } = makeAgent((call) => {
    if (call === 2) deliver({ kind: 'start', childId: 'a' })
  })
  const outcome = await waitForSubagentQuiescence(host, agent, 'lead', 60_000)
  assert.equal(outcome.outcome, 'quiesced')
  assert.equal(outcome.rounds, 2, 'end(a) → start(a) 复活 → 再 end(a)，共两轮')
  assert.equal(waitCalls(), 2)
})

test('子代理卡死 → 到上限回落 cap，并报告仍活跃数量', async () => {
  const { host, clock } = makeHost({
    rows: [
      { id: 'a', mode: 'continuable' },
      { id: 'b', mode: 'continuable' },
    ],
    residents: ['a', 'b'],
    // 无信号：每次等待都超时，时钟按 timeoutMs 前进
  })
  const { agent } = makeAgent()
  const outcome = await waitForSubagentQuiescence(host, agent, 'lead', 5000)
  assert.equal(outcome.outcome, 'cap')
  assert.equal(outcome.liveChildren, 2)
  assert.ok(outcome.waitedMs >= 5000, `waitedMs=${outcome.waitedMs}`)
  assert.ok(clock.value >= 5000)
})

test('上限在等待中耗尽 → cap（不无限等）', async () => {
  const { host, clock } = makeHost({
    rows: [{ id: 'a', mode: 'continuable' }],
    residents: ['a'],
  })
  const { agent } = makeAgent()
  const outcome = await waitForSubagentQuiescence(host, agent, 'lead', 1000)
  assert.equal(outcome.outcome, 'cap')
  assert.equal(outcome.liveChildren, 1)
  assert.ok(clock.value >= 1000)
})

test('每轮等待只挂一次信号（禁止忙轮询）', async () => {
  const signals = Array.from({ length: 5 }, (_, i) => ({ kind: 'end', childId: `c${i}` }))
  const { host, waitCalls } = makeHost({
    rows: signals.map((s) => ({ id: s.childId, mode: 'continuable' })),
    residents: signals.map((s) => s.childId),
    signals,
  })
  const { agent } = makeAgent()
  const outcome = await waitForSubagentQuiescence(host, agent, 'lead', 60_000)
  assert.equal(outcome.outcome, 'quiesced')
  assert.equal(outcome.rounds, 5)
  assert.equal(waitCalls(), 5, 'waitForSignal 调用次数必须等于轮数（没有空转重试）')
})

test('退出时必然退订（不留悬挂 listener）', async () => {
  const { host } = makeHost({ rows: [] })
  let unsubscribed = 0
  const original = host.subscribe
  host.subscribe = (onSignal) => {
    const off = original(onSignal)
    return () => {
      unsubscribed += 1
      off()
    }
  }
  const { agent } = makeAgent()
  await waitForSubagentQuiescence(host, agent, 'lead', 60_000)
  assert.equal(unsubscribed, 1)
})

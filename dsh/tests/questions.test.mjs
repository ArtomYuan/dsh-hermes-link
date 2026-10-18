/**
 * src/questions.ts（§2.6 问答桥接纯逻辑面）的单测：node:test + node:assert/strict，无新框架。
 *
 * 运行：`pnpm test`（先 build:host 产出 lib/questions.js 再跑）。
 *
 * 覆盖桥接里最容易悄悄坏掉的三件事：
 *  - **载荷形状**：桥靠 `question` 事件建卡，形状漂了卡片就发不出去；
 *  - **解挂严格性**：askId 精确命中优先，异常令牌响亮报警且不误答；
 *  - **不悬挂**：只认「作答 / 中止 / 任务收场」三种出口，任何一种都放行（零超时硬约束）。
 * SDK 侧的 input-required → taskId 续投契约由 tests/qna-continuation.test.mjs 实证。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  abandonQuestions,
  claimQuestion,
  continuationDisposition,
  pendingQuestionCount,
  readQuestionAnswer,
  resolveQuestion,
  toQuestionItems,
} from '../lib/questions.js'

/** 记录发布事件的假总线（claimQuestion 只用到 publish） */
function fakeBus() {
  const events = []
  return { events, publish: (event) => events.push(event) }
}

/** 取事件里的 data part 载荷 */
function dataPartOf(event, index = 0) {
  return event?.data?.artifact?.parts?.[index]?.content?.value
}

const OWNED = { taskId: 'task-1', contextId: 'ctx-1' }

test('toQuestionItems · 规范化：丢弃残缺项、保留选项与多选、不塞空键', () => {
  assert.deepEqual(toQuestionItems(undefined), [])
  assert.deepEqual(toQuestionItems('nope'), [])
  assert.deepEqual(toQuestionItems([null, 42, {}, { id: 'a' }, { question: 'q' }]), [])

  const items = toQuestionItems([
    {
      id: 'q1',
      question: '选哪个？',
      header: 'Confirm',
      detail: '细节',
      multi_select: true,
      options: [
        { label: '甲', description: '一句话' },
        { label: '' },
        { description: '缺 label' },
        'junk',
      ],
    },
    { id: 'q2', question: '还有吗？', multiSelect: true },
  ])

  assert.equal(items.length, 2)
  assert.deepEqual(items[0], {
    id: 'q1',
    question: '选哪个？',
    header: 'Confirm',
    detail: '细节',
    options: [{ label: '甲', description: '一句话' }],
    multiSelect: true,
  })
  assert.deepEqual(items[1], { id: 'q2', question: '还有吗？', multiSelect: true })
  // 空键纪律：缺省字段不得被塞成 undefined/空串
  assert.deepEqual(Object.keys(items[1]), ['id', 'question', 'multiSelect'])
})

test('claimQuestion · 载荷与流形状：question 事件 + INPUT_REQUIRED 挂起', async () => {
  const bus = fakeBus()
  const promise = claimQuestion(
    { ...OWNED, eventBus: bus },
    [{ id: 'q1', question: '走不走？', options: [{ label: '走' }, { label: '不走' }] }],
    undefined,
  )
  assert.equal(pendingQuestionCount('task-1'), 1)

  assert.equal(bus.events.length, 2)
  const [questionEvent, statusEvent] = bus.events
  assert.equal(questionEvent.kind, 'artifactUpdate')
  const payload = dataPartOf(questionEvent)
  assert.equal(payload.kind, 'question')
  assert.equal(payload.taskId, 'task-1')
  assert.equal(payload.contextId, 'ctx-1')
  assert.equal(typeof payload.askId, 'string')
  assert.ok(payload.askId.length > 0)
  assert.deepEqual(payload.questions[0].options, [{ label: '走' }, { label: '不走' }])

  // 首条流收束信号：INPUT_REQUIRED（A2A 枚举值 6），状态消息里带同一载荷
  assert.equal(statusEvent.kind, 'statusUpdate')
  assert.equal(statusEvent.data.status.state, 6)
  const statusParts = statusEvent.data.status.message.parts
  assert.equal(statusParts[0].content.value.askId, payload.askId)
  assert.match(statusParts[1].content.value, /走不走？/)

  // 命中 askId 解挂
  const answers = [{ id: 'q1', selected: ['走'] }]
  assert.equal(resolveQuestion('task-1', { askId: payload.askId, answers }), true)
  assert.deepEqual(await promise, answers)
  assert.equal(pendingQuestionCount('task-1'), 0)
})

test('resolveQuestion · 严格性：askId 不匹配只报警不放行，settle 只生效一次', async () => {
  const bus = fakeBus()
  let settledWith
  const promise = claimQuestion({ ...OWNED, eventBus: bus }, [{ id: 'q1', question: '?' }], undefined)
  promise.then((v) => { settledWith = v }, () => { settledWith = 'rejected' })
  const askId = dataPartOf(bus.events[0]).askId

  // 异常令牌：响亮报警 + 不解挂
  assert.equal(resolveQuestion('task-1', { askId: 'wrong-ask', answers: [{ id: 'q1', selected: ['x'] }] }), false)
  assert.equal(pendingQuestionCount('task-1'), 1)
  await Promise.resolve()
  assert.equal(settledWith, undefined, '异常令牌不得解开提问')

  // 正确令牌：解挂
  assert.equal(resolveQuestion('task-1', { askId, answers: [{ id: 'q1', selected: ['甲'] }] }), true)
  assert.deepEqual(await promise, [{ id: 'q1', selected: ['甲'] }])

  // 幂等：再解一次不得二次生效、也不得报成功
  assert.equal(resolveQuestion('task-1', { askId, answers: [{ id: 'q1', selected: ['乙'] }] }), false)
})

test('resolveQuestion · 降级：唯一未决提问时允许无 askId 命中（响亮报警）', async () => {
  const bus = fakeBus()
  const promise = claimQuestion({ ...OWNED, eventBus: bus }, [{ id: 'q1', question: '?' }], undefined)
  assert.equal(resolveQuestion('task-1', { answers: [{ id: 'q1', selected: ['甲'] }] }), true)
  assert.deepEqual(await promise, [{ id: 'q1', selected: ['甲'] }])
})

test('resolveQuestion · 跳过：如实以中止收口，不伪造空作答', async () => {
  const bus = fakeBus()
  const promise = claimQuestion({ ...OWNED, eventBus: bus }, [{ id: 'q1', question: '?' }], undefined)
  const askId = dataPartOf(bus.events[0]).askId
  assert.equal(resolveQuestion('task-1', { askId, answers: [], skipped: true }), true)
  await assert.rejects(promise, /skipped the question/)
  assert.equal(pendingQuestionCount('task-1'), 0)
})

test('claimQuestion · 零悬挂：中止信号与任务收场都必须放行', async () => {
  // ① 中止
  const bus = fakeBus()
  const controller = new AbortController()
  const aborted = claimQuestion({ ...OWNED, eventBus: bus }, [{ id: 'q1', question: '?' }], controller.signal)
  controller.abort()
  await assert.rejects(aborted, /aborted before the user answered/)
  assert.equal(pendingQuestionCount('task-1'), 0)

  // ② 已在就位前中止
  const bus2 = fakeBus()
  const preAborted = new AbortController()
  preAborted.abort()
  await assert.rejects(
    claimQuestion({ taskId: 'task-2', contextId: 'ctx-1', eventBus: bus2 }, [{ id: 'q1', question: '?' }], preAborted.signal),
    /aborted before the user answered/,
  )
  assert.equal(pendingQuestionCount('task-2'), 0)

  // ③ 任务收场
  const bus3 = fakeBus()
  const pending = claimQuestion({ taskId: 'task-3', contextId: 'ctx-1', eventBus: bus3 }, [{ id: 'q1', question: '?' }], undefined)
  abandonQuestions('task-3')
  await assert.rejects(pending, /task ended before the user answered/)
  assert.equal(pendingQuestionCount('task-3'), 0)

  // ④ 无未决提问时放弃是安静的 no-op
  abandonQuestions('task-404')
  assert.equal(pendingQuestionCount('task-404'), 0)
})

test('continuationDisposition · 续投三态判定（误用分支因此可单测）', () => {
  const answer = { askId: 'a', answers: [{ id: 'q1', selected: ['甲'] }] }
  assert.equal(continuationDisposition(answer, 0), 'answer')
  assert.equal(continuationDisposition(answer, 3), 'answer', '带了作答载荷就是 answer，与未决数无关')
  assert.equal(continuationDisposition(undefined, 1), 'input-required', '没载荷但正等作答 → 明确收束')
  assert.equal(continuationDisposition(undefined, 0), 'plain', '没载荷也没等答 → 普通续投')
  assert.equal(continuationDisposition({ answers: [], skipped: true }, 0), 'answer', 'skip 也走 answer 路径（由 resolveQuestion 以中止收口）')
})

test('readQuestionAnswer · 只认 question-answer data part，text part 不解析', () => {
  const textPart = { content: { $case: 'text', value: '{"kind":"question-answer"}' } }
  const answerPart = {
    content: {
      $case: 'data',
      value: {
        kind: 'question-answer',
        askId: 'ask-9',
        answers: [{ id: 'q1', selected: ['甲', 7], custom: '手输' }, { id: 'q2' }, 'junk', { selected: ['x'] }],
      },
    },
  }
  assert.equal(readQuestionAnswer(undefined), undefined)
  assert.equal(readQuestionAnswer({ parts: [textPart] }), undefined)
  assert.deepEqual(readQuestionAnswer({ parts: [textPart, answerPart] }), {
    askId: 'ask-9',
    answers: [{ id: 'q1', selected: ['甲'], custom: '手输' }, { id: 'q2', selected: [] }],
  })
  // 跳过标记：只认显式 true，且与作答一并解析
  const skipPart = {
    content: { $case: 'data', value: { kind: 'question-answer', askId: 'ask-skip', answers: [], skipped: true } },
  }
  assert.deepEqual(readQuestionAnswer({ parts: [skipPart] }), { askId: 'ask-skip', answers: [], skipped: true })
  const falsySkip = {
    content: { $case: 'data', value: { kind: 'question-answer', answers: [], skipped: 'yes' } },
  }
  assert.deepEqual(readQuestionAnswer({ parts: [falsySkip] }), { answers: [] })

  // 无 askId 的合法载荷：仍可解析（由 resolveQuestion 决定是否降级命中）
  const noAsk = { content: { $case: 'data', value: { kind: 'question-answer', answers: [{ id: 'q1', selected: [] }] } } }
  assert.deepEqual(readQuestionAnswer({ parts: [noAsk] }), { answers: [{ id: 'q1', selected: [] }] })
  // 其它 data part（流事件）不得误判为作答
  const streamEvent = { content: { $case: 'data', value: { kind: 'tool_call', name: 'x' } } }
  assert.equal(readQuestionAnswer({ parts: [streamEvent] }), undefined)
})

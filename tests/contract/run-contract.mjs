#!/usr/bin/env node
/**
 * 链路契约（Node/服务端侧）：同一组 fixtures，断言服务端解析结果与协议定义一致。
 *
 * 运行：`node tests/contract/run-contract.mjs`（根 `scripts/test-all.sh` 已含）。
 * 依赖 dsh/lib 的构建产物：先 `cd dsh && node node_modules/.bin/tsdown --config tsdown.prepare.config.ts`。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const FIXTURES = join(ROOT, 'tests', 'contract', 'fixtures')
const PROTOCOL = JSON.parse(readFileSync(join(ROOT, 'protocol', 'link-protocol.json'), 'utf-8'))

const { LINK_PROTOCOL_VERSION, WORKSPACE_META_KEY, SANDBOX_META_KEY, USER_QUESTIONS_META_KEY, SANDBOX_TIERS } =
  await import(join(ROOT, 'dsh', 'lib', 'link-protocol.js'))
const { readRequestOptions } = await import(join(ROOT, 'dsh', 'lib', 'request-options.js'))
const { questionPayload, readQuestionAnswer } = await import(join(ROOT, 'dsh', 'lib', 'questions.js'))

let checks = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    console.error(`FAIL ${label}\n  actual  = ${a}\n  expected= ${e}`)
    process.exit(1)
  }
  checks++
}
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf-8'))

// 0. 协议常量与定义一致（防生成物漂移）
check('protocol.version', LINK_PROTOCOL_VERSION, PROTOCOL.protocolVersion)
check('protocol.wsKey', WORKSPACE_META_KEY, PROTOCOL.metadataKeys.workspace)
check('protocol.sandboxKey', SANDBOX_META_KEY, PROTOCOL.metadataKeys.sandbox)
check('protocol.qnaKey', USER_QUESTIONS_META_KEY, PROTOCOL.metadataKeys.userQuestions)
check('protocol.tiers', [...SANDBOX_TIERS], PROTOCOL.sandboxTiers)

// 1. 请求级选项：桥产出的 metadata → 服务端解析
for (const name of ['request-metadata.json', 'request-metadata-path.json']) {
  const fx = fixture(name)
  check(`${name}: options`, readRequestOptions(fx.metadata), fx.node_options)
}

// 2. 提问载荷：服务端生产函数产出的 data part 必须与桥解析的线上形状逐字一致
{
  const fx = fixture('question-payload.json')
  check('question-payload: payload', questionPayload(fx.ask_id, fx.task_id, fx.context_id, fx.questions), fx.expect_payload)
}

// 3. 作答载荷：服务端从续投 data part 解析出的作答必须与桥产出的逐字一致
{
  const fx = fixture('answer-message.json')
  const message = { parts: [{ content: { $case: 'data', value: fx.expect_data_part } }] }
  check('answer-message: parsed', readQuestionAnswer(message), { askId: fx.ask_id, answers: fx.answers })
}

console.log(`contract(node): OK — ${checks} checks across 5 fixtures`)

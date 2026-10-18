/** A2A ⇄ Hermes 链路协议常量（**生成文件，勿手改**）。
 *
 * 源：protocol/link-protocol.json；重新生成：`python3 protocol/gen.py`。
 * 两端（hermes/ 桥、dsh/ 服务端）共用同一份定义，CI 用 `--check` 防漂移。
 */

export const LINK_PROTOCOL_VERSION = 1
export const A2A_VERSION = "1.0"

export const WORKSPACE_META_KEY = "x-dsh-workspace"
export const SANDBOX_META_KEY = "x-dsh-sandbox"
export const USER_QUESTIONS_META_KEY = "x-dsh-user-questions"

export const SANDBOX_TIERS = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const
export type SandboxTier = (typeof SANDBOX_TIERS)[number]

export const CARD_ACTION_KEY = "hermes_ask_action"
export const CARD_ACTIONS = ["pick", "submit", "skip"] as const

/** 事件类型（桥侧归一化事件 / 服务端流事件描述符共用） */
export const EVENT_TYPES = {
  thinking: "thinking",
  toolCall: "tool_call",
  toolResult: "tool_result",
  turnStart: "turn_start",
  turnEnd: "turn_end",
  text: "text",
  status: "status",
  question: "question",
} as const

/** A2A Data Part 私有载荷 kind */
export const PAYLOAD_KINDS = {
  question: "question",
  questionAnswer: "question-answer",
} as const

/** 提问/作答载荷字段名 */
export const QUESTION_FIELDS = {
  askId: "askId",
  questions: "questions",
  taskId: "taskId",
  contextId: "contextId",
  answers: "answers",
  skipped: "skipped",
  selected: "selected",
  custom: "custom",
} as const

/** 卡片回传值字段名（适配器补丁 ↔ 桥协议） */
export const CARD_VALUE_FIELDS = {
  askAction: "hermes_ask_action",
  askId: "ask_id",
  qid: "qid",
  choice: "choice",
  label: "label",
} as const

export const TERMINAL_TASK_STATES = ["completed", "failed", "canceled"] as const
export const TASK_STATE_PREFIX = "TASK_STATE_"
export const STATUS_REASONS = {"completed": "completed", "failed": "error", "canceled": "aborted"} as const

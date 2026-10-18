"""A2A ⇄ Hermes 链路协议常量（**生成文件，勿手改**）。

源：protocol/link-protocol.json；重新生成：`python3 protocol/gen.py`。
两端（hermes/ 桥、dsh/ 服务端）共用同一份定义，CI 用 `--check` 防漂移。
"""

PROTOCOL_VERSION = 1
A2A_VERSION = "1.0"

METADATA_WORKSPACE = "x-dsh-workspace"
METADATA_SANDBOX = "x-dsh-sandbox"
METADATA_USER_QUESTIONS = "x-dsh-user-questions"

SANDBOX_TIERS = ("read-only", "workspace-write", "danger-full-access",)

CARD_ACTION_KEY = "hermes_ask_action"
CARD_ACTIONS = ("pick", "submit", "skip",)

EVENT_THINKING = "thinking"
EVENT_TOOL_CALL = "tool_call"
EVENT_TOOL_RESULT = "tool_result"
EVENT_TURN_START = "turn_start"
EVENT_TURN_END = "turn_end"
EVENT_TEXT = "text"
EVENT_STATUS = "status"
EVENT_QUESTION = "question"

KIND_QUESTION = "question"
KIND_QUESTION_ANSWER = "question-answer"

FIELD_ASK_ID = "askId"
FIELD_QUESTIONS = "questions"
FIELD_TASK_ID = "taskId"
FIELD_CONTEXT_ID = "contextId"
FIELD_ANSWERS = "answers"
FIELD_SKIPPED = "skipped"
FIELD_SELECTED = "selected"
FIELD_CUSTOM = "custom"
CARD_FIELD_ASK_ACTION = "hermes_ask_action"
CARD_FIELD_ASK_ID = "ask_id"
CARD_FIELD_QID = "qid"
CARD_FIELD_CHOICE = "choice"
CARD_FIELD_LABEL = "label"

TERMINAL_TASK_STATES = ("completed", "failed", "canceled",)
TASK_STATE_PREFIX = "TASK_STATE_"
STATUS_REASONS = {"completed": "completed", "failed": "error", "canceled": "aborted"}

"""dsh-hermes-link — P2c 直播消费者（可独立运行、不经 gateway）.

向 dsh-hermes-link 发 ``SendStreamingMessage``，逐行解析 SSE ``data:`` 事件，
把 ``result.{task|statusUpdate|artifactUpdate}`` 归一化为统一事件序列，再按
dsh 客户端「工作步骤展示」的行形态渲染（组头行 / 步骤行 / 思考行 / 收束行，
无代码框），经节流（高信号逐条放行 / 低信号 text 聚合）与 redact 后发送到
飞书 / QQ 消息面。

渲染基线（v0.7.0 起）：**直播过程与回复一律不再使用代码框 / 围栏**，改为逐行
复刻 dsh 客户端的行结构与图标（见下文「dsh 行渲染」常量区的来源注释）。

wire 格式（dsh-hermes-link, @a2a-js/sdk v1.1.0）
------------------------------------------------
- ``POST http://127.0.0.1:8092/``，JSON-RPC ``method: "SendStreamingMessage"``，
  请求头 ``A2A-Version: 1.0`` + ``Authorization: Bearer <token>``。
- 服务端响应 ``Content-Type: text/event-stream``，每个 SSE 事件是
  ``data: <JSON>\\n\\n``（无 ``event:`` 行）。每个 data 的 JSON 是
  ``{"jsonrpc":"2.0","id":..,"result":{<task|statusUpdate|artifactUpdate>}}``。
- 事件顺序：task(submitted) → statusUpdate(working) → 若干 artifactUpdate
  (text 块 / data 中间事件) → artifactUpdate(最终 Result, lastChunk=true) →
  statusUpdate(completed)。

本模块只用标准库（urllib / json / threading / time / typing），风格仿
``plugins/platforms/a2a/tools.py`` 的 urllib 用法；所有 gateway / redact 依赖都在
函数内惰性 import，失败即降级（warning + 跳过），绝不向调用方抛异常。
"""

from __future__ import annotations

import itertools
import json
import logging
import sys
import time
import urllib.request
import uuid
from typing import Any, Callable, Dict, Iterable, Iterator, Optional

logger = logging.getLogger(__name__)


def _import_qna():
    """惰性 import ``qna`` 模块（§2.6 问答桥接）——**进程内唯一实例**的取用点。

    优先包内相对导入；按文件路径加载（单文件直跑 / 加载器回退）时挂到固定别名
    ``hermes_a2a_bridge.qna`` 上并先查 ``sys.modules``。这一步不是洁癖：qna 持有
    「ask_id → 等待槽位」登记表，若被加载成两份实例，适配器补丁投进来的点击就落不到
    发卡线程等的那个槽位上——表现为"点了没反应、任务永久挂起"。
    """
    global _QNA_MODULE
    if _QNA_MODULE is not None:
        return _QNA_MODULE
    canonical = "hermes_a2a_bridge.qna"
    cached = sys.modules.get(canonical)
    if cached is not None:
        _QNA_MODULE = cached
        return cached
    try:
        from . import qna as _qna
    except (ImportError, ValueError) as exc:
        logger.debug("dsh-hermes-link: relative qna import failed: %s", exc)
        import importlib.util
        import os

        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "qna.py")
        spec = importlib.util.spec_from_file_location(canonical, path)
        _qna = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_qna)
    # 别名兜底：无论从哪条路加载，后续取用都收敛到同一实例
    sys.modules.setdefault(canonical, _qna)
    _QNA_MODULE = _qna
    return _qna


_QNA_MODULE: Any = None

def _load_link_protocol():
    """惰性加载链路协议常量模块（包内相对导入优先；按文件路径加载时回退）。"""
    try:
        from . import link_protocol as _protocol
        return _protocol
    except (ImportError, ValueError):
        import importlib.util
        import os

        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "link_protocol.py")
        spec = importlib.util.spec_from_file_location("hermes_a2a_bridge.link_protocol", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module


_P = _load_link_protocol()

A2A_PROTOCOL_VERSION = _P.A2A_VERSION
# 链路协议版本（两端同号握手用；见 protocol/link-protocol.json）
LINK_PROTOCOL_VERSION = _P.PROTOCOL_VERSION
_DEFAULT_TIMEOUT = 300

# 配置门控常量：collector（直播消费者）默认关。register() 读
# ``plugins.entries.dsh-hermes-link.settings.collector.enabled``，缺省即 False。
DEFAULT_ENABLED = False

# 触发 text 缓冲 flush 的终态（status 终态；turn_end 单独处理）。
_TERMINAL_STATES = frozenset(_P.TERMINAL_TASK_STATES)

# §2.6 问答能力声明键：随首投 message.metadata 带上，服务端据此决定是否认领提问。
QNA_OPT_IN_KEY = _P.METADATA_USER_QUESTIONS

# §2.1/§2.4 请求级选项键：同样走 message.metadata（缺省不带＝现状）。
# 服务端（dsh-hermes-link src/request-options.ts）按同名字面量读取；两侧有用例锁一致。
WORKSPACE_META_KEY = _P.METADATA_WORKSPACE
SANDBOX_META_KEY = _P.METADATA_SANDBOX
# dsh 三档沙箱枚举（本部署 permission-presets 表键与之同名）
SANDBOX_TIERS = _P.SANDBOX_TIERS

# A2A 终态 → dsh ``TurnEndReason``（收束行文案用；对齐 dsh-session 的 reason 并集）。
_STATUS_REASON = dict(_P.STATUS_REASONS)

# --------------------------------------------------------------------------
# dsh 行渲染（v0.7.0）：逐行复刻 dsh 客户端「工作步骤展示」的行形态。
#
# 唯一标准 = 全局安装的 dsh 客户端源码（@deepseek-ai/dsh 0.2.0-rc.2）对过程块的
# 实际渲染；本模块只做「图标 → 字符」「CSS 截断 → 文本截断」两层文本化等效：
#   - dsh-client-ui-chat/lib/client.js
#       processTitle（关闭态组头文案）/ PROCESS_ICONS（活动图标）/
#       ChatGroupSeat（组头行）/ ReasoningRow（思考行）/ TurnProcessNodeView（收束行）/
#       message.think / message.turnProcess.* / duration.*Unit
#   - dsh-client-ui-tool/lib/client.js
#       TOOL_VARIANTS / TOOL_TITLE_KEYS / VARIANT_TITLE_KEYS（工具行标题）/
#       SUMMARY_KEYS / deriveSummary（工具行摘要）
#   - dsh-client-ui-conversation/lib/client.js
#       tool.title.* 中文文案（工具行标题字典）
#   - dsh-client-ui-primitives/lib/index.js
#       DisclosureRow（行前置图标 + 折叠箭头）
#   - dsh-client-ui-chat/lib/client.js POLICIES（四档 → 展示策略）
# --------------------------------------------------------------------------

# dsh 的行首图标是 SVG（无字符），文本层取最近 Unicode 几何字符等效：
_GLYPH_GROUP = "⌄"   # IconChevronDownOutlineRegular：组头行（关闭态组头）
_GLYPH_ROW = "▸"     # 组内行前置标记（IconTriangleRightFillRegular 同形）：步骤行 / 收束行
_GLYPH_THINK = "✦"   # IconThinkOutlineRegular：思考行
_THINK_LABEL = "思考"  # dsh message.think（zh）
_SEP = " · "           # dsh message.turnProcess.separator（组头 label 与 detail 之间）

# 文本层行内截断上限：dsh 用 CSS text-overflow:ellipsis，文本层改用字符截断 + `…`。
# 取 dsh 自己的 ``LIVE_TOOL_DETAIL_MAX_CHARS``（160）作为统一上限。
_ROW_DETAIL_MAX = 160

# 活动种类 → 关闭态中文文案（对齐 dsh message.stepProcess.done.*，逐字）。
_TOOL_KIND_TEXT = {
    "read": "已读取文件",
    "readImage": "已读取图片",
    "search": "已搜索代码",
    "write": "已写入文件",
    "edit": "修改了文件",
    "commands": "执行了命令",
    "code": "运行了代码",
    "webSearch": "已搜索网页",
    "webFetch": "已访问网页",
    "subagents": "已协调子智能体",
    "plan": "更新了计划",
    "questions": "向用户提出了问题",
    "thinking": "已完成分析",
    "tools": "已调用工具",
}

# 桥侧扩展（dsh 无这些工具，按其语义就近归入 subagents；见 ALIGN-FIX.md 修正 3）。
_SUBAGENT_TOOLS = frozenset(
    {"spawn_teammate", "send_message", "wait_agent", "list_agents", "interrupt_agent"}
)

# 「更新计划」类工具（对齐 dsh activity()：todo_write / create_goal / update_goal / get_goal）。
_PLAN_TOOLS = frozenset({"todo_write", "create_goal", "update_goal", "get_goal"})

# --------------------------------------------------------------------------
# 步骤行（dsh ToolRow）：工具变体 → 标题 → 摘要。
# --------------------------------------------------------------------------

# dsh ``TOOL_VARIANTS``（ui-tool/lib/client.js:83）：工具名 → 行变体。
_DSH_TOOL_VARIANTS = {
    "bash": "bash",
    "pwsh": "bash",
    "read": "read",
    "read_image": "read",
    "web_fetch": "read",
    "web_search": "search",
    "grep": "search",
    "glob": "search",
    "write": "write",
    "edit": "edit",
    "run_code": "code",
    "cordis_package_inspect": "read",
    "cordis_runtime_inspect": "read",
    "cordis_run": "others",
    "cordis_stop": "others",
    "cordis_undefine": "others",
}

# dsh ``VARIANT_TITLE_KEYS`` 的中文文案（ui-tool → ui-conversation zh 字典）。
_DSH_VARIANT_TITLES = {
    "search": "搜索",
    "read": "读取",
    "bash": "运行命令",
    "write": "写入",
    "edit": "编辑",
    "code": "代码",
    "others": "工具调用",
}

# dsh ``TOOL_TITLE_KEYS`` 里翻译到中文的工具（含桥侧 Agent Teams 工具，dsh 同名）。
_DSH_TOOL_TITLES = {
    "pwsh": "运行命令",
    "read_image": "读取图片",
    "grep": "搜索文件内容",
    "glob": "查找文件",
    "web_search": "网页搜索",
    "web_fetch": "网页获取",
    "todo_write": "更新任务清单",
    "ask_user_question": "提问",
    "create_goal": "创建目标",
    "get_goal": "查看目标",
    "update_goal": "更新目标",
    "subagent": "创建子智能体",
    "list_agents": "查看子智能体",
    "send_message": "发送消息",
    "interrupt_agent": "中断智能体",
    "spawn_teammate": "创建队友",
    "wait_agent": "等待子智能体",
    "team_task_create": "创建团队任务",
    "team_task_get": "读取团队任务",
    "team_task_update": "更新团队任务",
    "team_task_list": "查看团队任务",
    "job_list": "查看后台任务",
    "job_output": "读取任务输出",
    "job_kill": "取消后台任务",
    "workflow": "运行工作流",
    "ralph": "运行循环工作流",
    "lsp": "查询代码符号",
}

# dsh ``SUMMARY_KEYS``：变体 → 摘要取值键序（``others`` 为空 = 取参数里首个字符串值）。
_DSH_SUMMARY_KEYS = {
    "bash": ("description", "command"),
    "read": ("path", "file_path", "url"),
    "search": ("query", "pattern", "url"),
    "write": ("path", "file_path"),
    "edit": ("path", "file_path"),
    "code": ("description",),
    "others": (),
}


def _new_request_id() -> str:
    """生成一个对 dsh 无意义的 JSON-RPC request id（仅用于回包对齐）。"""
    return f"req-{time.time_ns()}"


def _status_message_text(message: Any) -> str:
    """从状态消息里取文本（A2A ``status.message.parts[].text``，按行拼接）。

    服务端执行失败时 SDK 会合成 ``statusUpdate(FAILED)`` 且把原因放在状态消息的 text
    part 里（如 ``Agent execution error: …``）。**不取它，失败原因就在桥侧被丢弃**，
    线路只看到「任务已结束（失败）——本次无文本输出」。
    """
    if not isinstance(message, dict):
        return ""
    texts: list = []
    for part in message.get("parts") or []:
        if isinstance(part, dict) and isinstance(part.get("text"), str) and part["text"].strip():
            texts.append(part["text"].strip())
    return "\n".join(texts)


def _short_state(state: Any) -> str:
    """``TASK_STATE_WORKING`` -> ``working``（也放行已是小写的状态）。"""
    if not state:
        return ""
    return str(state).replace(_P.TASK_STATE_PREFIX, "").replace("_", "-").lower()


# --------------------------------------------------------------------------
# 1. 流式 client
# --------------------------------------------------------------------------

def parse_sse_lines(lines: Iterable[Any]) -> Iterator[Dict[str, Any]]:
    """解析 SSE 行流，yield 每个 ``data:`` 行的 JSON 对象（JSON-RPC 消息 dict）。

    纯函数：输入可以是行字符串的 iterable，也可以是字节流（``urllib`` 响应的
    file-like 对象，逐行是 bytes）。跳过空行、``:`` 注释行与 ``event:`` 等其它
    字段行；``data:`` 行按 JSON 解析，解析失败只 warning 并跳过，不抛异常。
    """
    for raw in lines:
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", "replace")
        line = raw.rstrip("\r\n")
        if not line:
            continue
        if line.startswith(":"):
            continue
        if not line.startswith("data:"):
            continue
        payload = line[len("data:"):].strip()
        if not payload:
            continue
        try:
            obj = json.loads(payload)
        except (json.JSONDecodeError, ValueError) as exc:
            logger.warning("dsh-hermes-link: bad SSE data line: %s", exc)
            continue
        if isinstance(obj, dict):
            yield obj


def iter_sse_data(
    url: str,
    body: Dict[str, Any],
    headers: Optional[Dict[str, str]],
    timeout: int,
) -> Iterator[Dict[str, Any]]:
    """POST ``body`` 到 ``url``，逐行解析 ``text/event-stream``，yield ``result`` 字典。

    ``headers`` 与 ``Content-Type: application/json`` + ``A2A-Version`` 合并
    （调用方传 ``Authorization: Bearer <token>``）。每个 ``data:`` JSON 是 JSON-RPC
    消息 ``{"jsonrpc","id","result"}``；此处剥离外层，只 yield ``result`` 字典
    （供 ``normalize_events`` 消费）。
    """
    data = json.dumps(body).encode("utf-8")
    merged = {
        "Content-Type": "application/json",
        "A2A-Version": A2A_PROTOCOL_VERSION,
    }
    merged.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=merged, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 (configured dsh peer)
        for envelope in parse_sse_lines(resp):
            result = envelope.get("result")
            if isinstance(result, dict):
                yield result


# --------------------------------------------------------------------------
# 2. 事件归一化
# --------------------------------------------------------------------------

def _normalize_data_part(
    value: Dict[str, Any], last_chunk: bool
) -> Optional[Dict[str, Any]]:
    """把 data Part 的流式事件描述符 ``value`` 归一化为事件 dict（未知 kind 返回 None）。"""
    if not isinstance(value, dict):
        return None
    kind = value.get("kind")
    turn = value.get("turn")
    if kind == _P.EVENT_QUESTION:
        # §2.6：服务端在提问挂起时发的 question 事件；**必须**在上层任何门控之前处理，
        # 否则安静模式下会被跳过、任务永久悬挂（见 consume_stream 的注释）。
        return {
            "type": "question",
            "payload": value,
            "ask_id": value.get("askId", ""),
            "task_id": value.get("taskId", ""),
            "turn": turn,
        }
    if kind == _P.EVENT_THINKING:
        return {"type": "thinking", "text": value.get("text", ""), "turn": turn}
    if kind == _P.EVENT_TOOL_CALL:
        return {
            "type": "tool_call",
            "name": value.get("name", ""),
            "arguments": value.get("arguments", ""),
            "turn": turn,
        }
    if kind == _P.EVENT_TOOL_RESULT:
        return {
            "type": "tool_result",
            "name": value.get("name", ""),
            "text": value.get("text", ""),
            "turn": turn,
        }
    if kind == _P.EVENT_TURN_START:
        return {"type": "turn_start", "turn": turn}
    if kind == _P.EVENT_TURN_END:
        return {"type": "turn_end", "turn": turn, "reason": value.get("reason", "")}
    if kind == "text":
        return {"type": "text", "text": value.get("text", ""), "final": bool(last_chunk)}
    logger.warning("dsh-hermes-link: unknown data-part kind: %r", kind)
    return None


def normalize_events(results: Iterable[Dict[str, Any]]) -> Iterator[Dict[str, Any]]:
    """把 ``iter_sse_data`` 产出的 result 字典序列归一化为统一事件序列。

    每个 result 恰好含三个键之一（``task`` / ``statusUpdate`` / ``artifactUpdate``）；
    artifactUpdate 的每个 part 都处理（文本 part → text 事件；data part 按
    ``value.kind`` → thinking/tool_call/tool_result/turn_start/turn_end 事件）。
    单个 result / part 无法解析时只 warning 并跳过，不影响整体。
    """
    for result in results:
        if not isinstance(result, dict):
            continue

        if "task" in result:
            task = result.get("task")
            state = ""
            if isinstance(task, dict):
                status = task.get("status") or {}
                if isinstance(status, dict):
                    state = _short_state(status.get("state"))
            yield {"type": "status", "state": state or "submitted"}
            continue

        if "statusUpdate" in result:
            su = result.get("statusUpdate")
            state = ""
            message_text = ""
            if isinstance(su, dict):
                status = su.get("status") or {}
                if isinstance(status, dict):
                    state = _short_state(status.get("state"))
                    message_text = _status_message_text(status.get("message"))
            # 只在真有原因时才带 message 键：不带时事件 dict 与升级前逐字一致（既有用例锁定）
            status_event: Dict[str, Any] = {"type": "status", "state": state}
            if message_text:
                status_event["message"] = message_text
            yield status_event
            continue

        if "artifactUpdate" in result:
            au = result.get("artifactUpdate")
            if not isinstance(au, dict):
                continue
            artifact = au.get("artifact") or {}
            parts = artifact.get("parts") or [] if isinstance(artifact, dict) else []
            last_chunk = bool(au.get("lastChunk"))
            for part in parts:
                if not isinstance(part, dict):
                    continue
                # A2A v1.0 Part 的 JSON 序列化用判别字段名（text / data），非 content.$case。
                if "text" in part:
                    yield {
                        "type": "text",
                        "text": part.get("text", ""),
                        "final": last_chunk,
                    }
                elif "data" in part:
                    ev = _normalize_data_part(part.get("data") or {}, last_chunk)
                    if ev is not None:
                        yield ev
                # 其它 part 类型：跳过
            continue

        logger.warning(
            "dsh-hermes-link: unrecognized result keys: %s", sorted(result.keys())
        )


# --------------------------------------------------------------------------
# 3. T0 渲染
# --------------------------------------------------------------------------

def _truncate(text: Any, limit: int) -> str:
    """折叠空白并截断到 ``limit`` 字符（超长时补 ``…``，总长不超过 limit）。"""
    text = " ".join(str(text or "").split())
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"


# 事件流开关默认开（向后兼容：已部署副本不配置即保持推送中间事件）。
DEFAULT_EVENTS = True

# 内容开关默认开（向后兼容：已部署副本不配置即保持现状观感——直播全显）。
DEFAULT_CONTENT = True

# 直播档位（有序，对齐 dsh TRANSCRIPT_VIEW_MODES）。
LIVE_DETAIL_MODES = ("compact", "standard", "detailed", "verbose")

# live_detail 配置默认值（未显式设置且 content 未显式设置 → follow-dsh）。
DEFAULT_LIVE_DETAIL = "follow-dsh"

# follow-dsh 解析失败时的安全回落档位（= Web 默认 detailed，也 = 旧 content=True 观感）。
LIVE_DETAIL_FALLBACK = "detailed"

# dsh 数据根与活动 profile 的默认值（follow-dsh 读取路径）。
DSH_HOME_DEFAULT = "/home/artom/.dsh"
DSH_PROFILE_DEFAULT = "web"

# --------------------------------------------------------------------------
# 卡片渲染（v0.7.2 / plan §4.2 Phase 1）
# --------------------------------------------------------------------------
# collector.card：off（默认，纯文本行 = 终极回退层）/ panel（2.0 折叠卡，一组一块）。
CARD_MODES = ("off", "panel")
DEFAULT_CARD = "off"

# 官方硬限（飞书卡片）：体积 ≤30 KB、元素/组件数 ≤200（plan §2.4，均【直证】）。
# 取十进制 30000 而非 30720，留出编码/换行差异的余量。
_CARD_MAX_BYTES = 30000
_CARD_MAX_ELEMENTS = 200

# 续卡：重复折叠面板标题并标注「续」（plan §4.2 第 4 条）。
_CARD_CONT_MARK = "（续）"

# 纯文本分块 / 简约卡续卡的续接提示（同一常量，文本与卡片两态同源）。
_PLAIN_CONT_MARK = "⏩ 续"

# 简约卡族（v0.7.3）：决定 ``element_id`` 前缀，仅用于卡内唯一性与排障可读。
#   n = 叙述卡（低信号 text 累积后的叙述）/ f = 直播路径的 final 文本
#   t = 收束小卡（turn_end / 终态 status 的收束行）/ r = 结果卡（📬 头行 + 正文）
_CARD_FAMILY_NARRATIVE = "n"
_CARD_FAMILY_FINAL = "f"
_CARD_FAMILY_CLOSER = "t"
_CARD_FAMILY_RESULT = "r"

# 面板标题前缀图标（`standard_icon`）。
# 2026-10-12 启用：`down-small-ccm_outlined` 经真机实测（T1/T2 通过）可用；
# 位置/旋转角与实测探头同参数（icon_position="right"、展开旋转 -180）。
# 标题文本里的 `⌄` 锚点保留（与文本版逐字同源，V3 对拍不变）。
_CARD_PANEL_ICON_TOKEN: Optional[str] = "down-small-ccm_outlined"

_CARD_ROW_TEXT_SIZE = "notation"  # 面板内成员行字号：notation = 辅助信息 12px（【直证】）


class CardMessage(str):
    """一条「文本回退层 + 可选卡片」的外发件。

    是 ``str`` 子类（内容为文本版渲染结果），因此：
    - 既有「按文本比对」的断言/消费方**完全不受影响**（``card`` 缺省为 ``None``）；
    - 卡片模式下另带 ``card`` 字段，发送层优先发卡、失败回落本字符串。
    """

    __slots__ = ("card",)

    def __new__(cls, text: str, card: Optional[Dict[str, Any]] = None) -> "CardMessage":
        obj = super().__new__(cls, text)
        obj.card = card
        return obj


def _card_bytes(card: Dict[str, Any]) -> int:
    """卡片的 UTF-8 JSON 字节数（官方 ≤30 KB 口径）。"""
    return len(json.dumps(card, ensure_ascii=False).encode("utf-8"))


def _card_element_count(card: Dict[str, Any]) -> int:
    """递归统计带 ``tag`` 的组件/元素个数（官方 ≤200 口径）。"""
    total = 0
    stack: list = [card]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            if "tag" in node:
                total += 1
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
    return total


def _split_plain_chunks(
    content: str, limit: int = 8000, marker: str = _PLAIN_CONT_MARK
) -> list:
    """把长纯文本按换行边界分块，块间追加 ``marker`` 提示。

    v0.7.0 起直播与结果送达两条路径的正文都不再含代码框，本函数是文本回退层唯一的分块
    入口：只需保证每块 ≤ ``limit`` 且块间有分隔提示。卡片态的分块出口是
    ``split_plain_card_chunks``（按 30 KB / 200 元素预算，续接提示同源）。
    """
    if len(content) <= limit:
        return [content]

    chunks: list = []
    cur: list = []
    for line in content.split("\n"):
        cur.append(line)
        if sum(len(l) + 1 for l in cur) >= limit:
            chunks.append("\n".join(cur) + f"\n{marker}")
            cur = []
    if cur:
        chunks.append("\n".join(cur))
    return [c for c in chunks if c.strip()] or [content]


def _is_final_event(event: Dict[str, Any]) -> bool:
    """判断事件是否为「最终结果」：final 文本或终态 status（安静模式下仍推送）。"""
    etype = event.get("type")
    if etype == "text" and event.get("final"):
        return True
    if etype == "status" and event.get("state") in _TERMINAL_STATES:
        return True
    return False


def tool_activity_kind(name: Any) -> str:
    """把工具名映射为活动种类（对齐 dsh ``activity()`` 原表，见 ALIGN-FIX.md 修正 3）。

    映射：``read``→read、``read_image``→readImage、``grep``/``glob``/``*_inspect``→search、
    ``write``→write、``edit``/``apply_patch``→edit、``bash``/``pwsh``/``exec_command``/
    ``write_stdin``/``terminal_*``→commands、``run_code``→code、``web_search``→webSearch、
    ``web_fetch``→webFetch、``subagent``/``subagent_*``→subagents、``todo_write``/
    ``create_goal``/``update_goal``/``get_goal``→plan、``ask_user_question``/
    ``request_user_input``→questions，其它→tools（兜底）。

    桥侧扩展（dsh 无这些工具）：``spawn_teammate`` / ``send_message`` / ``wait_agent`` /
    ``list_agents`` / ``interrupt_agent`` / ``team_task_*`` → subagents。

    @param name - tool_call / tool_result 事件的 ``name``。
    @returns 活动种类 kind。
    """
    n = str(name or "").strip()
    if n == "read":
        return "read"
    if n == "read_image":
        return "readImage"
    if n in ("grep", "glob") or n.endswith("_inspect"):
        return "search"
    if n == "write":
        return "write"
    if n in ("edit", "apply_patch"):
        return "edit"
    if n in ("bash", "pwsh", "exec_command", "write_stdin") or n.startswith("terminal_"):
        return "commands"
    if n == "run_code":
        return "code"
    if n == "web_search":
        return "webSearch"
    if n == "web_fetch":
        return "webFetch"
    if n == "subagent" or n.startswith("subagent_"):
        return "subagents"
    if n in _PLAN_TOOLS:
        return "plan"
    if n in ("ask_user_question", "request_user_input"):
        return "questions"
    # 桥侧扩展（dsh 无这些工具，就近归入 subagents）。
    if n.startswith("team_task_") or n in _SUBAGENT_TOOLS:
        return "subagents"
    return "tools"


def group_title(kinds: Iterable[str]) -> str:
    """合成关闭态组头文案，逐字对齐 dsh ``processTitle``（ui-chat/lib/client.js:1820-1836）。

    dsh 先把种类按**去重后的出现次数降序**排（稳定排序，次数相同时保留首次出现顺序），
    再取前 3 类拼标题：

    - 1 类 → 该类的 ``done.*`` 文案；
    - 2 类 → ``{first}并{second}``，当两段都以「已」开头时第二段去掉「已」；
    - 3 类 → ``，`` 连接（不去「已」）；
    - >3 类 → 取前 3 类用 ``，`` 连接后追加 ``等``（不带计数）；
    - 空序列 → ``已完成分析``（对齐 dsh ``processTitle`` 空 counts 的兜底）。

    未知 kind 退化为 ``tools`` 文案（dsh 的 ``activity()`` 不会产出未知 kind）。

    @param kinds - 活动种类序列（可重复；函数内部按次数排序）。
    @returns 关闭态组头文本（不含 ``⌄`` 前缀）。
    """
    counts: Dict[str, int] = {}
    for kind in kinds:
        if kind:
            counts[kind] = counts.get(kind, 0) + 1
    ranked = sorted(counts.items(), key=lambda item: -item[1])
    labels = [_TOOL_KIND_TEXT.get(k, _TOOL_KIND_TEXT["tools"]) for k, _ in ranked]
    if not labels:
        return _TOOL_KIND_TEXT["thinking"]
    if len(labels) == 1:
        return labels[0]
    if len(labels) == 2:
        first, second = labels[0], labels[1]
        if first.startswith("已") and second.startswith("已"):
            second = second[1:]
        return f"{first}并{second}"
    title = "，".join(labels[:3])
    if len(labels) > 3:
        title += "等"
    return title


# 步骤行 / 思考行的排版常量（v0.7.0：无代码框，全部按 dsh 行形态逐行输出）。
# 档位 → 成员行密度对齐 dsh ``POLICIES``（ui-chat/lib/client.js:12100-12125）：
#   compact  stepGrouping=collapsed + settledReasoningPreview=false → 只出组头 + 「思考」标签；
#   standard stepGrouping=collapsed + settledReasoningPreview=true  → 组头 + 步骤行 + 思考预览；
#   detailed stepGrouping=history                                  → 同 standard，另出工具结果体（展开体等效）；
#   verbose  stepGrouping=none                                     → 不出组头，步骤行 + 思考全文 + 结果全文。
_MEMBER_MODES = ("standard", "detailed", "verbose")   # 出步骤行的档位
_BODY_MODES = ("detailed", "verbose")                 # 出工具结果体（dsh 展开体等效）的档位
_BODY_INDENT = "  "                                   # 展开体缩进（dsh thinkBody / 卡片体左侧内边距）


def _argument_object(arguments: Any) -> Optional[Dict[str, Any]]:
    """把 tool_call 的 ``arguments`` 解析为 dict（dsh ``parseArgs`` 的等价物）。

    dsh 侧 ``argsRaw`` 是 JSON 字符串，``JSON.parse`` 失败即「无参数」；本模块的
    ``arguments`` 可能是已解析的 dict（a2a-server 直传）或原始字符串，两者都接受。
    """
    if isinstance(arguments, dict):
        return arguments
    if not isinstance(arguments, str):
        return None
    text = arguments.strip()
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return None
    return data if isinstance(data, dict) else None


def _first_line(text: Any) -> str:
    """取首行（dsh ``firstLine``）。"""
    value = str(text or "")
    newline = value.find("\n")
    return value if newline == -1 else value[:newline]


def _pick_string(data: Dict[str, Any], keys: Iterable[str]) -> Optional[str]:
    """按序取第一个非空字符串值（dsh ``pickString``）。"""
    for key in keys:
        value = data.get(key)
        if isinstance(value, str) and value != "":
            return value
    return None


def dsh_tool_variant(name: Any) -> str:
    """工具名 → dsh 行变体（``TOOL_VARIANTS``，未知回落 ``others``）。"""
    return _DSH_TOOL_VARIANTS.get(str(name or "").strip(), "others")


def dsh_tool_title(name: Any) -> str:
    """工具名 → dsh 行标题（``TOOL_TITLE_KEYS`` 优先，否则变体标题）。

    返回 ``tool.title.generic`` 的中文时，调用方需按 dsh 的做法补工具名前缀
    （``toolRowModel``：``[generic ? toolName : "", base].join(" · ")``）。
    """
    tool = str(name or "").strip()
    if tool in _DSH_TOOL_TITLES:
        return _DSH_TOOL_TITLES[tool]
    return _DSH_VARIANT_TITLES[dsh_tool_variant(tool)]


def dsh_tool_summary(name: Any, arguments: Any) -> str:
    """工具行摘要，逐字对齐 dsh ``toolRowModel`` 的 ``summary``（ui-tool/lib/client.js:273-286）。

    ``base`` 来自 ``deriveSummary``（ui-tool/lib/client.js:221-232）：``search`` 变体的
    ``queries`` 数组 → SUMMARY_KEYS 首个非空字符串 → 参数对象里首个非空字符串值 →
    原始参数文本首行。
    标题回落到 ``tool.title.generic`` 时 dsh 会在摘要前补工具名
    （``[toolName, base].filter(Boolean).join(" · ")``），此处同。
    """
    tool = str(name or "").strip()
    variant = dsh_tool_variant(tool)
    raw = arguments if isinstance(arguments, str) else (
        json.dumps(arguments, ensure_ascii=False) if isinstance(arguments, (dict, list)) else ""
    )
    data = _argument_object(arguments)
    base = _first_line(raw)
    if data is not None:
        if variant == "search":
            queries = data.get("queries")
            if isinstance(queries, list):
                picked = [q for q in queries if isinstance(q, str) and q != ""]
                if picked:
                    base = ", ".join(_first_line(q) for q in picked)
                    return _join_generic(tool, base)
        value = _pick_string(data, _DSH_SUMMARY_KEYS[variant])
        if value is not None:
            base = _first_line(value)
        else:
            for candidate in data.values():
                if isinstance(candidate, str) and candidate != "":
                    base = _first_line(candidate)
                    break
    return _join_generic(tool, base)


def _join_generic(tool: str, base: str) -> str:
    """dsh ``[titleKey === "tool.title.generic" ? toolName : "", base].filter(Boolean).join(" · ")``。"""
    if dsh_tool_title(tool) == _DSH_VARIANT_TITLES["others"] and tool:
        return f"{tool}{_SEP}{base}" if base else tool
    return base


def render_step_row(name: Any, arguments: Any, level: Optional[str] = None) -> str:
    """dsh 步骤行：``▸ <工具标题> · <摘要>``（dsh ToolRow：``title`` + `` · `` + ``summary``）。

    标题取 ``tool.title.*``，摘要取 ``dsh_tool_summary``（标题回落到 ``工具调用`` 时
    摘要自带工具名前缀）。摘要按 ``_ROW_DETAIL_MAX`` 截断（dsh 用 CSS 省略号）；
    ``verbose`` 档不截断。

    @param name - 工具名。
    @param arguments - tool_call 的原始参数。
    @param level - 四档位；``verbose`` 不截断摘要。
    @returns 单行步骤行。
    """
    tool = str(name or "").strip()
    title = dsh_tool_title(tool)
    summary = dsh_tool_summary(tool, arguments)
    if not summary:
        return f"{_GLYPH_ROW} {title}"
    if level != "verbose":
        summary = _truncate(summary, _ROW_DETAIL_MAX)
    return f"{_GLYPH_ROW} {title}{_SEP}{summary}"


def render_think_row(thinking_text: Any, level: Optional[str] = None) -> str:
    """dsh 思考行：``✦ 思考 · <首段首行>``（dsh ``ReasoningRow`` ui-chat/lib/client.js:5800 + ``message.think`` :5500）。

    ``compact`` 不出预览（dsh ``settledReasoningPreview=false``）；``standard``/``detailed``
    出首行预览（截断 ``_ROW_DETAIL_MAX``）；``verbose`` 出全文，续行按 ``_BODY_INDENT`` 缩进
    （dsh 展开态 thinkBody）。dsh 侧预览会去掉 ``**``（``summaryText.replaceAll("**", "")``），
    此处同。
    """
    text = str(thinking_text or "")
    if level == "compact":
        return f"{_GLYPH_THINK} {_THINK_LABEL}"
    if level == "verbose":
        # 首行可能为空（思考文本以换行开头）：取首个非空行作摘要行，其余行缩进续排。
        lines = text.splitlines()
        index = next((i for i, line in enumerate(lines) if line.strip()), None)
        if index is None:
            return f"{_GLYPH_THINK} {_THINK_LABEL}"
        rendered = f"{_GLYPH_THINK} {_THINK_LABEL}{_SEP}{lines[index].replace('**', '').strip()}"
        for cont in lines[index + 1:]:
            rendered += f"\n{_BODY_INDENT}{cont.replace('**', '').strip()}"
        return rendered
    summary = _first_line(text.replace("**", "")).strip()
    if not summary:
        return f"{_GLYPH_THINK} {_THINK_LABEL}"
    return f"{_GLYPH_THINK} {_THINK_LABEL}{_SEP}{_truncate(summary, _ROW_DETAIL_MAX)}"


def render_result_body(result: Any, level: Optional[str] = None) -> str:
    """工具结果体（detailed/verbose）：dsh 展开态卡片体的文本层等效，按 ``_BODY_INDENT`` 缩进。

    dsh 的结果只在工具行展开后以 TerminalBlock / JSON 体出现，行本身不承载结果；
    文本层无法折叠，故 detailed/verbose 把结果体缩进挂在步骤行之后。
    """
    text = str(result or "").rstrip("\n")
    if not text.strip():
        return ""
    lines = text.splitlines()
    if level != "verbose":
        # 结果首行可能为空（如以换行开头的输出）：取首个非空行，避免产出只含缩进的空体行。
        for line in lines:
            if line.strip():
                return f"{_BODY_INDENT}{_truncate(line, _ROW_DETAIL_MAX)}"
        return ""
    return "\n".join(f"{_BODY_INDENT}{line}" for line in lines)


def _member_row_blocks(
    members: Iterable[Dict[str, Any]], mode: str
) -> tuple:
    """把过程组成员渲染为「每成员一块」的文本块列表（文本版与卡片版共用）。

    这是四档语义的**唯一实现**：``render_process_group``（文本）与
    ``render_process_group_card``（卡片）都从这里取块，保证两者逐字同源。

    @param members - 组内成员序列（发生顺序）。
    @param mode - 已归一的档位（compact/standard/detailed/verbose）。
    @returns ``(kinds, blocks)``：``kinds`` 为工具活动类别（供组头文案），
             ``blocks`` 为逐成员渲染块（块内可能多行）。
    """
    kinds: list = []
    blocks: list = []
    for member in members:
        kind = member.get("kind")
        if kind == "step":
            kinds.append(tool_activity_kind(member.get("name")))
            if mode in _MEMBER_MODES:
                row = render_step_row(member.get("name"), member.get("arguments"), mode)
                body = (
                    render_result_body(member.get("result"), mode)
                    if mode in _BODY_MODES
                    else ""
                )
                blocks.append(f"{row}\n{body}" if body else row)
        elif kind == "think":
            # dsh ``processActivity`` 只统计 tool-call 节点，思考不参与组头类别串
            # （组内无工具时 ``processTitle`` 回落「已完成分析」）。
            blocks.append(render_think_row(member.get("text"), mode))
    return kinds, blocks


def render_process_group(
    members: Iterable[Dict[str, Any]],
    level: Optional[str] = None,
) -> str:
    """把一个过程组渲染为 dsh 形态的多行正文（**不含代码框**）。

    纯函数（便于单测）：``members`` 是按发生顺序排列的组内成员，每项形如
    ``{"kind": "step"|"think", "name": ..., "arguments": ..., "result": ..., "text": ...}``。

    行结构（逐行对齐 dsh 过程块）：

    - 组头行 ``⌄ <processTitle>``（dsh ``ChatGroupSeat`` 关闭态组头；``verbose`` 档
      dsh ``stepGrouping=none`` 不出组头）；
    - 步骤行 ``▸ <工具标题> · <摘要>``（dsh ``ToolRow``）；
    - 思考行 ``✦ 思考 · <首行>``（dsh ``ReasoningRow``）；
    - 结果体（detailed/verbose）缩进 2 空格挂在对应步骤行之后。

    ``compact`` 档只出组头行 + ``✦ 思考``（工具成员不进成员行，但**仍计入组头类别串**
    并保证组头行照发——对齐 dsh ``stepGrouping=collapsed``：组成员折叠、组头可见）。
    ``level`` 非四档时回落 ``detailed``。

    @param members - 组内成员序列（发生顺序）。
    @param level - 四档位之一。
    @returns 多行正文（组成员为空时返回空串，调用方不发消息）。
    """
    mode = level if level in LIVE_DETAIL_MODES else "detailed"
    member_list = list(members)
    kinds, blocks = _member_row_blocks(member_list, mode)
    if not member_list:
        return ""
    if mode == "verbose":
        # dsh ``stepGrouping=none``：无组头行，只有成员行。
        return "\n".join(blocks)
    header = f"{_GLYPH_GROUP} {group_title(kinds)}"
    return f"{header}\n" + "\n".join(blocks) if blocks else header


def render_process_group_card(
    members: Iterable[Dict[str, Any]],
    level: Optional[str] = None,
    *,
    card_index: int = 1,
    continued: bool = False,
) -> Dict[str, Any]:
    """把一个过程组渲染为**飞书卡片 JSON 2.0**（折叠面板，一组一块）。

    四档语义与文本版 ``render_process_group`` **完全一致**（同一份 ``_member_row_blocks``
    文案），只换承载：

    - ``compact``：折叠面板，``expanded=false``（默认折叠），面板内成员行同文本版
      （工具的步骤行按档位不出，思考行照出）；
    - ``standard``：折叠面板，``expanded=false`` + 步骤行；
    - ``detailed``：折叠面板，``expanded=true`` + 步骤行 + 结果体；
    - ``verbose``：**不用面板**，成员行在 ``body.elements`` 平铺直出（同文本版无组头）。

    组头文案取文本版同一函数（``⌄ <group_title>``）放进 ``header.title``（markdown）。
    ``continued`` 为真时标题追加「（续）」（分卡续页）。

    **只用【直证】字段**（2.0 对未知属性会报错）：``schema`` / ``config.width_mode`` /
    ``body.elements`` / ``collapsible_panel``（``element_id``/``expanded``/``direction``/
    ``vertical_spacing``/``padding``/``header.title``/``header.vertical_align``/
    ``header.padding``/``header.width``/``border``/``elements``）/ ``markdown``
    （``element_id``/``content``/``text_size``）。``header.icon.*`` 默认不发
    （``_CARD_PANEL_ICON_TOKEN`` 为 None，属 T1/T2 待实测项）。

    @param members - 组内成员序列（发生顺序）。
    @param level - 四档位之一。
    @param card_index - 本组内第几张卡（用于生成唯一 ``element_id``，从 1 起）。
    @param continued - 是否为续卡（标题加「（续）」）。
    @returns 2.0 卡片 JSON；成员为空时返回 ``{}``（调用方按假值跳过）。
    """
    mode = level if level in LIVE_DETAIL_MODES else "detailed"
    member_list = list(members)
    if not member_list:
        return {}
    kinds, blocks = _member_row_blocks(member_list, mode)

    prefix = f"dsh_c{card_index}"
    rows = [
        {
            "tag": "markdown",
            "element_id": f"{prefix}_e{index}",
            "content": block,
            "text_size": _CARD_ROW_TEXT_SIZE,
        }
        for index, block in enumerate(blocks, start=1)
    ]

    card: Dict[str, Any] = {"schema": "2.0", "config": {"width_mode": "fill"}}
    if mode == "verbose":
        # dsh ``stepGrouping=none``：不用面板，成员行平铺。
        card["body"] = {"elements": rows}
        return card

    title = f"{_GLYPH_GROUP} {group_title(kinds)}"
    if continued:
        title = f"{title}{_CARD_CONT_MARK}"
    header: Dict[str, Any] = {
        "title": {"tag": "markdown", "content": title},
        "vertical_align": "center",
        "padding": "4px 0px 4px 8px",
        "width": "auto_when_fold",
    }
    if _CARD_PANEL_ICON_TOKEN:
        header["icon"] = {
            "tag": "standard_icon",
            "token": _CARD_PANEL_ICON_TOKEN,
            "size": "16px 16px",
        }
        header["icon_position"] = "right"
        header["icon_expanded_angle"] = -180
    panel = {
        "tag": "collapsible_panel",
        "element_id": f"{prefix}_panel",
        "expanded": mode == "detailed",
        "direction": "vertical",
        "vertical_spacing": "4px",
        "padding": "8px 8px 8px 8px",
        "header": header,
        "border": {"color": "grey", "corner_radius": "5px"},
        "elements": rows,
    }
    card["body"] = {"elements": [panel]}
    return card


def _card_chunk_fits(members: list, mode: str, card_index: int) -> bool:
    """试探性判断「把这些成员放进一张卡」是否仍在 30 KB / 200 元素预算内。"""
    card = render_process_group_card(members, mode, card_index=card_index)
    if not card:
        return True
    return (
        _card_bytes(card) <= _CARD_MAX_BYTES
        and _card_element_count(card) <= _CARD_MAX_ELEMENTS
    )


def _trim_card_to_budget(card: Dict[str, Any]) -> Dict[str, Any]:
    """单成员即超预算时的兜底：自后向前裁剪 markdown 正文直到进预算，并标注省略。

    正常档位（compact/standard/detailed）的成员行已被 ``_ROW_DETAIL_MAX`` 截断，
    触及此路径的只可能是 ``verbose`` 档的超长结果体。裁剪会记 ``logger.warning``。
    """
    if not card or _card_bytes(card) <= _CARD_MAX_BYTES:
        return card
    logger.warning(
        "dsh-hermes-link: 单个过程组超过 %d 字节卡片上限，已裁剪正文（verbose 超长结果）",
        _CARD_MAX_BYTES,
    )
    elements: list = []
    body = card.get("body") or {}
    for element in body.get("elements") or []:
        if element.get("tag") == "collapsible_panel":
            elements = element.get("elements") or []
    targets = elements or (body.get("elements") or [])
    marker = "\n…（超出卡片 30KB 上限，已截断）"
    for element in reversed(targets):
        if _card_bytes(card) <= _CARD_MAX_BYTES:
            break
        content = str(element.get("content") or "")
        while content and _card_bytes(card) > _CARD_MAX_BYTES:
            overflow = _card_bytes(card) - _CARD_MAX_BYTES
            content = content[: max(0, len(content) - max(overflow, 64))]
        element["content"] = content + marker
    return card


def _split_card_chunks(
    members: Iterable[Dict[str, Any]], level: Optional[str] = None
) -> list:
    """按**步骤行边界**把过程组切成若干张卡（每卡 ≤30 KB / ≤200 元素）。

    返回 ``[(fallback_text, card_json), ...]``：
    - ``fallback_text`` 是该段成员的**文本版渲染**（``render_process_group``），
      发送层在卡片失败时回落到它——保证「不丢信息」（V5）；
    - ``card_json`` 是 2.0 折叠卡；续卡（第 2 张起）重复折叠面板标题并标注「续」。

    切分只发生在成员边界（不会把一条步骤行劈成两半）；单个成员自身即超预算时由
    ``_trim_card_to_budget`` 兜底裁剪并告警。
    """
    member_list = list(members)
    if not member_list:
        return []
    mode = level if level in LIVE_DETAIL_MODES else "detailed"

    chunks: list = []
    cur: list = []
    for member in member_list:
        trial = cur + [member]
        if cur and not _card_chunk_fits(trial, mode, len(chunks) + 1):
            chunks.append(cur)
            cur = [member]
        else:
            cur = trial
    if cur:
        chunks.append(cur)

    out: list = []
    for index, chunk in enumerate(chunks):
        card = render_process_group_card(
            chunk, mode, card_index=index + 1, continued=index > 0
        )
        if _card_bytes(card) > _CARD_MAX_BYTES:
            card = _trim_card_to_budget(card)
        out.append((render_process_group(chunk, mode), card))
    return out


def _plain_markdown_element(
    family: str, card_index: int, position: int, content: str
) -> Dict[str, Any]:
    """简约卡的一个 markdown 元素（只用【直证】字段，**不发** ``text_size``）。

    ``text_size`` 省略 = 卡片默认正文字号；与过程组成员行的 ``notation``（12px 辅助
    信息）刻意区分：叙述 / 结果 / 收束是正文，不是辅助行。
    """
    return {
        "tag": "markdown",
        "element_id": f"dsh_{family}{card_index}_e{position}",
        "content": content,
    }


def render_plain_card(
    content: Any = "",
    *,
    family: str = _CARD_FAMILY_NARRATIVE,
    card_index: int = 1,
    lead: Optional[Iterable[str]] = None,
) -> Dict[str, Any]:
    """渲染**简约卡**：无折叠面板、无标题，``body.elements`` 只有 markdown（v0.7.3）。

    dsh 流出的非过程组内容全部走这里承载：

    - ``family="n"`` 叙述卡（低信号 text 累积后的叙述段）；
    - ``family="f"`` 直播路径的 final 文本；
    - ``family="t"`` 收束小卡（``render_turn_close`` 的收束行）；
    - ``family="r"`` 结果卡：``lead=[📬 头行]`` 先放一个元素，正文再放一个元素。

    只用【直证】字段（``schema`` / ``config.width_mode`` / ``body.elements`` /
    ``markdown``）：2.0 对未知属性会报错。**不用** ``collapsible_panel``（无折叠）、
    **不发** ``header``（无标题）。``lead`` 与 ``content`` 都为空时返回 ``{}``
    （调用方按假值跳过，与 ``render_process_group_card`` 同约定）。

    @param content - 卡片正文（markdown 原文）。
    @param family - 卡族，决定 ``element_id`` 前缀（n / f / t / r）。
    @param card_index - 同一段内容切成多张卡时的序号（从 1 起，用于卡内 id 唯一）。
    @param lead - 正文之前的前置元素文本序列（结果卡的 📬 头行）。
    @returns 2.0 卡片 JSON；无任何元素时返回 ``{}``。
    """
    elements: list = []
    for text in list(lead or []):
        if str(text or "").strip():
            elements.append(
                _plain_markdown_element(family, card_index, len(elements) + 1, str(text))
            )
    body = str(content or "")
    if body.strip():
        elements.append(
            _plain_markdown_element(family, card_index, len(elements) + 1, body)
        )
    if not elements:
        return {}
    return {
        "schema": "2.0",
        "config": {"width_mode": "fill"},
        "body": {"elements": elements},
    }


def _join_plain_fallback(lead: Optional[Iterable[str]], body: str) -> str:
    """简约卡的**文本回退层**：前置元素 + 空行 + 正文（结果卡即 ``头行\\n\\n正文``）。"""
    parts = [str(text) for text in list(lead or []) if str(text or "").strip()]
    if str(body or "").strip():
        parts.append(body)
    return "\n\n".join(parts)


def _plain_card_fits(
    text: str,
    family: str,
    card_index: int,
    more: bool,
    lead: Optional[Iterable[str]] = None,
) -> bool:
    """试探「这些文本放进一张简约卡」是否仍在 30 KB / 200 元素预算内。"""
    body = text + ("\n" + _PLAIN_CONT_MARK if more else "")
    card = render_plain_card(body, family=family, card_index=card_index, lead=lead)
    if not card:
        return True
    return (
        _card_bytes(card) <= _CARD_MAX_BYTES
        and _card_element_count(card) <= _CARD_MAX_ELEMENTS
    )


def _take_plain_prefix(
    text: str,
    family: str,
    card_index: int,
    lead: Optional[Iterable[str]] = None,
) -> tuple:
    """切出「一张简约卡装得下」的最长前缀，返回 ``(chunk, rest)``。

    优先按**行边界**切（不劈开一行）；某一行自身就超预算时按字符二分硬切，保证
    ``len(chunk) >= 1``（调用方据此必然收敛）。判定一律走 ``_card_bytes``（UTF-8
    真实字节数），不为字符数与字节数的差异留隐患。
    """
    if _plain_card_fits(text, family, card_index, False, lead):
        return text, ""
    lines = text.split("\n")
    used = 0
    for index in range(len(lines)):
        candidate = "\n".join(lines[: index + 1])
        if not _plain_card_fits(candidate, family, card_index, True, lead):
            break
        used = len(candidate)
    if used:
        rest = text[used:]
        return text[:used], rest[1:] if rest.startswith("\n") else rest
    lo, hi = 1, len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if _plain_card_fits(text[:mid], family, card_index, True, lead):
            lo = mid
        else:
            hi = mid - 1
    return text[:lo], text[lo:]


def split_plain_card_chunks(
    content: Any,
    *,
    family: str = _CARD_FAMILY_NARRATIVE,
    lead: Optional[Iterable[str]] = None,
) -> list:
    """把一段纯文本切成若干张**简约卡**，返回 ``[(fallback_text, card_json), ...]``。

    每卡 ≤30 KB / ≤200 元素（官方硬限）；切分只发生在行边界，单行超预算时按字符硬切；
    非末卡末尾追加 ``⏩ 续`` 续接提示（与 ``_split_plain_chunks`` 同源）。

    ``fallback_text`` 是该卡内容的**文本回退层**（``lead`` + 空行 + 卡内正文），发送层
    在卡片失败时回落它——两态逐字同源，卡片失败绝不丢信息（V5）。

    @param content - 正文（markdown 原文）。
    @param family - 卡族（n / f / t / r）。
    @param lead - 仅首卡的 ``lead`` 元素（结果卡的 📬 头行）；续卡不再重复。
    @returns 卡列表；正文与 ``lead`` 都为空时返回 ``[]``。
    """
    text = str(content or "")
    first_lead = [str(item) for item in list(lead or []) if str(item or "").strip()]
    if not text.strip() and not first_lead:
        return []
    out: list = []
    rest = text
    index = 0
    while True:
        index += 1
        chunk, rest = _take_plain_prefix(rest, family, index, first_lead or None)
        body = chunk + ("\n" + _PLAIN_CONT_MARK if rest else "")
        card = render_plain_card(body, family=family, card_index=index, lead=first_lead)
        if card:
            out.append((_join_plain_fallback(first_lead, body), card))
        first_lead = []
        if not rest:
            break
    return out


def split_result_cards(head: Any, body: Any) -> list:
    """**结果卡**切分：首卡 = 📬 头行 + 正文首块，正文超预算时按行切续卡（v0.7.3）。

    返回 ``[(fallback_text, card_json), ...]``；``fallback_text`` 与文本回退层
    ``_format_result_message`` **逐字同源**（首卡 ``头行\\n\\n正文块``、续卡为正文块），
    卡片失败即回落文本、不丢正文。

    @param head - 📬 头行（状态 + 耗时）。
    @param body - 结果正文（**不截断**）。
    @returns 卡列表；``head`` 与 ``body`` 都为空时返回 ``[]``。
    """
    return split_plain_card_chunks(body, family=_CARD_FAMILY_RESULT, lead=[head])


def resolve_card_mode(value: Any) -> Optional[str]:
    """把 ``collector.card`` 配置解析为 ``None``（关）或 ``"panel"``（卡片承载）。

    未配置 / 非法值一律回落 ``off``（默认关，灰度用）。``"on"``/``"true"`` 这类
    宽松值按 ``panel`` 处理，避免配置手误导致能力静默失效。

    ``panel`` 的含义（v0.7.3 起）：**dsh 流出的全部内容**都用卡片承载——过程组为 2.0
    折叠卡（``render_process_group_card``），叙述 / 直播最终文本 / 收束行为**简约卡**
    （``render_plain_card``），最终结果为**结果卡**（``split_result_cards``）。
    文本行始终保留为回退层；``off`` 时三条通路都退回 v0.7.0 的纯文本形态。
    """
    text = str(value if value is not None else DEFAULT_CARD).strip().lower()
    if text in ("panel", "on", "true", "1", "yes"):
        return "panel"
    return None



def dsh_duration_text(seconds: float) -> str:
    """时长文案，逐字对齐 dsh ``formatRunDuration``（ui-chat/lib/client.js:1009-1037）+ ``duration.*Unit``（zh）。

    < 60 秒 → ``12秒``；≥ 60 秒 → ``1分5秒``；≥ 1 小时 → ``1小时2分3秒``（dsh 固定带秒）。
    """
    total = max(0, int(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    parts = []
    if hours > 0:
        parts.append(f"{hours}小时")
    if total >= 60:
        parts.append(f"{minutes}分")
    parts.append(f"{secs}秒")
    return "".join(parts)


def render_turn_close(reason: Any = "completed", elapsed: Optional[float] = None) -> str:
    """收束行 ``▸ <轮次收束文案>``：逐字对齐 dsh ``TurnProcessNodeView``（ui-chat/lib/client.js:6225-6272）。

    - ``aborted`` → ``message.stopped``「已停止」；
    - ``error``   → ``message.turnProcess.failed``「处理失败」；
    - 其余（completed / blocked / max-tokens / …）→ 无时长 ``已完成``，
      有时长 ``已完成，用时 <duration>``（dsh ``took`` + ``formatRunDuration``）。
    """
    kind = str(reason or "")
    if kind == "aborted":
        return f"{_GLYPH_ROW} 已停止"
    if kind == "error":
        return f"{_GLYPH_ROW} 处理失败"
    if elapsed is None:
        return f"{_GLYPH_ROW} 已完成"
    return f"{_GLYPH_ROW} 已完成，用时 {dsh_duration_text(elapsed)}"


def _to_bool(value: Any) -> bool:
    """YAML 布尔 / 字符串布尔稳健转 bool（遗留 ``collector.content`` 键）。"""
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in {"1", "true", "yes", "on", "enabled"}


def normalize_live_detail(value: Any) -> Optional[str]:
    """把档位值归一为四档之一；非法 / None / 非四档返回 None。

    只接受四档字面量（大小写不敏感）；dsh 旧值 ``normal`` / ``expanded`` 不在此归一
    （由 ``read_dsh_transcript_view`` 负责），保证 ``collector.live_detail`` 值域严格。
    """
    if isinstance(value, str):
        text = value.strip().lower()
        if text in LIVE_DETAIL_MODES:
            return text
    return None


def read_dsh_transcript_view(dsh_home: str, dsh_profile: str) -> str:
    """读 dsh profile patch 的 ``ui-chat.transcriptView``，返回四档之一。

    路径 ``<dsh_home>/profiles/<dsh_profile>/cordis.patch.yml`` 是 YAML 条目数组；
    定位 ``id == "ui-chat"`` → ``config.transcriptView``。旧值 ``normal`` / ``expanded``
    读作 ``detailed``。**任何失败**（PyYAML 不可用 / 文件缺失 / YAML 坏 / 非数组 /
    无 ui-chat 条目 / 无键 / 值非法）→ 返回 ``LIVE_DETAIL_FALLBACK``（detailed），
    log 一次，不抛不阻塞。
    """
    import os

    path = os.path.join(str(dsh_home), "profiles", str(dsh_profile), "cordis.patch.yml")
    try:
        import yaml
    except Exception as exc:
        logger.warning("dsh-hermes-link: follow-dsh: PyYAML unavailable: %s", exc)
        return LIVE_DETAIL_FALLBACK
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = yaml.safe_load(fh)
    except Exception as exc:
        logger.warning("dsh-hermes-link: follow-dsh: cannot read %s: %s", path, exc)
        return LIVE_DETAIL_FALLBACK
    if not isinstance(data, list):
        logger.warning("dsh-hermes-link: follow-dsh: %s is not an entry array", path)
        return LIVE_DETAIL_FALLBACK
    for entry in data:
        if not isinstance(entry, dict) or entry.get("id") != "ui-chat":
            continue
        config = entry.get("config")
        if not isinstance(config, dict) or "transcriptView" not in config:
            break
        value = config.get("transcriptView")
        mode = normalize_live_detail(value)
        if mode is not None:
            return mode
        if isinstance(value, str) and value.strip().lower() in ("normal", "expanded"):
            return "detailed"
        break
    logger.warning(
        "dsh-hermes-link: follow-dsh: no valid ui-chat.transcriptView in %s", path
    )
    return LIVE_DETAIL_FALLBACK


def resolve_collector_level(
    live_detail_raw: Any,
    content_raw: Any,
    dsh_home: Any = None,
    dsh_profile: Any = None,
) -> str:
    """按冻结优先级把 collector 配置解析为四档之一。

    优先级：显式 live_detail（四档）> follow-dsh 解析 > 遗留 content 映射 > 默认。
    - ``live_detail`` 是四档之一 → 直接用；
    - ``live_detail`` 为 ``follow-dsh``（或其它非四档字符串）→ 读 dsh（失败回落 detailed）；
    - ``live_detail`` 未设置而 ``content`` 显式设置 → ``true→detailed`` / ``false→standard``；
    - 两者都未设置 → follow-dsh。
    """
    mode = normalize_live_detail(live_detail_raw)
    if mode is not None:
        return mode
    if live_detail_raw is None and content_raw is not None:
        return "detailed" if _to_bool(content_raw) else "standard"
    return read_dsh_transcript_view(
        dsh_home if dsh_home is not None else DSH_HOME_DEFAULT,
        dsh_profile if dsh_profile is not None else DSH_PROFILE_DEFAULT,
    )


def resolve_live_detail(content: bool = True, level: Optional[str] = None) -> str:
    """把渲染参数解析为四档之一：显式 ``level`` 优先，否则 ``content``→detailed/standard。"""
    if level in LIVE_DETAIL_MODES:
        return level
    return "detailed" if content else "standard"


def render_line(
    event: Dict[str, Any],
    content: bool = True,
    level: Optional[str] = None,
) -> Optional[str]:
    """把归一化事件渲染为一行飞书 / QQ 文本（无法识别返回 None）。

    v0.7.0 起直播路径**不再有代码框**：过程成员（工具步骤 / 思考）由 ``Throttler``
    收口为 dsh 形态的过程组消息（见 ``render_process_group``），``render_line`` 只负责
    叙述 / 最终文本（``text``）：

    | 事件 | 四档行为 |
    |---|---|
    | turn_start | 不产出（dsh 无「第 N 轮」行；轮次边界由收束行体现） |
    | tool_call / tool_result / thinking | 一律返回 None（由过程组承载） |
    | text（叙述/final） | 原样 markdown 文本（无前缀、无围栏）；verbose 不截断，其余档非 final 截断 120 |
    | turn_end / status | 一律返回 None（收束行由 ``Throttler`` 生成，见 ``render_turn_close``） |

    ``content``（遗留布尔）与 ``level``（四档，优先）经 ``resolve_live_detail`` 解析，
    只影响叙述文本的截断口径。
    - 任何档位都不吞 final_text 与 stats；终态由收束行体现（``Throttler`` 保证一轮一发）。
    - ``collector.events=false``（安静模式）优先于档位（由 consume_stream 处理）。
    """
    mode = resolve_live_detail(content, level)
    etype = event.get("type")
    if etype in ("thinking", "tool_call", "tool_result", "turn_start", "turn_end", "status"):
        return None
    if etype == "text":
        raw = str(event.get("text") or "")
        if event.get("final") or mode == "verbose":
            return raw
        return _truncate(raw, 120)
    return None


# --------------------------------------------------------------------------
# 4. 节流（简化版）
# --------------------------------------------------------------------------

class Throttler:
    """聚合低信号 text、把一轮内的过程成员收口为 dsh 形态消息、补收束行，并做限速。

    - ``tool_call`` / ``tool_result`` / ``thinking`` 在**四档**都进组缓冲，不逐条发出；
      收口时由 ``render_process_group`` 渲染为一条 dsh 形态消息（组头行 + 步骤行 /
      思考行，**无代码框**）。
    - **组边界（v0.7.2，对齐 dsh ``ChatGroupSeat``）**：出现助手叙述文本（非 final
      ``text``）且此刻确有过程组待收口时**先收口过程组再输出该段叙述**——组不再跨叙述
      累积到 ``turn_end``。无待收口组时叙述仍累积（连续叙述不拆分）。``turn_end`` /
      终态 status 只做「收口残余组 + 收束行」（残余叙述文本兜底 flush，不丢信息）。
    - 低信号 ``text``（非 final）累积为一条普通 markdown 文本（无前缀、无围栏）；
      在组边界、``turn_end`` 或 status 终态 flush。``collector.card=panel`` 时该叙述
      改由**叙述卡**（``render_plain_card``，无折叠 / 无标题）承载，文本行仍是回退层。
    - 收束行（``render_turn_close``）：``turn_end`` 优先（带时长），否则终态 status
      兜底；**一轮最多一条**，避免 turn_end 与 status completed 双发。卡片模式下改由
      **收束小卡**承载（状态与用时同时并入结果卡的 📬 头行，两条链路各自独立取数）。
    - 直播路径的 final 文本（``render_line`` 原样返回）在卡片模式下同样改由简约卡承载。
    - 收口时机（沿用）：``turn_end``、终态 status、final text、新 ``turn_start``（上一轮
      未发则先发）；过程组**先于**触发它的叙述 / 收束行发出。终态强制收口（不丢信息）。
    - 发空规则：该轮既无工具步也无思考 → 不发过程组。
    - 全局限速：相邻两次 send 至少间隔 ``min_interval`` 秒（默认 2.0）；不足则等待。
    """

    def __init__(
        self,
        min_interval: float = 2.0,
        level: Optional[str] = None,
        card: Any = None,
    ) -> None:
        self.min_interval = float(min_interval)
        self.level = level if level in LIVE_DETAIL_MODES else None
        # collector.card：None（off，默认）→ 纯文本行；"panel" → 2.0 折叠卡。
        self.card = resolve_card_mode(card)
        self._last_send = 0.0
        self._text_buf: list = []
        # 过程组缓冲（四档统一）：按发生顺序累积组内成员（步骤 / 思考）。
        self._members: list = []
        self._turn_started: Optional[float] = None
        self._closer_sent = False

    def _flush_text(self) -> Optional[str]:
        """叙述文本行：原样 markdown（无 ``📖`` 前缀、无围栏），非 verbose 截断 120。

        截断口径（低信号降噪）与 v0.7.0 逐字一致，**不因改卡片而放大**：卡片承载的
        内容就是本函数的返回值，两态同源。
        """
        if not self._text_buf:
            return None
        joined = " ".join(self._text_buf).strip()
        self._text_buf = []
        if not joined:
            return None
        if self.level == "verbose":
            return joined
        return _truncate(joined, 120)

    def _plain_items(self, text: Optional[str], family: str) -> list:
        """把一段文本包成外发件列表：卡片模式下发简约卡（超预算切多张），否则原样文本。

        ``family`` 见 ``_CARD_FAMILY_*``。卡片失败时发送层回落 ``CardMessage`` 的内容
        （文本回退层，与卡内文案同源），不丢信息。
        """
        if text is None or not str(text).strip():
            return []
        if self.card != "panel":
            return [text]
        return [
            CardMessage(fallback, card)
            for fallback, card in split_plain_card_chunks(text, family=family)
            if card
        ]

    def _flush_text_items(self) -> list:
        """叙述文本外发件（``panel`` → 叙述卡；``off`` → 普通文本行）。"""
        return self._plain_items(self._flush_text(), _CARD_FAMILY_NARRATIVE)

    def _closer_items(self, reason: Any = "completed") -> list:
        """收束行外发件（``panel`` → 收束小卡；``off`` → 普通文本行）；一轮最多一条。"""
        return self._plain_items(self._close_line(reason), _CARD_FAMILY_CLOSER)

    def _buffer_process_event(self, event: Dict[str, Any]) -> None:
        """把 tool_call / tool_result / thinking 收进过程组缓冲（四档统一，不逐条发出）。"""
        etype = event.get("type")
        if etype == "tool_call":
            self._members.append(
                {
                    "kind": "step",
                    "name": event.get("name") or "",
                    "arguments": event.get("arguments"),
                    "result": "",
                }
            )
        elif etype == "tool_result":
            result = str(event.get("text") or "")
            for member in reversed(self._members):
                if member.get("kind") == "step":
                    member["result"] = result
                    break
            else:
                # 异常流：无前导 tool_call 的 tool_result，补一步只含结果。
                self._members.append(
                    {
                        "kind": "step",
                        "name": event.get("name") or "",
                        "arguments": "",
                        "result": result,
                    }
                )
        elif etype == "thinking":
            self._members.append({"kind": "think", "text": str(event.get("text") or "")})

    def _flush_process_group(self) -> list:
        """收口当前过程组，返回**应发出的外发件列表**（文本 ``str`` 或 ``CardMessage``）。

        纯文本模式（``collector.card=off``，默认）恒为 0 或 1 项；卡片模式按
        30 KB / 200 元素预算可能切成多张卡——每张都是 ``CardMessage``：内容为
        **文本回退层**（卡片发送失败时回落它，不丢信息），``.card`` 为卡片 JSON。
        """
        if not self._members:
            return []
        members = self._members
        self._members = []
        if self.card == "panel":
            return [
                CardMessage(text, card)
                for text, card in _split_card_chunks(members, self.level)
                if text.strip()
            ]
        body = render_process_group(members, self.level)
        return [body] if body.strip() else []

    def _close_line(self, reason: Any = "completed") -> Optional[str]:
        """生成收束行（一轮最多一条）：turn_end 优先，终态 status 只在未发时兜底。"""
        if self._closer_sent:
            return None
        elapsed = None
        if self._turn_started is not None:
            # dsh ``TurnProcessNodeView``：``Math.max(1e3, end - start)``，下限 1 秒。
            elapsed = max(1.0, time.monotonic() - self._turn_started)
        self._closer_sent = True
        return render_turn_close(reason, elapsed)

    def _wait_interval(self) -> None:
        if self.min_interval <= 0:
            return
        remaining = self.min_interval - (time.monotonic() - self._last_send)
        if remaining > 0:
            time.sleep(remaining)

    def feed(self, event: Dict[str, Any], line: Optional[str]) -> list:
        """返回此刻应当发送的行列表（已做聚合与限速）。

        ``event`` 用于判断事件类型与终态；``line`` 是该事件的 ``render_line`` 结果
        （过程成员与终态事件恒为 None，这些事件在此进组缓冲 / 生成收束行）。
        """
        if not isinstance(event, dict):
            return []
        etype = event.get("type")
        candidates: list = []

        if etype in ("tool_call", "tool_result", "thinking"):
            # 进组缓冲（四档统一），不逐条发出。
            self._buffer_process_event(event)
        elif etype == "turn_start":
            # 轮次切换：先收口上一轮过程组，再进入新一轮计时。
            candidates.extend(self._flush_process_group())
            self._turn_started = time.monotonic()
            self._closer_sent = False
        elif etype == "text":
            if event.get("final"):
                # 防御性收口：final 文本到达时残存过程组先收口，再发最终文本。
                # 卡片模式下 final 文本同样由简约卡承载（文本回退层不变）。
                candidates.extend(self._flush_process_group())
                if line:
                    candidates.extend(self._plain_items(line, _CARD_FAMILY_FINAL))
            else:
                text = str(event.get("text") or "")
                if text:
                    self._text_buf.append(text)
                # 组边界修正（v0.7.2，对齐 dsh ``ChatGroupSeat``：出现助手叙述文本 /
                # INDEPENDENT 节点 / 轮次结束即断组）：此刻若确有过程组待收口，**先收口
                # 该组、再输出这段叙述**——叙述不再等到 ``turn_end`` 才与后续工具挤进
                # 同一条，于是「工具→叙述→工具→叙述」得到 2 组 + 2 段叙述。
                # 无待收口组时沿用「低信号 text 累积」语义：连续叙述不会被拆成多条。
                if self._members:
                    candidates.extend(self._flush_process_group())
                    candidates.extend(self._flush_text_items())
        elif etype == "turn_end":
            # turn_end：收口残余组 → 残余叙述（兜底 flush，不丢信息）→ 收束行。
            candidates.extend(self._flush_process_group())
            candidates.extend(self._flush_text_items())
            candidates.extend(self._closer_items(event.get("reason") or "completed"))
        elif etype == "status":
            state = event.get("state")
            if state in _TERMINAL_STATES:
                # 终态强制收口：残余组 → 残余叙述 → 收束行（turn_end 已发则不重复）。
                candidates.extend(self._flush_process_group())
                candidates.extend(self._flush_text_items())
                candidates.extend(
                    self._closer_items(_STATUS_REASON.get(state, "completed"))
                )
            # working / submitted：不产生行

        out: list = []
        for c in candidates:
            self._wait_interval()
            out.append(c)
            self._last_send = time.monotonic()
        return out


# --------------------------------------------------------------------------
# 5. 发送
# --------------------------------------------------------------------------

def _redact(text: str) -> str:
    """redact 敏感文本；``agent.redact`` import 失败则原样返回（不抛错）。"""
    try:
        from agent.redact import redact_sensitive_text

        return redact_sensitive_text(text, force=True)
    except Exception as exc:  # 独立运行时无 hermes-agent，redact 不可用即跳过
        logger.debug("dsh-hermes-link: redact unavailable, skipped: %s", exc)
        return text


def _target(platform: str, chat_id: str, thread_id: str) -> str:
    """拼出 ``platform:chat_id[:thread_id]`` 投递目标。"""
    target = f"{platform}:{chat_id}"
    if thread_id:
        target += f":{thread_id}"
    return target


def make_sender(ctx: Any = None) -> Callable[[str, str, str, str], Dict[str, Any]]:
    """返回 ``send(platform, chat_id, thread_id, text) -> dict``。

    长文本按换行边界分块（``_split_plain_chunks``，块间 ``⏩ 续``）：v0.7.0 起正文
    不再含代码框，分块无需围栏感知。

    发送前必做 redact。发送只走一条通路：从 gateway 主 loop 上的 adapter 发——用
    ``_gateway_runner_ref`` 弱引用拿到 runner，取 ``runner._gateway_loop``（gateway
    boot 时写入的 ``asyncio.get_running_loop()``），再用
    ``agent.async_utils.safe_schedule_threadsafe`` 把 ``adapter.send(...)`` 协程跨线程
    调度到主 loop 执行。这样 feishu / QQ adapter 的 aiohttp / websocket 绑定仍挂在主
    loop 上，不会在 daemon 线程里起新 loop 导致跨线程失败。

    为什么不再走 ``ctx.dispatch_tool("send_message", ...)``：dispatch_tool 不抛异常，
    失败也只返回 JSON 结果字符串（含失败 JSON），把「不抛异常」当成功会吞掉内部失败。
    ``ctx`` 参数保留仅为兼容 ``__init__.py`` 的 ``make_sender(_CTX)`` 调用签名，实际不
    参与发送。返回结构化 dict，永不抛异常进上层。
    """

    def send(
        platform: str,
        chat_id: str,
        thread_id: str,
        text: str,
        card: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        redacted = _redact(text)
        target = _target(platform, chat_id, thread_id)
        # 长文本（>8000）按换行边界分块发送；分块间由分块函数追加「⏩ 续」分隔提示。
        # v0.7.0 起正文不再含代码框，故统一走纯文本分块（无围栏感知需求）。
        chunks = _split_plain_chunks(redacted)

        try:
            from gateway.run import _gateway_runner_ref
            from gateway.config import Platform
            from agent.async_utils import safe_schedule_threadsafe

            runner = _gateway_runner_ref()
            if runner is None:
                return {"ok": False, "error": "no_gateway", "text": redacted,
                        "target": target, "message_id": None}
            loop = getattr(runner, "_gateway_loop", None)
            if loop is None:
                return {"ok": False, "error": "no_loop", "text": redacted,
                        "target": target, "message_id": None}
            try:
                adapter = runner.adapters.get(Platform(platform))
            except Exception:
                adapter = None
            if adapter is None:
                return {"ok": False, "error": "no_adapter", "text": redacted,
                        "target": target, "message_id": None}
            metadata = {"thread_id": thread_id} if thread_id else None

            # 卡片优先（collector.card=panel 时由 Throttler 挂上 card）：失败**一律回落
            # 文本行**，绝不因为卡片失败而丢消息（V5 降级链）。适配器缺 send_card
            # （旧版适配器）同样回落。
            if card is not None:
                # 卡片是**增强层**：任何失败（返回失败 / 抛异常 / 适配器无此方法）都
                # 回落文本行，绝不因卡片失败而丢消息（V5）。故单独 try/except 包住。
                try:
                    send_card = getattr(adapter, "send_card", None)
                    if callable(send_card):
                        fut = safe_schedule_threadsafe(
                            send_card(chat_id=chat_id, card=card, metadata=metadata), loop
                        )
                        if fut is None:
                            logger.warning(
                                "dsh-hermes-link: card schedule failed; 回落文本行"
                            )
                        else:
                            result = fut.result(timeout=60)
                            if getattr(result, "success", False):
                                return {
                                    "ok": True,
                                    "via": "adapter-card",
                                    "target": target,
                                    "text": redacted,
                                    "message_id": getattr(result, "message_id", None),
                                }
                            logger.warning(
                                "dsh-hermes-link: card send failed (%s); 回落文本行",
                                getattr(result, "error", "") or "unknown",
                            )
                    else:
                        logger.warning(
                            "dsh-hermes-link: adapter 无 send_card；回落文本行"
                        )
                except Exception as exc:  # 卡片异常不阻断文本回退
                    logger.warning(
                        "dsh-hermes-link: card send raised (%s); 回落文本行", exc
                    )

            last: Dict[str, Any] = {"ok": True, "via": "adapter", "target": target,
                                    "text": redacted, "message_id": None}
            for chunk in chunks:
                fut = safe_schedule_threadsafe(
                    adapter.send(chat_id=chat_id, content=chunk, metadata=metadata), loop
                )
                if fut is None:
                    return {"ok": False, "error": "schedule_failed", "text": chunk,
                            "target": target, "message_id": None}
                result = fut.result(timeout=60)
                if getattr(result, "success", False):
                    last = {"ok": True, "via": "adapter", "target": target, "text": chunk,
                            "message_id": getattr(result, "message_id", None)}
                else:
                    last = {"ok": False, "error": "send_failed",
                            "detail": str(getattr(result, "error", "") or ""),
                            "text": chunk, "target": target, "message_id": None}
            return last
        except Exception as exc:
            logger.warning("dsh-hermes-link: adapter send failed: %s", exc)
            return {"ok": False, "error": "send_failed", "text": redacted,
                    "target": target, "message_id": None}

    def ws_ready(platform: str) -> Optional[bool]:
        """平台长连接是否就位：``True`` 就绪 / ``False`` 未就绪 / ``None`` 判不出来。

        供 §2.6 发提问卡前的那道闸使用（见 ``_wait_ws_ready``）；探针缺失或异常都按
        「判不出来」放行，绝不因为探测本身把问答卡死。
        """
        try:
            from gateway.run import _gateway_runner_ref
            from gateway.config import Platform

            runner = _gateway_runner_ref()
            adapter = runner.adapters.get(Platform(platform)) if runner is not None else None
            probe = getattr(adapter, "is_ws_ready", None)
            if not callable(probe):
                return None
            return bool(probe())
        except Exception:
            return None

    send.ws_ready = ws_ready  # type: ignore[attr-defined]  # 探针随 sender 一起传（闭包属性）
    return send


# --------------------------------------------------------------------------
# 6. 编排入口
# --------------------------------------------------------------------------

# --------------------------------------------------------------------------
# 6b. §2.6 交互问答桥接（question 事件 → 卡片 → 作答 → A2A input-required 续投）
# --------------------------------------------------------------------------

def _question_fallback_text(question: Dict[str, Any], index: int, total: int) -> str:
    """提问的纯文本形态：既是卡片失败时的降级正文，也是卡片的伴随文本。"""
    head = f"❓ 需要您作答（第 {index}/{total} 题）" if total > 1 else "❓ 需要您作答"
    lines = [head, "", str(question.get("question") or "")]
    if question.get("detail"):
        lines += ["", str(question["detail"])]
    for i, option in enumerate(question.get("options") or [], start=1):
        label = str((option or {}).get("label") or "").strip()
        if not label:
            continue
        description = str((option or {}).get("description") or "").strip()
        lines.append(f"{i}) {label}" + (f"——{description}" if description else ""))
    return "\n".join(lines)


# 发提问卡前等平台长连接就位的上限（秒）——**有界**：这是发卡前置闸，不是问答等待
# （问答全程零超时）。测试可改此常量。
_WS_READY_TIMEOUT = 60.0

# 续投流建立失败的重试次数与退避基数（秒）：续投是作答的唯一归途，打不开＝dsh 侧永久挂起
_CONTINUATION_ATTEMPTS = 3
_CONTINUATION_RETRY_INTERVAL = 1.0


def _wait_ws_ready(
    sender: Callable[..., Any], platform: str, *, timeout: Optional[float] = None, interval: float = 2.0,
) -> bool:
    """发提问卡前等平台长连接就位（附录 A 实证坑：重启窗口期内点击报「目标回调服务未在线」）。

    ``sender`` 由 ``make_sender`` 造、带 ``ws_ready(platform)`` 探针；探针不可用或判不
    出来时**放行**（不因探测缺失而阻断问答）。等待是**有界**的——这道闸不是问答等待
    （问答本身零超时），超时即如实返回 False，由调用方按跳过收口，绝不悬挂。
    """
    probe = getattr(sender, "ws_ready", None)
    if not callable(probe):
        return True
    limit = _WS_READY_TIMEOUT if timeout is None else timeout
    deadline = time.monotonic() + max(0.0, limit)
    while True:
        try:
            ready = probe(platform)
        except Exception as exc:  # 探针异常按「判不出来」处理
            logger.warning("dsh-hermes-link: WS 就绪探针异常（放行）: %s", exc)
            return True
        if ready is not False:
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(interval)


def _handle_question_event(
    event: Dict[str, Any],
    *,
    url: str,
    context_id: str,
    platform: str,
    chat_id: str,
    thread_id: str,
    sender: Callable[..., Any],
    headers: Dict[str, str],
    timeout: int,
    card_mode: Optional[str],
) -> Optional[Iterator[Dict[str, Any]]]:
    """认领一次提问：逐题发卡 → 零超时等答 → 返回**续投流**（调用方拼到当前流尾部）。

    出口纪律（全链零悬挂）：只有「作答」才把答案带给服务端；**发卡未真正送达** /
    槽位被收场 / 用户跳过，一律以 ``skipped`` 续投（服务端把该提问以中止收口），
    绝不把任务留在没有出路的等待里。返回 ``None`` 表示连续投都发不出（调用方收工）。
    """
    qna = _import_qna()
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    ask_id = str(payload.get("askId") or event.get("ask_id") or "")
    task_id = str(payload.get("taskId") or event.get("task_id") or "")
    questions = payload.get("questions") if isinstance(payload.get("questions"), list) else []
    if not ask_id or not task_id or not questions:
        logger.warning(
            "dsh-hermes-link: question 事件载荷不完整，无法建卡（ask=%r task=%r 题数=%d）",
            ask_id, task_id, len(questions),
        )
        return None

    slot = qna.AskSlot(ask_id, questions)
    qna.register_ask(slot)
    answers: list = []
    skipped = False
    try:
        total = len(questions)
        # 挂起可见（B#4，仅面板档）：非面板线不因问答新增提示噪声——问题卡本身
        # 就是可见面，且点击后就地换卡。
        if card_mode == "panel":
            _send_aux_line(
                sender, platform, chat_id, thread_id,
                f"⏳ 等待作答（{total} 题）——作答后自动继续",
            )
        for index, question in enumerate(questions, start=1):
            qid = str(question.get("id") or "")
            if not qid:
                continue
            text = _question_fallback_text(question, index, total)
            card = qna.build_question_card(
                ask_id=ask_id,
                qid=qid,
                question=str(question.get("question") or ""),
                index=index,
                total=total,
                header=question.get("header"),
                detail=question.get("detail"),
                options=question.get("options"),
                multi_select=bool(question.get("multiSelect")),
                line_label=f"{chat_id}/{thread_id}" if thread_id else chat_id,
            )
            # 发卡前等平台长连接就位：窗口期内点击会报「目标回调服务未在线」，
            # 卡虽发出但点击归途不通（附录 A 实证坑）。超时即按跳过收口。
            if not _wait_ws_ready(sender, platform):
                logger.warning(
                    "dsh-hermes-link: 平台长连接未就位，提问卡未发（按跳过收口）platform=%s", platform,
                )
                skipped = True
                break
            res = sender(platform, chat_id, thread_id, text, card=card)
            # 判据是**卡片真的发出去了**（sender 回落文本行时 via != adapter-card）：
            # 没有可点的卡就没有作答归途，此时等待毫无意义。
            if not (isinstance(res, dict) and res.get("ok") and res.get("via") == "adapter-card"):
                logger.warning(
                    "dsh-hermes-link: 提问卡未真正送达（%r），本次提问按跳过收口", res,
                )
                skipped = True
                break
            answer = slot.wait_for(qid)  # 零超时：只认「作答 / 跳过 / 槽位收场」
            if answer is None:
                logger.warning("dsh-hermes-link: 提问槽位被收场，本次提问按跳过收口 ask=%s", ask_id)
                skipped = True
                break
            if "skipped" in answer:
                skipped = True
                break
            item: Dict[str, Any] = {"id": qid, "selected": list(answer.get("selected") or [])}
            if answer.get("custom"):
                item["custom"] = answer["custom"]
            answers.append(item)
    except Exception as exc:  # 任何异常都不许把任务留在悬挂里
        logger.warning("dsh-hermes-link: 提问处理异常，按跳过收口: %s", exc)
        skipped = True
    finally:
        qna.discard_ask(ask_id)

    body = qna.answer_stream_body(
        task_id=task_id, context_id=context_id, ask_id=ask_id, answers=answers, skipped=skipped,
    )
    logger.info(
        "dsh-hermes-link: 提问续投 task=%s ask=%s skipped=%s 答数=%d",
        task_id, ask_id, skipped, len(answers),
    )
    return _open_continuation(url, body, headers, timeout, ask_id=ask_id)


def _open_continuation(
    url: str, body: Dict[str, Any], headers: Dict[str, str], timeout: int, *, ask_id: str,
) -> Optional[Iterator[Dict[str, Any]]]:
    """建立续投流并**有界重试**。

    续投是作答的**唯一**归途：请求打不开就等于答案没送达，而 dsh 侧的提问是零超时的
    ——那条 turn 会**永久挂起**。故这里必须有界重试（重试是安全的：服务端解挂按
    ``askId`` 幂等，重复续投只会被记为「未命中未决提问」）。三次都失败则如实告警，
    说明该 turn 需在 GUI 侧中止收口。

    ``iter_sse_data`` 是生成器：仅调用不发起请求，必须 ``next()`` 一次才真正建立连接，
    故这里显式取首帧（服务端续投流必然先发 task 快照，不会长等）。
    """
    last_error: Optional[BaseException] = None
    for attempt in range(1, _CONTINUATION_ATTEMPTS + 1):
        try:
            stream = iter_sse_data(url, body, headers, timeout)
            first = next(stream, None)
        except Exception as exc:
            last_error = exc
            logger.warning(
                "dsh-hermes-link: 续投流建立失败（第 %d/%d 次）ask=%s: %s",
                attempt, _CONTINUATION_ATTEMPTS, ask_id, exc,
            )
            if attempt < _CONTINUATION_ATTEMPTS:
                time.sleep(_CONTINUATION_RETRY_INTERVAL * attempt)
            continue
        if first is None:
            return iter(())
        return itertools.chain([first], stream)
    logger.warning(
        "dsh-hermes-link: 续投流 %d 次都未建立，本次作答没能送达服务端"
        "（dsh 侧提问仍挂起，需中止该 turn 收口）ask=%s last_error=%s",
        _CONTINUATION_ATTEMPTS, ask_id, last_error,
    )
    return None


def _send_aux_line(
    sender: Callable[..., Any], platform: str, chat_id: str, thread_id: str, text: str,
) -> None:
    """发一条辅助状态行（仅面板档使用）；失败只告警，不影响提问主链。"""
    try:
        res = sender(platform, chat_id, thread_id, text)
        if not (isinstance(res, dict) and res.get("ok")):
            logger.warning("dsh-hermes-link: 提问状态行未送达: %r", res)
    except Exception as exc:
        logger.warning("dsh-hermes-link: 提问状态行发送异常: %s", exc)


def _streaming_message_body(
    message: str, context_id: str, extra_metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """构造 SendStreamingMessage 的 params（user message + contextId + 问答能力声明）。

    A2A v1.0 Part 的 JSON 序列化用判别字段名（text / data，非 ``content.$case``）；
    Role 枚举 JSON 值为 ``ROLE_USER``；SDK 校验 ``SendStreamingMessage`` 要求
    ``message.messageId`` 非空。

    ``metadata["x-dsh-user-questions"]=true`` 是 §2.6 的**能力声明**：服务端只认领
    声明过的调用方的提问——否则提问会被挂到没有作答能力的客户端上，而问答零超时＝
    无声挂死。旧服务端不认识该键，直接忽略，故对既有链路零影响。

    ``extra_metadata`` 承载 §2.1/§2.4 的请求级选项（``x-dsh-workspace`` /
    ``x-dsh-sandbox``）；缺省 ``None`` 时与升级前逐字一致（只有能力声明那一个键）。
    """
    metadata: Dict[str, Any] = {QNA_OPT_IN_KEY: True}
    if extra_metadata:
        metadata.update(extra_metadata)
    return {
        "jsonrpc": "2.0",
        "id": _new_request_id(),
        "method": "SendStreamingMessage",
        "params": {
            "message": {
                "role": "ROLE_USER",
                "parts": [
                    {"text": message, "mediaType": "text/plain"},
                ],
                "messageId": uuid.uuid4().hex,
                "contextId": context_id,
                # 能力声明 + 请求级选项（工作区 / 沙箱档；缺省只有能力声明）
                "metadata": metadata,
            }
        },
    }


def consume_stream(
    url: str,
    token: str,
    message: str,
    context_id: str,
    platform: str,
    chat_id: str,
    thread_id: str,
    sender: Callable[..., Any],
    min_interval: float = 2.0,
    timeout: int = _DEFAULT_TIMEOUT,
    events: bool = DEFAULT_EVENTS,
    content: bool = DEFAULT_CONTENT,
    level: Optional[str] = None,
    card: Any = None,
    extra_metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """发 SendStreamingMessage → 解析 → 归一化 → 渲染 → 节流 → 发送，返回统计。

    ``events`` 控制「中间事件」是否推送：``False`` 时只推最终结果（final 文本 /
    终态 status），中间事件（工具调用 / 中间文本 / thinking / 状态行）跳过渲染与
    发送，但仍完整记录 stats（final_text / states / events_seen 不丢）。
    ``content``（遗留布尔）与 ``level``（四档，优先）经 ``resolve_live_detail`` 解析为
    渲染档位：``content=False`` ≡ ``standard``、``content=True`` ≡ ``detailed``；显式
    ``level``（compact/standard/detailed/verbose）优先于 ``content``。四档统一把一轮内的
    工具步骤与思考收口为一条 dsh 形态过程组消息（``render_process_group``：组头行 +
    步骤行 + 思考行，**无代码框**），``render_line`` 不再为 tool_call / tool_result /
    thinking 产出单独行；叙述 / final 文本按原样 markdown 推送，``turn_end`` / 终态
    status 产出收束行（``render_turn_close``，一轮一条）。stats 完整性不受档位影响
    （final_text / events_seen / states 仍完整统计，供上层「📬 最终结果送达」使用）。

    返回 ``{"final_text": str, "events_seen": int, "messages_sent": int,
    "states": [...], "message_ids": [...]}``。全程 try/except 兜底，单个事件解析失败
    不影响整体。

    ``card`` 为 ``collector.card``：``off``（默认）/ ``panel``。``panel`` 时 **dsh 流出的
    全部内容**都改由卡片承载（过程组 2.0 折叠卡 ``render_process_group_card``；叙述 /
    直播 final 文本 / 收束行为简约卡 ``render_plain_card``；最终结果的结果卡在
    ``_deliver_final_result`` 侧，与本函数共用同一 ``make_sender``），**文本行一律保留为
    回退层**（卡片发送失败即回落，不丢信息）。两条链（直播 ``_stream_dsh_call`` / 结果
    送达 ``_deliver_final_result``）共用同一个 ``make_sender``，故都具备发卡能力。
    """
    mode = resolve_live_detail(content, level)
    card_mode = resolve_card_mode(card)
    stats: Dict[str, Any] = {
        "final_text": "",
        "events_seen": 0,
        "messages_sent": 0,
        "states": [],
        # 终态失败/取消时服务端给出的原因（取不到则空串）；供上层如实转述而不是"无文本输出"。
        "failure_reason": "",
        # 发出去的 message_id 列表（plan §4.2 第 1 条：更新类方案的唯一前置）。
        "message_ids": [],
    }

    headers: Dict[str, str] = {"A2A-Version": A2A_PROTOCOL_VERSION}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    throttler = Throttler(min_interval=min_interval, level=mode, card=card_mode)
    try:
        # §2.6：包一层可续接迭代器——提问答完后把「续投流」拼到当前流尾部，于是首跳
        # 解挂后的后续事件（artifact/completed）仍由本循环消费，任务收尾逻辑零改动。
        qna = _import_qna()
        # §2.1/§2.4：请求级选项随首投报文 metadata 带给服务端（缺省不传＝现状）
        body = _streaming_message_body(message, context_id, extra_metadata)
        results = qna.ResumableStream(iter_sse_data(url, body, headers, timeout))
        for event in normalize_events(results):
            try:
                stats["events_seen"] += 1
                # 问答必须**先于**任何门控处理：安静模式（events=false）会跳过中间事件，
                # 而提问无人作答题就永远不续跑——那正是「全程零超时」下的死结。
                if event.get("type") == "question":
                    resumed = _handle_question_event(
                        event,
                        url=url,
                        context_id=context_id,
                        platform=platform,
                        chat_id=chat_id,
                        thread_id=thread_id,
                        sender=sender,
                        headers=headers,
                        timeout=timeout,
                        card_mode=card_mode,
                    )
                    if resumed is not None:
                        results.resume(resumed)
                    continue
                if event.get("type") == "status":
                    stats["states"].append(event.get("state"))
                    if event.get("state") in ("failed", "canceled") and event.get("message"):
                        stats["failure_reason"] = event["message"]
                if event.get("type") == "text" and event.get("final"):
                    stats["final_text"] = event.get("text") or ""
                # 安静模式（events=false）：跳过中间事件，只推最终结果（final 文本 / 终态 status）。
                if not events and not _is_final_event(event):
                    continue
                # 内容/档位（content / level）只决定组成员密度与 text 截断口径，由
                # render_line / render_process_group 在各自分支处理；叙述流（text）
                # 与轮次事件照常走 feed，因此这里不再跳过任何事件类型。
                line = render_line(event, level=mode)
                for item in throttler.feed(event, line):
                    # 过程组项可能是 ``CardMessage``（带 .card）；叙述 / 收束 / final
                    # 恒为普通 str。**不改消息语义**：card=None 时调用签名与 v0.7.0 完全
                    # 一致（4 个位置参数），既有 sender 不受影响。
                    item_card = getattr(item, "card", None)
                    if item_card is None:
                        res = sender(platform, chat_id, thread_id, item)
                    else:
                        res = sender(platform, chat_id, thread_id, item, card=item_card)
                    if isinstance(res, dict) and not res.get("ok"):
                        logger.warning(
                            "dsh-hermes-link: send not delivered: %s", res.get("error")
                        )
                    else:
                        stats["messages_sent"] += 1
                    if isinstance(res, dict) and res.get("message_id"):
                        stats["message_ids"].append(res["message_id"])
            except Exception as exc:  # 单事件失败不影响整体
                logger.warning(
                    "dsh-hermes-link: event %r failed: %s", event, exc
                )
    except Exception as exc:  # 打开 / 迭代流失败（网络等）
        logger.warning("dsh-hermes-link: stream aborted: %s", exc)
    return stats

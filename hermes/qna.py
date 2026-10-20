"""dsh-hermes-link — §2.6 交互问答桥接（问题卡 · 作答登记表 · 续投资料）.

三块职责，全部纯标准库、零 gateway 依赖，故可直接单测：

1. **问题卡**（``build_question_card``）：把服务端 ``question`` 载荷渲染成飞书
   **2.0** 交互卡——选项按钮 + 自由输入框 + 提交/跳过；卡片版本铁律（2.0 ↔ 2.0
   响应卡，跨版本客户端报 ``200830``）与平台预算（卡 ≤30KB、≤200 组件、按钮文案
   ≤100 字、输入 ``max_length`` ≤1000）在本模块统一守住。
2. **作答登记表**（``register_ask`` / ``handle_card_action`` / ``AskSlot.wait_for``）：
   发卡线程按 ``ask_id`` 登记一个等待槽位；适配器补丁收到点击后调
   ``handle_card_action`` 就地投递并返回「已作答」换卡；等待**零超时**——只有
   「作答 / 跳过 / 进程收场」三种出口。
3. **续投资料**（``answer_stream_body``）：把结构化作答编成
   ``SendStreamingMessage`` 的 params（message 带 ``taskId`` + ``question-answer``
   Data Part），即 A2A 原生「input-required → 续投」归途的报文体。

通路定型（2026-10-17 管理员批）：点击走**同进程直连**（适配器处理器表 → 本模块），
不落盘、不轮询；回注走 **A2A 原生 input-required + taskId 续投**。
"""

from __future__ import annotations

import itertools
import json
import logging
import sys
import threading
import types
import uuid
from typing import Any, Dict, Iterable, List, Optional

logger = logging.getLogger(__name__)

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

# 适配器分支判据：正式命名空间（试验钩子用 hermes_qa_card_action，已废弃）
ASK_ACTION_KEY = _P.CARD_ACTION_KEY
# 卡片预算（附录 A 硬规则）
MAX_CARD_BYTES = 30720
MAX_CARD_COMPONENTS = 200
MAX_BUTTON_TEXT = 100
MAX_INPUT_LENGTH = 1000
# 输入框里把多项拆开的常见分隔符（多选降级路径、手输多值）
_MULTI_SEPARATORS = ("、", ",", "，", ";", "；", "|", "/")


# --------------------------------------------------------------------------
# 1. 问题卡（飞书 Card JSON 2.0）
# --------------------------------------------------------------------------

def _plain(text: str) -> Dict[str, Any]:
    return {"tag": "plain_text", "content": text}


def _clip(text: str, limit: int) -> str:
    """按字符数截断（平台按字符计文案上限）；超限加省略号，便于人看出被截。"""
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)] + "…"


def _button(
    *, name: str, text: str, value: Dict[str, Any], btype: str = "default",
) -> Dict[str, Any]:
    """一张表单内的一次性提交按钮（沿试验卡实证形状：form_action_type=submit）。"""
    return {
        "tag": "button",
        "name": name,
        "type": btype,
        "width": "fill",
        "text": _plain(_clip(text, MAX_BUTTON_TEXT)),
        "behaviors": [{"type": "callback", "value": value}],
        "form_action_type": "submit",
    }


def component_count(node: Any) -> int:
    """粗略统计卡内组件数（按 tag 计），用于预算守卫。"""
    if isinstance(node, dict):
        count = 1 if "tag" in node else 0
        return count + sum(component_count(v) for v in node.values())
    if isinstance(node, list):
        return sum(component_count(v) for v in node)
    return 0


def card_bytes(card: Dict[str, Any]) -> int:
    """卡片序列化字节数（飞书上限 30720 字节，按 UTF-8 计）。"""
    return len(json.dumps(card, ensure_ascii=False).encode("utf-8"))


def build_question_card(
    *,
    ask_id: str,
    qid: str,
    question: str,
    index: int = 1,
    total: int = 1,
    header: Optional[str] = None,
    detail: Optional[str] = None,
    options: Optional[Iterable[Dict[str, Any]]] = None,
    multi_select: bool = False,
    line_label: str = "",
) -> Dict[str, Any]:
    """渲染一张提问卡：题目 + 选项按钮 + 自由输入 + 提交/跳过。

    - ``index``/``total`` > 1 时标题带「第 n/N 题」，多问题走**逐题**（一题一卡）；
    - 选项按钮的 ``choice`` 是**序号**（"1"/"2"…），``label`` 是按钮显示文案——
      取值映射由登记表侧的题目载荷完成，卡片本身不承载业务语义；
    - ``multi_select`` 为真时如实标注「可多选：点一项，或在输入框用顿号/逗号分隔多项」
      （飞书勾选组件的跨版本风险未知，v1 不做勾选面，见模块末「已知边界」）。
    """
    lines: List[str] = []
    if header:
        lines.append(f"**{header}**")
    lines.append(question if not detail else f"{question}\n\n{detail}")
    if multi_select:
        lines.append("\n_（多选）可点一项，或在输入框用顿号/逗号分隔多项后提交。_")
    lines.append("\n作答后本卡会就地变为「已作答」；不设时限，慢慢来。")

    title = "❓ 需要您作答"
    if total > 1:
        title = f"❓ 需要您作答（第 {index}/{total} 题）"
    if line_label:
        title = f"{title} · {_clip(line_label, 40)}"

    elements: List[Dict[str, Any]] = [{"tag": "markdown", "content": "\n".join(lines)}]

    form_elements: List[Dict[str, Any]] = [
        {
            "tag": "input",
            "name": f"qa_input_{qid}",
            "placeholder": _plain("也可以在这里输入自由文字，然后点「提交」"),
            "max_length": MAX_INPUT_LENGTH,
            "label": _plain("自由输入"),
        }
    ]
    for i, option in enumerate(options or [], start=1):
        label = str((option or {}).get("label") or "").strip()
        if not label:
            continue
        description = str((option or {}).get("description") or "").strip()
        display = f"{i} · {label}"
        if description:
            display = f"{display}（{description}）"
        form_elements.append(
            _button(
                name=f"qa_opt_{qid}_{i}",
                text=display,
                btype="primary" if i == 1 else "default",
                value={
                    ASK_ACTION_KEY: "pick",
                    "ask_id": ask_id,
                    "qid": qid,
                    "choice": str(i),
                    "label": _clip(display, MAX_BUTTON_TEXT),
                },
            )
        )
    form_elements.append(
        {
            "tag": "column_set",
            "columns": [
                {
                    "tag": "column",
                    "width": "auto",
                    "elements": [
                        _button(
                            name=f"qa_submit_{qid}",
                            text="提交",
                            btype="primary",
                            value={ASK_ACTION_KEY: "submit", "ask_id": ask_id, "qid": qid},
                        )
                    ],
                },
                {
                    "tag": "column",
                    "width": "auto",
                    "elements": [
                        _button(
                            name=f"qa_skip_{qid}",
                            text="跳过",
                            value={ASK_ACTION_KEY: "skip", "ask_id": ask_id, "qid": qid},
                        )
                    ],
                },
            ],
        }
    )
    elements.append({"tag": "form", "name": f"qa_form_{qid}", "elements": form_elements})

    card = {
        "schema": "2.0",
        "header": {"template": "blue", "title": _plain(title)},
        "body": {"elements": elements},
    }
    return guard_card(card)


def guard_card(card: Dict[str, Any], *, context: str = "question") -> Dict[str, Any]:
    """预算守卫：超限只响亮告警并返回原卡（绝不静默丢内容，也绝不悄悄改语义）。

    出卡路径的兜底由调用方决定（发卡失败即回落文本行，V5 降级链在 sender 侧）。
    """
    size = card_bytes(card)
    components = component_count(card)
    if size > MAX_CARD_BYTES:
        logger.warning(
            "dsh-hermes-link: %s 卡超字节预算 %d/%d——平台可能拒收", context, size, MAX_CARD_BYTES
        )
    if components > MAX_CARD_COMPONENTS:
        logger.warning(
            "dsh-hermes-link: %s 卡超组件预算 %d/%d——平台可能拒收",
            context, components, MAX_CARD_COMPONENTS,
        )
    return card


def ack_card(*, title: str, body: str, template: str = "green") -> Dict[str, Any]:
    """就地换卡用的 2.0 响应卡（必须同为 2.0，否则客户端报 200830）。"""
    return {
        "schema": "2.0",
        "header": {"template": template, "title": _plain(_clip(title, 100))},
        "body": {"elements": [{"tag": "markdown", "content": body}]},
    }


# --------------------------------------------------------------------------
# 2. 作答登记表（ask_id → 等待槽位）
# --------------------------------------------------------------------------

class AskSlot:
    """一次 ``ask_user_question`` 调用对应的等待槽位（可含多题，逐题作答）。"""

    def __init__(self, ask_id: str, questions: List[Dict[str, Any]]) -> None:
        self.ask_id = ask_id
        self.questions = questions
        self._cond = threading.Condition()
        self._answers: Dict[str, Dict[str, Any]] = {}   # qid -> {selected, custom, by}
        self._skipped: Dict[str, str] = {}              # qid -> operator
        self._closed = False

    # ── 查询 ──
    def answered(self, qid: str) -> bool:
        with self._cond:
            return qid in self._answers or qid in self._skipped

    def option_labels(self, qid: str) -> List[str]:
        for question in self.questions:
            if str(question.get("id")) == qid:
                return [
                    str((option or {}).get("label") or "").strip()
                    for option in question.get("options") or []
                    if str((option or {}).get("label") or "").strip()
                ]
        return []

    # ── 投递（适配器补丁线程调用，必须立即返回） ──
    def deliver_choice(self, *, qid: str, selected: List[str], custom: Optional[str], by: str) -> bool:
        with self._cond:
            if self._closed or qid in self._answers:
                return False
            self._answers[qid] = {"selected": list(selected), "custom": custom, "by": by}
            self._cond.notify_all()
            return True

    def deliver_skip(self, *, qid: str, by: str) -> bool:
        with self._cond:
            if self._closed or qid in self._answers or qid in self._skipped:
                return False
            self._skipped[qid] = by
            self._cond.notify_all()
            return True

    def close(self) -> None:
        """进程收场 / 放弃本次提问：唤醒所有等待者（等待者据此收工，不悬挂）。"""
        with self._cond:
            self._closed = True
            self._cond.notify_all()

    # ── 等待（发卡线程调用；零超时） ──
    def wait_for(self, qid: str) -> Optional[Dict[str, Any]]:
        """挂起直到该题被作答/跳过/收场。

        @returns ``{"skipped": by}``（跳过）、``{"selected": [...], "custom": ..., "by": ...}``
                 （作答），或 ``None``（槽位被收场——调用方据此中止整次提问）。
        """
        with self._cond:
            while True:
                if qid in self._skipped:
                    return {"skipped": self._skipped[qid]}
                if qid in self._answers:
                    return self._answers[qid]
                if self._closed:
                    return None
                self._cond.wait()

    def snapshot(self) -> Dict[str, Any]:
        with self._cond:
            return {"answers": dict(self._answers), "skipped": dict(self._skipped), "closed": self._closed}


_REGISTRY_MODULE = "hermes_a2a_bridge_qna_registry"


def _shared_registry() -> Any:
    """进程级共享的登记表容器（``{slots, lock}``）。

    为什么不是模块级全局 dict：qna 可能被加载成**两份实例**（外部清理 ``sys.modules``
    别名、桥内两条加载器各回退到文件路径）。模块级 dict 会各持一份，适配器补丁投进来的
    点击就落不到发卡线程等的那个槽位上——表现为「点了没反应、任务永久挂起」。把容器挂在
    固定的 ``sys.modules`` 条目上，则**无论 qna 被加载几次，登记表只有一个**。
    """
    module = sys.modules.get(_REGISTRY_MODULE)
    if module is None:
        candidate = types.ModuleType(_REGISTRY_MODULE)
        candidate.slots = {}
        candidate.lock = threading.Lock()
        # dict.setdefault 是原子操作：两线程同时首建时也只会有一个容器胜出
        module = sys.modules.setdefault(_REGISTRY_MODULE, candidate)
    return module


def register_ask(slot: AskSlot) -> None:
    registry = _shared_registry()
    with registry.lock:
        registry.slots[slot.ask_id] = slot


def discard_ask(ask_id: str) -> None:
    registry = _shared_registry()
    with registry.lock:
        slot = registry.slots.pop(ask_id, None)
    if slot is not None:
        slot.close()


def lookup_ask(ask_id: str) -> Optional[AskSlot]:
    registry = _shared_registry()
    with registry.lock:
        return registry.slots.get(ask_id)


def pending_ask_ids() -> List[str]:
    registry = _shared_registry()
    with registry.lock:
        return list(registry.slots.keys())


def close_all() -> None:
    """收场：放行全部等待者，绝不悬挂。

    调用点现状（如实）：网关侧**没有插件卸载/关停钩子**可接，故生产路径上只有进程退出会
    走到（等待中的发卡线程是 daemon，进程结束即终）；本函数当前供测试与将来的收场面使用。
    跨进程重启导致登记表丢失的情形见模块末「已知边界 2」。
    """
    registry = _shared_registry()
    with registry.lock:
        slots = list(registry.slots.values())
        registry.slots.clear()
    for slot in slots:
        slot.close()


# --------------------------------------------------------------------------
# 3. 点击解码 + 就地换卡（适配器补丁的处理器实现）
# --------------------------------------------------------------------------

def decode_choice(*, action_value: Dict[str, Any], form_value: Any, option_labels: List[str]) -> Dict[str, Any]:
    """把一次点击解成 ``{"kind": pick|submit|skip, "selected": [...], "custom": str|None}``。

    规则（与 dsh ``ask_user_question`` 的作答形状对齐）：
    - 选项按钮：``choice`` 是选项序号（1 起）→ 映射回选项 label；
    - 提交：输入框文字**先按选项 label 精确匹配**（多选还会按顿号/逗号拆开逐项匹配），
      匹配不上就整段作为 ``custom`` 自由输入；输入为空则是合法的「空提交」；
    - 跳过：``kind="skip"``（语义＝用户不答，由服务端把提问以中止收口）。
    """
    action = str((action_value or {}).get(ASK_ACTION_KEY) or "")
    raw_input = ""
    if isinstance(form_value, dict):
        for key, value in form_value.items():
            if str(key).startswith("qa_input_"):
                raw_input = str(value or "").strip()
                break

    if action == "skip":
        return {"kind": "skip", "selected": [], "custom": None}
    if action == "pick":
        choice = str((action_value or {}).get("choice") or "").strip()
        selected: List[str] = []
        if choice.isdigit():
            idx = int(choice)
            if 1 <= idx <= len(option_labels):
                selected = [option_labels[idx - 1]]
        elif choice in option_labels:
            selected = [choice]
        if not selected:
            # 选项按钮却解析不出选项（越界序号 / 未知标签）：**响亮拒绝**，绝不悄悄降级
            # 成「空提交」——那会把一次无效点击记成用户主动不选。
            return {"kind": "invalid", "selected": [], "custom": None}
        return {"kind": "pick", "selected": selected, "custom": raw_input or None}

    # submit（含空提交）
    if not raw_input:
        return {"kind": "submit", "selected": [], "custom": None}
    if raw_input in option_labels:
        return {"kind": "submit", "selected": [raw_input], "custom": None}
    parts = [raw_input]
    for separator in _MULTI_SEPARATORS:
        if separator in raw_input:
            parts = [p.strip() for p in raw_input.split(separator)]
            break
    matched = [p for p in parts if p and p in option_labels]
    if matched and len(matched) == len([p for p in parts if p]):
        return {"kind": "submit", "selected": matched, "custom": None}
    return {"kind": "submit", "selected": [], "custom": raw_input}


def handle_card_action(payload: Dict[str, Any]) -> Dict[str, Any]:
    """适配器补丁的处理器：解码点击 → 投递给等待槽位 → 返回**就地换卡的 2.0 响应卡**。

    ``payload`` 由补丁组装（``action_value`` / ``action_form_value`` / ``operator_open_id``
    / ``chat_id`` / ``message_id`` / ``event_token``）。本函数**立即返回**，绝不阻塞
    回调线程——真正的续跑发生在等待该槽位的发卡线程里。

    认不出/已过期的 ask_id 一律响亮告警并如实换卡，绝不假装成功。
    """
    action_value = payload.get("action_value") if isinstance(payload.get("action_value"), dict) else {}
    form_value = payload.get("action_form_value")
    ask_id = str(action_value.get("ask_id") or "")
    qid = str(action_value.get("qid") or "")
    by = str(payload.get("operator_open_id") or "") or "<unknown>"

    slot = lookup_ask(ask_id) if ask_id else None
    if slot is None:
        logger.warning(
            "dsh-hermes-link: 收到未知/已过期提问卡的点击 ask_id=%r qid=%r operator=%s",
            ask_id, qid, by,
        )
        return ack_card(
            title="⌛ 该提问已失效",
            body="未被采纳：提问已结束或卡片已过期（桥侧无对应等待槽位）。",
            template="orange",
        )

    decoded = decode_choice(
        action_value=action_value, form_value=form_value, option_labels=slot.option_labels(qid)
    )
    if decoded["kind"] == "invalid":
        logger.warning(
            "dsh-hermes-link: 提问卡点击的选项无法识别（越界序号/未知标签），已拒绝 ask_id=%r qid=%r "
            "choice=%r label=%r operator=%s",
            ask_id, qid, action_value.get("choice"), action_value.get("label"), by,
        )
        return ack_card(
            title="⚠ 选项无法识别",
            body="未被采纳：这次点击的选项解析不出来（卡片可能已失效）。"
                 "若该任务仍在等作答，请用最新一张提问卡作答——本卡已不再接受点击。",
            template="red",
        )
    if decoded["kind"] == "skip":
        delivered = slot.deliver_skip(qid=qid, by=by)
        shown = "⏭ 已跳过"
        body = "本题已跳过；提问将以「用户跳过」收口。"
    else:
        delivered = slot.deliver_choice(
            qid=qid, selected=decoded["selected"], custom=decoded["custom"], by=by
        )
        shown = "✅ 已作答"
        body = _answer_summary(decoded)
    if not delivered:
        logger.warning(
            "dsh-hermes-link: 重复/失效点击被忽略 ask_id=%r qid=%r operator=%s", ask_id, qid, by,
        )
        return ack_card(title="✅ 已作答（重复点击已忽略）", body="本题此前已作答，本次点击未生效。", template="grey")
    logger.info(
        "dsh-hermes-link: 提问作答回传 ask_id=%s qid=%s kind=%s selected=%s custom=%r by=%s",
        ask_id, qid, decoded["kind"], decoded["selected"],
        (decoded["custom"] or "")[:60], by,
    )
    return ack_card(title=shown, body=body)


def _answer_summary(decoded: Dict[str, Any]) -> str:
    selected = decoded.get("selected") or []
    custom = decoded.get("custom")
    if selected and custom:
        return f"选择：{ '、'.join(selected) }\n\n输入：{custom}"
    if selected:
        return f"选择：{ '、'.join(selected) }"
    if custom:
        return f"输入：{custom}"
    return "空提交（未选择也未输入）。"


# --------------------------------------------------------------------------
# 4. 续投资料（A2A 原生 input-required → taskId 续投）
# --------------------------------------------------------------------------

def answer_stream_body(
    *,
    task_id: str,
    context_id: str,
    ask_id: str,
    answers: List[Dict[str, Any]],
    skipped: bool = False,
) -> Dict[str, Any]:
    """构造续投的**完整 JSON-RPC 报文**（与 ``_streaming_message_body`` 同形）。

    同一 ``taskId`` 的续投 + 作答载荷。

    - ``message.taskId`` 是 A2A 续投的受理依据（服务端 ``_createRequestContext`` 要求
      该任务非终态；问答挂起时任务为 input-required，正合条件）；
    - ``parts`` 第一段是 ``question-answer`` **Data Part**（服务端机器可读），第二段是
      人读摘要（进 task.history，便于事后对账）；
    - 跳过时带 ``skipped=true``，服务端把该提问以「用户跳过」中止收口。
    """
    payload: Dict[str, Any] = {
        "kind": _P.KIND_QUESTION_ANSWER, _P.FIELD_ASK_ID: ask_id, _P.FIELD_ANSWERS: answers,
    }
    if skipped:
        payload[_P.FIELD_SKIPPED] = True
    summary = "跳过作答" if skipped else "；".join(
        f"{a.get('id')}: {'、'.join(a.get('selected') or []) or (a.get('custom') or '空')}"
        for a in answers
    )
    message: Dict[str, Any] = {
        "role": "ROLE_USER",
        "parts": [
            {"data": payload, "mediaType": "application/json"},
            {"text": f"[作答] {summary}", "mediaType": "text/plain"},
        ],
        "messageId": uuid.uuid4().hex,
        "taskId": task_id,
    }
    if context_id:
        message["contextId"] = context_id
    return {
        "jsonrpc": "2.0",
        "id": f"req-{uuid.uuid4().hex}",
        "method": "SendStreamingMessage",
        "params": {"message": message},
    }


class ResumableStream:
    """可续接的结果迭代器：答完提问后把「续投流」拼到当前流尾部。

    这样上层的 ``for event in normalize_events(...)`` 不必重入就能继续消费首跳
    解挂后的后续事件（服务端把首跳后续事件发在续投那条流上）。
    """

    def __init__(self, stream: Iterable[Dict[str, Any]]) -> None:
        self._stream: Iterable[Dict[str, Any]] = iter(stream)

    def __iter__(self) -> "ResumableStream":
        return self

    def __next__(self) -> Dict[str, Any]:
        return next(self._stream)

    def resume(self, stream: Iterable[Dict[str, Any]]) -> None:
        self._stream = itertools.chain(self._stream, stream)


# --------------------------------------------------------------------------
# 已知边界（如实登记，不在本轮扩面）
# --------------------------------------------------------------------------
# 1. ``multi_select`` 不作勾选组件：只在卡面标注「可多选」并支持输入框顿号/逗号分隔
#    多项（飞书勾选组件的 2.0 schema 未实测，贸然用会踩版本坑）。验收清单未含此格。
# 2. 桥进程重启会丢掉登记表：正在进行中的提问将无法从飞书作答（dsh 侧仍按零超时
#    挂着），需在 GUI 侧中止该 turn 收口。落盘 spool 兜底未建（避免预设无用面）。
# 3. 同一会话并发多个 A2A 任务时的提问归属有歧义（服务端按 agent 认领），v1 未覆盖。

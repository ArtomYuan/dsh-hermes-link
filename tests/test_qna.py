"""§2.6 交互问答桥接（qna.py）单测：问题卡形状 / 作答解码 / 零悬挂等待 / 续投报文。

运行方式
--------
    python3 tests/test_qna.py

覆盖四块最容易悄悄坏掉的面：
- **卡面铁律**：2.0 结构（换卡报 200830 的根因）、按钮文案 ≤100 字、输入 max_length
  ≤1000、卡预算守卫、选项按钮回传值带全正式命名空间字段；
- **作答解码**：选项序号→label、手输（带字）、空提交、跳过、多选自拆、自由输入；
- **等待零悬挂**：只有「作答 / 跳过 / 收场」三种出口，``wait_for`` 不设超时；
- **续投报文**：``taskId`` + ``question-answer`` Data Part（服务端机器可读的那一段）。
"""

import importlib.util
import json
import os
import unittest

_WORKTREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location("hermes_a2a_bridge_qna", os.path.join(_WORKTREE, "qna.py"))
qna = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(qna)

# 日志断言必须打在模块真实 logger 上（按文件路径加载时 __name__ 不是包名）
_LOGGER = qna.logger.name


def _collect_buttons(node, out=None):
    """递归收集卡内按钮文案（顺序即卡面顺序）。"""
    out = [] if out is None else out
    if isinstance(node, dict):
        if node.get("tag") == "button":
            out.append(node.get("text", {}).get("content", ""))
        for value in node.values():
            _collect_buttons(value, out)
    elif isinstance(node, list):
        for value in node:
            _collect_buttons(value, out)
    return out


def _count_buttons(node):
    """递归数卡内按钮（提交/跳过嵌在 column_set 里，不是 form 的直接子元素）。"""
    if isinstance(node, dict):
        own = 1 if node.get("tag") == "button" else 0
        return own + sum(_count_buttons(v) for v in node.values())
    if isinstance(node, list):
        return sum(_count_buttons(v) for v in node)
    return 0

QUESTIONS = [
    {
        "id": "q1",
        "question": "走哪条路？",
        "header": "通路",
        "detail": "细节一行",
        "options": [{"label": "甲路", "description": "更稳"}, {"label": "乙路"}],
    }
]


def make_card(**overrides):
    kwargs = dict(
        ask_id="ask-1",
        qid="q1",
        question="走哪条路？",
        index=1,
        total=1,
        options=[{"label": "甲路", "description": "更稳"}, {"label": "乙路"}],
    )
    kwargs.update(overrides)
    return qna.build_question_card(**kwargs)


class QuestionCardTest(unittest.TestCase):
    def test_card_is_2_0_with_form_input_and_three_actions(self):
        card = make_card(header="通路", detail="细节一行", line_label="feishu/oc_x/omt_y")
        self.assertEqual(card["schema"], "2.0")
        self.assertEqual(card["header"]["template"], "blue")
        form = card["body"]["elements"][-1]
        self.assertEqual(form["tag"], "form")
        tags = [e["tag"] for e in form["elements"]]
        self.assertIn("input", tags)
        self.assertEqual(_count_buttons(card), 4)  # 2 选项 + 提交 + 跳过

        texts = _collect_buttons(form)
        self.assertTrue(any("提交" == t for t in texts))
        self.assertTrue(any("跳过" == t for t in texts))
        self.assertTrue(any(t.startswith("1 · 甲路") for t in texts))

        markdown = card["body"]["elements"][0]["content"]
        self.assertIn("走哪条路？", markdown)
        self.assertIn("细节一行", markdown)
        self.assertIn("不设时限", markdown)
        title = card["header"]["title"]["content"]
        self.assertIn("需要您作答", title)
        self.assertNotIn("第 1/1", title)  # 单题不带序号
        self.assertIn("feishu/oc_x/omt_y", title)

    def test_input_cap_and_button_text_cap(self):
        long_question = "题" * 300
        card = make_card(question=long_question, options=[{"label": "选" * 300}])
        form = card["body"]["elements"][-1]
        input_el = next(e for e in form["elements"] if e["tag"] == "input")
        self.assertEqual(input_el["max_length"], qna.MAX_INPUT_LENGTH)
        self.assertLessEqual(qna.MAX_INPUT_LENGTH, 1000)
        for element in form["elements"]:
            if element["tag"] == "button":
                self.assertLessEqual(len(element["text"]["content"]), qna.MAX_BUTTON_TEXT)

    def test_button_values_carry_formal_namespace(self):
        card = make_card()
        buttons = [e for e in card["body"]["elements"][-1]["elements"] if e["tag"] == "button"]
        for button in buttons:
            value = button["behaviors"][0]["value"]
            self.assertEqual(value[qna.ASK_ACTION_KEY] in ("pick", "submit", "skip"), True)
            self.assertEqual(value["ask_id"], "ask-1")
            self.assertEqual(value["qid"], "q1")
        pick = next(
            e for e in buttons
            if e["behaviors"][0]["value"][qna.ASK_ACTION_KEY] == "pick"
        )
        self.assertEqual(pick["behaviors"][0]["value"]["choice"], "1")
        self.assertEqual(pick["behaviors"][0]["value"]["label"], "1 · 甲路（更稳）")

    def test_multi_question_title_and_multiselect_note(self):
        card = make_card(index=2, total=3, multi_select=True)
        self.assertIn("第 2/3 题", card["header"]["title"]["content"])
        self.assertIn("多选", card["body"]["elements"][0]["content"])

    def test_guard_warns_on_oversize_but_returns_card(self):
        huge = make_card(question="长" * 40000)
        with self.assertLogs(_LOGGER, level="WARNING") as logs:
            returned = qna.guard_card(huge)
        self.assertIs(returned, huge)
        self.assertTrue(any("超字节预算" in line for line in logs.output))
        self.assertGreater(qna.card_bytes(huge), qna.MAX_CARD_BYTES)

    def test_ack_card_is_2_0(self):
        card = qna.ack_card(title="✅ 已作答", body="选择：甲路")
        self.assertEqual(card["schema"], "2.0")
        self.assertEqual(card["header"]["template"], "green")


class DecodeChoiceTest(unittest.TestCase):
    labels = ["甲路", "乙路"]

    def test_pick_by_index(self):
        decoded = qna.decode_choice(
            action_value={qna.ASK_ACTION_KEY: "pick", "choice": "2", "label": "2 · 乙路"},
            form_value={"qa_input_q1": ""},
            option_labels=self.labels,
        )
        self.assertEqual(decoded["kind"], "pick")
        self.assertEqual(decoded["selected"], ["乙路"])
        self.assertIsNone(decoded["custom"])

    def test_pick_with_typed_text_keeps_both(self):
        decoded = qna.decode_choice(
            action_value={qna.ASK_ACTION_KEY: "pick", "choice": "1"},
            form_value={"qa_input_q1": "补充说明"},
            option_labels=self.labels,
        )
        self.assertEqual(decoded["selected"], ["甲路"])
        self.assertEqual(decoded["custom"], "补充说明")

    def test_submit_matching_label(self):
        decoded = qna.decode_choice(
            action_value={qna.ASK_ACTION_KEY: "submit"},
            form_value={"qa_input_q1": "乙路"},
            option_labels=self.labels,
        )
        self.assertEqual(decoded, {"kind": "submit", "selected": ["乙路"], "custom": None})

    def test_submit_multiple_by_separator(self):
        decoded = qna.decode_choice(
            action_value={qna.ASK_ACTION_KEY: "submit"},
            form_value={"qa_input_q1": "甲路、乙路"},
            option_labels=self.labels,
        )
        self.assertEqual(decoded["selected"], ["甲路", "乙路"])
        self.assertIsNone(decoded["custom"])

    def test_submit_free_text_is_custom(self):
        decoded = qna.decode_choice(
            action_value={qna.ASK_ACTION_KEY: "submit"},
            form_value={"qa_input_q1": "都不选，走第三条路"},
            option_labels=self.labels,
        )
        self.assertEqual(decoded["selected"], [])
        self.assertEqual(decoded["custom"], "都不选，走第三条路")

    def test_empty_submit_and_skip(self):
        empty = qna.decode_choice(
            action_value={qna.ASK_ACTION_KEY: "submit"}, form_value={"qa_input_q1": "  "}, option_labels=self.labels,
        )
        self.assertEqual(empty, {"kind": "submit", "selected": [], "custom": None})
        skip = qna.decode_choice(
            action_value={qna.ASK_ACTION_KEY: "skip"}, form_value=None, option_labels=self.labels,
        )
        self.assertEqual(skip, {"kind": "skip", "selected": [], "custom": None})

    def test_pick_with_out_of_range_choice_is_rejected(self):
        """选项按钮却解析不出选项 → 明确拒绝，绝不悄悄当成空提交。"""
        out_of_range = qna.decode_choice(
            action_value={qna.ASK_ACTION_KEY: "pick", "choice": "9"}, form_value=None, option_labels=self.labels,
        )
        self.assertEqual(out_of_range, {"kind": "invalid", "selected": [], "custom": None})
        unknown_label = qna.decode_choice(
            action_value={qna.ASK_ACTION_KEY: "pick", "choice": "丙路"}, form_value=None, option_labels=self.labels,
        )
        self.assertEqual(unknown_label["kind"], "invalid")

    def test_handle_card_action_rejects_invalid_choice_without_delivering(self):
        slot = qna.AskSlot("ask-invalid", QUESTIONS)
        qna.register_ask(slot)
        try:
            with self.assertLogs(_LOGGER, level="WARNING") as logs:
                card = qna.handle_card_action(
                    {
                        "action_value": {qna.ASK_ACTION_KEY: "pick", "ask_id": "ask-invalid", "qid": "q1", "choice": "9"},
                        "action_form_value": {},
                        "operator_open_id": "ou_op",
                    }
                )
            self.assertEqual(card["header"]["template"], "red")
            self.assertTrue(any("无法识别" in line for line in logs.output))
            self.assertFalse(slot.answered("q1"), "无效点击不得记成作答")
        finally:
            qna.discard_ask("ask-invalid")

    def test_partial_match_falls_back_to_custom(self):
        decoded = qna.decode_choice(
            action_value={qna.ASK_ACTION_KEY: "submit"},
            form_value={"qa_input_q1": "甲路、张三"},
            option_labels=self.labels,
        )
        self.assertEqual(decoded["selected"], [])
        self.assertEqual(decoded["custom"], "甲路、张三")


class AskSlotTest(unittest.TestCase):
    def setUp(self):
        self.slot = qna.AskSlot("ask-slot", QUESTIONS)
        qna.register_ask(self.slot)

    def tearDown(self):
        qna.discard_ask("ask-slot")

    def test_register_lookup_and_discard(self):
        self.assertIs(qna.lookup_ask("ask-slot"), self.slot)
        self.assertIn("ask-slot", qna.pending_ask_ids())
        qna.discard_ask("ask-slot")
        self.assertIsNone(qna.lookup_ask("ask-slot"))

    def test_option_labels_from_payload(self):
        self.assertEqual(self.slot.option_labels("q1"), ["甲路", "乙路"])
        self.assertEqual(self.slot.option_labels("nope"), [])

    def test_wait_for_returns_answer_and_skip(self):
        self.slot.deliver_choice(qid="q1", selected=["甲路"], custom=None, by="ou_x")
        self.assertEqual(self.slot.wait_for("q1")["selected"], ["甲路"])
        self.assertTrue(self.slot.answered("q1"))

        self.slot.deliver_skip(qid="q1", by="ou_y")
        self.assertFalse(self.slot.deliver_skip(qid="q1", by="ou_y"), "重复跳过不得生效")

    def test_wait_for_returns_none_after_close(self):
        qna.discard_ask("ask-slot")  # discard closes the slot
        self.assertIsNone(self.slot.wait_for("q1"))

    def test_duplicate_delivery_ignored(self):
        self.assertTrue(self.slot.deliver_choice(qid="q1", selected=["甲路"], custom=None, by="ou_x"))
        self.assertFalse(self.slot.deliver_choice(qid="q1", selected=["乙路"], custom=None, by="ou_x"))

    def test_close_all_releases_everything(self):
        second = qna.AskSlot("ask-2", QUESTIONS)
        qna.register_ask(second)
        qna.close_all()
        self.assertIsNone(qna.lookup_ask("ask-2"))
        self.assertIsNone(second.wait_for("q1"))
        self.assertEqual(qna.pending_ask_ids(), [])


class HandleCardActionTest(unittest.TestCase):
    def setUp(self):
        self.slot = qna.AskSlot("ask-act", QUESTIONS)
        qna.register_ask(self.slot)

    def tearDown(self):
        qna.discard_ask("ask-act")

    def payload(self, **overrides):
        base = {
            "action_value": {qna.ASK_ACTION_KEY: "pick", "ask_id": "ask-act", "qid": "q1", "choice": "1"},
            "action_form_value": {"qa_input_q1": ""},
            "operator_open_id": "ou_op",
            "chat_id": "oc_x",
            "message_id": "om_x",
            "event_token": "c-token",
        }
        base.update(overrides)
        return base

    def test_pick_delivers_and_returns_green_ack(self):
        card = qna.handle_card_action(self.payload())
        self.assertEqual(card["schema"], "2.0")
        self.assertEqual(card["header"]["template"], "green")
        self.assertIn("甲路", json.dumps(card, ensure_ascii=False))
        self.assertEqual(self.slot.wait_for("q1")["by"], "ou_op")

    def test_unknown_ask_id_is_loud_and_not_adopted(self):
        with self.assertLogs(_LOGGER, level="WARNING") as logs:
            card = qna.handle_card_action(
                self.payload(action_value={qna.ASK_ACTION_KEY: "pick", "ask_id": "ask-gone", "qid": "q1"})
            )
        self.assertEqual(card["header"]["template"], "orange")
        self.assertTrue(any("未知/已过期" in line for line in logs.output))
        self.assertFalse(self.slot.answered("q1"))

    def test_duplicate_click_returns_grey_ack(self):
        qna.handle_card_action(self.payload())
        with self.assertLogs(_LOGGER, level="WARNING"):
            again = qna.handle_card_action(self.payload())
        self.assertEqual(again["header"]["template"], "grey")

    def test_skip_returns_skip_card_and_marks_skipped(self):
        card = qna.handle_card_action(
            self.payload(action_value={qna.ASK_ACTION_KEY: "skip", "ask_id": "ask-act", "qid": "q1"})
        )
        self.assertEqual(card["header"]["template"], "green")
        self.assertIn("跳过", card["header"]["title"]["content"])
        self.assertEqual(self.slot.wait_for("q1"), {"skipped": "ou_op"})

    def test_submit_with_typed_text(self):
        card = qna.handle_card_action(
            self.payload(
                action_value={qna.ASK_ACTION_KEY: "submit", "ask_id": "ask-act", "qid": "q1"},
                action_form_value={"qa_input_q1": "乙路"},
            )
        )
        self.assertIn("乙路", json.dumps(card, ensure_ascii=False))
        self.assertEqual(self.slot.wait_for("q1")["selected"], ["乙路"])


class AnswerMessageTest(unittest.TestCase):
    def test_body_carries_task_id_and_data_part(self):
        body = qna.answer_stream_body(
            task_id="task-9",
            context_id="ctx-9",
            ask_id="ask-9",
            answers=[{"id": "q1", "selected": ["甲路"], "custom": "备注"}],
        )
        self.assertEqual(body["jsonrpc"], "2.0")
        self.assertEqual(body["method"], "SendStreamingMessage")
        message = body["params"]["message"]
        self.assertEqual(message["taskId"], "task-9")
        self.assertEqual(message["contextId"], "ctx-9")
        self.assertEqual(message["role"], "ROLE_USER")
        self.assertTrue(message["messageId"])
        payload = message["parts"][0]["data"]
        self.assertEqual(payload["kind"], "question-answer")
        self.assertEqual(payload["askId"], "ask-9")
        self.assertEqual(payload["answers"][0]["selected"], ["甲路"])
        self.assertNotIn("skipped", payload)
        self.assertIn("甲路", message["parts"][1]["text"])

    def test_skip_flag_and_empty_summary(self):
        body = qna.answer_stream_body(
            task_id="t", context_id="", ask_id="a", answers=[], skipped=True,
        )
        message = body["params"]["message"]
        self.assertTrue(message["parts"][0]["data"]["skipped"])
        self.assertNotIn("contextId", message)
        self.assertIn("跳过", message["parts"][1]["text"])


class ResumableStreamTest(unittest.TestCase):
    def test_resume_appends_second_stream(self):
        stream = qna.ResumableStream(iter([{"a": 1}, {"a": 2}]))
        stream.resume(iter([{"b": 1}]))
        self.assertEqual([dict(x) for x in stream], [{"a": 1}, {"a": 2}, {"b": 1}])


if __name__ == "__main__":
    unittest.main(verbosity=2)

"""dsh 全内容卡片化：叙述卡 / 直播最终文本 / 收束小卡 / 结果卡（v0.7.3，纯 stdlib unittest）。

运行方式
--------
    python3 tests/test_card_content.py

覆盖四组断言：

- **C1 简约卡结构**：``schema="2.0"``、无 ``collapsible_panel``（不折叠）、无 header
  （无标题）、只用【直证】字段、``element_id`` 卡内唯一且 ≤20 字符。
- **C2 分卡预算**：叙述 / 结果正文超 30 KB 时按行切卡，续卡带「⏩ 续」，**文本回退层
  不丢信息**（卡内容与回退文本逐字同源）。
- **C3 直播接线**：``Throttler`` 在 ``collector.card=panel`` 下把叙述 / 直播最终文本 /
  收束行都改成卡片；``off`` 时输出与 v0.7.0 **逐字一致**（同一事件序列的文本序列不变）。
- **C4 结果送达**：``_deliver_final_result`` 在 ``panel`` 下发结果卡（📬 头行 + 正文），
  文本回退层与卡内元素逐字同源；``card=None`` 时仍是 v0.7.2 的单条文本。
"""

import importlib.util
import json
import os
import types
import unittest

_WORKTREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load(module_name, filename):
    spec = importlib.util.spec_from_file_location(
        module_name, os.path.join(_WORKTREE, filename)
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


consumer = _load("hermes_a2a_bridge_consumer_content", "consumer.py")
_MODULE = _load("hermes_a2a_bridge_content", "__init__.py")

# ---- 白名单（与 test_card_render 同口径：多一个键即失败）----------------------
ALLOWED_CARD_KEYS = {"schema", "config", "body"}
ALLOWED_CONFIG_KEYS = {"width_mode"}
ALLOWED_PLAIN_MARKDOWN_KEYS = {"tag", "element_id", "content"}  # 简约卡：不发 text_size
ELEMENT_ID_MAX = 20

# ---- 同一事件序列：过程组 → 叙述 → final 文本 → 收束行（四类内容一套走完）------
FULL_SEQUENCE = [
    ({"type": "turn_start"}, None),
    ({"type": "tool_call", "name": "bash", "arguments": "ls -la"}, None),
    ({"type": "tool_result", "name": "bash", "text": "ok"}, None),
    ({"type": "thinking", "text": "先看看目录。"}, None),
    ({"type": "text", "text": "开场说明：这一段是叙述。"}, "开场说明：这一段是叙述。"),
    ({"type": "text", "text": "最终答复正文。", "final": True}, "最终答复正文。"),
    ({"type": "turn_end", "reason": "stop"}, None),
]


def _first_panel(card):
    for element in (card.get("body") or {}).get("elements") or []:
        if element.get("tag") == "collapsible_panel":
            return element
    return None


def _element_ids(card):
    ids = []
    stack = [card]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            if "element_id" in node:
                ids.append(node["element_id"])
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
    return ids


def _run_throttler(card_mode):
    throttler = consumer.Throttler(min_interval=0.0, level="standard", card=card_mode)
    items = []
    for event, line in FULL_SEQUENCE:
        items.extend(throttler.feed(event, line))
    return items


# ---------------------------------------------------------------------------
# C1 简约卡结构
# ---------------------------------------------------------------------------
class PlainCardStructureTest(unittest.TestCase):
    def test_narrative_card_is_flat_2_0(self):
        card = consumer.render_plain_card("开场说明：这一段是叙述。")
        self.assertEqual(set(card), ALLOWED_CARD_KEYS)
        self.assertEqual(card["schema"], "2.0")
        self.assertEqual(set(card["config"]), ALLOWED_CONFIG_KEYS)
        self.assertEqual(set(card["body"]), {"elements"})
        self.assertIsNone(_first_panel(card), "简约卡不得使用折叠面板")
        self.assertNotIn("header", card, "简约卡不得带头部/标题")
        element = card["body"]["elements"][0]
        self.assertEqual(set(element), ALLOWED_PLAIN_MARKDOWN_KEYS)
        self.assertEqual(element["tag"], "markdown")
        self.assertEqual(element["content"], "开场说明：这一段是叙述。")

    def test_closer_card_is_single_small_element(self):
        closer = consumer.render_turn_close("stop", 12.0)
        card = consumer.render_plain_card(closer, family=consumer._CARD_FAMILY_CLOSER)
        self.assertEqual(len(card["body"]["elements"]), 1)
        self.assertEqual(card["body"]["elements"][0]["content"], closer)
        self.assertTrue(
            card["body"]["elements"][0]["element_id"].startswith(
                f"dsh_{consumer._CARD_FAMILY_CLOSER}"
            )
        )

    def test_result_card_first_element_is_head_then_body(self):
        items = consumer.split_result_cards("📬 头行", "正文第一行\n正文第二行")
        self.assertEqual(len(items), 1)
        fallback, card = items[0]
        elements = card["body"]["elements"]
        self.assertEqual(len(elements), 2)
        self.assertEqual(elements[0]["content"], "📬 头行")
        self.assertEqual(elements[1]["content"], "正文第一行\n正文第二行")
        self.assertEqual(fallback, "📬 头行\n\n正文第一行\n正文第二行")

    def test_element_ids_unique_and_bounded(self):
        items = consumer.split_result_cards("📬 头行 " + "x" * 10, "正文")
        for _, card in items:
            ids = _element_ids(card)
            self.assertEqual(len(ids), len(set(ids)), ids)
            for element_id in ids:
                self.assertLessEqual(len(element_id), ELEMENT_ID_MAX, element_id)
                self.assertRegex(element_id, r"^[A-Za-z][A-Za-z0-9_]*$")

    def test_cards_are_json_serializable(self):
        for card in (
            consumer.render_plain_card("叙述"),
            consumer.render_plain_card("正文", family="r", lead=["📬 头"]),
            consumer.split_result_cards("📬 头", "正文")[0][1],
        ):
            json.dumps(card, ensure_ascii=False)  # 不抛即可

    def test_empty_content_yields_nothing(self):
        self.assertEqual(consumer.render_plain_card(""), {}, "无内容不得产出空卡")
        self.assertEqual(consumer.render_plain_card("   "), {})
        self.assertEqual(consumer.split_plain_card_chunks(""), [])
        self.assertEqual(consumer.split_result_cards("", ""), [])


# ---------------------------------------------------------------------------
# C2 分卡预算 + 回退层不丢信息
# ---------------------------------------------------------------------------
class PlainCardBudgetTest(unittest.TestCase):
    @staticmethod
    def _paragraph(lines, width=200):
        return "\n".join(f"第 {i} 行 " + "x" * width for i in range(lines))

    def test_long_narrative_is_split_and_within_budget(self):
        text = self._paragraph(400)  # 远大于 30 KB
        items = consumer.split_plain_card_chunks(text)
        self.assertGreater(len(items), 1, "超长叙述必须分卡")
        for _, card in items:
            self.assertLessEqual(consumer._card_bytes(card), consumer._CARD_MAX_BYTES)
            self.assertLessEqual(
                consumer._card_element_count(card), consumer._CARD_MAX_ELEMENTS
            )

    def test_long_narrative_loses_nothing_via_fallback(self):
        text = self._paragraph(400)
        items = consumer.split_plain_card_chunks(text)
        marker = consumer._PLAIN_CONT_MARK
        rebuilt = []
        for fallback, card in items:
            # 回退文本 == 卡内元素内容逐字拼接（两态同源）。
            self.assertEqual(
                fallback, "\n\n".join(e["content"] for e in card["body"]["elements"])
            )
            body = fallback[: -len("\n" + marker)] if fallback.endswith("\n" + marker) else fallback
            rebuilt.append(body)
        self.assertEqual("\n".join(rebuilt), text, "分卡后不得丢正文")

    def test_non_final_cards_carry_continuation_marker(self):
        items = consumer.split_plain_card_chunks(self._paragraph(400))
        for fallback, _ in items[:-1]:
            self.assertTrue(fallback.endswith("\n" + consumer._PLAIN_CONT_MARK), fallback[-20:])
        self.assertFalse(items[-1][0].endswith(consumer._PLAIN_CONT_MARK))

    def test_single_overlong_line_is_hard_split(self):
        text = "y" * 60000  # 单行 60 KB，无换行可切
        items = consumer.split_plain_card_chunks(text)
        self.assertGreater(len(items), 1)
        for _, card in items:
            self.assertLessEqual(consumer._card_bytes(card), consumer._CARD_MAX_BYTES)
        rebuilt = "".join(
            fallback[: -len("\n" + consumer._PLAIN_CONT_MARK)]
            if fallback.endswith("\n" + consumer._PLAIN_CONT_MARK)
            else fallback
            for fallback, _ in items
        )
        self.assertEqual(rebuilt, text, "硬切后不得丢字符")

    def test_long_result_body_keeps_head_on_first_card_only(self):
        head = "📬 **dsh 任务完成，结果如下**（用时 12 秒）"
        body = self._paragraph(400)
        items = consumer.split_result_cards(head, body)
        self.assertGreater(len(items), 1)
        first_elements = items[0][1]["body"]["elements"]
        self.assertEqual(first_elements[0]["content"], head)
        for fallback, card in items[1:]:
            self.assertEqual(card["body"]["elements"][0]["tag"], "markdown")
            self.assertNotEqual(card["body"]["elements"][0]["content"], head, "续卡不重复头行")
        for _, card in items:
            self.assertLessEqual(consumer._card_bytes(card), consumer._CARD_MAX_BYTES)
        # 首卡回退层 = 头行 + 空行 + 正文块（与 _format_result_message 同源）。
        self.assertTrue(items[0][0].startswith(head + "\n\n"))
        joined = "\n".join(
            fallback[: -len("\n" + consumer._PLAIN_CONT_MARK)]
            if fallback.endswith("\n" + consumer._PLAIN_CONT_MARK)
            else fallback
            for fallback, _ in items
        )
        self.assertIn(head, joined)
        self.assertIn("第 399 行", joined, "末行不得丢")


# ---------------------------------------------------------------------------
# C3 直播接线（Throttler / consume_stream）
# ---------------------------------------------------------------------------
class LiveCardWiringTest(unittest.TestCase):
    def test_all_dsh_messages_are_cards_in_panel_mode(self):
        items = _run_throttler("panel")
        self.assertEqual(len(items), 4, items)
        for item in items:
            self.assertIsInstance(item, consumer.CardMessage, item)
            self.assertEqual(item.card["schema"], "2.0")
        # 四类承载各就各位：折叠面板（过程组）+ 叙述卡 + final 卡 + 收束小卡。
        self.assertTrue(_first_panel(items[0].card))
        families = [
            item.card["body"]["elements"][0]["element_id"].split("_")[1][0]
            for item in items[1:]
        ]
        self.assertEqual(
            families,
            [
                consumer._CARD_FAMILY_NARRATIVE,
                consumer._CARD_FAMILY_FINAL,
                consumer._CARD_FAMILY_CLOSER,
            ],
            families,
        )

    def test_off_mode_text_sequence_is_unchanged(self):
        off_items = _run_throttler("off")
        panel_items = _run_throttler("panel")
        for item in off_items:
            self.assertNotIsInstance(item, consumer.CardMessage, item)
            self.assertIsInstance(item, str)
        # 卡片只是承载形态：同一事件序列的**文本内容逐字一致**（回退层即原文本行）。
        self.assertEqual([str(i) for i in panel_items], off_items)
        self.assertEqual(len(off_items), 4)

    def test_narrative_card_carries_same_truncated_text(self):
        narrative = "叙述" * 200  # 400 字，standard 档截断 120
        throttler = consumer.Throttler(min_interval=0.0, level="standard", card="panel")
        throttler.feed({"type": "tool_call", "name": "bash", "arguments": "ls"}, None)
        items = throttler.feed({"type": "text", "text": narrative}, None)
        narrative_items = [i for i in items if isinstance(i, consumer.CardMessage)][-1]
        expected = consumer._truncate(narrative, 120)
        self.assertEqual(str(narrative_items), expected)
        self.assertEqual(
            narrative_items.card["body"]["elements"][0]["content"], expected,
            "卡片内容必须与文本回退层同源（低信号截断口径不放大）",
        )

    def test_verbose_narrative_card_is_not_truncated(self):
        narrative = "叙述" * 200
        throttler = consumer.Throttler(min_interval=0.0, level="verbose", card="panel")
        throttler.feed({"type": "tool_call", "name": "bash", "arguments": "ls"}, None)
        items = throttler.feed({"type": "text", "text": narrative}, None)
        narrative_items = [i for i in items if isinstance(i, consumer.CardMessage)][-1]
        self.assertEqual(str(narrative_items), narrative)

    def test_consume_stream_panel_cards_text_events(self):
        def art(parts, last=False):
            return {"artifactUpdate": {"taskId": "t1",
                                       "artifact": {"artifactId": "a", "parts": parts,
                                                    "name": "x"},
                                       "lastChunk": last}}

        # 叙述（非 lastChunk）→ final 文本（text part + lastChunk）→ turn_end。
        events = [
            art([{"data": {"kind": "text", "turn": 1, "text": "开场说明"}}]),
            art([{"text": "最终答复"}], last=True),
            art([{"data": {"kind": "turn_end", "turn": 1, "reason": "stop"}}]),
        ]

        def run(card_mode):
            sent = []

            def sender(platform, chat_id, thread_id, text, card=None):
                sent.append((text, card))
                return {"ok": True, "message_id": f"om_{len(sent)}"}

            original = consumer.iter_sse_data
            consumer.iter_sse_data = lambda url, body, headers, timeout: iter(events)
            try:
                stats = consumer.consume_stream(
                    url="http://x/", token="t", message="m", context_id="c",
                    platform="feishu", chat_id="oc_x", thread_id="", sender=sender,
                    min_interval=0.0, level="standard", card=card_mode,
                )
            finally:
                consumer.iter_sse_data = original
            return sent, stats

        off_sent, _ = run("off")
        panel_sent, stats = run("panel")
        self.assertTrue(panel_sent)
        # panel：dsh 流出的每一条都带卡片。
        self.assertTrue(all(card is not None for _, card in panel_sent), panel_sent)
        # off：全部纯文本（行为与 v0.7.2 一致）。
        self.assertTrue(all(card is None for _, card in off_sent), off_sent)
        # 承载形态变了，文本序列逐字不变（卡片失败即回落该文本，不丢信息）。
        self.assertEqual([text for text, _ in panel_sent],
                         [text for text, _ in off_sent])
        self.assertIn("最终答复", [text for text, _ in panel_sent])
        self.assertTrue(any(text.startswith(consumer._GLYPH_ROW)
                            for text, _ in panel_sent), panel_sent)
        self.assertEqual(stats["messages_sent"], len(panel_sent))


# ---------------------------------------------------------------------------
# C4 结果送达（__init__ · _deliver_final_result）
# ---------------------------------------------------------------------------
class ResultDeliveryTest(unittest.TestCase):
    def setUp(self):
        self._orig = _MODULE._CONSUMER_MODULE
        self.sent = []

        def sender(platform, chat_id, thread_id, text, card=None):
            self.sent.append({"platform": platform, "chat_id": chat_id,
                              "thread_id": thread_id, "text": text, "card": card})
            return {"ok": True, "message_id": f"om_{len(self.sent)}"}

        fake = types.SimpleNamespace(
            resolve_card_mode=consumer.resolve_card_mode,
            split_result_cards=consumer.split_result_cards,
            make_sender=lambda ctx: sender,
        )
        _MODULE._CONSUMER_MODULE = fake

    def tearDown(self):
        _MODULE._CONSUMER_MODULE = self._orig

    def test_panel_sends_result_card(self):
        _MODULE._deliver_final_result(
            "feishu", "oc_x", "omt_y", "报告正文", "completed", 0.0, "panel"
        )
        self.assertEqual(len(self.sent), 1, self.sent)
        call = self.sent[0]
        self.assertIsNotNone(call["card"], "结果必须以结果卡送达")
        self.assertEqual(call["card"]["schema"], "2.0")
        self.assertIsNone(_first_panel(call["card"]), "结果卡不折叠")
        elements = call["card"]["body"]["elements"]
        self.assertTrue(elements[0]["content"].startswith("📬"))
        self.assertEqual(elements[1]["content"], "报告正文")
        # 回退层与卡内元素逐字同源（卡片失败回落它，不丢内容）。
        self.assertEqual(
            call["text"], "\n\n".join(e["content"] for e in elements)
        )
        self.assertTrue(call["text"].endswith("\n\n报告正文"))

    def test_panel_no_text_output_still_sends_card(self):
        _MODULE._deliver_final_result(
            "feishu", "oc_x", "", "", "completed", 0.0, "panel"
        )
        self.assertEqual(len(self.sent), 1)
        card = self.sent[0]["card"]
        self.assertEqual(len(card["body"]["elements"]), 1)
        self.assertIn("无文本输出", card["body"]["elements"][0]["content"])
        self.assertNotIn("```", self.sent[0]["text"])

    def test_panel_long_result_splits_into_cards(self):
        body = "\n".join(f"第 {i} 行 " + "x" * 200 for i in range(300))
        _MODULE._deliver_final_result(
            "feishu", "oc_x", "omt_y", body, "completed", 0.0, "panel"
        )
        self.assertGreater(len(self.sent), 1, "超长结果必须分卡")
        for call in self.sent:
            self.assertIsNotNone(call["card"])
            self.assertLessEqual(
                consumer._card_bytes(call["card"]), consumer._CARD_MAX_BYTES
            )
        self.assertTrue(self.sent[0]["text"].startswith("📬"))
        self.assertIn("第 0 行", self.sent[0]["text"])
        joined = "\n".join(call["text"] for call in self.sent)
        self.assertIn("第 299 行", joined, "末行不得丢")

    def test_card_none_keeps_plain_text_path(self):
        _MODULE._deliver_final_result(
            "feishu", "oc_x", "omt_y", "报告正文", "completed", 0.0
        )
        self.assertEqual(len(self.sent), 1)
        self.assertIsNone(self.sent[0]["card"], "card=None 时行为同 v0.7.2（纯文本）")
        self.assertTrue(self.sent[0]["text"].startswith("📬"))
        self.assertTrue(self.sent[0]["text"].endswith("\n\n报告正文"))

    def test_format_result_message_equals_parts_join(self):
        head, body = _MODULE._format_result_parts("报告", "completed", 90)
        self.assertEqual(_MODULE._format_result_message("报告", "completed", 90),
                         f"{head}\n\n{body}")
        head, body = _MODULE._format_result_parts("", "completed", 3)
        self.assertEqual(body, "")
        self.assertEqual(_MODULE._format_result_message("", "completed", 3), head)

    def test_delivery_retries_each_card_once(self):
        attempts = []

        def flaky(p, c, t, text, card=None):
            attempts.append(text)
            return {"ok": len(attempts) > 1, "error": "send_failed"}

        _MODULE._CONSUMER_MODULE = types.SimpleNamespace(
            resolve_card_mode=consumer.resolve_card_mode,
            split_result_cards=consumer.split_result_cards,
            make_sender=lambda ctx: flaky,
        )
        _MODULE._deliver_final_result(
            "feishu", "oc_x", "omt_y", "报告", "completed", 0.0, "panel"
        )
        self.assertEqual(len(attempts), 2, "失败重试一次")
        self.assertEqual(attempts[0], attempts[1])


if __name__ == "__main__":
    unittest.main(verbosity=2)

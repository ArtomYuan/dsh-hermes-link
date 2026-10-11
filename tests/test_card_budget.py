"""卡片预算压测（V2）+ 降级链（V5）+ collector.card 配置（纯 stdlib unittest）。

运行方式
--------
    python3 tests/test_card_budget.py

V2 30KB / 200 元素预算：用**与 ``bridge-dsh-v2-1010/E2E-OUTPUT.txt`` 同源**的真实
过程组成员做基数，按 N 倍放大压测 ``_split_card_chunks``——断言「每张卡都在预算内」
且「分卡后文本回退层不丢信息」，并给出分卡阈值的**实践结论**。

V5 降级链：注入卡片发送失败 / 抛异常 / 适配器无 ``send_card`` 三种情形，断言一律
**回落到文本行且不丢信息**；卡片成功时走卡片通路并带出 ``message_id``。

collector.card：``off``（默认）/ ``panel`` 的归一化与端到端接线。
"""

import asyncio
import concurrent.futures
import importlib.util
import os
import sys
import types
import unittest

_WORKTREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_CONSUMER_PATH = os.path.join(_WORKTREE, "consumer.py")
_spec = importlib.util.spec_from_file_location("hermes_a2a_bridge_consumer", _CONSUMER_PATH)
consumer = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(consumer)

# 与 E2E-OUTPUT.txt 同源的 4 步基数（bash/read/grep/edit + 一条思考）。
BASE_MEMBERS = [
    {"kind": "think", "text": "先确认仓库结构与目标文件。\n再看测试是否覆盖。"},
    {"kind": "step", "name": "bash", "arguments": "ls -la",
     "result": "total 8\ndrwxr-xr-x  2 artom artom\n-rw-r--r--  1 artom artom consumer.py"},
    {"kind": "step", "name": "read", "arguments": "consumer.py",
     "result": "<path>consumer.py</path>\n<type>file</type>\n<content>\n...\n</content>"},
    {"kind": "step", "name": "grep", "arguments": "render_process_group",
     "result": "consumer.py:1: ..."},
    {"kind": "step", "name": "edit", "arguments": "consumer.py", "result": "ok"},
]


def _one_card(n, level):
    """n 步时切出的第一张卡。"""
    return consumer._split_card_chunks(_scale(n), level)[0][1]


def _scale(n):
    """把同源基数按 n 倍放大成 n 个「工具步」（含一条思考）。"""
    members = [BASE_MEMBERS[0]]
    step = BASE_MEMBERS[3]
    for i in range(n):
        members.append(dict(step, arguments=f"render_process_group #{i}"))
    return members


# ---------------------------------------------------------------------------
# 假 gateway / 适配器（沿用 test_consumer 的桩法；不触网、不起服务）
# ---------------------------------------------------------------------------
class _FakePlatform:
    def __init__(self, value):
        self.value = value

    def __eq__(self, other):
        return isinstance(other, _FakePlatform) and self.value == other.value

    def __hash__(self):
        return hash(self.value)


def _install_fake_gateway(runner_factory):
    pkg = types.ModuleType("gateway")
    pkg.__path__ = []
    run_mod = types.ModuleType("gateway.run")
    run_mod._gateway_runner_ref = runner_factory
    config_mod = types.ModuleType("gateway.config")
    config_mod.Platform = _FakePlatform
    sys.modules["gateway"] = pkg
    sys.modules["gateway.run"] = run_mod
    sys.modules["gateway.config"] = config_mod
    pkg.run = run_mod
    pkg.config = config_mod


def _install_fake_async_utils():
    pkg = sys.modules.get("agent")
    if pkg is None:
        pkg = types.ModuleType("agent")
        pkg.__path__ = []
        sys.modules["agent"] = pkg

    def safe_schedule_threadsafe(coro, loop):
        result = asyncio.run(coro)
        fut = concurrent.futures.Future()
        fut.set_result(result)
        return fut

    mod = types.ModuleType("agent.async_utils")
    mod.safe_schedule_threadsafe = safe_schedule_threadsafe
    sys.modules["agent.async_utils"] = mod
    pkg.async_utils = mod


class _FakeAdapter:
    """假适配器：``send`` 走文本；``send_card`` 可配置成功/失败/抛异常/缺省。"""

    def __init__(self, card_mode="ok", text_success=True, with_send_card=True):
        self.card_mode = card_mode          # ok | fail | raise
        self.text_success = text_success
        self.text_calls = []
        self.card_calls = []
        if with_send_card:
            self.send_card = self._send_card  # 实例属性 → 无 self 绑定

    async def _send_card(self, chat_id, card, metadata=None):
        self.card_calls.append({"chat_id": chat_id, "card": card, "metadata": metadata})
        if self.card_mode == "raise":
            raise RuntimeError("card boom")
        ok = self.card_mode == "ok"
        return types.SimpleNamespace(success=ok, message_id="om_card" if ok else None,
                                     error=None if ok else "card rejected")

    async def send(self, chat_id, content, metadata=None):
        self.text_calls.append({"chat_id": chat_id, "content": content, "metadata": metadata})
        return types.SimpleNamespace(
            success=self.text_success,
            message_id="om_text" if self.text_success else None,
            error=None if self.text_success else "text rejected",
        )


class _FakeRunner:
    def __init__(self, adapter):
        self.adapters = {_FakePlatform("feishu"): adapter}
        self._gateway_loop = types.SimpleNamespace()


def _sender_for(adapter):
    _install_fake_gateway(lambda: _FakeRunner(adapter))
    _install_fake_async_utils()
    return consumer.make_sender(None)


def _cleanup():
    for name in ("gateway", "gateway.run", "gateway.config", "agent", "agent.async_utils"):
        sys.modules.pop(name, None)


# ---------------------------------------------------------------------------
# V2 预算压测
# ---------------------------------------------------------------------------
class CardBudgetTest(unittest.TestCase):
    def test_every_card_within_budget_across_scales(self):
        for level in consumer.LIVE_DETAIL_MODES:
            for n in (4, 20, 50, 100, 200, 400, 800):
                members = _scale(n)
                for text, card in consumer._split_card_chunks(members, level):
                    self.assertLessEqual(consumer._card_bytes(card), consumer._CARD_MAX_BYTES,
                                         f"{level} n={n}")
                    self.assertLessEqual(consumer._card_element_count(card),
                                         consumer._CARD_MAX_ELEMENTS, f"{level} n={n}")
                    self.assertTrue(text.strip(), f"{level} n={n}: 文本回退层不得为空")

    @staticmethod
    def _member_rows(text, level):
        """去掉每块自己的组头行（续卡会各自重复一次组头，属设计），只留成员行。"""
        if level == "verbose":
            return text
        lines = text.split("\n")
        return "\n".join(lines[1:]) if lines and lines[0].startswith(consumer._GLYPH_GROUP) else text

    def test_fallback_text_loses_nothing(self):
        for level in consumer.LIVE_DETAIL_MODES:
            for n in (20, 200, 800):
                members = _scale(n)
                chunks = consumer._split_card_chunks(members, level)
                joined = "\n".join(self._member_rows(text, level) for text, _ in chunks)
                full = self._member_rows(
                    consumer.render_process_group(members, level), level
                )
                self.assertEqual(joined, full,
                                 f"{level} n={n}: 分卡后文本回退层的成员行不得丢")

    def test_fallback_rows_are_never_dropped_in_verbose(self):
        # verbose 无组头，逐字相等（最强口径）。
        members = _scale(200)
        chunks = consumer._split_card_chunks(members, "verbose")
        joined = "\n".join(text for text, _ in chunks)
        self.assertEqual(joined, consumer.render_process_group(members, "verbose"))

    def test_continuation_cards_marked_and_titled(self):
        chunks = consumer._split_card_chunks(_scale(800), "detailed")
        self.assertGreater(len(chunks), 1, "800 步必然需要分卡")
        titles = []
        for _, card in chunks:
            panel = card["body"]["elements"][0]
            titles.append(panel["header"]["title"]["content"])
        self.assertNotIn(consumer._CARD_CONT_MARK, titles[0], "首卡不标续")
        for title in titles[1:]:
            self.assertTrue(title.endswith(consumer._CARD_CONT_MARK), title)
        # 续卡刻意「重复折叠面板标题」并标注（续）——同组内续卡标题因此相同，属设计。
        self.assertEqual(len(set(titles[1:])), 1, titles)

    def test_no_split_when_small(self):
        chunks = consumer._split_card_chunks(_scale(2), "standard")
        self.assertEqual(len(chunks), 1)

    def test_practical_thresholds_are_reported(self):
        """给出分卡阈值实践结论（同时断言阈值合理：单卡容量有余量、不是 1 步一卡）。"""
        report = {}
        cap = 600
        for level in consumer.LIVE_DETAIL_MODES:
            if len(consumer._split_card_chunks(_scale(cap), level)) == 1:
                report[level] = cap
                continue
            lo, hi = 1, cap
            while lo < hi:
                mid = (lo + hi + 1) // 2
                if len(consumer._split_card_chunks(_scale(mid), level)) == 1:
                    lo = mid
                else:
                    hi = mid - 1
            report[level] = lo
        print("\n  [V2] 单卡可容纳的最大工具步数（同源成员，30KB / 200 元素）:")
        for level, n in report.items():
            print(f"       {level:9s} N = {n}")
        for level, n in report.items():
            if level == "compact":
                # compact 档面板内只有思考行（步骤行按档位不出），卡内容与 N 无关
                # → 天然单卡。这不是「压测没触发上限」，而是该档语义使然。
                self.assertEqual(n, 600)
                self.assertEqual(
                    consumer._card_bytes(_one_card(1, level)),
                    consumer._card_bytes(_one_card(600, level)),
                    "compact 卡体积不应随工具步数增长",
                )
                continue
            self.assertGreaterEqual(n, 20, f"{level}: 单卡容量过小（N={n}），阈值不合理")
            self.assertLess(n, 600, f"{level}: 600 步仍单卡，说明压测没触发上限")

    def test_element_limit_binds_before_byte_limit_for_small_rows(self):
        # 短行（standard）时元素上限 200 先到；断言不会静默超限。
        members = _scale(400)
        chunks = consumer._split_card_chunks(members, "standard")
        counts = [consumer._card_element_count(c) for _, c in chunks]
        self.assertTrue(all(c <= consumer._CARD_MAX_ELEMENTS for c in counts), counts)


# ---------------------------------------------------------------------------
# V5 降级链
# ---------------------------------------------------------------------------
class CardDegradeTest(unittest.TestCase):
    def setUp(self):
        self.card = consumer.render_process_group_card(BASE_MEMBERS, "standard")
        self.text = consumer.render_process_group(BASE_MEMBERS, "standard")

    def tearDown(self):
        _cleanup()

    def test_card_success_uses_card_path(self):
        adapter = _FakeAdapter(card_mode="ok")
        res = _sender_for(adapter)("feishu", "oc_x", "", self.text, card=self.card)
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["via"], "adapter-card")
        self.assertEqual(res["message_id"], "om_card")
        self.assertEqual(len(adapter.card_calls), 1)
        self.assertEqual(adapter.card_calls[0]["card"], self.card)
        self.assertEqual(adapter.text_calls, [], "卡片成功时不得再发文本")

    def test_card_failure_falls_back_to_text(self):
        adapter = _FakeAdapter(card_mode="fail")
        res = _sender_for(adapter)("feishu", "oc_x", "", self.text, card=self.card)
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["via"], "adapter")
        self.assertEqual(len(adapter.card_calls), 1, "先尝试过卡片")
        self.assertEqual(len(adapter.text_calls), 1, "必须回落文本行")
        self.assertEqual(adapter.text_calls[0]["content"], self.text, "回落内容不得丢信息")

    def test_card_exception_falls_back_to_text(self):
        adapter = _FakeAdapter(card_mode="raise")
        res = _sender_for(adapter)("feishu", "oc_x", "", self.text, card=self.card)
        self.assertTrue(res["ok"], res)
        self.assertEqual(len(adapter.text_calls), 1)
        self.assertEqual(adapter.text_calls[0]["content"], self.text)

    def test_adapter_without_send_card_falls_back_to_text(self):
        adapter = _FakeAdapter(with_send_card=False)
        res = _sender_for(adapter)("feishu", "oc_x", "", self.text, card=self.card)
        self.assertTrue(res["ok"], res)
        self.assertEqual(adapter.text_calls[0]["content"], self.text)

    def test_text_path_unchanged_when_no_card(self):
        adapter = _FakeAdapter()
        res = _sender_for(adapter)("feishu", "oc_x", "", self.text)
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["via"], "adapter")
        self.assertEqual(res["message_id"], "om_text", "文本路径也要带出 message_id")
        self.assertEqual(adapter.card_calls, [])

    def test_long_fallback_text_is_chunked_with_marker(self):
        long_text = "\n".join(f"row {i}" for i in range(3000))  # >8000 字节
        adapter = _FakeAdapter(card_mode="fail")
        res = _sender_for(adapter)("feishu", "oc_x", "", long_text, card=self.card)
        self.assertTrue(res["ok"], res)
        self.assertGreater(len(adapter.text_calls), 1, "超长回落应分块")
        self.assertIn(consumer._split_plain_chunks.__defaults__[1],
                      "".join(c["content"] for c in adapter.text_calls))

    def test_degradation_keeps_message_ids(self):
        adapter = _FakeAdapter(card_mode="fail")
        res = _sender_for(adapter)("feishu", "oc_x", "", self.text, card=self.card)
        self.assertEqual(res["message_id"], "om_text")


# ---------------------------------------------------------------------------
# collector.card 配置
# ---------------------------------------------------------------------------
class CardConfigTest(unittest.TestCase):
    def test_resolve_card_mode(self):
        self.assertIsNone(consumer.resolve_card_mode(None))
        self.assertIsNone(consumer.resolve_card_mode("off"))
        self.assertIsNone(consumer.resolve_card_mode("OFF"))
        self.assertIsNone(consumer.resolve_card_mode(""))
        self.assertIsNone(consumer.resolve_card_mode("bogus"))
        self.assertEqual(consumer.resolve_card_mode("panel"), "panel")
        self.assertEqual(consumer.resolve_card_mode("PANEL"), "panel")
        self.assertEqual(consumer.resolve_card_mode("on"), "panel")

    def test_default_is_off(self):
        self.assertEqual(consumer.DEFAULT_CARD, "off")
        self.assertIsNone(consumer.resolve_card_mode(consumer.DEFAULT_CARD))

    def _run_stream(self, card_config, members_events):
        sent = []

        def sender(platform, chat_id, thread_id, text, card=None):
            sent.append((text, card))
            return {"ok": True, "message_id": f"om_{len(sent)}"}

        consumer._orig_iter = consumer.iter_sse_data
        consumer.iter_sse_data = lambda url, body, headers, timeout: iter(members_events)
        try:
            stats = consumer.consume_stream(
                url="http://x/", token="t", message="m", context_id="c",
                platform="feishu", chat_id="oc_x", thread_id="", sender=sender,
                min_interval=0.0, level="standard", card=card_config,
            )
        finally:
            consumer.iter_sse_data = consumer._orig_iter
        return sent, stats

    @staticmethod
    def _events():
        def art(parts, last=False):
            return {"artifactUpdate": {"taskId": "t1",
                                       "artifact": {"artifactId": "a", "parts": parts, "name": "x"},
                                       "lastChunk": last}}

        return [
            art([{"data": {"kind": "tool_call", "turn": 1, "name": "bash", "arguments": "ls"}}]),
            art([{"data": {"kind": "tool_result", "turn": 1, "name": "bash", "text": "ok"}}]),
            art([{"data": {"kind": "turn_end", "turn": 1, "reason": "stop"}}]),
        ]

    def test_card_off_sends_plain_text(self):
        sent, stats = self._run_stream("off", self._events())
        self.assertTrue(sent)
        self.assertTrue(all(card is None for _, card in sent), sent)
        self.assertEqual(stats["messages_sent"], len(sent))

    def test_card_panel_sends_cards_for_process_groups(self):
        sent, stats = self._run_stream("panel", self._events())
        card_items = [(text, card) for text, card in sent if card is not None]
        self.assertEqual(len(card_items), 1, f"过程组应发一张卡：{sent!r}")
        self.assertEqual(card_items[0][1]["schema"], "2.0")
        # 同一外发件同时带文本回退层（CardMessage 的内容 = 文本版过程组）。
        self.assertTrue(card_items[0][0].startswith(consumer._GLYPH_GROUP), card_items[0][0])

    def test_stats_carry_message_ids(self):
        _, stats = self._run_stream("off", self._events())
        self.assertEqual(stats["message_ids"], [f"om_{i}" for i in range(1, len(stats["message_ids"]) + 1)])
        self.assertTrue(stats["message_ids"], "message_id 必须带出（plan §4.2 第 1 条）")


if __name__ == "__main__":
    unittest.main(verbosity=2)

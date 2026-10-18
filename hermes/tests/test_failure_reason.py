"""失败原因转述回归：服务端 ``statusUpdate(FAILED)`` 里的原因必须回到本线。

运行方式
--------
    python3 tests/test_failure_reason.py

背景（2026-10-18 核验指出）：服务端执行失败时 SDK 合成的 ``statusUpdate(FAILED)`` 把原因
放在**状态消息的 text part**（如 ``Agent execution error: …``）。桥此前只读 ``status.state``，
于是线路只看到「任务已结束（失败）——本次无文本输出」，连同 §2.1/§2.4 的「非法参数」原因
一起丢失。本用例锁两件事：
1. ``normalize_events`` / ``consume_stream`` 把终态原因记进 ``stats["failure_reason"]``；
2. ``_stream_dsh_call`` 在无正文时用该原因顶替正文（送达消息里看得到原因）。
"""

import importlib.util
import os
import sys
import types
import unittest

_WORKTREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location("hermes_a2a_bridge_consumer_fr", os.path.join(_WORKTREE, "consumer.py"))
consumer = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(consumer)

_mspec = importlib.util.spec_from_file_location("hermes_a2a_bridge_fr", os.path.join(_WORKTREE, "__init__.py"))
bridge = importlib.util.module_from_spec(_mspec)
_mspec.loader.exec_module(bridge)

_PREEXISTING = {
    name: sys.modules.get(name)
    for name in ("gateway", "gateway.session_context", "hermes_cli", "hermes_cli.config")
}

FAILED_FRAMES = [
    {"task": {"id": "task-f", "contextId": "feishu/oc_x", "status": {"state": "TASK_STATE_SUBMITTED"}}},
    {"statusUpdate": {"taskId": "task-f", "status": {"state": "TASK_STATE_WORKING"}}},
    {
        "statusUpdate": {
            "taskId": "task-f",
            "status": {
                "state": "TASK_STATE_FAILED",
                "message": {
                    "role": "ROLE_AGENT",
                    "messageId": "m-err",
                    "parts": [{"text": "Agent execution error: 未知沙箱档 \"root\"", "mediaType": "text/plain"}],
                },
            },
        }
    },
]


def _restore_modules():
    for name, prev in _PREEXISTING.items():
        if prev is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = prev


class StatusMessageTest(unittest.TestCase):
    def test_status_message_text_extracts_text_parts(self):
        self.assertEqual(
            consumer._status_message_text({"parts": [{"text": " a "}, {"data": {}}, {"text": "b"}]}),
            "a\nb",
        )
        self.assertEqual(consumer._status_message_text(None), "")
        self.assertEqual(consumer._status_message_text({"parts": []}), "")

    def test_normalize_events_carries_failure_message(self):
        events = list(consumer.normalize_events(FAILED_FRAMES))
        statuses = [e for e in events if e["type"] == "status"]
        self.assertEqual(statuses[-1]["state"], "failed")
        self.assertIn("未知沙箱档", statuses[-1]["message"])


class ConsumeStreamFailureTest(unittest.TestCase):
    def setUp(self):
        self._orig_iter = consumer.iter_sse_data
        consumer.iter_sse_data = lambda url, body, headers, timeout: iter(FAILED_FRAMES)
        consumer._QNA_MODULE = None

    def tearDown(self):
        consumer.iter_sse_data = self._orig_iter

    def test_stats_record_failure_reason(self):
        def sender(p, c, t, text, card=None):
            return {"ok": True, "via": "adapter"}

        stats = consumer.consume_stream(
            url="http://127.0.0.1:9300/", token="", message="hi", context_id="feishu/oc_x",
            platform="feishu", chat_id="oc_x", thread_id="", sender=sender,
            min_interval=0.0, timeout=5, events=False,
        )
        self.assertEqual(stats["states"][-1], "failed")
        self.assertIn("未知沙箱档", stats["failure_reason"])
        self.assertEqual(stats["final_text"], "", "失败流没有正文")


class StreamCallFailureSurfaceTest(unittest.TestCase):
    """_stream_dsh_call 在无正文时把失败原因顶成正文（送到线路的内容看得到原因）。"""

    def setUp(self):
        _restore_modules()
        # 假 gateway / hermes_cli：让 _dsh_peer / 配置解析走确定性路径
        pkg = types.ModuleType("gateway")
        pkg.__path__ = []
        mod = types.ModuleType("gateway.session_context")
        mod.session_is_messaging_surface = lambda: True
        mod.get_session_env = lambda key, default="": {}
        sys.modules["gateway"] = pkg
        sys.modules["gateway.session_context"] = mod
        pkg.session_context = mod

        hcli = types.ModuleType("hermes_cli")
        hcli.__path__ = []
        cfg = types.ModuleType("hermes_cli.config")
        cfg.load_config = lambda: {"a2a_agents": {"dsh": {"url": "http://127.0.0.1:8092", "auth": {"type": "bearer", "token": "t"}}}}
        sys.modules["hermes_cli"] = hcli
        sys.modules["hermes_cli.config"] = cfg
        hcli.config = cfg

        self._orig_deliver = bridge._deliver_final_result
        self._orig_peer = bridge._dsh_peer
        self._orig_switch = bridge._read_switch
        self._orig_live = bridge._read_live_detail
        self._orig_card = bridge._read_card_mode

        class FakeConsumer:
            _DEFAULT_TIMEOUT = 300

            def make_sender(self, ctx):
                return lambda p, c, t, text, card=None: {"ok": True}

            def consume_stream(self, **kw):
                return {
                    "final_text": "",
                    "events_seen": 3,
                    "messages_sent": 1,
                    "states": ["submitted", "working", "failed"],
                    "failure_reason": 'Agent execution error: 未知沙箱档 "root"',
                    "message_ids": [],
                }

        bridge._CONSUMER_MODULE = FakeConsumer()
        bridge._read_switch = lambda key, default: default
        bridge._read_live_detail = lambda: "standard"
        bridge._read_card_mode = lambda: None

    def tearDown(self):
        bridge._deliver_final_result = self._orig_deliver
        bridge._dsh_peer = self._orig_peer
        bridge._read_switch = self._orig_switch
        bridge._read_live_detail = self._orig_live
        bridge._read_card_mode = self._orig_card
        bridge._CONSUMER_MODULE = None
        _restore_modules()

    def test_returned_and_delivered_text_carry_reason(self):
        delivered = {}
        bridge._deliver_final_result = lambda platform, chat_id, thread_id, final_text, state, started_at, card=None: delivered.update(
            {"final_text": final_text, "state": state}
        )
        result = bridge._stream_dsh_call("hi", "feishu/oc_x")
        self.assertIn("失败", result)
        self.assertIn("未知沙箱档", result)
        self.assertIn("未知沙箱档", delivered["final_text"])
        self.assertEqual(delivered["state"], "failed")


if __name__ == "__main__":
    unittest.main(verbosity=2)

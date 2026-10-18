"""§2.6 问答桥接**全链集成测试**（consume_stream ↔ qna，纯 stdlib unittest）。

运行方式
--------
    python3 tests/test_qna_flow.py

用脚本化的两条「SSE 结果流」（首流：task→working→question→input-required；续投流：
最终 Result→completed）驱动 ``consume_stream``，并在**另一个线程**里模拟适配器补丁的
点击回调（调 ``qna.handle_card_action``），从而端到端验证：

- ``question`` 事件 → 发 2.0 提问卡 → 零超时等待；
- 点击 → 作答 → 续投报文带 ``taskId`` + ``question-answer`` Data Part；
- 续投流被无缝拼回**同一个**消费循环（首跳解挂后的最终文本/终态照常收口）；
- **安静模式（events=false）也照样处理提问**——门控顺序错了就会永久悬挂；
- **发卡未真正送达**（sender 回落文本行）时按「跳过」续投，绝不悬挂；
- 未知 ask_id 的点击不生效（异常令牌不误答）。

不做真实网络：``consumer.iter_sse_data`` 被 monkeypatch 成脚本化流。
"""

import importlib.util
import json
import os
import threading
import time
import unittest

_WORKTREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location("hermes_a2a_bridge_consumer", os.path.join(_WORKTREE, "consumer.py"))
consumer = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(consumer)
# 必须取 consumer 那一个实例：qna 持有作答登记表，两份实例会让点击投不进等待槽位
qna = consumer._import_qna()

TASK_ID = "task-q"
ASK_ID = "ask-q"
QUESTION_PAYLOAD = {
    "kind": "question",
    "askId": ASK_ID,
    "taskId": TASK_ID,
    "contextId": "feishu/oc_x/omt_y",
    "questions": [
        {
            "id": "q1",
            "question": "走哪条路？",
            "header": "通路",
            "options": [{"label": "甲路", "description": "更稳"}, {"label": "乙路"}],
        }
    ],
}


def first_stream():
    return [
        {"task": {"id": TASK_ID, "contextId": "feishu/oc_x/omt_y", "status": {"state": "TASK_STATE_SUBMITTED"}}},
        {"statusUpdate": {"taskId": TASK_ID, "status": {"state": "TASK_STATE_WORKING"}}},
        {
            "artifactUpdate": {
                "taskId": TASK_ID,
                "artifact": {
                    "artifactId": "q-artifact",
                    "name": "StreamQuestion",
                    "parts": [{"data": QUESTION_PAYLOAD, "mediaType": "application/json"}],
                },
                "append": False,
                "lastChunk": False,
            }
        },
        {"statusUpdate": {"taskId": TASK_ID, "status": {"state": "TASK_STATE_INPUT_REQUIRED"}}},
    ]


def resumed_stream():
    return [
        {
            "artifactUpdate": {
                "taskId": TASK_ID,
                "artifact": {
                    "artifactId": "result",
                    "name": "Result",
                    "parts": [{"text": "已按甲路执行完毕", "mediaType": "text/plain"}],
                },
                "append": False,
                "lastChunk": True,
            }
        },
        {"statusUpdate": {"taskId": TASK_ID, "status": {"state": "TASK_STATE_COMPLETED"}}},
    ]


class QuestionFlowTest(unittest.TestCase):
    def setUp(self):
        self.orig_iter = consumer.iter_sse_data
        self.bodies = []
        self.sent = []
        self.card_sent = threading.Event()
        self.card_result = {"ok": True, "via": "adapter-card"}
        self.orig_ws_timeout = consumer._WS_READY_TIMEOUT
        self.orig_retry_interval = consumer._CONTINUATION_RETRY_INTERVAL

    def tearDown(self):
        consumer.iter_sse_data = self.orig_iter
        consumer._WS_READY_TIMEOUT = self.orig_ws_timeout
        consumer._CONTINUATION_RETRY_INTERVAL = self.orig_retry_interval
        qna.close_all()

    def _install_stream(self):
        def fake_iter(url, body, headers, timeout):
            self.bodies.append(body)
            return iter(first_stream() if len(self.bodies) == 1 else resumed_stream())

        consumer.iter_sse_data = fake_iter

    def _sender(self, ws_ready=None):
        def sender(platform, chat_id, thread_id, text, card=None):
            self.sent.append({"text": text, "card": card})
            if card is not None:
                if self.card_result.get("via") == "adapter-card":
                    self.card_sent.set()
                return dict(self.card_result)
            return {"ok": True, "via": "adapter"}

        if ws_ready is not None:
            sender.ws_ready = lambda platform: ws_ready
        return sender

    def _run_in_thread(self, **kwargs):
        outcome = {}

        def run():
            try:
                outcome["stats"] = consumer.consume_stream(
                    url="http://127.0.0.1:9300/",
                    token="",
                    message="开工",
                    context_id="feishu/oc_x/omt_y",
                    platform="feishu",
                    chat_id="oc_x",
                    thread_id="omt_y",
                    sender=self._sender(ws_ready=kwargs.get("ws_ready")),
                    min_interval=0.0,
                    timeout=5,
                    events=kwargs.get("events", True),
                    level=kwargs.get("level", "standard"),
                    card=kwargs.get("card"),
                )
            except Exception as exc:  # 线程里异常必须回传，否则测试会假绿
                outcome["error"] = exc

        worker = threading.Thread(target=run, daemon=True)
        worker.start()
        return worker, outcome

    def test_streaming_body_declares_qna_capability(self):
        """首投必须带能力声明：服务端只认领声明过的调用方的提问。"""
        body = consumer._streaming_message_body("开工", "feishu/oc_x/omt_y")
        message = body["params"]["message"]
        self.assertIs(message["metadata"][consumer.QNA_OPT_IN_KEY], True)
        self.assertEqual(message["contextId"], "feishu/oc_x/omt_y")

    def test_question_flow_card_click_answer_resume(self):
        self._install_stream()
        worker, outcome = self._run_in_thread()
        self.assertTrue(self.card_sent.wait(timeout=5), "应发出提问卡")
        card = next(item["card"] for item in self.sent if item["card"] is not None)
        self.assertEqual(card["schema"], "2.0")
        self.assertIn("走哪条路？", json.dumps(card, ensure_ascii=False))

        # 模拟适配器补丁里的点击：选第 1 项
        ack = qna.handle_card_action(
            {
                "action_value": {"hermes_ask_action": "pick", "ask_id": ASK_ID, "qid": "q1", "choice": "1"},
                "action_form_value": {"qa_input_q1": "顺带提一句"},
                "operator_open_id": "ou_admin",
            }
        )
        self.assertEqual(ack["schema"], "2.0")
        worker.join(timeout=5)
        self.assertFalse(worker.is_alive(), "答完后消费循环应随之收尾")
        self.assertNotIn("error", outcome, f"线程内异常: {outcome.get('error')}")

        # 续投报文：同一 taskId + question-answer Data Part（含选项 label 与手输）
        self.assertEqual(len(self.bodies), 2, "应恰有一次续投")
        message = self.bodies[1]["params"]["message"]
        self.assertEqual(message["taskId"], TASK_ID)
        payload = message["parts"][0]["data"]
        self.assertEqual(payload["kind"], "question-answer")
        self.assertEqual(payload["askId"], ASK_ID)
        self.assertEqual(payload["answers"], [{"id": "q1", "selected": ["甲路"], "custom": "顺带提一句"}])
        self.assertNotIn("skipped", payload)

        # 续投流被拼回同一循环：最终文本与终态照常收口（提问事件也计入 events_seen）
        stats = outcome["stats"]
        self.assertEqual(stats["events_seen"], 6, "task + working + question + input-required + result + completed")
        self.assertEqual(stats["final_text"], "已按甲路执行完毕")
        self.assertEqual(stats["states"][-1], "completed")
        self.assertIn("input-required", stats["states"])

    def test_empty_submit_is_a_valid_answer(self):
        self._install_stream()
        worker, outcome = self._run_in_thread()
        self.assertTrue(self.card_sent.wait(timeout=5))
        qna.handle_card_action(
            {
                "action_value": {"hermes_ask_action": "submit", "ask_id": ASK_ID, "qid": "q1"},
                "action_form_value": {"qa_input_q1": ""},
                "operator_open_id": "ou_admin",
            }
        )
        worker.join(timeout=5)
        payload = self.bodies[1]["params"]["message"]["parts"][0]["data"]
        self.assertEqual(payload["answers"], [{"id": "q1", "selected": []}])
        self.assertNotIn("skipped", payload)

    def test_skip_goes_out_as_skipped_continuation(self):
        self._install_stream()
        worker, outcome = self._run_in_thread()
        self.assertTrue(self.card_sent.wait(timeout=5))
        qna.handle_card_action(
            {
                "action_value": {"hermes_ask_action": "skip", "ask_id": ASK_ID, "qid": "q1"},
                "action_form_value": {},
                "operator_open_id": "ou_admin",
            }
        )
        worker.join(timeout=5)
        payload = self.bodies[1]["params"]["message"]["parts"][0]["data"]
        self.assertTrue(payload["skipped"])
        self.assertEqual(payload["answers"], [])
        self.assertFalse(worker.is_alive())

    def test_quiet_mode_still_handles_questions(self):
        """安静模式跳过中间事件，但提问必须照常处理（否则永久悬挂）。"""
        self._install_stream()
        worker, outcome = self._run_in_thread(events=False)
        self.assertTrue(self.card_sent.wait(timeout=5), "安静模式下也必须发提问卡")
        qna.handle_card_action(
            {
                "action_value": {"hermes_ask_action": "submit", "ask_id": ASK_ID, "qid": "q1"},
                "action_form_value": {"qa_input_q1": "乙路"},
                "operator_open_id": "ou_admin",
            }
        )
        worker.join(timeout=5)
        self.assertFalse(worker.is_alive())
        payload = self.bodies[1]["params"]["message"]["parts"][0]["data"]
        self.assertEqual(payload["answers"], [{"id": "q1", "selected": ["乙路"]}])

    def test_card_failure_never_hangs_the_run(self):
        """发卡未真正送达（回落文本行）⇒ 立刻按跳过续投，不留悬挂。"""
        self.card_result = {"ok": True, "via": "adapter"}
        self._install_stream()
        worker, outcome = self._run_in_thread()
        worker.join(timeout=5)
        self.assertFalse(worker.is_alive(), "送不出卡时也必须收尾，不得等待作答")
        self.assertEqual(len(self.bodies), 2)
        payload = self.bodies[1]["params"]["message"]["parts"][0]["data"]
        self.assertTrue(payload["skipped"])

    def test_panel_mode_marks_the_suspension_off_panel_does_not(self):
        """B#4：面板档补一条「⏳ 等待作答」状态位；非面板档**不新增**任何提示噪声。"""
        self._install_stream()
        worker, outcome = self._run_in_thread(card="panel")
        self.assertTrue(self.card_sent.wait(timeout=5))
        marks = [i for i, item in enumerate(self.sent) if "等待作答" in (item["text"] or "")]
        cards = [i for i, item in enumerate(self.sent) if item["card"] is not None]
        self.assertTrue(marks, f"面板档应有挂起状态位，实得 {[i['text'][:40] for i in self.sent]}")
        self.assertTrue(cards, "面板档仍应发出提问卡")
        self.assertLess(marks[0], cards[0], "状态位应在提问卡之前")
        qna.handle_card_action(
            {
                "action_value": {"hermes_ask_action": "pick", "ask_id": ASK_ID, "qid": "q1", "choice": "1"},
                "action_form_value": {},
                "operator_open_id": "ou_admin",
            }
        )
        worker.join(timeout=5)
        self.assertFalse(worker.is_alive())

    def test_off_mode_adds_no_suspension_noise(self):
        """非面板档（默认）：只有提问卡，没有额外提示行。"""
        self._install_stream()
        worker, outcome = self._run_in_thread()
        self.assertTrue(self.card_sent.wait(timeout=5))
        self.assertEqual(
            [item for item in self.sent if "等待作答" in (item["text"] or "")], [],
            "非面板档不得新增提示噪声",
        )
        qna.handle_card_action(
            {
                "action_value": {"hermes_ask_action": "pick", "ask_id": ASK_ID, "qid": "q1", "choice": "1"},
                "action_form_value": {},
                "operator_open_id": "ou_admin",
            }
        )
        worker.join(timeout=5)
        self.assertFalse(worker.is_alive())

    def test_ws_not_ready_skips_instead_of_dead_ending(self):
        """长连接未就位（重启窗口期）：不发卡、立刻按跳过续投，绝不悬挂。"""
        consumer._WS_READY_TIMEOUT = 0.0
        self._install_stream()
        worker, outcome = self._run_in_thread(ws_ready=False)
        worker.join(timeout=5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(
            [item for item in self.sent if item["card"] is not None], [], "未就位时不该发出提问卡",
        )
        payload = self.bodies[1]["params"]["message"]["parts"][0]["data"]
        self.assertTrue(payload["skipped"])

    def test_ws_ready_probe_passes_through(self):
        """探针报就位：正常发卡作答（闸不误伤）。"""
        self._install_stream()
        worker, outcome = self._run_in_thread(ws_ready=True)
        self.assertTrue(self.card_sent.wait(timeout=5))
        qna.handle_card_action(
            {
                "action_value": {"hermes_ask_action": "pick", "ask_id": ASK_ID, "qid": "q1", "choice": "2"},
                "action_form_value": {},
                "operator_open_id": "ou_admin",
            }
        )
        worker.join(timeout=5)
        self.assertFalse(worker.is_alive())
        payload = self.bodies[1]["params"]["message"]["parts"][0]["data"]
        self.assertEqual(payload["answers"], [{"id": "q1", "selected": ["乙路"]}])

    def test_continuation_retries_then_gives_up_loudly(self):
        """续投流打不开＝作答送不到：必须**有界重试**，最后如实告警（并说明需中止该 turn）。"""
        consumer._CONTINUATION_RETRY_INTERVAL = 0.0
        calls = {"n": 0}

        def fake_iter(url, body, headers, timeout):
            calls["n"] += 1
            if calls["n"] == 1:
                return iter(first_stream())
            raise OSError("connection refused")

        consumer.iter_sse_data = fake_iter
        worker, outcome = self._run_in_thread()
        self.assertTrue(self.card_sent.wait(timeout=5))
        with self.assertLogs(consumer.logger.name, level="WARNING") as logs:
            qna.handle_card_action(
                {
                    "action_value": {"hermes_ask_action": "pick", "ask_id": ASK_ID, "qid": "q1", "choice": "1"},
                    "action_form_value": {},
                    "operator_open_id": "ou_admin",
                }
            )
            worker.join(timeout=5)
        self.assertFalse(worker.is_alive(), "重试耗尽后必须收尾，不得悬挂")
        # 1 次首投 + 3 次续投尝试
        self.assertEqual(calls["n"], 1 + consumer._CONTINUATION_ATTEMPTS)
        self.assertTrue(
            any("续投流" in line for line in logs.output),
            f"应有续投失败的响亮告警，实得 {logs.output}",
        )
        self.assertNotIn("error", outcome)

    def test_unknown_ask_click_is_not_adopted(self):
        """异常令牌：不存在的 ask_id 点击不得解开任何等待（响亮报警在 qna 单测覆盖）。"""
        self._install_stream()
        worker, outcome = self._run_in_thread()
        self.assertTrue(self.card_sent.wait(timeout=5))
        with self.assertLogs(qna.logger.name, level="WARNING"):
            card = qna.handle_card_action(
                {
                    "action_value": {"hermes_ask_action": "pick", "ask_id": "ask-gone", "qid": "q1", "choice": "1"},
                    "action_form_value": {},
                    "operator_open_id": "ou_admin",
                }
            )
        self.assertEqual(card["header"]["template"], "orange")
        # 仍要能正常作答，证明误点击没有污染等待槽位
        qna.handle_card_action(
            {
                "action_value": {"hermes_ask_action": "pick", "ask_id": ASK_ID, "qid": "q1", "choice": "1"},
                "action_form_value": {},
                "operator_open_id": "ou_admin",
            }
        )
        worker.join(timeout=5)
        self.assertFalse(worker.is_alive())
        time.sleep(0)  # 让日志线程/flush 稳定（不影响断言）


if __name__ == "__main__":
    unittest.main(verbosity=2)

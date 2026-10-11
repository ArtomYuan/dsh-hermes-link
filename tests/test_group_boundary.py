"""组边界修正回归测试（v0.7.2，纯 stdlib unittest）——验证 V4。

运行方式
--------
    python3 tests/test_group_boundary.py

背景
----
dsh 的过程组在「出现助手叙述文本 / 出现 INDEPENDENT 节点 / 轮次结束」时**断开**
（`dsh-client-ui-chat/lib/client.js` `ChatGroupSeat` ~2290-2306）。v0.7.0 的桥把一轮内
所有工具/思考缓冲到 `turn_end` 才 flush，于是「工具→叙述→工具→叙述」被压成
**1 个组 + 1 段叙述**，与「一组工具调用 = 一个独立块」不符。

v0.7.2 改法（`consumer.py` `Throttler.feed`）：非 final `text` 到达且**确有过程组
待收口**时，先 `_flush_process_group()` 收口该组，再输出这段叙述；`turn_end` /
终态 status 只做「收口残余组 + 收束行」（残余叙述兜底 flush，不丢信息）。

本文件断言：
1. 「工具→叙述→工具→叙述」→ **2 个组 + 2 段叙述**（+1 收束行）；
2. 只有叙述、没有工具时**不被拆条**（沿用「低信号 text 累积」语义，既有断言不回归）；
3. 组始终**先于**触发它的叙述发出（顺序断言）；
4. 终态残余兜底不丢信息；收束行仍一轮一条。
"""

import importlib.util
import os
import unittest

_WORKTREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_CONSUMER_PATH = os.path.join(_WORKTREE, "consumer.py")

# 目录名带连字符，用 spec 加载 consumer.py。
_spec = importlib.util.spec_from_file_location("hermes_a2a_bridge_consumer", _CONSUMER_PATH)
consumer = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(consumer)


def _run(events, level=None, min_interval=0.0):
    """跑一遍 feed，返回发出的行列表（确定性：min_interval=0）。"""
    throttler = consumer.Throttler(min_interval=min_interval, level=level)
    sent = []
    for event in events:
        line = consumer.render_line(event, level=level)
        sent.extend(throttler.feed(event, line))
    return sent


def _step(name, arguments, result):
    return [
        {"type": "tool_call", "name": name, "arguments": arguments},
        {"type": "tool_result", "name": name, "text": result},
    ]


GROUP1 = "\n".join(["⌄ 执行了命令", "▸ 运行命令 · ls", "  total 4"])
GROUP2 = "\n".join(["⌄ 执行了命令", "▸ 运行命令 · pwd", "  /home"])


class GroupBoundaryTest(unittest.TestCase):
    # ---- V4 主断言：2 组 + 2 段叙述 -------------------------------------
    def test_tool_narration_tool_narration_yields_two_groups_two_narrations(self):
        events = (
            _step("bash", "ls", "total 4")
            + [{"type": "text", "text": "第一段叙述", "final": False}]
            + _step("bash", "pwd", "/home")
            + [{"type": "text", "text": "第二段叙述", "final": False}]
            + [{"type": "turn_end", "turn": 1, "reason": "stop"}]
        )
        sent = _run(events)
        groups = [line for line in sent if line.startswith("⌄ ")]
        narrations = [line for line in sent if line in ("第一段叙述", "第二段叙述")]
        self.assertEqual(len(groups), 2, f"应产出 2 个过程组，实得 {len(groups)}：{sent!r}")
        self.assertEqual(
            len(narrations), 2, f"应产出 2 段叙述，实得 {len(narrations)}：{sent!r}"
        )
        self.assertEqual(sent, [GROUP1, "第一段叙述", GROUP2, "第二段叙述", "▸ 已完成"])

    def test_group_always_precedes_the_narration_that_breaks_it(self):
        events = (
            _step("bash", "ls", "total 4")
            + [{"type": "text", "text": "叙述", "final": False}]
        )
        sent = _run(events)
        self.assertEqual(sent, [GROUP1, "叙述"])
        self.assertTrue(sent[0].startswith("⌄ "), "过程组必须先于叙述发出")

    def test_group_flushed_at_boundary_not_deferred_to_turn_end(self):
        # 边界即发：在没有 turn_end 的情况下，叙述到达时组就应已发出。
        events = (
            _step("bash", "ls", "total 4")
            + [{"type": "text", "text": "叙述", "final": False}]
        )
        throttler = consumer.Throttler(min_interval=0.0)
        out = []
        for event in events:
            out.extend(throttler.feed(event, consumer.render_line(event)))
        self.assertEqual(len(out), 2)
        self.assertTrue(out[0].startswith("⌄ "))
        self.assertEqual(throttler._members, [], "收口后组缓冲应为空")

    # ---- 既有语义不回归 -------------------------------------------------
    def test_consecutive_narrations_without_tools_are_not_split(self):
        # 无待收口组 → 沿用「低信号 text 累积」：两个非 final text 仍合成一条。
        events = [
            {"type": "text", "text": "第一块", "final": False},
            {"type": "text", "text": "第二块", "final": False},
            {"type": "status", "state": "completed"},
        ]
        self.assertEqual(_run(events), ["第一块 第二块", "▸ 已完成"])

    def test_turn_end_still_flushes_residual_group_and_narration(self):
        # 组 + 叙述同轮到达 turn_end：边界已发组+叙述，turn_end 只剩收束行。
        events = (
            _step("bash", "ls", "total 4")
            + [{"type": "text", "text": "叙述", "final": False}]
            + [{"type": "turn_end", "turn": 1, "reason": "stop"}]
        )
        sent = _run(events)
        self.assertEqual(sent, [GROUP1, "叙述", "▸ 已完成"])
        self.assertEqual(sum(1 for x in sent if x.startswith("▸ 已完成")), 1)

    def test_terminal_residual_narration_is_not_lost(self):
        # 只有叙述（无组）→ turn_end 兜底 flush，不丢信息。
        events = [
            {"type": "text", "text": "块内容", "final": False},
            {"type": "turn_end", "turn": 1, "reason": "stop"},
        ]
        self.assertEqual(_run(events), ["块内容", "▸ 已完成"])

    def test_residual_group_flushed_by_terminal_status(self):
        # 组未遇边界 → 终态 status 强制收口（不丢信息）。
        events = _step("bash", "ls", "total 4") + [
            {"type": "status", "state": "completed"}
        ]
        self.assertEqual(_run(events), [GROUP1, "▸ 已完成"])

    def test_wire_sequence_output_is_unchanged(self):
        # wire 序列是「叙述→工具→turn_end→final」：叙述先到、组后建，故边界不触发，
        # 输出与 v0.7.0 完全一致（组 → 叙述 → 收束行 → final）。
        def _text_part(text):
            return {"text": text}

        def _data_part(data):
            return {"data": data}

        def _artifact_update(parts, last_chunk, artifact_id=None, name=None, append=False):
            return {
                "artifactUpdate": {
                    "taskId": "t1",
                    "artifact": {"artifactId": artifact_id or "a", "parts": parts,
                                 "name": name or "x", "append": append},
                    "lastChunk": last_chunk,
                }
            }

        results = [
            {"statusUpdate": {"taskId": "t1", "contextId": "feishu/oc_x",
                              "status": {"state": "TASK_STATE_WORKING"}}},
            _artifact_update([_text_part("正在查看当前目录…")], False,
                             artifact_id="stream-text", name="StreamText", append=True),
            _artifact_update([_data_part({"kind": "thinking", "turn": 1, "text": "让我先想想"})], False),
            _artifact_update([_data_part({"kind": "tool_call", "turn": 1, "name": "shell_exec",
                                          "arguments": "ls"})], False),
            _artifact_update([_data_part({"kind": "tool_result", "turn": 1, "name": "shell_exec",
                                          "text": "total 4"})], False),
            _artifact_update([_data_part({"kind": "turn_end", "turn": 1, "reason": "stop"})], False),
            _artifact_update([_text_part("目录下有 4 个文件。")], True,
                             artifact_id="final", name="Result"),
        ]
        events = list(consumer.normalize_events(iter(results)))
        sent = _run(events)
        self.assertEqual(
            sent,
            [
                "\n".join(["⌄ 已调用工具", "✦ 思考 · 让我先想想",
                           "▸ 工具调用 · shell_exec · ls", "  total 4"]),
                "正在查看当前目录…",
                "▸ 已完成",
                "目录下有 4 个文件。",
            ],
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)

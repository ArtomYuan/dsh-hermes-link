"""卡片渲染结构与四档语义测试（V1 + V3，纯 stdlib unittest）。

运行方式
--------
    python3 tests/test_card_render.py

V1 结构合法性：``render_process_group_card`` 的输出必须是合法 2.0 卡片——
``schema="2.0"``、``body.elements`` 层级正确、``element_id`` 全局唯一且 ≤20 字符、
**只用【直证】字段**（2.0 对未知属性会报错，故逐层断言字段集合恰好等于白名单）。

V3 四档语义与 v0.7.0 文本版**逐档对拍**：同一份 members 下，卡片版的组头文案与成员行
必须与 ``render_process_group`` 逐字同源（``compact`` 面板内不出步骤行、``verbose``
不用面板且无组头等）。

members 取自真实事件序列重建，输出与
``~/.dsh/workspace/bridge-dsh-v2-1010/E2E-OUTPUT.txt`` 四档样例**逐字一致**
（见 ``test_text_render_matches_e2e_sample``）。
"""

import importlib.util
import json
import os
import unittest

_WORKTREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_CONSUMER_PATH = os.path.join(_WORKTREE, "consumer.py")
_spec = importlib.util.spec_from_file_location("hermes_a2a_bridge_consumer", _CONSUMER_PATH)
consumer = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(consumer)

# ---- 与 E2E-OUTPUT.txt 同源的真实过程组成员 ----------------------------------
E2E_MEMBERS = [
    {"kind": "think", "text": "先确认仓库结构与目标文件。\n再看测试是否覆盖。"},
    {"kind": "step", "name": "bash", "arguments": "ls -la",
     "result": "total 8\ndrwxr-xr-x  2 artom artom\n-rw-r--r--  1 artom artom consumer.py"},
    {"kind": "step", "name": "read", "arguments": "consumer.py",
     "result": "<path>consumer.py</path>\n<type>file</type>\n<content>\n...\n</content>"},
    {"kind": "step", "name": "grep", "arguments": "render_process_group",
     "result": "consumer.py:1: ..."},
    {"kind": "step", "name": "edit", "arguments": "consumer.py", "result": "ok"},
]

# E2E-OUTPUT.txt 四档样例（逐字摘录，用于文本版黄金对照）。
E2E_TEXT = {
    "compact": "\n".join(["⌄ 执行了命令，已读取文件，已搜索代码等", "✦ 思考"]),
    "standard": "\n".join([
        "⌄ 执行了命令，已读取文件，已搜索代码等",
        "✦ 思考 · 先确认仓库结构与目标文件。",
        "▸ 运行命令 · ls -la",
        "▸ 读取 · consumer.py",
        "▸ 搜索文件内容 · render_process_group",
        "▸ 编辑 · consumer.py",
    ]),
    "detailed": "\n".join([
        "⌄ 执行了命令，已读取文件，已搜索代码等",
        "✦ 思考 · 先确认仓库结构与目标文件。",
        "▸ 运行命令 · ls -la", "  total 8",
        "▸ 读取 · consumer.py", "  <path>consumer.py</path>",
        "▸ 搜索文件内容 · render_process_group", "  consumer.py:1: ...",
        "▸ 编辑 · consumer.py", "  ok",
    ]),
    "verbose": "\n".join([
        "✦ 思考 · 先确认仓库结构与目标文件。",
        "  再看测试是否覆盖。",
        "▸ 运行命令 · ls -la",
        "  total 8",
        "  drwxr-xr-x  2 artom artom",
        "  -rw-r--r--  1 artom artom consumer.py",
        "▸ 读取 · consumer.py",
        "  <path>consumer.py</path>",
        "  <type>file</type>",
        "  <content>",
        "  ...",
        "  </content>",
        "▸ 搜索文件内容 · render_process_group",
        "  consumer.py:1: ...",
        "▸ 编辑 · consumer.py",
        "  ok",
    ]),
}

# ---- V1：只用【直证】字段（逐层白名单，多一个键即失败）------------------------
ALLOWED_KEYS = {
    "card": {"schema", "config", "body"},
    "config": {"width_mode"},
    "body": {"elements"},
    "panel": {"tag", "element_id", "expanded", "direction", "vertical_spacing",
              "padding", "header", "border", "elements"},
    "panel_header": {"title", "vertical_align", "padding", "width",
                     "icon", "icon_position", "icon_expanded_angle"},
    "title": {"tag", "content"},
    "border": {"color", "corner_radius"},
    "markdown": {"tag", "element_id", "content", "text_size"},
}
PANEL_MODES = ("compact", "standard", "detailed")
ELEMENT_ID_MAX = 20


def _panels(card):
    return [
        e for e in (card.get("body") or {}).get("elements") or []
        if e.get("tag") == "collapsible_panel"
    ]


def _markdown_rows(card):
    """面板内外所有 markdown 成员行（按出现顺序）。"""
    if _panels(card):
        return [e for e in _panels(card)[0].get("elements") or []]
    return [e for e in (card.get("body") or {}).get("elements") or []]


def _iter_element_ids(card):
    stack = [card]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            if "element_id" in node:
                yield node["element_id"]
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)


class CardStructureTest(unittest.TestCase):
    """V1：2.0 结构断言。"""

    def test_schema_and_body_hierarchy(self):
        for level in consumer.LIVE_DETAIL_MODES:
            card = consumer.render_process_group_card(E2E_MEMBERS, level)
            self.assertEqual(card["schema"], "2.0", level)
            self.assertIn("body", card)
            self.assertIsInstance(card["body"]["elements"], list)
            self.assertTrue(card["body"]["elements"], level)

    def test_only_documented_keys(self):
        for level in consumer.LIVE_DETAIL_MODES:
            card = consumer.render_process_group_card(E2E_MEMBERS, level)
            self.assertEqual(set(card), ALLOWED_KEYS["card"], level)
            self.assertEqual(set(card["config"]), ALLOWED_KEYS["config"], level)
            self.assertEqual(set(card["body"]), ALLOWED_KEYS["body"], level)
            if _panels(card):
                panel = _panels(card)[0]
                self.assertEqual(set(panel), ALLOWED_KEYS["panel"], level)
                # 面板标题字段：基础四个 + 仅当启用图标 token 时才有图标三件套
                # （token `down-small-ccm_outlined` 不在图标库导出里，属 T1 待实测，
                # 默认不发 → 默认路径不引入未证实字段）。
                expect_header = {"title", "vertical_align", "padding", "width"}
                if consumer._CARD_PANEL_ICON_TOKEN:
                    expect_header |= {"icon", "icon_position", "icon_expanded_angle"}
                self.assertEqual(set(panel["header"]), expect_header, level)
                self.assertTrue(set(panel["header"]) <= ALLOWED_KEYS["panel_header"], level)
                self.assertEqual(set(panel["header"]["title"]), ALLOWED_KEYS["title"], level)
                self.assertEqual(set(panel["border"]), ALLOWED_KEYS["border"], level)
            for row in _markdown_rows(card):
                self.assertEqual(set(row), ALLOWED_KEYS["markdown"], level)
                self.assertEqual(row["tag"], "markdown", level)

    def test_element_ids_unique_and_bounded(self):
        for level in consumer.LIVE_DETAIL_MODES:
            card = consumer.render_process_group_card(E2E_MEMBERS, level)
            ids = list(_iter_element_ids(card))
            self.assertTrue(ids, level)
            self.assertEqual(len(ids), len(set(ids)), f"{level}: element_id 必须全局唯一")
            for element_id in ids:
                self.assertLessEqual(len(element_id), ELEMENT_ID_MAX, f"{level}: {element_id}")
                self.assertRegex(element_id, r"^[A-Za-z][A-Za-z0-9_]*$", f"{level}: {element_id}")

    def test_element_ids_unique_across_continuation_cards(self):
        # 续卡是另一张卡，各自内部唯一即可；同卡内不得重复。
        card = consumer.render_process_group_card(E2E_MEMBERS, "standard", card_index=3,
                                                 continued=True)
        ids = list(_iter_element_ids(card))
        self.assertEqual(len(ids), len(set(ids)))
        self.assertTrue(all(i.startswith("dsh_c3") for i in ids), ids)

    def test_panel_presence_and_expanded_by_tier(self):
        compact = consumer.render_process_group_card(E2E_MEMBERS, "compact")
        standard = consumer.render_process_group_card(E2E_MEMBERS, "standard")
        detailed = consumer.render_process_group_card(E2E_MEMBERS, "detailed")
        verbose = consumer.render_process_group_card(E2E_MEMBERS, "verbose")
        for card in (compact, standard, detailed):
            self.assertTrue(_panels(card), "折叠面板档必须用 collapsible_panel")
        self.assertFalse(_panels(verbose), "verbose 不用面板（平铺直出）")
        self.assertIs(compact["body"]["elements"][0]["expanded"], False)
        self.assertIs(standard["body"]["elements"][0]["expanded"], False)
        self.assertIs(detailed["body"]["elements"][0]["expanded"], True)

    def test_empty_members_yield_empty_card(self):
        self.assertEqual(consumer.render_process_group_card([], "standard"), {})

    def test_card_is_json_serializable(self):
        for level in consumer.LIVE_DETAIL_MODES:
            card = consumer.render_process_group_card(E2E_MEMBERS, level)
            json.dumps(card, ensure_ascii=False)  # 不抛即可


class CardTierParityTest(unittest.TestCase):
    """V3：卡片四档语义与文本版逐字对拍。"""

    def test_text_render_matches_e2e_sample(self):
        # 文本版是与 E2E-OUTPUT.txt 同源的黄金对照（确认 members 重建无误）。
        for level, expected in E2E_TEXT.items():
            self.assertEqual(consumer.render_process_group(E2E_MEMBERS, level), expected, level)

    def test_card_header_equals_text_header(self):
        for level in PANEL_MODES:
            text = consumer.render_process_group(E2E_MEMBERS, level)
            card = consumer.render_process_group_card(E2E_MEMBERS, level)
            self.assertEqual(
                _panels(card)[0]["header"]["title"]["content"], text.split("\n")[0], level
            )

    def test_card_rows_equal_text_member_rows(self):
        for level in consumer.LIVE_DETAIL_MODES:
            text = consumer.render_process_group(E2E_MEMBERS, level)
            card = consumer.render_process_group_card(E2E_MEMBERS, level)
            card_body = "\n".join(row["content"] for row in _markdown_rows(card))
            if level == "verbose":
                # verbose 无组头：卡片正文 == 文本全文。
                self.assertEqual(card_body, text, level)
            else:
                # 非 verbose：卡片正文 == 文本去掉组头行之后的部分。
                self.assertEqual(card_body, "\n".join(text.split("\n")[1:]), level)

    def test_card_row_text_size_is_notation(self):
        for level in consumer.LIVE_DETAIL_MODES:
            card = consumer.render_process_group_card(E2E_MEMBERS, level)
            for row in _markdown_rows(card):
                self.assertEqual(row["text_size"], "notation", level)

    def test_compact_panel_has_no_step_rows(self):
        card = consumer.render_process_group_card(E2E_MEMBERS, "compact")
        rows = [r["content"] for r in _markdown_rows(card)]
        self.assertFalse([r for r in rows if r.startswith("▸ ")], rows)
        self.assertTrue([r for r in rows if r.startswith("✦")], rows)

    def test_detailed_and_verbose_carry_result_bodies(self):
        detailed = "\n".join(r["content"] for r in _markdown_rows(
            consumer.render_process_group_card(E2E_MEMBERS, "detailed")))
        standard = "\n".join(r["content"] for r in _markdown_rows(
            consumer.render_process_group_card(E2E_MEMBERS, "standard")))
        self.assertIn("  total 8", detailed)
        self.assertNotIn("  total 8", standard)

    def test_verbose_has_no_group_header_in_card(self):
        card = consumer.render_process_group_card(E2E_MEMBERS, "verbose")
        joined = "\n".join(r["content"] for r in _markdown_rows(card))
        self.assertNotIn(consumer._GLYPH_GROUP, joined)

    def test_unknown_level_falls_back_to_detailed(self):
        card = consumer.render_process_group_card(E2E_MEMBERS, "bogus")
        expanded = _panels(card)[0]["expanded"]
        self.assertIs(expanded, True, "非四档应回落 detailed（expanded=true）")

    def test_continued_card_marks_continuation(self):
        base = consumer.render_process_group_card(E2E_MEMBERS, "standard")
        cont = consumer.render_process_group_card(E2E_MEMBERS, "standard", continued=True)
        self.assertEqual(
            _panels(cont)[0]["header"]["title"]["content"],
            _panels(base)[0]["header"]["title"]["content"] + consumer._CARD_CONT_MARK,
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)

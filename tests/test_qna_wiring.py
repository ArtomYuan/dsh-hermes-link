"""§2.6 问答卡回调**接线**测试：桥 → 适配器注册表 → 处理器派发（纯 stdlib unittest）。

运行方式
--------
    python3 tests/test_qna_wiring.py

只验证接线本身（不需要真实网关/飞书）：用假 ``gateway.run`` / ``gateway.config`` 提供
一个假适配器实例，其类的 ``__module__`` 指向一个假适配器模块（内含
``register_ask_action_handler`` 注册表与 ``_handle_ask_card_action`` 式的派发）。断言：

- 桥把 ``qna.handle_card_action`` 挂进了适配器注册表（同进程直连的方向）；
- 幂等：同一平台重复调用只挂一次；
- 适配器模块缺 ``register_ask_action_handler`` 时**只告警不抛**（补丁未打也不阻断直播）；
- 取不到适配器时同样只告警不抛。
"""

import importlib.util
import os
import sys
import types
import unittest

_WORKTREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location("hermes_a2a_bridge", os.path.join(_WORKTREE, "__init__.py"))
bridge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bridge)

_FAKE_ADAPTER_MODULE = "fake_feishu_adapter_for_qna_wiring"
_PREEXISTING = {name: sys.modules.get(name) for name in ("gateway", "gateway.run", "gateway.config", _FAKE_ADAPTER_MODULE)}


def install_fake_gateway(adapter):
    """装一套假 gateway：runner.adapters[Platform('feishu')] = adapter；Platform 取值即字符串。"""
    pkg = types.ModuleType("gateway")
    run_mod = types.ModuleType("gateway.run")
    config_mod = types.ModuleType("gateway.config")
    runner = types.SimpleNamespace(adapters={"feishu": adapter})
    run_mod._gateway_runner_ref = lambda: runner
    config_mod.Platform = lambda value: value
    sys.modules["gateway"] = pkg
    sys.modules["gateway.run"] = run_mod
    sys.modules["gateway.config"] = config_mod
    return runner


def restore_modules():
    for name, prev in _PREEXISTING.items():
        if prev is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = prev


class AskActionWiringTest(unittest.TestCase):
    def setUp(self):
        bridge._ASK_HANDLER_REGISTERED.clear()
        self.registered = []

        def register(handler):
            if handler not in self.registered:
                self.registered.append(handler)

        module = types.ModuleType(_FAKE_ADAPTER_MODULE)
        module.register_ask_action_handler = register
        sys.modules[_FAKE_ADAPTER_MODULE] = module

        adapter_cls = type("FakeFeishuAdapter", (), {})
        adapter_cls.__module__ = _FAKE_ADAPTER_MODULE
        self.adapter = adapter_cls()
        install_fake_gateway(self.adapter)

    def tearDown(self):
        restore_modules()
        bridge._ASK_HANDLER_REGISTERED.clear()

    def test_handler_is_registered_once_and_is_idempotent(self):
        bridge._ensure_ask_action_handler("feishu")
        bridge._ensure_ask_action_handler("feishu")
        self.assertEqual(len(self.registered), 1, "同平台只应挂一次")
        self.assertIs(self.registered[0], bridge._import_qna().handle_card_action)

    def test_registered_handler_answers_a_live_slot(self):
        qna = bridge._import_qna()
        slot = qna.AskSlot("ask-wire", [{"id": "q1", "question": "?", "options": [{"label": "甲"}]}])
        qna.register_ask(slot)
        try:
            bridge._ensure_ask_action_handler("feishu")
            card = self.registered[0](
                {
                    "action_value": {"hermes_ask_action": "pick", "ask_id": "ask-wire", "qid": "q1", "choice": "1"},
                    "action_form_value": {},
                    "operator_open_id": "ou_admin",
                }
            )
            self.assertEqual(card["schema"], "2.0")
            self.assertEqual(slot.wait_for("q1")["selected"], ["甲"])
        finally:
            qna.discard_ask("ask-wire")

    def test_missing_patch_warns_but_does_not_raise(self):
        del sys.modules[_FAKE_ADAPTER_MODULE].register_ask_action_handler
        with self.assertLogs(bridge.logger.name, level="WARNING") as logs:
            bridge._ensure_ask_action_handler("feishu")
        self.assertTrue(any("register_ask_action_handler" in line for line in logs.output))
        self.assertEqual(self.registered, [])

    def test_no_adapter_warns_but_does_not_raise(self):
        del sys.modules["gateway.run"]._gateway_runner_ref
        sys.modules["gateway.run"]._gateway_runner_ref = lambda: None
        with self.assertLogs(bridge.logger.name, level="WARNING") as logs:
            bridge._ensure_ask_action_handler("feishu")
        self.assertTrue(any("适配器" in line for line in logs.output))


if __name__ == "__main__":
    unittest.main(verbosity=2)

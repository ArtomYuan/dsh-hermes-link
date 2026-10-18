"""§2.1 工作区选择 ＋ §2.4 沙箱档：**桥侧**参数面单测（纯 stdlib unittest）。

运行方式
--------
    python3 tests/test_request_options.py

三块面：
- **线上键一致性**：桥与 consumer 两处同名字面量必须一致（服务端按同名键读，漂了就是静默失效）；
- **报文形状**：`a2a_call(workspace=…, sandbox=…)` → 首投报文 `message.metadata` 带上
  `x-dsh-workspace` / `x-dsh-sandbox`；**不带参数时 metadata 与升级前逐字一致**（只有能力声明）；
- **拒绝纪律**：非法档位 / 空工作区 / 参数存在但走不到流式投递（collector 关等）一律
  block 并说明，**绝不静默改用默认值**。
"""

import importlib.util
import os
import sys
import types
import unittest

_WORKTREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_MODULE_PATH = os.path.join(_WORKTREE, "__init__.py")
_CONSUMER_PATH = os.path.join(_WORKTREE, "consumer.py")

_spec = importlib.util.spec_from_file_location("hermes_a2a_bridge", _MODULE_PATH)
_MODULE = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_MODULE)

_cspec = importlib.util.spec_from_file_location("hermes_a2a_bridge_consumer_ro", _CONSUMER_PATH)
_CONSUMER = importlib.util.module_from_spec(_cspec)
_cspec.loader.exec_module(_CONSUMER)

_PREEXISTING = {
    name: sys.modules.get(name)
    for name in ("gateway", "gateway.session_context", "hermes_cli", "hermes_cli.config")
}

_CONFIG = {
    "a2a_agents": {
        "dsh": {"url": "http://127.0.0.1:8092", "auth": {"type": "bearer", "token": "token-dsh"}},
        "ivan": {"url": "http://192.168.50.32:9900", "auth": {"type": "bearer", "token": "token-ivan"}},
    }
}


def _restore_modules():
    for name, prev in _PREEXISTING.items():
        if prev is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = prev


def _install_fake_gateway(is_messaging, env_values):
    pkg = types.ModuleType("gateway")
    pkg.__path__ = []
    mod = types.ModuleType("gateway.session_context")
    mod.session_is_messaging_surface = lambda: is_messaging
    mod.get_session_env = lambda key, default="": env_values.get(key, default)
    sys.modules["gateway"] = pkg
    sys.modules["gateway.session_context"] = mod
    pkg.session_context = mod


def _install_fake_hermes_cli(config_dict):
    pkg = types.ModuleType("hermes_cli")
    pkg.__path__ = []
    mod = types.ModuleType("hermes_cli.config")
    mod.load_config = lambda: config_dict
    sys.modules["hermes_cli"] = pkg
    sys.modules["hermes_cli.config"] = mod
    pkg.config = mod


class _SettingsCtx:
    def __init__(self, settings=None):
        self.settings = dict(settings or {})

    def get_config(self, key, default=None):
        return self.settings.get(key, default)

    def register_hook(self, *_args, **_kwargs):
        pass


class WireKeyTest(unittest.TestCase):
    """两侧线上键必须一致（服务端按同名键读；漂了＝参数静默失效）。"""

    def test_wire_literals_pinned(self):
        """线上字面量钉死（TS 侧同样钉一份；任一侧改名都会在本地测试炸）。"""
        self.assertEqual(_MODULE.WORKSPACE_META_KEY, "x-dsh-workspace")
        self.assertEqual(_MODULE.SANDBOX_META_KEY, "x-dsh-sandbox")
        self.assertEqual(_CONSUMER.WORKSPACE_META_KEY, "x-dsh-workspace")
        self.assertEqual(_CONSUMER.SANDBOX_META_KEY, "x-dsh-sandbox")
        self.assertEqual(
            tuple(_CONSUMER.SANDBOX_TIERS), ("read-only", "workspace-write", "danger-full-access")
        )

    def test_meta_keys_and_tiers_match_consumer(self):
        self.assertEqual(_MODULE.WORKSPACE_META_KEY, _CONSUMER.WORKSPACE_META_KEY)
        self.assertEqual(_MODULE.SANDBOX_META_KEY, _CONSUMER.SANDBOX_META_KEY)
        self.assertEqual(tuple(_MODULE.SANDBOX_TIERS), tuple(_CONSUMER.SANDBOX_TIERS))
        self.assertEqual(_MODULE.SANDBOX_TIERS, ("read-only", "workspace-write", "danger-full-access"))


class StreamBodyTest(unittest.TestCase):
    def test_body_unchanged_when_no_options(self):
        body = _CONSUMER._streaming_message_body("hi", "feishu/oc_x")
        message = body["params"]["message"]
        self.assertEqual(message["metadata"], {_CONSUMER.QNA_OPT_IN_KEY: True})
        self.assertEqual(body["method"], "SendStreamingMessage")
        self.assertEqual(message["contextId"], "feishu/oc_x")

    def test_body_carries_request_options(self):
        meta = {
            _MODULE.WORKSPACE_META_KEY: "我的书",
            _MODULE.SANDBOX_META_KEY: "workspace-write",
        }
        body = _CONSUMER._streaming_message_body("hi", "feishu/oc_x", meta)
        metadata = body["params"]["message"]["metadata"]
        self.assertEqual(metadata[_MODULE.WORKSPACE_META_KEY], "我的书")
        self.assertEqual(metadata[_MODULE.SANDBOX_META_KEY], "workspace-write")
        # 能力声明不被选项挤掉
        self.assertIs(metadata[_CONSUMER.QNA_OPT_IN_KEY], True)


class ExtractMetaTest(unittest.TestCase):
    def test_absent_options(self):
        self.assertEqual(_MODULE._extract_request_meta({"agent": "dsh", "message": "hi"}), ({}, None))

    def test_valid_options_are_trimmed(self):
        meta, err = _MODULE._extract_request_meta({"workspace": "  我的书 ", "sandbox": " workspace-write "})
        self.assertIsNone(err)
        self.assertEqual(meta, {
            _MODULE.WORKSPACE_META_KEY: "我的书",
            _MODULE.SANDBOX_META_KEY: "workspace-write",
        })

    def test_invalid_values_are_rejected_with_explanation(self):
        for args, needle in (
            ({"sandbox": "sudo"}, "未知沙箱档"),
            ({"sandbox": 7}, "未知沙箱档"),
            ({"workspace": ""}, "非空字符串"),
            ({"workspace": "   "}, "非空字符串"),
            ({"workspace": 42}, "非空字符串"),
        ):
            meta, err = _MODULE._extract_request_meta(args)
            self.assertEqual(meta, {})
            self.assertIsNotNone(err, f"{args} 应被拒绝")
            self.assertIn(needle, err)


class PreToolCallTest(unittest.TestCase):
    """_on_pre_tool_call 的参数面：传参 / 拒绝 / 未生效即 block。"""

    def setUp(self):
        _restore_modules()
        _install_fake_gateway(
            True, {"HERMES_SESSION_PLATFORM": "feishu", "HERMES_SESSION_CHAT_ID": "oc_x"}
        )
        _install_fake_hermes_cli(_CONFIG)
        _MODULE._CTX = _SettingsCtx()
        self._orig_spawn = _MODULE._spawn_stream_worker
        self.spawned = []

        def fake_spawn(message, origin, request_meta=None):
            self.spawned.append((message, origin, request_meta))

        _MODULE._spawn_stream_worker = fake_spawn

    def tearDown(self):
        _MODULE._spawn_stream_worker = self._orig_spawn
        _MODULE._CTX = None
        _restore_modules()

    def _enable_collector(self, enabled=True):
        _MODULE._CTX = _SettingsCtx({"collector.enabled": enabled})

    def test_options_threaded_into_stream_worker_and_receipt(self):
        self._enable_collector(True)
        result = _MODULE._on_pre_tool_call(
            "a2a_call",
            {"agent": "dsh", "message": "hi", "workspace": "我的书", "sandbox": "workspace-write"},
        )
        self.assertEqual(result["action"], "block")
        self.assertEqual(len(self.spawned), 1)
        message, origin, request_meta = self.spawned[0]
        self.assertEqual(message, "hi")
        self.assertEqual(request_meta, {
            _MODULE.WORKSPACE_META_KEY: "我的书",
            _MODULE.SANDBOX_META_KEY: "workspace-write",
        })
        self.assertIn("工作区=我的书", result["message"])
        self.assertIn("沙箱=workspace-write", result["message"])

    def test_invalid_sandbox_blocks_without_spawning(self):
        self._enable_collector(True)
        result = _MODULE._on_pre_tool_call("a2a_call", {"agent": "dsh", "message": "hi", "sandbox": "root"})
        self.assertEqual(result["action"], "block")
        self.assertIn("参数不合法", result["message"])
        self.assertIn("read-only", result["message"])
        self.assertEqual(self.spawned, [])

    def test_options_without_streaming_path_block_loudly(self):
        """collector 关（不回退流式）时带参数 → 明确拒绝，不静默忽略。"""
        self._enable_collector(False)
        result = _MODULE._on_pre_tool_call(
            "a2a_call", {"agent": "dsh", "message": "hi", "workspace": "我的书"}
        )
        self.assertEqual(result["action"], "block")
        self.assertIn("未生效", result["message"])
        self.assertIn("collector.enabled", result["message"])
        self.assertEqual(self.spawned, [])

    def test_non_dsh_target_with_options_blocks(self):
        """非 dsh 目标带参 → 明确 block（参数只在 dsh 流式路径生效）"""
        self._enable_collector(True)
        result = _MODULE._on_pre_tool_call(
            "a2a_call", {"agent": "ivan", "message": "hi", "workspace": "我的书"}
        )
        self.assertEqual(result["action"], "block")
        self.assertIn("未生效", result["message"])
        self.assertEqual(self.spawned, [])

    def test_workspace_shape_is_delegated_to_server(self):
        """桥只挡「非法档位/空名字」；更细的形状规则由服务端校验（两层设计，避免双实现漂移）。"""
        self._enable_collector(True)
        result = _MODULE._on_pre_tool_call(
            "a2a_call", {"agent": "dsh", "message": "hi", "workspace": "a/b"}
        )
        self.assertEqual(result["action"], "block")  # block 是「已受理」回执
        self.assertEqual(len(self.spawned), 1)
        self.assertEqual(self.spawned[0][2], {_MODULE.WORKSPACE_META_KEY: "a/b"})

    def test_no_options_keeps_old_behavior(self):
        """不带参数：行为与升级前一致（collector 关 → 不 spawn；仅注入 origin 或放行）。"""
        self._enable_collector(False)
        # collector 关：不接管投递，但仍按旧行为注入 origin（modify），不 spawn
        self.assertEqual(
            _MODULE._on_pre_tool_call("a2a_call", {"agent": "dsh", "message": "hi"}),
            {"action": "modify", "args": {"context_id": "feishu/oc_x"}},
        )
        self.assertEqual(self.spawned, [])
        self._enable_collector(True)
        result = _MODULE._on_pre_tool_call("a2a_call", {"agent": "dsh", "message": "hi"})
        self.assertEqual(result["action"], "block")
        self.assertEqual(len(self.spawned), 1)
        self.assertIsNone(self.spawned[0][2])


class ConsumeStreamPassthroughTest(unittest.TestCase):
    """consume_stream 把 extra_metadata 送到首投报文（真实 body 构造，桩掉网络）。"""

    def setUp(self):
        self._orig_iter = _CONSUMER.iter_sse_data
        self.bodies = []
        _CONSUMER.iter_sse_data = lambda url, body, headers, timeout: self._record(body)
        _CONSUMER._QNA_MODULE = None

    def tearDown(self):
        _CONSUMER.iter_sse_data = self._orig_iter

    def _record(self, body):
        self.bodies.append(body)
        return iter([])

    def test_extra_metadata_reaches_wire(self):
        def sender(p, c, t, text, card=None):
            return {"ok": True, "via": "adapter"}

        _CONSUMER.consume_stream(
            url="http://127.0.0.1:9300/", token="", message="hi", context_id="feishu/oc_x",
            platform="feishu", chat_id="oc_x", thread_id="", sender=sender,
            min_interval=0.0, timeout=5, events=True, extra_metadata={"x-dsh-workspace": "我的书"},
        )
        self.assertEqual(len(self.bodies), 1)
        self.assertEqual(
            self.bodies[0]["params"]["message"]["metadata"]["x-dsh-workspace"], "我的书",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)

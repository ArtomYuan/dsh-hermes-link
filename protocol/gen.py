#!/usr/bin/env python3
"""链路协议生成器：`protocol/link-protocol.json` → 两端常量文件。

用法：
    python3 protocol/gen.py           # 生成/更新 hermes/link_protocol.py 与 dsh/src/link-protocol.ts
    python3 protocol/gen.py --check   # 只校验产物是否与定义一致（CI；漂移则退出码 1）

产物**提交入库**，两端的运行时不依赖 protocol/ 目录（安装路径不变）。
"""
from __future__ import annotations

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEC_PATH = os.path.join(ROOT, 'protocol', 'link-protocol.json')
TARGETS = {
    os.path.join('hermes', 'link_protocol.py'): 'py',
    os.path.join('dsh', 'src', 'link-protocol.ts'): 'ts',
}


def _const(k: str) -> str:
    return ''.join('_' + c if c.isupper() else c for c in k).upper()


def render_python(spec: dict) -> str:
    lines = [
        '"""A2A ⇄ Hermes 链路协议常量（**生成文件，勿手改**）。',
        '',
        '源：protocol/link-protocol.json；重新生成：`python3 protocol/gen.py`。',
        '两端（hermes/ 桥、dsh/ 服务端）共用同一份定义，CI 用 `--check` 防漂移。',
        '"""',
        '',
        f"PROTOCOL_VERSION = {spec['protocolVersion']}",
        f"A2A_VERSION = {json.dumps(spec['a2aVersion'])}",
        '',
        f"METADATA_WORKSPACE = {json.dumps(spec['metadataKeys']['workspace'])}",
        f"METADATA_SANDBOX = {json.dumps(spec['metadataKeys']['sandbox'])}",
        f"METADATA_USER_QUESTIONS = {json.dumps(spec['metadataKeys']['userQuestions'])}",
        '',
        f"SANDBOX_TIERS = ({', '.join(json.dumps(t) for t in spec['sandboxTiers'])},)",
        '',
        f"CARD_ACTION_KEY = {json.dumps(spec['cardActionKey'])}",
        f"CARD_ACTIONS = ({', '.join(json.dumps(a) for a in spec['cardActions'])},)",
        '',
    ]
    for k, v in spec['eventTypes'].items():
        lines.append(f"EVENT_{_const(k)} = {json.dumps(v)}")
    lines.append('')
    for k, v in spec['payloadKinds'].items():
        lines.append(f"KIND_{_const(k)} = {json.dumps(v)}")
    lines.append('')
    for k, v in spec['questionFieldNames'].items():
        lines.append(f"FIELD_{_const(k)} = {json.dumps(v)}")
    for k, v in spec['cardValueFields'].items():
        lines.append(f"CARD_FIELD_{_const(k)} = {json.dumps(v)}")
    lines += [
        '',
        f"TERMINAL_TASK_STATES = ({', '.join(json.dumps(s) for s in spec['terminalTaskStates'])},)",
        f"TASK_STATE_PREFIX = {json.dumps(spec['taskStatePrefix'])}",
        f"STATUS_REASONS = {json.dumps(spec['statusReasons'], ensure_ascii=False)}",
        '',
    ]
    return '\n'.join(lines)


def render_ts(spec: dict) -> str:
    t = [
        '/** A2A ⇄ Hermes 链路协议常量（**生成文件，勿手改**）。',
        ' *',
        ' * 源：protocol/link-protocol.json；重新生成：`python3 protocol/gen.py`。',
        ' * 两端（hermes/ 桥、dsh/ 服务端）共用同一份定义，CI 用 `--check` 防漂移。',
        ' */',
        '',
        f"export const LINK_PROTOCOL_VERSION = {spec['protocolVersion']}",
        f"export const A2A_VERSION = {json.dumps(spec['a2aVersion'])}",
        '',
        f"export const WORKSPACE_META_KEY = {json.dumps(spec['metadataKeys']['workspace'])}",
        f"export const SANDBOX_META_KEY = {json.dumps(spec['metadataKeys']['sandbox'])}",
        f"export const USER_QUESTIONS_META_KEY = {json.dumps(spec['metadataKeys']['userQuestions'])}",
        '',
        'export const SANDBOX_TIERS = [',
    ]
    for tier in spec['sandboxTiers']:
        t.append(f"  {json.dumps(tier)},")
    t += [
        '] as const',
        'export type SandboxTier = (typeof SANDBOX_TIERS)[number]',
        '',
        f"export const CARD_ACTION_KEY = {json.dumps(spec['cardActionKey'])}",
        f"export const CARD_ACTIONS = {json.dumps(spec['cardActions'])} as const",
        '',
        '/** 事件类型（桥侧归一化事件 / 服务端流事件描述符共用） */',
        'export const EVENT_TYPES = {',
    ]
    for k, v in spec['eventTypes'].items():
        t.append(f"  {k}: {json.dumps(v)},")
    t += [
        '} as const',
        '',
        '/** A2A Data Part 私有载荷 kind */',
        'export const PAYLOAD_KINDS = {',
    ]
    for k, v in spec['payloadKinds'].items():
        t.append(f"  {k}: {json.dumps(v)},")
    t += [
        '} as const',
        '',
        '/** 提问/作答载荷字段名 */',
        'export const QUESTION_FIELDS = {',
    ]
    for k, v in spec['questionFieldNames'].items():
        t.append(f"  {k}: {json.dumps(v)},")
    t += ['} as const', '', '/** 卡片回传值字段名（适配器补丁 ↔ 桥协议） */', 'export const CARD_VALUE_FIELDS = {']
    for k, v in spec['cardValueFields'].items():
        t.append(f"  {k}: {json.dumps(v)},")
    t += [
        '} as const',
        '',
        f"export const TERMINAL_TASK_STATES = {json.dumps(spec['terminalTaskStates'])} as const",
        f"export const TASK_STATE_PREFIX = {json.dumps(spec['taskStatePrefix'])}",
        f"export const STATUS_REASONS = {json.dumps(spec['statusReasons'])} as const",
        '',
    ]
    return '\n'.join(t)


def main() -> int:
    spec = json.load(open(SPEC_PATH, encoding='utf-8'))
    rendered = {
        rel: (render_python(spec) if kind == 'py' else render_ts(spec))
        for rel, kind in TARGETS.items()
    }
    if '--check' in sys.argv:
        drift = []
        for rel, want in rendered.items():
            path = os.path.join(ROOT, rel)
            have = open(path, encoding='utf-8').read() if os.path.exists(path) else ''
            if have != want:
                drift.append(rel)
        print('DRIFT: ' + ', '.join(drift) if drift else 'protocol artifacts up-to-date')
        return 1 if drift else 0
    for rel, want in rendered.items():
        path = os.path.join(ROOT, rel)
        os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write(want)
        print('wrote', rel)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

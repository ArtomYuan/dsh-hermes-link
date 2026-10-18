#!/usr/bin/env python3
"""链路契约（Python 侧）：同一组 fixtures，断言桥侧解析结果与协议定义一致。

运行：`python3 tests/contract/run_contract.py`（根 `scripts/test-all.sh` 已含）。
fixtures 在 `tests/contract/fixtures/`，两侧各跑一遍、断言同一份期望。
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERMES = os.path.join(ROOT, 'hermes')
FIXTURES = os.path.join(ROOT, 'tests', 'contract', 'fixtures')
PROTOCOL = json.load(open(os.path.join(ROOT, 'protocol', 'link-protocol.json'), encoding='utf-8'))


def load(name: str):
    path = os.path.join(HERMES, name + '.py')
    spec = importlib.util.spec_from_file_location('contract_' + name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    # 让模块内的相对导入回退（consumer/qna/__init__ 自带 dual-path loader）生效
    sys.path.insert(0, HERMES)
    spec.loader.exec_module(mod)
    return mod


def fixture(name: str) -> dict:
    return json.load(open(os.path.join(FIXTURES, name), encoding='utf-8'))


checks = 0


def check(label: str, actual, expected):
    global checks
    if actual != expected:
        print(f'FAIL {label}\n  actual  = {json.dumps(actual, ensure_ascii=False)}\n  expected= {json.dumps(expected, ensure_ascii=False)}')
        raise SystemExit(1)
    checks += 1


def main() -> int:
    consumer = load('consumer')
    qna = load('qna')
    bridge = load('__init__')

    # 0. 协议常量与定义一致（防生成物漂移）
    check('protocol.metadataKeys.workspace', consumer.WORKSPACE_META_KEY, PROTOCOL['metadataKeys']['workspace'])
    check('protocol.metadataKeys.sandbox', consumer.SANDBOX_META_KEY, PROTOCOL['metadataKeys']['sandbox'])
    check('protocol.metadataKeys.userQuestions', consumer.QNA_OPT_IN_KEY, PROTOCOL['metadataKeys']['userQuestions'])
    check('protocol.sandboxTiers', list(consumer.SANDBOX_TIERS), PROTOCOL['sandboxTiers'])
    check('protocol.version', consumer.LINK_PROTOCOL_VERSION, PROTOCOL['protocolVersion'])
    check('protocol.cardActionKey', qna.ASK_ACTION_KEY, PROTOCOL['cardActionKey'])

    # 1. 请求级选项：tool args → metadata（服务端再解析，见 Node 侧）
    for name in ('request-metadata.json', 'request-metadata-path.json'):
        fx = fixture(name)
        meta, err = bridge._extract_request_meta(fx['tool_args'])
        check(f'{name}: err', err, None)
        check(f'{name}: metadata', meta, fx['metadata'])

    # 2. 提问载荷：服务端生产形状 → 线上 data part → 桥解析
    fx = fixture('question-payload.json')
    frame = {'artifactUpdate': {'taskId': fx['task_id'], 'artifact': {
        'artifactId': 'a1', 'name': 'StreamQuestion',
        'parts': [{'data': fx['expect_payload'], 'mediaType': 'application/json'}]},
        'append': False, 'lastChunk': False}}
    events = [e for e in consumer.normalize_events([frame]) if e['type'] == 'question']
    check('question-payload: event count', len(events), 1)
    check('question-payload: ask_id', events[0]['ask_id'], fx['ask_id'])
    check('question-payload: task_id', events[0]['task_id'], fx['task_id'])
    check('question-payload: payload', events[0]['payload'], fx['expect_payload'])

    # 3. 作答报文：桥产出的续投 message ↔ 服务端解析（Node 侧反解同一 data part）
    fx = fixture('answer-message.json')
    body = qna.answer_stream_body(task_id=fx['task_id'], context_id=fx['context_id'],
                                  ask_id=fx['ask_id'], answers=fx['answers'])
    message = body['params']['message']
    check('answer-message: method', body['method'], 'SendStreamingMessage')
    check('answer-message: taskId', message['taskId'], fx['task_id'])
    check('answer-message: contextId', message['contextId'], fx['context_id'])
    check('answer-message: data part', message['parts'][0]['data'], fx['expect_data_part'])

    # 4. 失败原因：服务端 FAILED 状态消息 → 桥归一化
    fx = fixture('failed-status.json')
    status = [e for e in consumer.normalize_events([fx['frame']]) if e['type'] == 'status']
    check('failed-status: state', status[0]['state'], fx['expect_state'])
    check('failed-status: reason', status[0]['message'], fx['expect_reason'])

    print(f'contract(python): OK — {checks} checks across 5 fixtures')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

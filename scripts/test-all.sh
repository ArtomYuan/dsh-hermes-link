#!/usr/bin/env bash
# 全测门禁：协议漂移 + 双侧契约 + 桥测试 + 服务端构建与测试。
# 每一阶段收尾都跑它；任何一项失败即非零退出。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "== 1/6 协议漂移（protocol/gen.py --check）=="
python3 protocol/gen.py --check

echo "== 2/6 契约（Python 侧）=="
python3 tests/contract/run_contract.py

echo "== 3/6 桥测试（hermes/tests）=="
bridge_total=0
for t in hermes/tests/test_*.py; do
  out="$(python3 -B "$t" 2>&1)" || { echo "$out" | tail -20; echo "FAIL $t"; exit 1; }
  n="$(printf '%s\n' "$out" | grep -oE 'Ran [0-9]+ tests?' | tail -1 | grep -oE '[0-9]+')"
  bridge_total=$((bridge_total + n))
done
echo "bridge tests=$bridge_total files=$(ls hermes/tests/test_*.py | wc -l | tr -d ' ')"

echo "== 4/6 服务端构建（tsc + tsdown）=="
(cd dsh && node node_modules/.bin/tsc -p tsconfig.json --noEmit && node node_modules/.bin/tsdown --config tsdown.prepare.config.ts >/dev/null)

echo "== 5/6 契约（Node 侧，读 dsh/lib 构建产物）=="
node tests/contract/run-contract.mjs

echo "== 6/6 服务端测试（dsh/tests）=="
(cd dsh && node --test tests/*.test.mjs 2>&1 | grep -E '^# (tests|pass|fail)')

echo "ALL GREEN"

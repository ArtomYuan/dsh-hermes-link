#!/usr/bin/env bash
# 安装后自检：版本握手 + 端口健康 + 飞书连接 + 协议漂移。
# 用法：scripts/verify.sh [--soft]
#   任一项 FAIL 退出 1；--soft 时飞书连接只告警不判失败（如在无网关闭环境跑）。
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
SOFT=0
for arg in "$@"; do
  case "$arg" in
    --soft) SOFT=1 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) die "未知参数：$arg" 2 ;;
  esac
done

FAILED=0
report() { # $1=状态 $2=项 $3=细节
  printf '%-4s %-22s %s\n' "$1" "$2" "$3"
  [ "$1" = "FAIL" ] && FAILED=1
}

say "════ dsh-hermes-link self-check ════"
require_paired_versions
resolve_endpoint

# 1) 版本握手（两半 + agent-card + 协议）
srv="$(installed_version_server)"; bridge="$(installed_version_bridge)"
[ "$srv" = "$REPO_VERSION" ] && report OK "服务端已装版本" "$srv" || report FAIL "服务端已装版本" "$srv（期望 $REPO_VERSION）"
[ "$bridge" = "$REPO_VERSION" ] && report OK "桥已装版本" "$bridge" || report FAIL "桥已装版本" "$bridge（期望 $REPO_VERSION）"
card="$(agent_card_version 2>/dev/null || true)"
[ "$card" = "$REPO_VERSION" ] && report OK "agent-card 版本" "$card" || report FAIL "agent-card 版本" "${card:-不可达}（期望 $REPO_VERSION）"

# 2) 8091 健康
if port_listening "$A2A_PORT"; then
  report OK "端口 $A2A_PORT" "LISTEN"
else
  report FAIL "端口 $A2A_PORT" "未监听"
fi
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$A2A_URL/.well-known/agent-card.json" || true)"
[ "$code" = "200" ] || [ "$code" = "401" ] && report OK "agent-card HTTP" "$code（401=需 token，属正常）" || report FAIL "agent-card HTTP" "${code:-无响应}"

# 3) 协议漂移（仓库工作树）
if python3 "$ROOT/protocol/gen.py" --check >/dev/null 2>&1; then
  report OK "协议生成物" "与 protocol/link-protocol.json 一致（v$(protocol_version)）"
else
  report FAIL "协议生成物" "与定义漂移，跑 python3 protocol/gen.py"
fi

# 4) 飞书连接（网关进程 + 最近一次 connected 日志）
pid="$(gateway_pid)"
if [ -n "$pid" ]; then report OK "网关进程" "pid=$pid"; else report FAIL "网关进程" "未找到 hermes gateway"; fi
line="$(last_feishu_connected)"
if [ -n "$line" ]; then
  stamp="$(printf '%s' "$line" | cut -c1-19)"
  report OK "飞书连接" "最近：$stamp"
elif [ "$SOFT" = 1 ]; then
  report WARN "飞书连接" "日志无 'feishu connected'（--soft）"
else
  report FAIL "飞书连接" "日志无 'feishu connected'"
fi

say ""
if [ "$FAILED" = 1 ]; then
  die "自检未通过：按上面 FAIL 项处理（重载/版本不配对/端口未起）" 1
fi
say "✓ 全部通过"

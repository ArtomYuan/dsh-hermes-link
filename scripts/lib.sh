#!/usr/bin/env bash
# 安装/校验脚本共用：仓库版本、部署路径、当前安装版本、token/端口探测。
# 约定：任何写操作之前先打印将要做什么；--dry-run 只打印不写。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
SERVER_PKG_DIR="$PROFILE_DIR/node_modules/@artomyuan/dsh-a2a-server"
BRIDGE_DIR="${HERMES_BRIDGE_DIR:-$HOME/.hermes/plugins/hermes-a2a-bridge}"
SERVICE_PATCH="${DSH_SERVICE_PATCH:-$HOME/.dsh/dsh-service.patch.yml}"
PROFILE_PATCH="$PROFILE_DIR/cordis.patch.yml"
GATEWAY_LOG="${HERMES_GATEWAY_LOG:-$HOME/.hermes/logs/gateway.log}"
A2A_URL="${A2A_URL:-http://127.0.0.1:8091}"
DRY_RUN=0

say()  { printf '%s\n' "$*"; }
warn() { printf '⚠  %s\n' "$*" >&2; }
die()  { printf '✗  %s\n' "$*" >&2; exit "${2:-1}"; }
act()  { if [ "$DRY_RUN" = 1 ]; then say "（dry-run）$*"; else eval "$*"; fi; }

# ── 版本 ────────────────────────────────────────────────────────────────
repo_version_bridge() { grep -m1 '^version:' "$ROOT/hermes/plugin.yaml" | sed -E 's/^version:[[:space:]]*"?([^"]+)"?.*/\1/'; }
repo_version_server() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" "$ROOT/dsh/package.json"; }
protocol_version()   { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['protocolVersion'])" "$ROOT/protocol/link-protocol.json"; }

installed_version_server() {
  if [ -f "$SERVER_PKG_DIR/package.json" ]; then
    python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('version','?'))" "$SERVER_PKG_DIR/package.json"
  else echo "未安装"; fi
}
installed_version_bridge() {
  if [ -f "$BRIDGE_DIR/plugin.yaml" ]; then
    grep -m1 '^version:' "$BRIDGE_DIR/plugin.yaml" | sed -E 's/^version:[[:space:]]*"?([^"]+)"?.*/\1/'
  else echo "未安装"; fi
}

# 版本配对：两半必须同号（单号锁步）；不等即拒装
require_paired_versions() {
  local bridge server
  bridge="$(repo_version_bridge)"; server="$(repo_version_server)"
  [ "$bridge" = "$server" ] || die "仓库内两半版本不一致（桥 $bridge / 服务端 $server）——单号锁步，拒绝安装" 2
  say "仓库版本：$bridge（链路协议 v$(protocol_version)）"
  REPO_VERSION="$bridge"
}

# ── 部署探测 ────────────────────────────────────────────────────────────
extract_a2a_config() {
  # 从 systemd patch / profile patch 里读 a2a-server 段的 port 与 authToken（不依赖 yaml 库）
  python3 - "$@" <<'PY'
import re, sys
for path in sys.argv[1:]:
    try: text = open(path, encoding='utf-8').read()
    except OSError: continue
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if re.search(r'id:\s*a2a-server\s*$', line.strip()):
            port = token = ''
            for nxt in lines[i + 1:]:
                if re.match(r'\s*-\s+id:', nxt) or nxt.strip() == '---':
                    break
                m = re.search(r'authToken:\s*(\S+)', nxt)
                if m and not token: token = m.group(1).strip('"\'')
                m = re.search(r'port:\s*(\d+)', nxt)
                if m and not port: port = m.group(1)
            if port or token:
                print(f'{port}\t{token}')
                raise SystemExit(0)
raise SystemExit(1)
PY
}

resolve_endpoint() {
  local cfg port token
  cfg="$(extract_a2a_config "$SERVICE_PATCH" "$PROFILE_PATCH" 2>/dev/null || true)"
  if [ -n "$cfg" ]; then
    port="${cfg%%$'\t'*}"; token="${cfg##*$'\t'}"
    [ -n "${A2A_URL_OVERRIDE:-}" ] && A2A_URL="$A2A_URL_OVERRIDE"
    [ -n "$port" ] && A2A_URL="${A2A_URL_OVERRIDE:-http://127.0.0.1:$port}"
    A2A_TOKEN="${A2A_TOKEN:-$token}"
  fi
  A2A_PORT="$(printf '%s' "$A2A_URL" | sed -E 's#.*:([0-9]+).*#\1#')"
}

# agent-card 握手：输出版本号；失败返回非零
agent_card_version() {
  local auth=()
  [ -n "${A2A_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $A2A_TOKEN")
  curl -fsS --max-time 5 "${auth[@]}" "$A2A_URL/.well-known/agent-card.json" \
    | python3 -c 'import json,sys;print(json.load(sys.stdin).get("version",""))'
}

port_listening() { ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN; }
gateway_pid()    { pgrep -f 'hermes_cli\.main gate' | head -1 || true; }
# 注意：gateway.log 可能含二进制字节（崩溃堆栈/编码混杂），grep 默认二进制检测会截断匹配，
# 导致 tail -1 停在很旧的一条 —— 必须 -a 当文本处理。
last_feishu_connected() { grep -ah 'feishu connected' "$GATEWAY_LOG" 2>/dev/null | tail -1 || true; }

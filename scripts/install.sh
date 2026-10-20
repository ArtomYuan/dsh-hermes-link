#!/usr/bin/env bash
# 一次安装（顺序门禁内置）：预检 → 版本配对 → 装服务端 → 验 agent-card → 装桥。
#
# 用法：
#   scripts/install.sh [--dry-run] [--force] [--skip-verify] [--server-only|--bridge-only]
#
# 幂等：目标版本已就位则跳过（--force 强制重装）。任何真实安装/切换后需宿主侧重载，
# 本脚本只做文件落位与校验，绝不重启服务。
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

FORCE=0; SKIP_VERIFY=0; ONLY=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    --skip-verify) SKIP_VERIFY=1 ;;
    --server-only) ONLY=server ;;
    --bridge-only) ONLY=bridge ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "未知参数：$arg" 2 ;;
  esac
done

backup_dir() { # $1=目标目录 → 打印备份路径（保留最近 2 份）
  local target="$1" stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  local path="${target}.bak.${stamp}"
  act "cp -a '$target' '$path'"
  { ls -1dt "${target}.bak."* 2>/dev/null || true; } | tail -n +3 | while read -r old; do act "rm -rf '$old'"; done
}

say "════ dsh-hermes-link 安装 ════"
require_paired_versions
resolve_endpoint
say "部署路径：服务端 $SERVER_PKG_DIR"
say "          桥     $BRIDGE_DIR"
say "          端点   $A2A_URL"

# ── 预检 ────────────────────────────────────────────────────────────────
[ -d "$PROFILE_DIR" ] || die "找不到 dsh profile：$PROFILE_DIR（--dry-run 也要真实存在）"
command -v node >/dev/null || die "缺 node"
command -v python3 >/dev/null || die "缺 python3"
[ -f "$ROOT/protocol/link-protocol.json" ] || die "仓库缺 protocol/link-protocol.json"

inst_srv="$(installed_version_server)"; inst_bridge="$(installed_version_bridge)"
say "当前安装：服务端 $inst_srv / 桥 $inst_bridge"

# ── 服务端 ──────────────────────────────────────────────────────────────
install_server() {
  if [ "$inst_srv" = "$REPO_VERSION" ] && [ "$FORCE" = 0 ]; then
    say "✓ 服务端已是 $REPO_VERSION，跳过"
    return 0
  fi
  say "── 1) 构建服务端（tsc + tsdown）──"
  act "cd '$ROOT/dsh' && node node_modules/.bin/tsc -p tsconfig.json --noEmit"
  act "cd '$ROOT/dsh' && node node_modules/.bin/tsdown --config tsdown.prepare.config.ts >/dev/null"
  if [ -d "$SERVER_PKG_DIR" ]; then
    say "── 2) 备份现有服务端安装 → ${SERVER_PKG_DIR}.bak.<ts> ──"
    backup_dir "$SERVER_PKG_DIR"
  fi
  say "── 3) 落位服务端文件（包名 @artomyuan/dsh-hermes-link 不变）──"
  act "mkdir -p '$SERVER_PKG_DIR'"
  for f in package.json lib client cordis.patch.yml README.md README.en.md CHANGELOG.md CHANGELOG.en.md CONFIGURATION.md CONFIGURATION.en.md LICENSE; do
    if [ -e "$ROOT/dsh/$f" ]; then act "cp -a '$ROOT/dsh/$f' '$SERVER_PKG_DIR/'"; fi
  done
  say "⚠ 待宿主侧执行：重载 dsh web（本脚本不重启服务）"
}

gate_server_ready() {
  local seen
  seen="$(agent_card_version 2>/dev/null || true)"
  if [ "$DRY_RUN" = 1 ]; then
    say "（dry-run）顺序门禁：当前 agent-card 报 '${seen:-不可达}'，期望 $REPO_VERSION"
    say "（dry-run）真实执行时此处必须报 $REPO_VERSION（=服务端已重载）才允许装桥"
    return 0
  fi
  if [ "$seen" = "$REPO_VERSION" ]; then
    say "✓ agent-card 握手通过：$seen"
    return 0
  fi
  if [ "$SKIP_VERIFY" = 1 ]; then
    warn "agent-card 报 $seen（期望 $REPO_VERSION），--skip-verify 继续（仅限已知未重载的调试场景）"
    return 0
  fi
  die "顺序门禁：服务端 agent-card 报的版本是 '${seen:-不可达}'，期望 $REPO_VERSION。
   服务端文件已落位但进程未重载 → 请宿主侧先重载 dsh web，再重跑本脚本装桥（或调试用 --skip-verify）。" 3
}

install_bridge() {
  if [ "$inst_bridge" = "$REPO_VERSION" ] && [ "$FORCE" = 0 ]; then
    say "✓ 桥已是 $REPO_VERSION，跳过"
    return 0
  fi
  if [ -d "$BRIDGE_DIR" ]; then
    say "── 4) 备份现有桥安装 → ${BRIDGE_DIR}.bak.<ts> ──"
    backup_dir "$BRIDGE_DIR"
  fi
  say "── 5) 落位桥文件（插件目录不变）──"
  act "mkdir -p '$BRIDGE_DIR'"
  for f in "$ROOT"/hermes/*; do
    base="$(basename "$f")"
    [ "$base" = "tests" ] && continue
    [ "$base" = "__pycache__" ] && continue
    act "cp -a '$f' '$BRIDGE_DIR/'"
  done
  say "⚠ 待宿主侧执行：从网关进程外重载网关（本脚本不重启服务），等待 '✓ feishu connected'"
}

if [ "$ONLY" != "bridge" ]; then install_server; fi
if [ "$ONLY" = "server" ]; then
  say "（--server-only：跳过桥）"; exit 0
fi
if [ "$ONLY" != "server" ]; then
  gate_server_ready
  install_bridge
fi

say ""
say "════ 安装完成（文件已落位）════"
say "宿主侧收尾步骤："
say "  1) 重载 dsh web（若上一步未做；--server-only 时先重载再重跑装桥）"
say "  2) 从网关进程外重载网关，等 '✓ feishu connected'"
say "  3) 跑 scripts/verify.sh 复核版本握手 / 端口健康 / 飞书连接"

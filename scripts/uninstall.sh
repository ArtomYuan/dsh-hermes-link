#!/usr/bin/env bash
# 反序卸载：桥先退 → 服务端后退（与安装顺序相反；版本门禁的逆序）。
# 用法：scripts/uninstall.sh [--dry-run] [--keep-files]
#   恢复最近一份 .bak 备份；无备份则拒绝（防误删现网安装）。
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

KEEP=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --keep-files) KEEP=1 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) die "未知参数：$arg" 2 ;;
  esac
done

restore_latest() { # $1=目标目录
  local target="$1" latest
  latest="$(ls -1dt "${target}.bak."* 2>/dev/null | head -1 || true)"
  if [ -z "$latest" ]; then
    warn "没有可恢复的备份：${target}.bak.*（保留现有安装）"
    return 1
  fi
  say "恢复 $target ← $latest"
  act "rm -rf '$target'"
  act "cp -a '$latest' '$target'"
}

say "════ dsh-hermes-link 反序卸载 ════"
resolve_endpoint
say "1) 退桥（先）：$BRIDGE_DIR"
restore_latest "$BRIDGE_DIR" || true
say "⚠ 待宿主侧执行：从网关进程外重载网关（退桥后重载才生效）"
say "2) 退服务端（后）：$SERVER_PKG_DIR"
restore_latest "$SERVER_PKG_DIR" || true
say "⚠ 待宿主侧执行：重载 dsh web（退服务端后重载才生效）"
if [ "$KEEP" = 0 ]; then
  say "提示：备份仍保留在 *.bak.*，确认无误后可自行清理"
fi
say "════ 反序卸载完成（文件已回位）════"

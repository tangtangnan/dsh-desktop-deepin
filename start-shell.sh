#!/usr/bin/env bash
# 一键启动 DSH 社区壳（系统内核模式）。
# 所有可变项都从同目录的 config.json 读取（launcher 段），此脚本只负责：
# 解析配置 → 逐项核对 → 设环境 → 直启 Electron。不套娃、不硬编码路径。
set -euo pipefail

SHELL_DIR="/media/wangke/OFFICE/harness/DeepSeek-Harness-Desktop-dev-deepin-linux2"
CONFIG="$SHELL_DIR/config.json"

err() { echo "✖ $*" >&2; exit 1; }
command -v node >/dev/null 2>&1 || export PATH="/usr/local/nodejs/bin:$PATH"

[ -f "$CONFIG" ] || err "配置文件缺失: $CONFIG"

# 用 node 解析 config.json 的 launcher 段（相对路径以壳目录为基准解析）
read_cfg() {
  node -e "const c=require('$CONFIG').launcher; console.log(c.$1)"
}
resolve_rel() {
  local p="$1"
  case "$p" in
    /*) echo "$p" ;;
    *)  echo "$SHELL_DIR/$p" ;;
  esac
}

ELECTRON="$(resolve_rel "$(read_cfg electron)")"
SYSTEM_DSH="$(read_cfg systemDsh)"
NODEBIN="$(read_cfg nodeBinDir)"
USERDATA="$(resolve_rel "$(read_cfg userDataDir)")"
TELEMETRY="$(read_cfg telemetryMode)"

# ---- 逐项核对 ----
[ -x "$ELECTRON" ]        || err "Electron 不可执行: $ELECTRON"
[ -x "$SYSTEM_DSH" ]      || err "系统 dsh 不存在: $SYSTEM_DSH"
[ -d "$NODEBIN" ]         || err "Node bin 目录不存在: $NODEBIN"

export PATH="$NODEBIN:$PATH"
command -v node >/dev/null 2>&1 || err "PATH 里找不到 node: $NODEBIN"

# ---- 环境 ----
export DSH_KERNEL_BIN="$SYSTEM_DSH"
export ELECTRON_USER_DATA="$USERDATA"
export DSH_TELEMETRY_MODE="$TELEMETRY"
mkdir -p "$USERDATA"

echo "▶ 启动 DSH 社区壳（系统内核模式）"
echo "  shell    : $SHELL_DIR"
echo "  electron : $ELECTRON"
echo "  dsh      : $SYSTEM_DSH ($(node -p "require('$SYSTEM_DSH'/../lib/node_modules/@deepseek-ai/dsh/package.json').version" 2>/dev/null || echo '版本未知'))"
echo "  DSH_HOME : $(node -e "const c=require('$CONFIG');const h=c.kernel.homeSubdir;process.stdout.write(h.startsWith('/')?h:'$USERDATA/'+h)")"
echo "  log      : $USERDATA/shell.log"

cd "$SHELL_DIR"
exec "$ELECTRON" . >> "$USERDATA/shell.log" 2>&1

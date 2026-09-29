#!/usr/bin/env bash
# 一键启动 DSH 社区壳（系统内核模式）。
#
# 流程：解析配置 → 判断是否首次启动 → 缺运行时则自动下载 → 回填 config.json
#       → 设环境 → 直启 Electron。
#
# 首次启动的判断依据不是「有没有装过」这种模糊状态，而是**三个运行时是否都可用**：
#   Electron ≥ 33、Node ≥ 22.15、任意可用的 dsh
# 三者齐备就直接启动（零下载、零检测开销）；缺任何一项就进入自举流程。
# 这样「重装壳」「换机器」「手动删了 runtime」都能被正确识别，不需要额外的标记文件。
set -uo pipefail

# 用 bash 参数展开取目录，不依赖 dirname —— 本脚本要在工具极简的系统上运行。
SCRIPT_PATH="${BASH_SOURCE[0]}"
SCRIPT_DIR="${SCRIPT_PATH%/*}"
[ "$SCRIPT_DIR" = "$SCRIPT_PATH" ] && SCRIPT_DIR="."
SHELL_DIR="$(cd "$SCRIPT_DIR" && pwd)"
CONFIG="$SHELL_DIR/config.json"
BOOTSTRAP="$SHELL_DIR/tools/bootstrap.sh"
RUNTIME_DIR="${HOME}/.dsh-desktop/runtime"

err()  { echo "✖ $*" >&2; exit 1; }
say()  { printf '%s\n' "$*"; }
ok()   { printf '  ✅ %s\n' "$*"; }
bad()  { printf '  ❌ %s\n' "$*"; }
info() { printf '  · %s\n' "$*"; }

have() { command -v "$1" >/dev/null 2>&1; }

# 依赖的最低版本，与 tools/bootstrap.sh 保持一致
NODE_MIN_MAJOR=22; NODE_MIN_MINOR=15
ELECTRON_MIN_MAJOR=33

[ -f "$CONFIG" ] || err "配置文件缺失: $CONFIG"

# ── 读 config.json（纯 shell，不依赖 node；node 可能还没装）──────────────
config_value() {
  local key="$1"
  sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$CONFIG" | head -1
}

resolve_rel() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *)  printf '%s' "$SHELL_DIR/$1" ;;
  esac
}

version_ge() {
  local a="$1" b="$2" am aj bm bj
  am=$(printf '%s' "$a" | sed -n 's/^v\{0,1\}\([0-9]*\)\..*/\1/p')
  aj=$(printf '%s' "$a" | sed -n 's/^v\{0,1\}[0-9]*\.\([0-9]*\).*/\1/p')
  bm=$(printf '%s' "$b" | sed -n 's/^v\{0,1\}\([0-9]*\)\..*/\1/p')
  bj=$(printf '%s' "$b" | sed -n 's/^v\{0,1\}[0-9]*\.\([0-9]*\).*/\1/p')
  [ -z "$am" ] && am=0; [ -z "$aj" ] && aj=0
  [ -z "$bm" ] && bm=0; [ -z "$bj" ] && bj=0
  [ "$am" -gt "$bm" ] && return 0
  [ "$am" -lt "$bm" ] && return 1
  [ "$aj" -ge "$bj" ]
}

# ── 检测三个运行时 ─────────────────────────────────────────────────────
# 输出：ELECTRON_OK / NODE_OK / DSH_OK 三个变量，以及它们的路径。
ELECTRON=""; NODE_BIN=""; SYSTEM_DSH=""

detect() {
  local cfg_e cfg_d cfg_n
  cfg_e="$(config_value electron || true)"
  cfg_d="$(config_value systemDsh || true)"
  cfg_n="$(config_value nodeBinDir || true)"

  # 每项按 配置 → PATH → 常见位置 → 私有 runtime 目录 依次查找
  if [ -n "$cfg_e" ] && [ -x "$cfg_e" ]; then ELECTRON="$cfg_e"
  elif have electron; then ELECTRON="$(command -v electron)"
  else
    local c
    for c in /usr/bin/electron /usr/local/bin/electron "$RUNTIME_DIR"/electron-*/electron; do
      [ -x "$c" ] && { ELECTRON="$c"; break; }
    done
  fi

  if [ -n "$cfg_n" ] && [ -x "$cfg_n/node" ]; then NODE_BIN="$cfg_n/node"
  elif have node; then NODE_BIN="$(command -v node)"
  else
    local c
    for c in /usr/local/bin/node /usr/bin/node /usr/local/nodejs/bin/node \
             "$RUNTIME_DIR"/node-*/bin/node; do
      [ -x "$c" ] && { NODE_BIN="$c"; break; }
    done
  fi

  if [ -n "$cfg_d" ] && { [ -x "$cfg_d" ] || [ -f "$cfg_d" ]; }; then SYSTEM_DSH="$cfg_d"
  elif have dsh; then SYSTEM_DSH="$(command -v dsh)"
  else
    local c
    for c in /usr/local/bin/dsh /usr/bin/dsh /usr/local/nodejs/bin/dsh \
             /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js; do
      [ -e "$c" ] && { SYSTEM_DSH="$c"; break; }
    done
  fi
}

# 版本是否满足要求；不满足则清空对应变量
verify() {
  if [ -n "$ELECTRON" ]; then
    local v; v="$("$ELECTRON" --version 2>/dev/null | head -1)"
    version_ge "$v" "v${ELECTRON_MIN_MAJOR}.0" || { ELECTRON=""; }
  fi
  if [ -n "$NODE_BIN" ]; then
    local v; v="$("$NODE_BIN" --version 2>/dev/null | head -1)"
    version_ge "$v" "v${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}" || { NODE_BIN=""; }
  fi
  # dsh 不锁版本：能跑就行
}

missing_list() {
  local m=""
  [ -z "$ELECTRON" ] && m="$m electron"
  [ -z "$NODE_BIN" ] && m="$m node"
  [ -z "$SYSTEM_DSH" ] && m="$m dsh"
  printf '%s' "${m# }"
}

# ── 首次启动判断 + 自动补齐 ─────────────────────────────────────────────
detect
verify
MISSING="$(missing_list)"

if [ -n "$MISSING" ]; then
  say ""
  say "════════════════════════════════════════════════════════"
  say " 首次启动：缺少运行时 -> $MISSING"
  say "════════════════════════════════════════════════════════"
  say ""
  say "壳本身很小（约 1 MB），运行时按需获取。现在开始自动下载，"
  say "全部走国内镜像并自动测速选最快的一个。"
  say ""

  [ -x "$BOOTSTRAP" ] || err "自举脚本缺失或不可执行: $BOOTSTRAP
请手动执行：bash $SHELL_DIR/tools/bootstrap.sh install"

  # 交给纯 shell 的 bootstrap 干活（它不依赖 node，所以 node 缺失时也能跑）
  bash "$BOOTSTRAP" install || err "运行时下载失败，请检查网络后重试：
  bash $BOOTSTRAP install"

  # 下载完成后重新检测 + 校验版本
  ELECTRON=""; NODE_BIN=""; SYSTEM_DSH=""
  detect
  verify
  MISSING="$(missing_list)"
  [ -z "$MISSING" ] || err "补齐后仍缺少：$MISSING
请手动检查：bash $BOOTSTRAP check"
  say ""
  ok "运行时已全部就绪"
fi

# ── 回填 config.json（只在检测到的路径与配置不一致时写）────────────────
ELECTRON_CFG="$(config_value electron || true)"
DSH_CFG="$(config_value systemDsh || true)"
NODE_CFG="$(config_value nodeBinDir || true)"
NEW_NODE_DIR="$(dirname "$NODE_BIN")"

if [ "$ELECTRON" != "$ELECTRON_CFG" ] || [ "$SYSTEM_DSH" != "$DSH_CFG" ] || [ "$NEW_NODE_DIR" != "$NODE_CFG" ]; then
  say ""
  say "回填 config.json（检测到的路径与配置不一致）："
  [ "$ELECTRON" != "$ELECTRON_CFG" ]   && info "launcher.electron  : $ELECTRON_CFG  →  $ELECTRON"
  [ "$NEW_NODE_DIR" != "$NODE_CFG" ]  && info "launcher.nodeBinDir: $NODE_CFG  →  $NEW_NODE_DIR"
  [ "$SYSTEM_DSH" != "$DSH_CFG" ]     && info "launcher.systemDsh : $DSH_CFG  →  $SYSTEM_DSH"

  cp -n "$CONFIG" "$CONFIG.bak-first-run" 2>/dev/null || true
  TMP="$CONFIG.tmp.$$"
  cp "$CONFIG" "$TMP"
  set_kv() {
    local key="$1" value="$2" esc
    esc=$(printf '%s' "$value" | sed 's/[&/\\|]/\\&/g')
    sed -i "s|\"${key}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"|\"${key}\": \"${esc}\"|" "$TMP"
  }
  set_kv electron "$ELECTRON"
  set_kv nodeBinDir "$NEW_NODE_DIR"
  set_kv systemDsh "$SYSTEM_DSH"
  mv "$TMP" "$CONFIG"
  ok "已写回（备份：config.json.bak-first-run）"
fi

# ── 环境与启动 ─────────────────────────────────────────────────────────
USERDATA="$(resolve_rel "$(config_value userDataDir || echo data-shell)")"
TELEMETRY="$(config_value telemetryMode || echo DISABLED)"
export PATH="$NEW_NODE_DIR:$PATH"
export DSH_KERNEL_BIN="$SYSTEM_DSH"
export ELECTRON_USER_DATA="$USERDATA"
export DSH_TELEMETRY_MODE="$TELEMETRY"
mkdir -p "$USERDATA"

# DSH_HOME 解析：~ 必须展开（Node 的 path.isAbsolute('~/.dsh') 为 false，
# 不展开会被当相对路径拼到 userData 下，生成名为 ~ 的空目录）。
HOME_SUB="$(config_value homeSubdir || echo kernel-home)"
case "$HOME_SUB" in
  '~')    DSH_HOME="$HOME" ;;
  '~/'*)  DSH_HOME="$HOME/${HOME_SUB#\~/}" ;;
  /*)     DSH_HOME="$HOME_SUB" ;;
  *)      DSH_HOME="$USERDATA/$HOME_SUB" ;;
esac

say ""
say "▶ 启动 DSH 社区壳（系统内核模式）"
say "  shell    : $SHELL_DIR"
say "  electron : $ELECTRON"
say "  node     : $NODE_BIN"
say "  dsh      : $SYSTEM_DSH"
say "  DSH_HOME : $DSH_HOME"
say "  log      : $USERDATA/shell.log"
say ""

cd "$SHELL_DIR"
exec "$ELECTRON" . >> "$USERDATA/shell.log" 2>&1

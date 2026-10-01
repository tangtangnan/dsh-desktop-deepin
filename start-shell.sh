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
# 每用户覆盖配置：全局 /opt/.../config.json 只读，用户改的东西都落这里。
USER_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/dsh-desktop"
USER_CONFIG="$USER_CONFIG_DIR/config.json"
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

# ── 读 config（纯 shell，不依赖 node；node 可能还没装）──────────────────
# 取值顺序：用户覆盖份 (~/.config/dsh-desktop/config.json) 优先，
#           全局份 (/opt/.../config.json) 兜底。两处都没有则空。
config_value() {
  local key="$1" v=""
  if [ -f "$USER_CONFIG" ]; then
    v="$(sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$USER_CONFIG" | head -1)"
  fi
  [ -z "$v" ] && v="$(sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$CONFIG" | head -1)"
  printf '%s' "$v"
}

# 把某个 key 写进「用户覆盖份」而不是全局份。全局份保持只读，避免多用户互相
# 覆盖、也避免普通用户写不了 /opt。首次写时从全局份继承其它字段做底子。
set_user_kv() {
  local key="$1" value="$2" esc
  esc="$(printf '%s' "$value" | sed 's/[&/\\|]/\\&/g')"
  mkdir -p "$USER_CONFIG_DIR"
  # 底子：用户份已有的合并全局份，缺失则新建最小骨架
  if [ -f "$USER_CONFIG" ]; then
    cp "$USER_CONFIG" "$USER_CONFIG.tmp.$$"
  else
    cp "$CONFIG" "$USER_CONFIG.tmp.$$" 2>/dev/null || printf '{\n}\n' > "$USER_CONFIG.tmp.$$"
  fi
  sed -i "s|\"${key}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"|\"${key}\": \"${esc}\"|" "$USER_CONFIG.tmp.$$"
  mv "$USER_CONFIG.tmp.$$" "$USER_CONFIG"
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

# ── 首启进度可见化 ───────────────────────────────────────────────────────
# 缺运行时且当前不在终端里（双击启动器启动，Terminal=false 无输出）时，
# 借一个终端模拟器重跑自己：检测、下载、写回配置的全过程用户都看得见，
# 避免「点了没反应、黑屏几分钟突然弹窗」的困惑。
#   DSH_BOOTSTRAP_IN_TTY=1 是防死循环标记：终端里这一轮不再转开。
#   运行时齐备的正常启动走不到这里，零变化、零弹框。
if [ -n "$MISSING" ] && [ ! -t 0 ] && [ "${DSH_BOOTSTRAP_IN_TTY:-}" != "1" ]; then
  for term in deepin-terminal x-terminal-emulator gnome-terminal konsole xfce4-terminal; do
    if command -v "$term" >/dev/null 2>&1; then
      # exec：终端进程直接替换为本脚本，窗口关闭即链条终止，无孤儿进程。
      # -e 后接命令是这几类终端模拟器通用的执行约定。
      exec env DSH_BOOTSTRAP_IN_TTY=1 "$term" -e bash "$SCRIPT_PATH"
    fi
  done
  # 找不到任何终端模拟器的极简系统 → 保持现状：后台静默下载（日志仍写 shell.log）。
fi

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

  cp -n "$USER_CONFIG" "$USER_CONFIG.bak-first-run" 2>/dev/null || true
  set_user_kv electron "$ELECTRON"
  set_user_kv nodeBinDir "$NEW_NODE_DIR"
  set_user_kv systemDsh "$SYSTEM_DSH"
  ok "已写回用户配置（备份：$USER_CONFIG.bak-first-run）"
fi

# ── 环境与启动 ─────────────────────────────────────────────────────────
# userDataDir 现在默认进用户目录（~/.local/share/dsh-desktop/data-shell），
# 多用户互不干扰。先展开 ~，再交给 resolve_rel（它只懂绝对/相对，不懂 ~）。
USERDATA_RAW="$(config_value userDataDir || echo '~/.local/share/dsh-desktop/data-shell')"
case "$USERDATA_RAW" in
  '~'|'~/'*) USERDATA_RAW="$HOME/${USERDATA_RAW#\~/}" ;;
esac
USERDATA="$(resolve_rel "$USERDATA_RAW")"
TELEMETRY="$(config_value telemetryMode || echo DISABLED)"
export PATH="$NEW_NODE_DIR:$PATH"
export DSH_KERNEL_BIN="$SYSTEM_DSH"
export ELECTRON_USER_DATA="$USERDATA"
export DSH_TELEMETRY_MODE="$TELEMETRY"

# ── 时区兜底 ────────────────────────────────────────────────────────────
# Chromium/ICU 只认 IANA 正式时区名。部分国产发行版把 /etc/timezone 写成
# backward 别名（Asia/Beijing、PRC 等），ICU 解析会得到 undefined，前端随后报
# "clientTimeZone must be UTC or a valid IANA Area/Location name"。
# 只在检测到这类已知非法别名时映射成等价正式名，其余情况一律不干预，
# 避免在时区本来就正常的机器上改坏。
tz_now="${TZ:-$(cat /etc/timezone 2>/dev/null || echo '')}"
case "$tz_now" in
  Asia/Beijing|PRC|Asia/Chungking)
    export TZ="Asia/Shanghai"
    info "时区兜底：$tz_now 非 IANA 正式名（Chromium 不认），已映射为 $TZ"
    ;;
esac
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
# 说明当前实际生效的配置文件：用户覆盖份存在时它优先，否则用全局份。
# 改配置要改「生效的那份」，写在这里让人不用翻代码就知道。
if [ -f "$USER_CONFIG" ]; then
  say "  config   : $USER_CONFIG （用户覆盖份，优先生效；要改配置改这份）"
else
  say "  config   : $CONFIG （全局份；如需个性化请在 $USER_CONFIG 创建覆盖份）"
fi
say ""

# 经终端转开的首启：提示用户这个窗口接下来的角色，避免误关。
# Electron 的 stdout/stderr 仍并入日志文件；窗口保持打开只是承载进程，
# 用户最小化即可，关闭它等于退出壳（和关闭主窗口等价）。
if [ "${DSH_BOOTSTRAP_IN_TTY:-}" = "1" ]; then
  say "✔ 运行时已就绪，正在启动主窗口……"
  say "  本终端窗口将承载应用进程：可以最小化，请勿直接关闭"
  say "  （关闭本窗口等同于退出 DeepSeek Harness Desktop）。"
  say ""
fi

cd "$SHELL_DIR"
exec "$ELECTRON" . >> "$USERDATA/shell.log" 2>&1

#!/usr/bin/env bash
# 运行时自举：在没有任何 Node/Electron 的机器上把壳跑起来。
#
# 为什么必须用纯 shell 写：这个脚本的职责就是「检查 Node 在不在并把它装上」，
# 如果它自己需要 Node 才能运行，那么 Node 缺失时它根本启动不了——一个自举
# 循环。所以这里只用 bash + curl/wget + tar/unzip，这些在 Debian/UOS 基础
# 系统里必定存在。
#
# 检测顺序：config.json 指定 → PATH → 常见安装位置 → 私有运行时目录。
# 缺失时优先从国内镜像下载（上游源在大陆经常不可达）。
#
# 用法：
#   bootstrap.sh check     只检测，报告缺什么（exit 1 表示有缺失）
#   bootstrap.sh install   检测并下载缺失项
#   bootstrap.sh run       保证就绪后启动壳
set -uo pipefail

# 用 bash 参数展开取目录，不调用外部 dirname —— 这个脚本要能在
# 工具极度精简的环境里跑起来，任何外部命令依赖都是风险。
SCRIPT_PATH="${BASH_SOURCE[0]}"
SCRIPT_DIR="${SCRIPT_PATH%/*}"
[ "$SCRIPT_DIR" = "$SCRIPT_PATH" ] && SCRIPT_DIR="."
SHELL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG="$SHELL_DIR/config.json"
# 每用户覆盖配置：全局 /opt/.../config.json 只读，用户改的东西落这里。
USER_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/dsh-desktop"
USER_CONFIG="$USER_CONFIG_DIR/config.json"
RUNTIME_DIR="${HOME}/.dsh-desktop/runtime"

# 国内镜像（全部实测可用）。顺序即优先级。
NODE_MIRRORS=(
  "https://npmmirror.com/mirrors/node"
  "https://mirrors.huaweicloud.com/nodejs"
)
ELECTRON_MIRRORS=(
  "https://npmmirror.com/mirrors/electron"
  "https://mirrors.huaweicloud.com/electron"
)
NPM_REGISTRY="https://registry.npmmirror.com"

# 版本要求：内核用到 zlib.createZstdDecompress，Node 22.15 起才有；
# Electron 下限是本壳开发验证过的版本，更高版本同样接受。
NODE_WANT="v24.19.0"
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=15
ELECTRON_WANT="v33.3.0"
ELECTRON_MIN_MAJOR=33

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ✅ %s\n' "$*"; }
bad()  { printf '  ❌ %s\n' "$*"; }
info() { printf '  · %s\n' "$*"; }

# ── 工具可用性 ──────────────────────────────────────────────────────────
have() { command -v "$1" >/dev/null 2>&1; }

# 基础命令预检：缺了就没法自举，必须明确报出来而不是中途神秘失败。
require_basics() {
  local missing="" c
  for c in mkdir rm cp mv sed grep head tar; do
    have "$c" || missing="$missing $c"
  done
  if ! have curl && ! have wget; then
    missing="$missing curl/wget"
  fi
  if ! have unzip && [ "${NEED_UNZIP:-0}" = "1" ]; then
    missing="$missing unzip"
  fi
  if [ -n "$missing" ]; then
    bad "缺少基础命令：$missing"
    say ""
    say "  这些是自举所需的工具，请先安装："
    say "    sudo apt install coreutils sed grep tar gzip curl unzip"
    return 1
  fi
  return 0
}

# 下载到文件，返回 0/1。curl 优先，wget 兜底。跟随重定向。
fetch() {
  local url="$1" dest="$2"
  if have curl; then
    curl -fSL --retry 2 --connect-timeout 20 -o "$dest" "$url" 2>/dev/null
  elif have wget; then
    wget -q -O "$dest" "$url"
  else
    return 1
  fi
}

# 测速：从 url 拉一小段，返回速度（字节/秒）。失败返回 0。
speed_of() {
  local url="$1" bytes="${2:-262144}" out
  if have curl; then
    out=$(curl -sSL --connect-timeout 8 --max-time 15 -r "0-$((bytes-1))" -o /dev/null \
          -w '%{speed_download}' "$url" 2>/dev/null) || out=0
  elif have wget; then
    # wget 没有直接的速度输出，用时间差估算
    local t0 t1
    t0=$(date +%s%N 2>/dev/null || echo 0)
    wget -q --timeout=15 -O /dev/null "$url" 2>/dev/null || { echo 0; return; }
    t1=$(date +%s%N 2>/dev/null || echo 0)
    [ "$t1" -gt "$t0" ] && out=$(( bytes * 1000000000 / (t1 - t0) )) || out=0
  else
    out=0
  fi
  printf '%.0f' "${out:-0}" 2>/dev/null || printf '0'
}

# 在多个镜像里挑最快的。参数：测速用的样本 URL 前缀 + 文件名，候选镜像列表。
# 输出选中的镜像（最多等 3 个候选，避免慢镜像拖太久）。
pick_fastest() {
  local version="$1" sample_file="$2"; shift 2
  local best="" best_speed=0 m url sp
  local tried=0
  for m in "$@"; do
    [ "$tried" -ge 3 ] && break
    url="$m/$version/$sample_file"
    sp=$(speed_of "$url")
    tried=$((tried + 1))
    info "测速 $m → $((sp / 1024)) KB/s" >&2
    if [ "$sp" -gt "$best_speed" ]; then best_speed="$sp"; best="$m"; fi
  done
  printf '%s' "$best"
}

# ── 读取 config.json 里的某个 launcher 值（纯 shell，不依赖 node）────────
# 用 grep/sed 抠 JSON 字符串值。配置由本项目生成，格式稳定，够用。
config_value() {
  local key="$1" v=""
  if [ -f "$USER_CONFIG" ]; then
    v="$(sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$USER_CONFIG" | head -1)"
  fi
  [ -z "$v" ] && [ -f "$CONFIG" ] && v="$(sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$CONFIG" | head -1)"
  printf '%s' "$v"
}

# ── 版本比较：a >= b（按 major.minor 比较，够用）────────────────────────
version_ge() {
  local a="$1" b="$2"
  local am aj bm bj
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

# ── 定位一个可执行文件 ─────────────────────────────────────────────────
# 参数：配置里的值、命令名、若干候选绝对路径
locate() {
  local configured="$1" name="$2"; shift 2
  if [ -n "$configured" ] && [ -x "$configured" ]; then printf '%s' "$configured"; return 0; fi
  if have "$name"; then command -v "$name"; return 0; fi
  local c
  for c in "$@"; do
    [ -x "$c" ] && { printf '%s' "$c"; return 0; }
  done
  return 1
}

# ── 检测 ───────────────────────────────────────────────────────────────
NODE_BIN=""; ELECTRON_BIN=""; DSH_BIN=""

detect() {
  local cfg_electron cfg_dsh cfg_nodebin
  cfg_electron="$(config_value electron || true)"
  cfg_dsh="$(config_value systemDsh || true)"
  cfg_nodebin="$(config_value nodeBinDir || true)"

  # 候选位置按「系统级 → 版本管理器 → 用户级 → 第三方包管理器 → 自举私有目录」铺开，
  # 目的是尽量复用机器上已有的运行时，避免无谓下载。glob 未匹配时保持原样、[ -x ] 会跳过。
  NODE_BIN="$(locate "${cfg_nodebin:+$cfg_nodebin/node}" node \
    /usr/local/bin/node /usr/bin/node /usr/local/nodejs/bin/node \
    /usr/local/node/bin/node /snap/bin/node \
    /opt/node/bin/node /opt/nodejs/bin/node /opt/node-*/bin/node /opt/node*/bin/node \
    /opt/apps/*/files/bin/node /opt/*/bin/node \
    /home/linuxbrew/.linuxbrew/bin/node \
    "${HOME}/.nvm/versions/node/"*/bin/node \
    "${HOME}/.fnm/node-versions/"*/installation/bin/node \
    "${HOME}/.volta/bin/node" \
    "${HOME}/.asdf/installs/nodejs/"*/bin/node "${HOME}/.asdf/shims/node" \
    "${HOME}/.nvs/"*/bin/node \
    /usr/local/n/versions/node/"${NODE_WANT}"/bin/node \
    /usr/local/n/versions/node/*/bin/node \
    "${HOME}/.local/share/pnpm/node" "${HOME}/.yarn/bin/node" \
    "${HOME}/.local/bin/node" \
    "$RUNTIME_DIR"/node-*/bin/node || true)"
  ELECTRON_BIN="$(locate "$cfg_electron" electron \
    /usr/bin/electron /usr/local/bin/electron /usr/lib/electron/electron \
    /opt/electron/electron /opt/electron*/electron /opt/*/electron \
    /opt/apps/*/files/bin/electron /snap/bin/electron \
    /usr/share/electron/electron \
    "${HOME}/.local/bin/electron" "${HOME}/.local/share/electron/"*/electron \
    "${HOME}/.cache/electron/"*/electron \
    "${HOME}/.nvm/versions/node/"*/lib/node_modules/electron/dist/electron \
    "${HOME}/.dsh-desktop/runtime/"electron-*/electron \
    "$RUNTIME_DIR"/electron-*/electron || true)"
  # dsh 优先在「Node 所在的 bin 目录」里找：npm install -g 一定装到那个目录，
  # 这是最常见的情况（真机实测 dsh 就在 ~/.nvm/versions/node/*/bin/dsh）。
  local node_dir=""
  [ -n "$NODE_BIN" ] && node_dir="$(dirname "$NODE_BIN")"
  DSH_BIN="$(locate "$cfg_dsh" dsh \
    ${node_dir:+"$node_dir/dsh"} \
    /usr/local/bin/dsh /usr/bin/dsh /usr/local/nodejs/bin/dsh \
    /opt/nodejs/bin/dsh /opt/node/bin/dsh /opt/*/bin/dsh \
    /snap/bin/dsh \
    "${HOME}/.local/bin/dsh" "${HOME}/.yarn/bin/dsh" \
    "${HOME}/.local/share/pnpm/dsh" \
    "${HOME}/.nvm/versions/node/"*/bin/dsh \
    "${HOME}/.volta/bin/dsh" \
    "${HOME}/.asdf/shims/dsh" || true)"

  # 已装 dsh 但不在 PATH？再用常见全局 node_modules 目录探一次（覆盖 pnpm/yarn/版本管理器等）。
  if [ -z "$DSH_BIN" ] && [ -n "$NODE_BIN" ]; then
    local candidate node_dir2
    node_dir2="$(dirname "$NODE_BIN")"
    for candidate in \
      "${node_dir2%/bin}"/lib/node_modules/@deepseek-ai/dsh/lib/bin.js \
      /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js \
      /usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js \
      "${HOME}/.nvm/versions/node/"*/lib/node_modules/@deepseek-ai/dsh/lib/bin.js \
      "${HOME}/.local/share/pnpm/global/"*/node_modules/@deepseek-ai/dsh/lib/bin.js \
      "${HOME}/.config/yarn/global/node_modules/@deepseek-ai/dsh/lib/bin.js"; do
      [ -f "$candidate" ] && { DSH_BIN="$candidate"; break; }
    done
  fi
}

report() {
  say "运行时检测："
  if [ -n "$NODE_BIN" ]; then
    local v; v="$("$NODE_BIN" --version 2>/dev/null || echo '?')"
    if version_ge "$v" "v${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}"; then
      ok "Node      $v   $NODE_BIN"
    else
      bad "Node      $v   $NODE_BIN  (需要 ≥ v${NODE_MIN_MAJOR}.${NODE_MIN_MINOR})"
      NODE_BIN=""
    fi
  else
    bad "Node      未找到  (需要 ≥ v${NODE_MIN_MAJOR}.${NODE_MIN_MINOR})"
  fi

  if [ -n "$ELECTRON_BIN" ]; then
    local v; v="$("$ELECTRON_BIN" --version 2>/dev/null || echo '?')"
    if version_ge "$v" "v${ELECTRON_MIN_MAJOR}.0"; then
      ok "Electron  $v   $ELECTRON_BIN"
    else
      bad "Electron  $v   $ELECTRON_BIN  (需要 ≥ v${ELECTRON_MIN_MAJOR})"
      ELECTRON_BIN=""
    fi
  else
    bad "Electron  未找到  (需要 ≥ v${ELECTRON_MIN_MAJOR})"
  fi

  if [ -n "$DSH_BIN" ]; then
    ok "dsh 内核   $DSH_BIN"
  else
    bad "dsh 内核   未找到  (需要能运行的任意版本)"
  fi
  say ""
}

missing() {
  local m=""
  [ -z "$NODE_BIN" ] && m="$m node"
  [ -z "$ELECTRON_BIN" ] && m="$m electron"
  [ -z "$DSH_BIN" ] && m="$m dsh"
  printf '%s' "${m# }"
}

# ── 安装 ───────────────────────────────────────────────────────────────
install_node() {
  say "下载 Node ${NODE_WANT}"
  say "国内镜像优先"
  mkdir -p "$RUNTIME_DIR"
  local arch file url dest mirror
  arch="$(uname -m)"
  case "$arch" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; esac
  file="node-${NODE_WANT}-linux-${arch}.tar.gz"
  dest="$RUNTIME_DIR/$file"

  # 先测速挑最快的镜像（多备几个地址，避免死磕最慢的那个）
  say "  正在测速选择最快的镜像…"
  local fastest=""
  fastest="$(pick_fastest "$NODE_WANT" "$file" "${NODE_MIRRORS[@]}")"
  local ordered=()
  if [ -n "$fastest" ]; then
    # 让测速胜出的镜像排在最前，其余按原顺序兜底
    for m in "${NODE_MIRRORS[@]}"; do
      [ "$m" = "$fastest" ] && ordered=("$m" "${ordered[@]}") || ordered+=("$m")
    done
  else
    ordered=("${NODE_MIRRORS[@]}")
  fi

  for mirror in "${ordered[@]}"; do
    url="$mirror/$NODE_WANT/$file"
    info "$url"
    if fetch "$url" "$dest"; then break; fi
    bad "该镜像失败，换下一个"
    dest=""
  done
  [ -n "$dest" ] && [ -f "$dest" ] || { bad "所有镜像都下载失败"; return 1; }

  if have tar; then
    tar -xzf "$dest" -C "$RUNTIME_DIR" || { bad "解压失败"; return 1; }
    rm -f "$dest"
    NODE_BIN="$RUNTIME_DIR/node-${NODE_WANT}-linux-${arch}/bin/node"
    chmod +x "$NODE_BIN" 2>/dev/null
    ok "Node 已装到 $NODE_BIN"
    return 0
  fi
  bad "缺少 tar，无法解压"
  return 1
}

install_electron() {
  say "下载 Electron ${ELECTRON_WANT}"
  say "国内镜像优先，约 180MB，请耐心等待"
  mkdir -p "$RUNTIME_DIR"
  local arch file url dest mirror
  arch="$(uname -m)"
  case "$arch" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; esac
  file="electron-${ELECTRON_WANT}-linux-${arch}.zip"
  dest="$RUNTIME_DIR/$file"

  say "  正在测速选择最快的镜像…"
  local fastest=""
  fastest="$(pick_fastest "$ELECTRON_WANT" "$file" "${ELECTRON_MIRRORS[@]}")"
  local ordered=()
  if [ -n "$fastest" ]; then
    for m in "${ELECTRON_MIRRORS[@]}"; do
      [ "$m" = "$fastest" ] && ordered=("$m" "${ordered[@]}") || ordered+=("$m")
    done
  else
    ordered=("${ELECTRON_MIRRORS[@]}")
  fi

  for mirror in "${ordered[@]}"; do
    url="$mirror/$ELECTRON_WANT/$file"
    info "$url"
    if fetch "$url" "$dest"; then break; fi
    bad "该镜像失败，换下一个"
    dest=""
  done
  [ -n "$dest" ] && [ -f "$dest" ] || { bad "所有镜像都下载失败"; return 1; }

  local target="$RUNTIME_DIR/electron-${ELECTRON_WANT}"
  if have unzip; then
    mkdir -p "$target"
    unzip -q -o "$dest" -d "$target" || { bad "解压失败"; return 1; }
    rm -f "$dest"
    ELECTRON_BIN="$target/electron"
    chmod +x "$ELECTRON_BIN" 2>/dev/null
    ok "Electron 已装到 $ELECTRON_BIN"
    return 0
  fi
  bad "缺少 unzip，无法解压"
  return 1
}

install_dsh() {
  say "安装 dsh 内核（npm 国内源）…"
  [ -n "$NODE_BIN" ] || { bad "需要先有 Node"; return 1; }
  local npm_bin
  npm_bin="$(dirname "$NODE_BIN")/npm"
  if [ ! -x "$npm_bin" ]; then
    if have npm; then npm_bin="$(command -v npm)"; else bad "找不到 npm"; return 1; fi
  fi
  "$npm_bin" install --global --registry "$NPM_REGISTRY" @deepseek-ai/dsh@latest >/dev/null 2>&1 \
    && { ok "dsh 已通过 npm 安装"; return 0; }
  bad "npm 安装失败"
  return 1
}

# ── 把解析出的路径写回「用户覆盖份」而非全局份 ─────────────────────────
# 全局 /opt/.../config.json 保持只读（root 才写得动、且多用户会互相覆盖），
# 所以自举检测到的路径写进每个用户自己的 ~/.config/dsh-desktop/config.json。
# 改动前备份；用 sed 做定点替换，保留文件里的注释字段。
writeback() {
  mkdir -p "$USER_CONFIG_DIR"
  # 临时文件统一在此声明，if/else 两个分支都必须赋值，否则 set -u 下
  # 首次安装（用户份尚不存在、走 else 分支）会报「tmp：未绑定的变量」。
  local tmp="$USER_CONFIG.tmp.$$"
  # 底子：用户份已有则继承，否则从全局份复制（保留全局份的所有字段与注释）。
  if [ -f "$USER_CONFIG" ]; then
    cp -n "$USER_CONFIG" "$USER_CONFIG.bak-bootstrap" 2>/dev/null || true
    cp "$USER_CONFIG" "$tmp"
  else
    cp "$CONFIG" "$tmp" 2>/dev/null || { bad "找不到 $CONFIG"; return 1; }
  fi

  set_kv() {
    local key="$1" value="$2"
    local escaped; escaped=$(printf '%s' "$value" | sed 's/[&/\\]/\\&/g')
    sed -i "s|\"${key}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"|\"${key}\": \"${escaped}\"|" "$tmp"
  }

  [ -n "$ELECTRON_BIN" ] && set_kv electron "$ELECTRON_BIN"
  [ -n "$NODE_BIN" ] && set_kv nodeBinDir "$(dirname "$NODE_BIN")"
  if [ -n "$DSH_BIN" ]; then
    case "$DSH_BIN" in
      */bin.js) : ;;  # 已经是脚本路径，直接用
      *) DSH_BIN="$(command -v "$DSH_BIN" 2>/dev/null || echo "$DSH_BIN")" ;;
    esac
    set_kv systemDsh "$DSH_BIN"
  fi

  mv "$tmp" "$USER_CONFIG"
  ok "已写回用户配置（备份：$USER_CONFIG.bak-bootstrap）"
}

# ── 主流程 ─────────────────────────────────────────────────────────────
cmd="${1:-check}"

detect

case "$cmd" in
  check)
    report
    m="$(missing)"
    if [ -z "$m" ]; then
      say "全部就绪。"
      exit 0
    fi
    say "缺失：$m"
    say ""
    say "执行以下命令自动下载（国内源优先）："
    say "  bash $SCRIPT_DIR/bootstrap.sh install"
    exit 1
    ;;
  install)
    report
    m="$(missing)"
    if [ -z "$m" ]; then
      say "全部就绪，无需下载。"
      exit 0
    fi
    require_basics || exit 1
    say "缺失：$m —— 开始下载"
    say ""
    failed=0
    case "$m" in *electron*) install_electron || failed=1 ;; esac
    case "$m" in *node*)     install_node     || failed=1 ;; esac
    # dsh 依赖 Node，所以放在 Node 之后就绪后再试
    case "$m" in *dsh*)      install_dsh      || failed=1 ;; esac
    say ""
    if [ "$failed" -eq 0 ]; then
      writeback
      say ""
      say "完成。重新运行 start-shell.sh 即可启动。"
    else
      bad "有项目未能安装，请检查网络后重试"
      exit 1
    fi
    ;;
  run)
    report
    m="$(missing)"
    if [ -n "$m" ]; then
      say "缺失：$m，先自动安装…"
      say ""
      bash "$SCRIPT_DIR/bootstrap.sh" install || exit 1
      detect
    fi
    say "启动壳…"
    exec bash "$SHELL_DIR/start-shell.sh"
    ;;
  *)
    say "用法：bootstrap.sh [check|install|run]"
    exit 2
    ;;
esac

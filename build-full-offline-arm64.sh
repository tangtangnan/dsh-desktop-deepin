#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# DSH Desktop 深度离线（full-offline）arm64 一键构建脚本
#
# 默认产出免 root 的 tar.gz 便携包（FORMAT=deb|both 可切），内嵌全部运行时：
#   · Electron v33.3.0 linux-arm64（官方 zip，来自 npmmirror）
#   · Node v24.19.0 linux-arm64（bootstrap 自举兜底用）
#   · 完整 dsh 内核树（@deepseek-ai/dsh@0.2.0-rc.2 + dshmarket 插件
#     + 全部依赖 + node-pty 原生模块，arm64 编译）+ 内核专用 Node v22.22.0
# 安装后：零联网、零下载、零 npm，断网机器解压 install.sh 完即用。
#
# 【在哪跑】必须有外网的 aarch64 Linux（以下任选其一）：
#   A. 生产机本身（若它实际能访问外网）——装完构建依赖直接构建+安装
#   B. 任意联网的 arm64 云主机/开发板，构建完把包拷回生产机
#   C. GitHub Actions 的免费 arm64 runner（见同目录 package-full-offline-arm64.yml）
#
# 【产物】dsh-full-offline-kit/build/dsh-desktop-deepin/release/
#         DeepSeek-Harness-Desktop-<版本>-full-offline-arm64.tar.gz  （默认）
#         DeepSeek-Harness-Desktop-<版本>-full-offline-arm64.deb     （FORMAT=deb）
#
# 【网络】所有下载件都带「国内镜像 → 官方源」两级回退；npm 安装失败自动
#         换源重试（3 轮 × 2 源）。境外 runner 访问 npmmirror 不稳也不会中断。
#         DSH_DEBUG=1 可打开 set -x 全量跟踪。
#
# 【系统要求】bash curl/wget tar unzip gzip sha256sum dpkg-deb
#             node-pty 原生编译还需 make g++ python3（Kylin: apt install -y
#             build-essential python3；无 g++ 时可用 ALLOW_NO_TOOLCHAIN=1
#             跳过，但内核终端 PTY 功能会降级）
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── 可调参数（均可用环境变量覆盖）─────────────────────────────────────
KERNEL_NODE_VER="${KERNEL_NODE_VER:-v22.22.0}"   # 内核自带 Node，须与 upstream.lock.json 的 nodeRuntime.version 一致
BOOT_NODE_VER="${BOOT_NODE_VER:-v24.19.0}"       # bootstrap.sh 的 NODE_WANT（自举兜底）
ELECTRON_VER="${ELECTRON_VER:-v33.3.0}"          # bootstrap.sh 的 ELECTRON_WANT
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
NODE_MIRROR="${NODE_MIRROR:-https://npmmirror.com/mirrors/node}"
ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron}"
REPO_TARBALL="${REPO_TARBALL:-https://github.com/westanke/dsh-desktop-deepin/archive/refs/heads/main.tar.gz}"
REPO_DIR="${DSH_REPO_DIR:-}"                     # 已有源码目录（已 clone/已解包）时直接用
KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${WORK:-$KIT_DIR/build}"
ALLOW_NO_TOOLCHAIN="${ALLOW_NO_TOOLCHAIN:-0}"
# 产物格式：tar.gz（默认，免 root 便携包）| deb | both
FORMAT="${FORMAT:-tar.gz}"
# 版本标记：日志第一行会打出来，用来确认 runner 上跑的是不是最新版
KIT_VERSION="v2 · 2026-10-09（默认 tar.gz + 双源回退 + npm 双 registry 重试 + 失败定位）"

say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  ✅ %s\n' "$*"; }
warn() { printf '  ⚠ %s\n' "$*"; }
die()  { printf '  ✖ %s\n' "$*" >&2; exit 1; }
say2() { printf '  · %s\n' "$*"; }

# 失败定位：打印出错行号/命令，并顺带吐出 npm 日志尾部（排查第一步就看这里）
on_err() {
  local ec=$?
  printf '\n\033[1;31m✖ 构建中断：第 %s 行，退出码 %s\033[0m\n' "${BASH_LINENO[0]:-?}" "$ec" >&2
  printf '  失败命令：%s\n' "${BASH_COMMAND:-?}" >&2
  local logs
  logs="$(ls -t "${HOME:-/root}"/.npm/_logs/*.log 2>/dev/null | head -1 || true)"
  if [ -n "$logs" ]; then
    printf '\n  ---- npm 日志尾部（%s）----\n' "$logs" >&2
    tail -n 40 "$logs" >&2 || true
  fi
  exit "$ec"
}
trap on_err ERR

case "${DSH_DEBUG:-0}" in 1|true|TRUE|yes) set -x ;; esac

fetch() { # fetch <url> <dest>
  if command -v curl >/dev/null 2>&1; then
    curl -fSL --retry 3 --retry-delay 3 --connect-timeout 20 --max-time 900 -o "$2" "$1"
  else
    wget -q -O "$2" "$1"
  fi
}

sha_of() { sha256sum "$1" | awk '{print $1}'; }

# fetch_first <dest> <url> [备选 url...] —— 依次尝试，第一个成功即返回
# （GitHub runner 在境外，npmmirror 偶发不可达；官方源兜底）
fetch_first() {
  local dest="$1"; shift
  local url
  for url in "$@"; do
    say2 "尝试 $url"
    if fetch "$url" "$dest"; then return 0; fi
    warn "拉取失败，换下一个源"
  done
  return 1
}

# fetch_and_verify <dest> <file_name> <base_url> [备选 base_url...]
#   逐个源尝试：下载文件 + 该源同目录 SHASUMS256.txt，校验通过才落盘
fetch_and_verify() {
  local dest="$1" file="$2"; shift 2
  local base tmp manifest expected
  tmp="$dest.download"
  rm -f "$tmp"
  for base in "$@"; do
    say2 "下载 $base/$file"
    if ! fetch "$base/$file" "$tmp"; then warn "下载失败，换下一个源"; continue; fi
    manifest="$tmp.sha256s"
    if fetch "$base/SHASUMS256.txt" "$manifest" 2>/dev/null; then
      expected="$(grep -E "^[0-9a-f]{64}[[:space:]]+\*?${file}\$" "$manifest" | awk '{print $1}' || true)"
      rm -f "$manifest"
      if [ -z "$expected" ]; then
        warn "清单中未找到 $file 的校验值，跳过校验"
      elif [ "$(sha_of "$tmp")" = "$expected" ]; then
        say2 "sha256 校验通过"
      else
        warn "sha256 校验失败（$base），换下一个源"
        continue
      fi
    else
      warn "SHASUMS256.txt 拉取失败，跳过校验"
      rm -f "$manifest"
    fi
    mv "$tmp" "$dest"
    return 0
  done
  rm -f "$tmp"
  die "下载并校验失败：$file（已尝试全部源：$*）"
}

# 下载源优先级（环境变量可整体覆盖）
NODE_BASES=( "$NODE_MIRROR/$KERNEL_NODE_VER" "https://nodejs.org/dist/$KERNEL_NODE_VER" )

# ── ① 预检 ────────────────────────────────────────────────────────────
say "① 预检"
printf '  · 构建工具链 %s\n' "$KIT_VERSION"
[ "$(uname -m)" = "aarch64" ] || die "本脚本须在 aarch64 (ARM64) Linux 上运行（当前: $(uname -m)）"
for c in tar unzip gzip sha256sum sed grep awk; do
  command -v "$c" >/dev/null 2>&1 || die "缺少命令: $c"
done
command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || die "缺少 curl 或 wget"
if [ "$FORMAT" != "tar.gz" ]; then
  command -v dpkg-deb >/dev/null 2>&1 || die "缺少 dpkg-deb（打 deb 需要；FORMAT=tar.gz 不需要）"
fi
ok "架构 aarch64，基础工具齐备（FORMAT=$FORMAT）"
printf '  · 网络自检：'
for u in "https://registry.npmmirror.com" "https://registry.npmjs.org" "https://nodejs.org/dist"; do
  if command -v curl >/dev/null 2>&1; then
    code="$(curl -s -o /dev/null -m 12 -w '%{http_code}' "$u" || echo fail)"
  else
    code="skip"
  fi
  printf ' %s=%s' "${u#https://}" "$code"
done
printf '\n'

MISS_TC=""
for c in make g++ python3; do command -v "$c" >/dev/null 2>&1 || MISS_TC="$MISS_TC $c"; done
if [ -n "$MISS_TC" ]; then
  if [ "$ALLOW_NO_TOOLCHAIN" = "1" ]; then
    warn "缺编译工具链:$MISS_TC（已 ALLOW_NO_TOOLCHAIN=1 放行）——node-pty 无法编译，内核终端 PTY 功能会降级"
  else
    die "缺编译工具链:$MISS_TC
node-pty 原生模块必须在 arm64 上编译。请先安装（Kylin V10）：
  sudo apt install -y build-essential python3 make g++
或确认确不需要终端 PTY 功能后，用 ALLOW_NO_TOOLCHAIN=1 跳过本检查。"
  fi
else
  ok "编译工具链 make / g++ / python3 齐备（node-pty 可编译）"
fi

# glibc 预检：Electron v33 基于 Ubuntu 20.04 构建，需要 glibc ≥ 2.31
GLIBC_VER="$(ldd --version 2>/dev/null | sed -n '1s/.* \([0-9][0-9.]*\)$/\1/p' || echo 0)"
GLIBC_MAJOR="$(printf '%s' "$GLIBC_VER" | cut -d. -f1)"
GLIBC_MINOR="$(printf '%s' "$GLIBC_VER" | cut -d. -f2)"
if [ "${GLIBC_MAJOR:-0}" -lt 2 ] || { [ "${GLIBC_MAJOR:-0}" -eq 2 ] && [ "${GLIBC_MINOR:-0}" -lt 31 ]; }; then
  warn "glibc $GLIBC_VER 低于 2.31 —— Electron v33 可能无法运行（Kylin V10 SP1 桌面版为 2.31，通常没问题；-server 版请自行确认）"
else
  ok "glibc $GLIBC_VER ≥ 2.31，满足 Electron v33 要求"
fi

mkdir -p "$WORK"

# ── ② 构建工具链 Node（≥22.15，供 npm 安装内核用）─────────────────────
say "② 构建工具链 Node"
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_V="$(node --version)"
  case "$NODE_V" in
    v22.[1-9][0-9].*|v2[2-9].*|v3[0-9].*) NODE_OK=1 ;;
  esac
  if [ "$NODE_OK" = "1" ]; then ok "复用系统 Node $NODE_V"; else warn "系统 Node $NODE_V 过低（需 ≥ v22.15），改用下载的 $KERNEL_NODE_VER"; fi
fi
if [ "$NODE_OK" != "1" ]; then
  TC_DIR="$WORK/toolchain"
  if [ ! -x "$TC_DIR/node-$KERNEL_NODE_VER-linux-arm64/bin/node" ]; then
    mkdir -p "$TC_DIR"
    fetch_and_verify "$TC_DIR/node.tar.gz" "node-$KERNEL_NODE_VER-linux-arm64.tar.gz" "${NODE_BASES[@]}"
    tar -xzf "$TC_DIR/node.tar.gz" -C "$TC_DIR"
    rm -f "$TC_DIR/node.tar.gz"
  fi
  export PATH="$TC_DIR/node-$KERNEL_NODE_VER-linux-arm64/bin:$PATH"
  ok "工具链 Node $(node --version) 就绪"
fi

# ── ③ 获取源码 + 叠加 overlay ──────────────────────────────────────────
say "③ 获取 dsh-desktop-deepin 源码并叠加 overlay"
if [ -n "$REPO_DIR" ]; then
  [ -f "$REPO_DIR/tools/build-deb.sh" ] || die "DSH_REPO_DIR=$REPO_DIR 不是有效的源码目录"
else
  REPO_DIR="$WORK/dsh-desktop-deepin"
  if [ ! -f "$REPO_DIR/tools/build-deb.sh" ]; then
    rm -rf "$REPO_DIR"
    mkdir -p "$REPO_DIR"
    say2() { printf '  · %s\n' "$*"; }
    say2 "下载 $REPO_TARBALL"
    fetch "$REPO_TARBALL" "$WORK/repo.tar.gz" || die "源码下载失败（GitHub 不可达时，可手动下载解包后用 DSH_REPO_DIR 指向它）"
    tar -xzf "$WORK/repo.tar.gz" -C "$REPO_DIR" --strip-components=1
    rm -f "$WORK/repo.tar.gz"
  fi
fi
# overlay 叠加：支持「kit 目录旁挂」与「已就地覆盖仓库同名文件」两种放法。
#   · overlay/tools/*.sh 存在  → 拷进仓库
#   · 不存在（GitHub 网页上传时已直接覆盖 tools/ 下同名文件）→ 跳过拷贝
#   · 源与目标同一文件（cp a a 会报错）→ 跳过
overlay_copy() { # overlay_copy <src> <dst>
  local src="$1" dst="$2"
  if [ ! -f "$src" ]; then
    warn "overlay 未随脚本提供：$src —— 假定 $dst 已是增强版，继续"
    return 0
  fi
  if [ "$(readlink -f "$src" 2>/dev/null || echo "$src")" = \
       "$(readlink -f "$dst" 2>/dev/null || echo "$dst")" ]; then
    return 0
  fi
  cp -f "$src" "$dst" || die "overlay 拷贝失败：$dst"
}
overlay_copy "$KIT_DIR/overlay/tools/build-deb.sh"       "$REPO_DIR/tools/build-deb.sh"
overlay_copy "$KIT_DIR/overlay/tools/install-plugins.sh" "$REPO_DIR/tools/install-plugins.sh"
overlay_copy "$KIT_DIR/overlay/tools/build-tarball.sh"   "$REPO_DIR/tools/build-tarball.sh"
chmod 0755 "$REPO_DIR/tools/build-deb.sh" "$REPO_DIR/tools/install-plugins.sh" \
           "$REPO_DIR/tools/build-tarball.sh"
# 硬校验：没叠加成功就只打出「在线包」，所以这里必须拦住
if [ "$FORMAT" != "tar.gz" ]; then
  grep -q -- "--full-offline" "$REPO_DIR/tools/build-deb.sh" \
    || die "tools/build-deb.sh 不是增强版（缺 --full-offline）。
  请把 overlay/tools/build-deb.sh 的内容覆盖到仓库的 tools/build-deb.sh。"
fi
if [ "$FORMAT" != "deb" ]; then
  [ -f "$REPO_DIR/tools/build-tarball.sh" ] \
    || die "缺少 tools/build-tarball.sh（请把 overlay/tools/build-tarball.sh 放进仓库 tools/）"
  grep -q -- "--full-offline" "$REPO_DIR/tools/build-tarball.sh" \
    || die "tools/build-tarball.sh 不是增强版（缺 --full-offline）"
fi
grep -q -- "FULL-OFFLINE" "$REPO_DIR/tools/install-plugins.sh" \
  || die "tools/install-plugins.sh 不是增强版（缺 FULL-OFFLINE 标记）。
  请把 overlay/tools/install-plugins.sh 的内容覆盖到仓库的 tools/install-plugins.sh。"
ok "源码就绪：$REPO_DIR（overlay 已校验，FORMAT=$FORMAT）"

# ── ④ 补 upstream.lock.json 的 linux-arm64 Node 条目 ───────────────────
say "④ 补 upstream.lock.json 的 nodeRuntime.linux-arm64 条目"
NODE_TARBALL_NAME="node-$KERNEL_NODE_VER-linux-arm64.tar.gz"
if ! fetch_first "$WORK/SHASUMS-node.txt" \
      "$NODE_MIRROR/$KERNEL_NODE_VER/SHASUMS256.txt" \
      "https://nodejs.org/dist/$KERNEL_NODE_VER/SHASUMS256.txt"; then
  rm -f "$WORK/SHASUMS-node.txt"
  die "拿不到 Node 的 SHASUMS256.txt（npmmirror 与 nodejs.org 都不可达？）"
fi
# 注意：grep 找不到时返回 1，配合 set -e 会直接中断，所以必须 || true 兜住
SHA256_KERNEL_NODE="$(grep -E "^[0-9a-f]{64}[[:space:]]+\*?${NODE_TARBALL_NAME}\$" "$WORK/SHASUMS-node.txt" | awk '{print $1}' || true)"
rm -f "$WORK/SHASUMS-node.txt"
if [ -z "$SHA256_KERNEL_NODE" ]; then
  die "SHASUMS256.txt 里没有 $NODE_TARBALL_NAME 的条目。
  可能原因：$KERNEL_NODE_VER 没有 linux-arm64 构建，或清单格式变化。
  可改用其它版本重试：KERNEL_NODE_VER=v22.20.0 bash $0"
fi
LOCK_FILE="$REPO_DIR/upstream.lock.json" \
LOCK_VER="$KERNEL_NODE_VER" \
LOCK_ARCHIVE="$NODE_TARBALL_NAME" \
LOCK_SHA="$SHA256_KERNEL_NODE" \
node -e '
const fs = require("fs")
const file = process.env.LOCK_FILE
const lock = JSON.parse(fs.readFileSync(file, "utf8"))
lock.nodeRuntime = lock.nodeRuntime ?? {}
if (lock.nodeRuntime.version !== process.env.LOCK_VER) lock.nodeRuntime.version = process.env.LOCK_VER
lock.nodeRuntime["linux-arm64"] = { archive: process.env.LOCK_ARCHIVE, sha256: process.env.LOCK_SHA }
fs.writeFileSync(file, JSON.stringify(lock, null, 2) + "\n")
console.log(`  ✅ nodeRuntime["linux-arm64"] = ${process.env.LOCK_ARCHIVE} (${process.env.LOCK_SHA.slice(0, 12)}...)`)
'
ok "upstream.lock.json 已补齐 linux-arm64"

# ── ⑤ 安装 dsh 内核树（npm，走国内源）──────────────────────────────────
say "⑤ 安装 dsh 内核树（联网，通常 5~25 分钟）"
cd "$REPO_DIR"
# 源优先级：国内镜像 → 官方源。境外 runner 上 npmmirror 偶发超时，失败自动回退重试。
NPM_REGISTRIES=( "$NPM_REGISTRY" "https://registry.npmjs.org" )
NPM_DISTURLS=(  "$NODE_MIRROR"   "https://nodejs.org/dist" )
KERNEL_DONE=0
for round in 1 2 3; do
  idx=0
  for reg in "${NPM_REGISTRIES[@]}"; do
    dist="${NPM_DISTURLS[$idx]:-$NODE_MIRROR}"
    idx=$((idx + 1))
    say2 "第 $round 轮 · registry=$reg"
    export npm_config_registry="$reg"
    export npm_config_disturl="$dist"
    export npm_config_fetch_retries=5
    export npm_config_fetch_retry_maxtimeout=120000
    export npm_config_fetch_timeout=600000
    if node tools/install-kernel.js; then KERNEL_DONE=1; break 2; fi
    warn "内核安装未成功（registry=$reg），换源/重试"
  done
done
[ "$KERNEL_DONE" = "1" ] || die "dsh 内核树安装失败（已 3 轮 × 2 源）。请看上方 npm 报错或下载 debug-logs 制品。"
[ -f "$REPO_DIR/resources/kernel/node_modules/@deepseek-ai/dsh/lib/bin.js" ] || die "内核安装后缺少 bin.js，安装失败"
PTY_NODE="$REPO_DIR/resources/kernel/node_modules/node-pty/build/Release/pty.node"
if [ -f "$PTY_NODE" ]; then
  ok "node-pty 原生模块已编译（arm64）"
else
  if [ "$ALLOW_NO_TOOLCHAIN" = "1" ]; then
    warn "pty.node 缺失——内核可启动，但终端 PTY 功能降级"
  else
    die "pty.node 缺失且未放行：node-pty 编译失败，检查 make/g++/python3"
  fi
fi

# ABI 兼容预检：原生模块链接的是「构建机」的 glibc / libstdc++，
# 目标机（Kylin V10 ≈ Ubuntu 20.04 底座）更旧时会报
#   version `GLIBCXX_3.4.xx' not found / `GLIBC_2.xx' not found
# 这里把需求的最高符号版本打出来，供与目标机比对（不阻断构建，
# 因为绝大多数情况下可在目标机本地重编解决）。
if [ -f "$PTY_NODE" ] && command -v objdump >/dev/null 2>&1; then
  NEED_GLIBC="$(objdump -p "$PTY_NODE" 2>/dev/null | grep -o 'GLIBC_[0-9][0-9.]*'   | sort -V | tail -1 || true)"
  NEED_CXX="$(objdump -p "$PTY_NODE" 2>/dev/null  | grep -o 'GLIBCXX_[0-9][0-9.]*' | sort -V | tail -1 || true)"
  ok "pty.node 需要的符号版本上限：${NEED_GLIBC:-无} / ${NEED_CXX:-无}"
  cat <<'ABI'

  ⚠ 构建机的 glibc/libstdc++ 若比目标机（Kylin V10）新，加载 pty.node 可能报
    "version `GLIBCXX_x.x.xx' not found"。目标机上自查：
      strings /usr/lib/aarch64-linux-gnu/libstdc++.so.6 | grep GLIBCXX | tail -1
    若确实更旧，在目标机本地重编即可（用内核自带 Node，ABI 一致，无需重装包）：
      sudo apt install -y build-essential python3
      cd /opt/deepseek-harness-desktop/resources/kernel
      PATH="$PWD:$PATH" npm rebuild node-pty
ABI
fi
ok "dsh 内核树就绪（$(du -sh resources/kernel | cut -f1)）"

# ── ⑥ 内核自带 Node 二进制 + npm/corepack 垫片 ─────────────────────────
say "⑥ 放置内核专用 Node $KERNEL_NODE_VER（arm64）"
if [ ! -x "$REPO_DIR/resources/kernel/node" ]; then
  ND_STAGE="$WORK/node-dist"
  rm -rf "$ND_STAGE"; mkdir -p "$ND_STAGE"
  fetch_and_verify "$ND_STAGE/node.tar.gz" "$NODE_TARBALL_NAME" "${NODE_BASES[@]}"
  tar -xzf "$ND_STAGE/node.tar.gz" -C "$ND_STAGE"
  ND_ROOT="$ND_STAGE/node-$KERNEL_NODE_VER-linux-arm64"
  "$ND_ROOT/bin/node" --version | grep -q "$KERNEL_NODE_VER" || die "解包出的 node --version 不符"
  cp -a "$ND_ROOT/bin/node" "$REPO_DIR/resources/kernel/node"
  chmod 0755 "$REPO_DIR/resources/kernel/node"
  # 顺手把 npm / npx / corepack 垫片与实体也放进内核目录：
  # config 的 nodeBinDir 指向内核目录 → PATH 里就有 node/npm/corepack，
  # 之后要联网补装插件（corepack enable pnpm）也有工具可用。
  mkdir -p "$REPO_DIR/resources/kernel/lib/node_modules"
  cp -a "$ND_ROOT/lib/node_modules/npm"      "$REPO_DIR/resources/kernel/lib/node_modules/"
  cp -a "$ND_ROOT/lib/node_modules/corepack" "$REPO_DIR/resources/kernel/lib/node_modules/" 2>/dev/null || true
  ln -sfn "lib/node_modules/npm/bin/npm-cli.js"      "$REPO_DIR/resources/kernel/npm"
  ln -sfn "lib/node_modules/npm/bin/npx-cli.js"      "$REPO_DIR/resources/kernel/npx"
  [ -f "$ND_ROOT/lib/node_modules/corepack/dist/corepack.js" ] && \
    ln -sfn "lib/node_modules/corepack/dist/corepack.js" "$REPO_DIR/resources/kernel/corepack"
  rm -rf "$ND_STAGE"
fi
"$REPO_DIR/resources/kernel/node" --version
ok "内核 Node 就绪"

# ── ⑦ 下载 bootstrap 兜底运行时（offline 内嵌件）──────────────────────
say "⑦ 下载运行时压缩包（Electron + Node，供包内嵌）"
RELEASE="$REPO_DIR/release"
mkdir -p "$RELEASE"
BOOT_NODE_FILE="node-$BOOT_NODE_VER-linux-arm64.tar.gz"
ELECTRON_FILE="electron-$ELECTRON_VER-linux-arm64.zip"
[ -f "$RELEASE/$BOOT_NODE_FILE" ] || fetch_and_verify "$RELEASE/$BOOT_NODE_FILE" "$BOOT_NODE_FILE" \
  "$NODE_MIRROR/$BOOT_NODE_VER" "https://nodejs.org/dist/$BOOT_NODE_VER"
[ -f "$RELEASE/$ELECTRON_FILE" ] || fetch_and_verify "$RELEASE/$ELECTRON_FILE" "$ELECTRON_FILE" \
  "$ELECTRON_MIRROR/$ELECTRON_VER" "https://github.com/electron/electron/releases/download/$ELECTRON_VER"
ok "运行时压缩包就绪（$(du -sh "$RELEASE" | cut -f1)）"

# ── ⑧ 打包（默认 tar.gz 便携包；FORMAT=deb|both 可切）─────────────────
say "⑧ 打包 full-offline（格式: $FORMAT）"
VERSION="$(node -p "require('$REPO_DIR/package.json').version")"
case "$FORMAT" in
  deb)
    bash "$REPO_DIR/tools/build-deb.sh" arm64 "$VERSION" --full-offline
    ;;
  both)
    bash "$REPO_DIR/tools/build-tarball.sh" arm64 "$VERSION" --full-offline
    bash "$REPO_DIR/tools/build-deb.sh" arm64 "$VERSION" --full-offline
    ;;
  tar.gz|*)
    bash "$REPO_DIR/tools/build-tarball.sh" arm64 "$VERSION" --full-offline
    ;;
esac

# ── ⑨ 产物报告 ────────────────────────────────────────────────────────
say "⑨ 构建完成"
shopt -s nullglob
TB=( "$RELEASE"/DeepSeek-Harness-Desktop-*-full-offline-arm64.tar.gz )
DEBS=( "$RELEASE"/DeepSeek-Harness-Desktop-*-full-offline-arm64.deb )
[ ${#TB[@]} -eq 0 ] && [ ${#DEBS[@]} -eq 0 ] && die "没有找到任何产物（打包失败？）"

for f in "${TB[@]}"; do
  ok "产物: $f"
  ok "体积: $(du -h "$f" | cut -f1)   sha256: $(sha_of "$f")"
  cat <<TIP

目标机安装（普通用户即可，无需 root）：
  tar -xzf $(basename "$f")
  cd deepseek-harness-desktop-${VERSION}-full-offline-arm64
  bash install.sh                      # 默认装到 ~/.local/share/deepseek-harness-desktop
  # bash install.sh --prefix /data/dsh  # 或指定任意可写目录
  # bash install.sh --no-desktop        # 不建桌面图标
启动：应用菜单搜「DeepSeek Harness Desktop」，或命令行 dsh-desktop
TIP
done
for f in "${DEBS[@]}"; do
  ok "产物: $f"
  ok "体积: $(du -h "$f" | cut -f1)   sha256: $(sha_of "$f")"
  cat <<TIP

目标机安装（需要 root）：
  sudo apt install ./$(basename "$f")
TIP
done

cat <<'TIP'

注意：
  · 默认插件（dsh-im 等）需要联网才能补装，离线机上启动时会自动静默跳过；
    有网时手动执行：<安装目录>/tools/install-plugins.sh
  · 升级便携包：重新解压新包跑 install.sh（只替换应用文件，用户数据不动）
  · 卸载便携包：bash uninstall.sh
TIP

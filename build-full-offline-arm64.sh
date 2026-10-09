#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# DSH Desktop 深度离线（full-offline）arm64 deb 一键构建脚本
#
# 产出一个内嵌全部运行时的 deb：
#   · Electron v33.3.0 linux-arm64（官方 zip，来自 npmmirror）
#   · Node v24.19.0 linux-arm64（bootstrap 自举兜底用）
#   · 完整 dsh 内核树（@deepseek-ai/dsh@0.2.0-rc.2 + dshmarket 插件
#     + 全部依赖 + node-pty 原生模块，arm64 编译）+ 内核专用 Node v22.22.0
# 安装后：零联网、零下载、零 npm，断网机器 dpkg -i 完即用。
#
# 【在哪跑】必须有外网的 aarch64 Linux（以下任选其一）：
#   A. 生产机本身（若它实际能访问外网）——装完构建依赖直接构建+安装
#   B. 任意联网的 arm64 云主机/开发板，构建完把 deb 拷回生产机
#   C. GitHub Actions 的免费 arm64 runner（见同目录 package-full-offline-arm64.yml）
#
# 【产物】dsh-full-offline-kit/build/dsh-desktop-deepin/release/
#         DeepSeek-Harness-Desktop-<版本>-full-offline-arm64.deb
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

say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '  ✅ %s\n' "$*"; }
warn() { printf '  ⚠ %s\n' "$*"; }
die()  { printf '  ✖ %s\n' "$*" >&2; exit 1; }

fetch() { # fetch <url> <dest>
  if command -v curl >/dev/null 2>&1; then
    curl -fSL --retry 3 --connect-timeout 20 -o "$2" "$1"
  else
    wget -q -O "$2" "$1"
  fi
}

sha_of() { sha256sum "$1" | awk '{print $1}'; }

# fetch_and_verify <base_url> <file_name> <dest_path>
#   下载文件 + 同目录 SHASUMS256.txt，校验后落盘
fetch_and_verify() {
  local base="$1" file="$2" dest="$3" tmp manifest expected
  tmp="$dest.download"
  say2() { printf '  · %s\n' "$*"; }
  say2 "下载 $base/$file"
  fetch "$base/$file" "$tmp" || die "下载失败: $base/$file"
  manifest="$tmp.sha256s"
  if fetch "$base/SHASUMS256.txt" "$manifest" 2>/dev/null; then
    expected="$(grep -E "^[0-9a-f]{64}[[:space:]]+\*?$file\$" "$manifest" | awk '{print $1}' || true)"
    rm -f "$manifest"
    if [ -n "$expected" ]; then
      if [ "$(sha_of "$tmp")" = "$expected" ]; then
        say2 "sha256 校验通过"
      else
        die "sha256 校验失败: $file（镜像产物与官方清单不符）"
      fi
    else
      warn "清单中未找到 $file 的校验值，跳过校验"
    fi
  else
    warn "SHASUMS256.txt 拉取失败，跳过校验"
    rm -f "$manifest"
  fi
  mv "$tmp" "$dest"
}

# ── ① 预检 ────────────────────────────────────────────────────────────
say "① 预检"
[ "$(uname -m)" = "aarch64" ] || die "本脚本须在 aarch64 (ARM64) Linux 上运行（当前: $(uname -m)）"
for c in tar unzip gzip sha256sum sed grep awk; do
  command -v "$c" >/dev/null 2>&1 || die "缺少命令: $c"
done
command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || die "缺少 curl 或 wget"
command -v dpkg-deb >/dev/null 2>&1 || die "缺少 dpkg-deb（dpkg 工具，Kylin/Debian 系自带）"
ok "架构 aarch64，基础工具齐备"

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
    fetch_and_verify "$NODE_MIRROR/$KERNEL_NODE_VER" "node-$KERNEL_NODE_VER-linux-arm64.tar.gz" "$TC_DIR/node.tar.gz"
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
chmod 0755 "$REPO_DIR/tools/build-deb.sh" "$REPO_DIR/tools/install-plugins.sh"
# 硬校验：没叠加成功就只打出「在线包」，所以这里必须拦住
grep -q -- "--full-offline" "$REPO_DIR/tools/build-deb.sh" \
  || die "tools/build-deb.sh 不是增强版（缺 --full-offline）。
  请把 overlay/tools/build-deb.sh 的内容覆盖到仓库的 tools/build-deb.sh。"
grep -q -- "FULL-OFFLINE" "$REPO_DIR/tools/install-plugins.sh" \
  || die "tools/install-plugins.sh 不是增强版（缺 FULL-OFFLINE 标记）。
  请把 overlay/tools/install-plugins.sh 的内容覆盖到仓库的 tools/install-plugins.sh。"
ok "源码就绪：$REPO_DIR（overlay 已校验）"

# ── ④ 补 upstream.lock.json 的 linux-arm64 Node 条目 ───────────────────
say "④ 补 upstream.lock.json 的 nodeRuntime.linux-arm64 条目"
NODE_TARBALL_NAME="node-$KERNEL_NODE_VER-linux-arm64.tar.gz"
fetch "$NODE_MIRROR/$KERNEL_NODE_VER/SHASUMS256.txt" "$WORK/SHASUMS-node.txt"
SHA256_KERNEL_NODE="$(grep -E "^[0-9a-f]{64}[[:space:]]+\*?$NODE_TARBALL_NAME\$" "$WORK/SHASUMS-node.txt" | awk '{print $1}')"
rm -f "$WORK/SHASUMS-node.txt"
[ -n "$SHA256_KERNEL_NODE" ] || die "拿不到 $NODE_TARBALL_NAME 的 sha256（镜像 $NODE_MIRROR 不可达？）"
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
say "⑤ 安装 dsh 内核树（联网，约几分钟）"
export npm_config_registry="$NPM_REGISTRY"
export npm_config_disturl="$NODE_MIRROR"   # node-gyp 下载 headers 也走镜像
cd "$REPO_DIR"
node tools/install-kernel.js
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
  fetch_and_verify "$NODE_MIRROR/$KERNEL_NODE_VER" "$NODE_TARBALL_NAME" "$ND_STAGE/node.tar.gz"
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
say "⑦ 下载运行时压缩包（Electron + Node，供 deb 内嵌）"
RELEASE="$REPO_DIR/release"
mkdir -p "$RELEASE"
BOOT_NODE_FILE="node-$BOOT_NODE_VER-linux-arm64.tar.gz"
ELECTRON_FILE="electron-$ELECTRON_VER-linux-arm64.zip"
[ -f "$RELEASE/$BOOT_NODE_FILE" ] || fetch_and_verify "$NODE_MIRROR/$BOOT_NODE_VER" "$BOOT_NODE_FILE" "$RELEASE/$BOOT_NODE_FILE"
[ -f "$RELEASE/$ELECTRON_FILE" ] || fetch_and_verify "$ELECTRON_MIRROR/$ELECTRON_VER" "$ELECTRON_FILE" "$RELEASE/$ELECTRON_FILE"
ok "运行时压缩包就绪（$(du -sh "$RELEASE" | cut -f1)）"

# ── ⑧ 打包 deb ────────────────────────────────────────────────────────
say "⑧ 打包 full-offline deb"
VERSION="$(node -p "require('$REPO_DIR/package.json').version")"
bash "$REPO_DIR/tools/build-deb.sh" arm64 "$VERSION" --full-offline

# ── ⑨ 产物报告 ────────────────────────────────────────────────────────
say "⑨ 构建完成"
DEB="$RELEASE/DeepSeek-Harness-Desktop-${VERSION}-full-offline-arm64.deb"
[ -f "$DEB" ] || die "预期产物不存在: $DEB"
ok "产物: $DEB"
ok "体积: $(du -h "$DEB" | cut -f1)   sha256: $(sha_of "$DEB")"
cat <<TIP

安装（拷到目标机后）：
  sudo apt install ./DeepSeek-Harness-Desktop-<版本>-full-offline-arm64.deb
  # 或: sudo dpkg -i DeepSeek-Harness-Desktop-<版本>-full-offline-arm64.deb
装完直接从启动器点「DeepSeek Harness Desktop」即可，全程不需要网络。

注意：
  · 默认插件（dsh-im 等）需要联网才能补装，离线机上启动时会自动静默跳过；
    有网时可手动执行 bash /opt/deepseek-harness-desktop/tools/install-plugins.sh
  · 升级：直接用新 deb 重装（config.json 已声明为 conffile，用户改动受 dpkg 保护）
TIP

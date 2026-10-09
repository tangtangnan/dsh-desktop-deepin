#!/usr/bin/env bash
# 把壳代码打成「只含壳代码」的 deb（约 1MB）。
#
# 不走 electron-builder：它的职责是把 Electron 打进包，而本项目的决定是
# Electron / Node / dsh 全部在首次启动时按需下载。所以这里用 dpkg-deb 手工
# 打包——deb 里就是纯文本 + 图标，不包含任何运行时。
#
# 产物体积来源：
#   src/ tools/ config.json start-shell.sh  —— 约 0.5MB
#   assets/icon.png                          —— 约 14KB
#   加起来 1MB 上下，其余全是包结构开销。
set -uo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
SCRIPT_DIR="${SCRIPT_PATH%/*}"
[ "$SCRIPT_DIR" = "$SCRIPT_PATH" ] && SCRIPT_DIR="."
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

STAGE="$ROOT/debian"
PKG_NAME="deepseek-harness-desktop"
# 版本号优先级：显式传入 > 环境变量 DEB_VERSION > package.json。
# CI 打 tag 时会把 tag 名（去掉 v 前缀）传进来，保证 deb 文件名与 tag 永远一致，
# 避免「tag 是 v0.1.7 但包名还写 0.1.2」这种错位。
VERSION="${2:-${DEB_VERSION:-}}"
if [ -z "$VERSION" ]; then
  VERSION="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo '0.1.2')"
fi
OUTPUT_DIR="$ROOT/release"

# ── 目标架构 ───────────────────────────────────────────────────────────
# 壳本身（src/ tools/ config.json）是架构无关的纯 JS + shell，deb 不含运行时，
# 运行时由 bootstrap.sh 按 uname -m 首次启动下载（官方 Electron/Node 均提供
# linux-arm64 / linux-x64 预编译包）。所以同一个源码可以打 amd64 与 arm64 两种包。
# 用法：bash tools/build-deb.sh [amd64|arm64] [版本] [--offline|--full-offline]
#   --offline：在包内嵌 Node + Electron 的官方压缩包（若 release/ 下已有），
#   bootstrap.sh 优先解包本地缓存，实现「装完即用、首启零下载」。
#   产物命名为 *-offline.deb；缺压缩包时明确报错，而不是悄悄打出在线包。
#   --full-offline：在 --offline 基础上再内嵌完整 dsh 内核树
#   （resources/kernel：@deepseek-ai/dsh + 全部依赖 + 内核自带 node 二进制），
#   并预写 config.json 直接指向内嵌内核——安装后零联网、零下载、零 npm，
#   断网机器 dpkg -i 完即可从启动器点开就用。产物命名为 *-full-offline.deb。
ARCH="${1:-amd64}"
OFFLINE=0
FULL=0
for arg in "$@"; do
  [ "$arg" = "--offline" ] && OFFLINE=1
  [ "$arg" = "--full-offline" ] && { OFFLINE=1; FULL=1; }
done
case "$ARCH" in
  amd64|x86_64) ARCH="amd64"; DEB_ARCH="amd64"; NODE_ARCH_LABEL="x64" ;;
  arm64|aarch64|arm) ARCH="arm64"; DEB_ARCH="arm64"; NODE_ARCH_LABEL="arm64" ;;
  *) err "不支持的架构: $ARCH（仅支持 amd64 / arm64）" ;;
esac

# offline 模式需要的两个官方压缩包（与 bootstrap.sh 的 NODE_WANT/ELECTRON_WANT 对齐）
NODE_VER="$(sed -n 's/^NODE_WANT="\(.*\)"/\1/p' "$ROOT/tools/bootstrap.sh")"
ELECTRON_VER="$(sed -n 's/^ELECTRON_WANT="\(.*\)"/\1/p' "$ROOT/tools/bootstrap.sh")"
NODE_TARBALL="node-${NODE_VER}-linux-${NODE_ARCH_LABEL}.tar.gz"
ELECTRON_ZIP="electron-${ELECTRON_VER}-linux-${NODE_ARCH_LABEL}.zip"

err() { echo "✖ $*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

[ -f "$ROOT/package.json" ] || err "找不到 package.json"
command -v dpkg-deb >/dev/null 2>&1 || err "缺少 dpkg-deb（dpkg 工具）"

# ── 清空并重建 stage 目录 ──────────────────────────────────────────────
rm -rf "$STAGE"
mkdir -p "$STAGE/DEBIAN"
APP_DIR="$STAGE/opt/$PKG_NAME"
mkdir -p "$APP_DIR"

# ── 复制壳代码（不进包：node_modules、.git、release、测试产物）──────────
say "复制壳代码…"
cp -r "$ROOT/src"          "$APP_DIR/src"
cp -r "$ROOT/tools"        "$APP_DIR/tools"
cp -r "$ROOT/assets"       "$APP_DIR/assets"
# renderer/ is the shell's own static documents (loading/error pages served
# over the dsh-app://shell/ scheme). It ships with the shell code so the
# handler in src/main.js can resolve it at runtime.
[ -d "$ROOT/renderer" ] && {
  cp -r "$ROOT/renderer" "$APP_DIR/renderer"
  # The shell's static pages (served over the dsh-app://shell/ scheme) ship with
  # the shell code and must be world-readable: 0644 like the rest of the payload.
  find "$APP_DIR/renderer" -type f -exec chmod 0644 {} +
}
cp    "$ROOT/config.json"  "$APP_DIR/config.json"
cp    "$ROOT/start-shell.sh" "$APP_DIR/start-shell.sh"
cp    "$ROOT/package.json" "$APP_DIR/package.json"
cp    "$ROOT/LICENSE"      "$APP_DIR/LICENSE" 2>/dev/null || true
cp    "$ROOT/NOTICE"       "$APP_DIR/NOTICE"  2>/dev/null || true

# 排除测试文件、打包工具自身，以及非 Linux 平台图标（.icns 是 macOS、.ico 是 Windows）
find "$APP_DIR/src" -name '*.test.js' -delete
rm -f "$APP_DIR/tools/build-deb.sh"
rm -f "$APP_DIR/assets/icon.icns" "$APP_DIR/assets/icon.ico" \
      "$APP_DIR/assets/entitlements.mac.plist" 2>/dev/null

# 排除 electron-builder 时代的遗留工具（方案 A 用 dpkg-deb，不再需要这些）
rm -f "$APP_DIR/tools/install-kernel.js" "$APP_DIR/tools/install-node.js" \
      "$APP_DIR/tools/prune-kernel.js" "$APP_DIR/tools/after-pack.js" \
      "$APP_DIR/src/supervisor-smoke.mjs" 2>/dev/null

# 整树权限兜底：确保装到别的用户机器上，普通用户能读能进（否则 EACCES）。
# dpkg-deb --root-owner-group 只把 owner/group 改成 root，不动 mode；而构建机
# 上的文件若带限制性 mode（如 0640）或父目录不可进，普通用户运行 electron 时
# 读 /opt/.../src/*.js 就会被 permission denied 打崩。
#   a+rX ：所有文件加读、目录加执行（X 只对目录/已有执行位文件生效，不会给普通
#           .js 乱加执行位，也不会清除已有的写位）。
# 之后再单独把启动脚本钉成 0755（a+rX 不会动它，这里是双保险）。
chmod -R a+rX "$APP_DIR"
chmod 0755 "$APP_DIR/start-shell.sh"
chmod 0755 "$APP_DIR/tools/bootstrap.sh"
chmod 0755 "$APP_DIR/tools/doctor.js" 2>/dev/null || true

# 全局只读配置/元数据：必须为 0644（a+rX 已保证可读，这里再显式钉死避免回归）。
chmod 0644 "$APP_DIR/config.json"
chmod 0644 "$APP_DIR/package.json"
chmod 0644 "$APP_DIR/LICENSE" 2>/dev/null || true
chmod 0644 "$APP_DIR/NOTICE" 2>/dev/null || true

# ── offline 模式：内嵌运行时压缩包 ─────────────────────────────────────
# bootstrap.sh 会先查 $APP_DIR/runtimes/，命中就直接解包，跳过一切网络。
if [ "$OFFLINE" -eq 1 ]; then
  say "offline 模式：内嵌运行时压缩包…"
  RT_DIR="$APP_DIR/runtimes"
  mkdir -p "$RT_DIR"
  NODE_SRC="$OUTPUT_DIR/$NODE_TARBALL"
  ELECTRON_SRC="$OUTPUT_DIR/$ELECTRON_ZIP"
  if [ ! -f "$NODE_SRC" ] || [ ! -f "$ELECTRON_SRC" ]; then
    err "offline 打包需要先备好两个官方压缩包（放到 $OUTPUT_DIR/）：
  $NODE_TARBALL
  $ELECTRON_ZIP
下载命令：
  curl -L -o $OUTPUT_DIR/$NODE_TARBALL https://npmmirror.com/mirrors/node/$NODE_VER/$NODE_TARBALL
  curl -L -o $OUTPUT_DIR/$ELECTRON_ZIP https://npmmirror.com/mirrors/electron/$ELECTRON_VER/$ELECTRON_ZIP"
  fi
  cp "$NODE_SRC" "$RT_DIR/"
  cp "$ELECTRON_SRC" "$RT_DIR/"
  # 同一镜像的 SHASUMS256.txt 一并内嵌，离线机器也能校验
  curl -fsSL "https://npmmirror.com/mirrors/node/$NODE_VER/SHASUMS256.txt" \
    -o "$RT_DIR/SHASUMS256.node.$NODE_VER.txt" 2>/dev/null \
    || say "  ⚠ node 的 SHASUMS256.txt 拉取失败，离线校验将跳过"
  curl -fsSL "https://npmmirror.com/mirrors/electron/$ELECTRON_VER/SHASUMS256.txt" \
    -o "$RT_DIR/SHASUMS256.electron.$ELECTRON_VER.txt" 2>/dev/null \
    || say "  ⚠ electron 的 SHASUMS256.txt 拉取失败，离线校验将跳过"
  chmod 0644 "$RT_DIR"/* 2>/dev/null
fi

# ── full-offline 模式：内嵌完整 dsh 内核树 ─────────────────────────────
# 内核树由构建机上的 `node tools/install-kernel.js` 预先装好
# （tools/install-kernel.js 会装 @deepseek-ai/dsh + shipped 插件 + 补 peer +
#   换装并编译 node-pty 原生模块），再把内核专用 Node 二进制放到
#   resources/kernel/node（src/main.js 的 resolveKernelPaths 约定路径）。
# 装到目标机后：config.json 的 systemDsh / nodeBinDir 直接指向包内路径，
# start-shell.sh 的系统内核模式三项全部本地命中，不走任何网络。
if [ "$FULL" -eq 1 ]; then
  say "full-offline 模式：内嵌 dsh 内核树…"
  KERNEL_SRC="$ROOT/resources/kernel"
  [ -f "$KERNEL_SRC/node_modules/@deepseek-ai/dsh/lib/bin.js" ] \
    || err "full-offline 需要预装内核树：$KERNEL_SRC 缺少 @deepseek-ai/dsh
先在联网的 $NODE_ARCH_LABEL 机器上执行：node tools/install-kernel.js"
  [ -x "$KERNEL_SRC/node" ] \
    || err "full-offline 需要内核自带 Node：$KERNEL_SRC/node 不存在或不可执行
（从 ${NODE_VER_TIP:-node dist} 提取 bin/node 放到该路径）"
  mkdir -p "$APP_DIR/resources"
  cp -a "$KERNEL_SRC" "$APP_DIR/resources/kernel"
  # 权限兜底：整树可读可进，node 二进制保留可执行（同壳代码的 a+rX 口径）
  chmod -R a+rX "$APP_DIR/resources/kernel"
  chmod 0755 "$APP_DIR/resources/kernel/node"
  # 预写 config.json：系统内核模式三项里 dsh/node 两项直接指向包内路径，
  # 用户覆盖份（~/.config/dsh-desktop/config.json）不存在时全局份即生效。
  sed -i "s|\"systemDsh\"[[:space:]]*:[[:space:]]*\"[^\"]*\"|\"systemDsh\": \"/opt/$PKG_NAME/resources/kernel/node_modules/@deepseek-ai/dsh/lib/bin.js\"|" "$APP_DIR/config.json"
  sed -i "s|\"nodeBinDir\"[[:space:]]*:[[:space:]]*\"[^\"]*\"|\"nodeBinDir\": \"/opt/$PKG_NAME/resources/kernel\"|" "$APP_DIR/config.json"
  # 离线标记：install-plugins.sh 的 check 模式据此静默跳过，避免断网机器
  # 每次启动弹终端补装插件（插件 market 等本就需要联网才有内容）。
  touch "$RT_DIR/FULL-OFFLINE"
  chmod 0644 "$RT_DIR/FULL-OFFLINE"
  say "  内核树 $(du -sh "$APP_DIR/resources/kernel" | cut -f1) → $APP_DIR/resources/kernel"
fi

# ── DEBIAN 控制文件 ─────────────────────────────────────────────────────
say "写 DEBIAN/control…"
# full-offline 包内嵌全部运行时与内核，目标机不需要联网下载，
# Depends 收窄到解包与自检所需的最小集（curl/wget 不再是硬依赖）。
if [ "$FULL" -eq 1 ]; then
  DEPENDS_LINE="bash, tar, gzip, unzip, ca-certificates"
  DESC_LINE=" 内嵌 Electron + Node + dsh 内核（full-offline），安装后零联网可用。"
else
  DEPENDS_LINE="bash, curl | wget, tar, gzip, unzip, ca-certificates"
  DESC_LINE=" 本包只包含壳代码（约 1MB）。Electron、Node 与 dsh 内核在首次
 启动时按需下载（国内镜像优先），见 tools/bootstrap.sh。"
fi
cat > "$STAGE/DEBIAN/control" <<EOF
Package: $PKG_NAME
Version: $VERSION
Section: devel
Priority: optional
Architecture: $DEB_ARCH
Depends: $DEPENDS_LINE
Maintainer: DeepSeek Harness Desktop Community <noreply@example.com>
Description: DeepSeek Harness 桌面壳（Deepin / UOS / Linux $NODE_ARCH_LABEL）
 面向 Deepin / UOS / Linux $NODE_ARCH_LABEL 的 DeepSeek Harness 桌面壳。
 把命令行 agent 运行时 dsh 包进 Electron 窗口，双击即用。
 .
$DESC_LINE
Homepage: https://github.com/westanke/dsh-desktop-deepin
EOF

# conffiles：把全局 config.json 声明为受 dpkg 保护的配置文件。
# 没有这行时，升级包会无脑覆盖 /opt/$PKG_NAME/config.json——用户在
# 全局份做的修改被抹掉，且新版新增的配置键/注释也到不了老用户手里。
# 声明后 dpkg 的行为：用户没改过 → 正常更新为新版；用户改过 → 保留用户版，
# 新版默认配置落为 config.json.dpkg-dist 供参考（Debian 标准语义）。
# start-shell.sh 已打印生效的 config 路径，用户覆盖份（~/.config/…）不受影响。
cat > "$STAGE/DEBIAN/conffiles" <<EOF
/opt/$PKG_NAME/config.json
EOF

# ── 维护者脚本（postinst / prerm / postrm）────────────────────────────
# 源文件放在 packaging/DEBIAN/，刻意不放在 $STAGE（也就是 debian/）里。
#
# 【为什么不能放 debian/DEBIAN/】下面第 62 行会 `rm -rf "$STAGE"` 重建暂存
# 目录，而 $STAGE 正是 $ROOT/debian —— 源文件若放在那里，会在打包第一步被
# 自己删掉，随后的 cp 必然失败并静默回落到 heredoc 兜底。历史版本恰是如此：
# 仓库 debian/DEBIAN/postinst（4049 字节）与包内实际脚本（4214 字节）长期
# 不一致，对源文件的任何修改都从未真正进过包。
#
# 现在源与 stage 彻底分离，并取消 heredoc 兜底：源缺失即打包失败。
# 宁可构建报错，也不再产出一个「和源码长得不一样」的包。
PKG_CTL_DIR="$ROOT/packaging/DEBIAN"
[ -d "$PKG_CTL_DIR" ] || err "找不到维护者脚本目录：$PKG_CTL_DIR"
for f in postinst prerm postrm; do
  [ -f "$PKG_CTL_DIR/$f" ] || err "缺少维护者脚本：$PKG_CTL_DIR/$f"
  cp "$PKG_CTL_DIR/$f" "$STAGE/DEBIAN/$f"
  chmod 0755 "$STAGE/DEBIAN/$f"
done
say "维护者脚本已就位：$(ls "$STAGE/DEBIAN" | tr '\n' ' ')"

# ── 桌面图标 + .desktop ────────────────────────────────────────────────
say "写桌面启动器…"
mkdir -p "$STAGE/usr/share/applications"
mkdir -p "$STAGE/usr/share/icons/hicolor/128x128/apps"
cp "$ROOT/assets/icon.png" "$STAGE/usr/share/icons/hicolor/128x128/apps/$PKG_NAME.png"
cat > "$STAGE/usr/share/applications/$PKG_NAME.desktop" <<EOF
[Desktop Entry]
Name=DeepSeek Harness Desktop
GenericName=DeepSeek Harness 桌面壳
Comment=DeepSeek Harness agent 运行时的桌面壳（首次启动会下载运行时）
Exec=bash /opt/$PKG_NAME/start-shell.sh
Terminal=false
Type=Application
Icon=$PKG_NAME
StartupWMClass=DeepSeek Harness Desktop
Categories=Development;Utility;
EOF

# ── 打包 ───────────────────────────────────────────────────────────────
mkdir -p "$OUTPUT_DIR"
SUFFIX=""
[ "$OFFLINE" -eq 1 ] && SUFFIX="-offline"
[ "$FULL" -eq 1 ] && SUFFIX="-full-offline"
DEB_FILE="$OUTPUT_DIR/DeepSeek-Harness-Desktop-${VERSION}${SUFFIX}-${ARCH}.deb"
say "打包 $DEB_FILE …"
# -Zgzip：显式指定压缩格式。新版 dpkg-deb（Ubuntu 24.04 runner，1.22+）默认改用
# zstd，而 Deepin 20 / 老系（dpkg 1.19）不认识 control.tar.zst，装包直接报
# 「对成员 control.tar.zst 使用了未知的压缩」。gzip 是所有 dpkg 版本的最小公约数，
# 壳才 ~100KB，压缩率差异可忽略。
dpkg-deb --build -Zgzip --root-owner-group "$STAGE" "$DEB_FILE" || err "dpkg-deb 打包失败"

# ── 报告 ───────────────────────────────────────────────────────────────
SIZE=$(du -h "$DEB_FILE" | cut -f1)
say ""
say "✅ 完成：$DEB_FILE"
say "   体积：$SIZE"
say ""
# 注意：不要在这里接 `| head` —— 关掉管道会让 dpkg-deb 收到 SIGPIPE，
# 把本已成功的打包流程判成 exit 2（CI 因此误报失败）。


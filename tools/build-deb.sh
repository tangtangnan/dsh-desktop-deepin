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
# 用法：bash tools/build-deb.sh [amd64|arm64]，默认 amd64。
ARCH="${1:-amd64}"
case "$ARCH" in
  amd64|x86_64) ARCH="amd64"; DEB_ARCH="amd64"; NODE_ARCH_LABEL="x86_64" ;;
  arm64|aarch64|arm) ARCH="arm64"; DEB_ARCH="arm64"; NODE_ARCH_LABEL="aarch64" ;;
  *) err "不支持的架构: $ARCH（仅支持 amd64 / arm64）" ;;
esac

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

# ── DEBIAN 控制文件 ─────────────────────────────────────────────────────
say "写 DEBIAN/control…"
cat > "$STAGE/DEBIAN/control" <<EOF
Package: $PKG_NAME
Version: $VERSION
Section: devel
Priority: optional
Architecture: $DEB_ARCH
Depends: bash, curl | wget, tar, gzip, unzip, ca-certificates
Maintainer: DeepSeek Harness Desktop Community <noreply@example.com>
Description: DeepSeek Harness 桌面壳（Deepin / UOS / Linux $NODE_ARCH_LABEL）
 面向 Deepin / UOS / Linux $NODE_ARCH_LABEL 的 DeepSeek Harness 桌面壳。
 把命令行 agent 运行时 dsh 包进 Electron 窗口，双击即用。
 .
 本包只包含壳代码（约 1MB）。Electron、Node 与 dsh 内核在首次
 启动时按需下载（国内镜像优先），见 tools/bootstrap.sh。
Homepage: https://github.com/westanke/dsh-desktop-deepin
EOF

# postinst：安装后跑一次自检
cp "$ROOT/debian/DEBIAN/postinst" "$STAGE/DEBIAN/postinst" 2>/dev/null || \
  cat > "$STAGE/DEBIAN/postinst" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
INSTALL_DIR="/opt/dsh-desktop-deepin"
BOOTSTRAP="$INSTALL_DIR/tools/bootstrap.sh"
echo ""
echo "DeepSeek Harness Desktop 已安装到 $INSTALL_DIR"
echo ""
if [ -x "$BOOTSTRAP" ]; then
  echo "正在检查运行时依赖（Electron / Node / dsh）…"
  echo ""
  bash "$BOOTSTRAP" check || {
    echo ""
    echo "提示：缺少运行时依赖。自动下载："
    echo "  bash $BOOTSTRAP install"
    echo "或直接启动（首次启动也会自动补齐）："
    echo "  bash $INSTALL_DIR/start-shell.sh"
    echo ""
  }
fi
exit 0
EOF
chmod 0755 "$STAGE/DEBIAN/postinst"

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
DEB_FILE="$OUTPUT_DIR/DeepSeek-Harness-Desktop-${VERSION}-${ARCH}.deb"
say "打包 $DEB_FILE …"
dpkg-deb --build --root-owner-group "$STAGE" "$DEB_FILE" || err "dpkg-deb 打包失败"

# ── 报告 ───────────────────────────────────────────────────────────────
SIZE=$(du -h "$DEB_FILE" | cut -f1)
say ""
say "✅ 完成：$DEB_FILE"
say "   体积：$SIZE"
say ""
# 注意：不要在这里接 `| head` —— 关掉管道会让 dpkg-deb 收到 SIGPIPE，
# 把本已成功的打包流程判成 exit 2（CI 因此误报失败）。


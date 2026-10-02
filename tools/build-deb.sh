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
# 用法：bash tools/build-deb.sh [amd64|arm64] [版本] [--offline]
#   --offline：在包内嵌 Node + Electron 的官方压缩包（若 release/ 下已有），
#   bootstrap.sh 优先解包本地缓存，实现「装完即用、首启零下载」。
#   产物命名为 *-offline.deb；缺压缩包时明确报错，而不是悄悄打出在线包。
ARCH="${1:-amd64}"
OFFLINE=0
for arg in "$@"; do
  [ "$arg" = "--offline" ] && OFFLINE=1
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

# conffiles：把全局 config.json 声明为受 dpkg 保护的配置文件。
# 没有这行时，升级包会无脑覆盖 /opt/$PKG_NAME/config.json——用户在
# 全局份做的修改被抹掉，且新版新增的配置键/注释也到不了老用户手里。
# 声明后 dpkg 的行为：用户没改过 → 正常更新为新版；用户改过 → 保留用户版，
# 新版默认配置落为 config.json.dpkg-dist 供参考（Debian 标准语义）。
# start-shell.sh 已打印生效的 config 路径，用户覆盖份（~/.config/…）不受影响。
cat > "$STAGE/DEBIAN/conffiles" <<EOF
/opt/$PKG_NAME/config.json
EOF

# postinst：安装后跑一次自检
# 优先用仓库里的 debian/DEBIAN/postinst（单一事实来源）；此处 heredoc 仅为
# 该文件缺失时的兜底，目录必须与 PKG_NAME 一致（/opt/deepseek-harness-desktop）。
cp "$ROOT/debian/DEBIAN/postinst" "$STAGE/DEBIAN/postinst" 2>/dev/null || \
  cat > "$STAGE/DEBIAN/postinst" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
INSTALL_DIR="/opt/deepseek-harness-desktop"
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

# ── 以「真实登录用户」身份在后台预下载运行时 ──────────────────────────
# postinst 由 root 执行（apt install），而运行时要落在该用户的
# $HOME/.dsh-desktop/runtime 里——以 root 下载会写错属主、也污染 root 的家
# 目录。所以先认人，再降权跑。
#
# 为什么是「后台」：Electron 约 180MB，阻塞 postinst 会让 apt 卡几分钟，
# 用户以为安装死了。这里 detach 一个后台任务，postinst 立即返回，下载在
# 后台继续；用户稍后双击启动时多半已经就绪，等于拿到「装完即用」的体验，
# 又不必发 152MB 的离线包。
#
# 关闭方式（装包时不预下载）：
#   sudo DSH_NO_POSTINST_DOWNLOAD=1 apt install ./xxx.deb
if [ "${DSH_NO_POSTINST_DOWNLOAD:-}" = "1" ]; then
  echo "（已设置 DSH_NO_POSTINST_DOWNLOAD=1，跳过安装后预下载）"
else
  # 认人：$SUDO_USER（sudo 场景）→ loginctl 活跃用户 → /home 下第一个真实用户
  INSTALL_USER="${SUDO_USER:-}"
  if [ -z "$INSTALL_USER" ] || [ "$INSTALL_USER" = "root" ]; then
    INSTALL_USER="$(loginctl list-users --no-legend 2>/dev/null | awk '{print $2}' | grep -v '^root$' | head -1)"
  fi
  if [ -z "$INSTALL_USER" ]; then
    for candidate in /home/*; do
      [ -d "$candidate" ] || continue
      name="$(basename "$candidate")"
      if id "$name" >/dev/null 2>&1; then INSTALL_USER="$name"; break; fi
    done
  fi

  if [ -n "$INSTALL_USER" ] && [ "$INSTALL_USER" != "root" ] && id "$INSTALL_USER" >/dev/null 2>&1 && [ -x "$BOOTSTRAP" ]; then
    echo "正在为 $INSTALL_USER 后台预下载运行时（约 180MB，不阻塞安装）…"
    # setsid + nohup：脱离 apt 的进程组，apt 结束时下载不受影响。
    # 日志落在该用户自己的 .dsh-desktop 下（不用 /tmp，也避免 root 写用户目录）。
    if command -v runuser >/dev/null 2>&1; then
      runuser -u "$INSTALL_USER" -- setsid nohup bash "$BOOTSTRAP" install \
        >>"/home/$INSTALL_USER/.dsh-desktop/bootstrap-postinst.log" 2>&1 &
    else
      su - "$INSTALL_USER" -c "setsid nohup bash '$BOOTSTRAP' install \
        >>'/home/$INSTALL_USER/.dsh-desktop/bootstrap-postinst.log' 2>&1 &"
    fi
    echo "下载在后台进行；完成后双击启动器即可直接使用。"
  else
    echo "（未能识别登录用户，跳过预下载；首次启动时会自动补齐）"
  fi
fi

# 默认插件补装（升级用户也覆盖到；独立于 bootstrap 的预下载路径）。
PLUGINS_SCRIPT="$INSTALL_DIR/tools/install-plugins.sh"
if [ -x "\$PLUGINS_SCRIPT" ]; then
  INSTALL_USER="\${INSTALL_USER:-}"
  if [ -z "\$INSTALL_USER" ] || [ "\$INSTALL_USER" = "root" ]; then
    INSTALL_USER="\$(loginctl list-users --no-legend 2>/dev/null | awk '{print \$2}' | grep -v '^root\$' | head -1)"
  fi
  if [ -n "\$INSTALL_USER" ] && [ "\$INSTALL_USER" != "root" ] && id "\$INSTALL_USER" >/dev/null 2>&1; then
    echo "检查默认插件（dsh-im / pocket-relay / mcp-panel / market）…"
    runuser -u "\$INSTALL_USER" -- bash "\$PLUGINS_SCRIPT" \
      >>"/home/\$INSTALL_USER/.dsh-desktop/bootstrap-postinst.log" 2>&1 \
      || echo "（默认插件补装未完成，不影响使用；可手动执行 bash \$PLUGINS_SCRIPT）"
  fi
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
SUFFIX=""
[ "$OFFLINE" -eq 1 ] && SUFFIX="-offline"
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


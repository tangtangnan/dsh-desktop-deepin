#!/usr/bin/env bash
# 打成「免 root 便携包」：tar.gz，解压后跑 install.sh 即装到用户目录。
#
# 与 build-deb.sh 的区别：
#   · 不需要 dpkg-deb，不需要 sudo，任何普通用户都能装
#   · 安装前缀按用户可写目录（默认 ~/.local/share/deepseek-harness-desktop），
#     同机多用户互不干扰；全局 config.json 保持原样，路径写到用户覆盖份里，
#     所以同一个包可以装到任意前缀（$HOME / /data / U 盘都行）
#   · 桌面图标落在 ~/.local/share/applications，命令行启动器落在 ~/.local/bin
#
# 用法：bash tools/build-tarball.sh [amd64|arm64] [版本] [--full-offline]
set -uo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
SCRIPT_DIR="${SCRIPT_PATH%/*}"
[ "$SCRIPT_DIR" = "$SCRIPT_PATH" ] && SCRIPT_DIR="."
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PKG_NAME="deepseek-harness-desktop"
VERSION="${2:-${TB_VERSION:-}}"
if [ -z "$VERSION" ]; then
  VERSION="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo '0.0.0')"
fi
OUTPUT_DIR="$ROOT/release"

ARCH="${1:-amd64}"
FULL=0
for arg in "$@"; do
  [ "$arg" = "--full-offline" ] && FULL=1
done
case "$ARCH" in
  amd64|x86_64) ARCH="amd64"; NODE_ARCH_LABEL="x64" ;;
  arm64|aarch64|arm) ARCH="arm64"; NODE_ARCH_LABEL="arm64" ;;
  *) echo "✖ 不支持的架构: $ARCH（仅支持 amd64 / arm64）" >&2; exit 1 ;;
esac

NODE_VER="$(sed -n 's/^NODE_WANT="\(.*\)"/\1/p' "$ROOT/tools/bootstrap.sh")"
ELECTRON_VER="$(sed -n 's/^ELECTRON_WANT="\(.*\)"/\1/p' "$ROOT/tools/bootstrap.sh")"
NODE_TARBALL="node-${NODE_VER}-linux-${NODE_ARCH_LABEL}.tar.gz"
ELECTRON_ZIP="electron-${ELECTRON_VER}-linux-${NODE_ARCH_LABEL}.zip"

err() { echo "✖ $*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

[ "$FULL" -eq 1 ] || err "便携包目前只支持 --full-offline（内核等运行时必须内嵌，否则普通用户装完还要联网）"
command -v tar >/dev/null 2>&1 || err "缺少 tar"

# ── 暂存目录 ───────────────────────────────────────────────────────────
STAGE="$ROOT/portable-stage"
rm -rf "$STAGE"
TB_NAME="${PKG_NAME}-${VERSION}-full-offline-${ARCH}"
TB_ROOT="$STAGE/$TB_NAME"
APP_DIR="$TB_ROOT/app"
mkdir -p "$APP_DIR"

# ── 壳代码 ─────────────────────────────────────────────────────────────
say "复制壳代码…"
cp -r "$ROOT/src"          "$APP_DIR/src"
cp -r "$ROOT/tools"        "$APP_DIR/tools"
cp -r "$ROOT/assets"       "$APP_DIR/assets"
[ -d "$ROOT/renderer" ] && cp -r "$ROOT/renderer" "$APP_DIR/renderer"
cp    "$ROOT/config.json"  "$APP_DIR/config.json"
cp    "$ROOT/start-shell.sh" "$APP_DIR/start-shell.sh"
cp    "$ROOT/package.json" "$APP_DIR/package.json"
cp    "$ROOT/LICENSE"      "$APP_DIR/LICENSE" 2>/dev/null || true
cp    "$ROOT/NOTICE"       "$APP_DIR/NOTICE"  2>/dev/null || true

find "$APP_DIR/src" -name '*.test.js' -delete
rm -f "$APP_DIR/tools/build-deb.sh" "$APP_DIR/tools/build-tarball.sh"
rm -f "$APP_DIR/tools/install-kernel.js" "$APP_DIR/tools/install-node.js" \
      "$APP_DIR/tools/prune-kernel.js" "$APP_DIR/tools/after-pack.js" \
      "$APP_DIR/src/supervisor-smoke.mjs" 2>/dev/null
rm -f "$APP_DIR/assets/icon.icns" "$APP_DIR/assets/icon.ico" \
      "$APP_DIR/assets/entitlements.mac.plist" 2>/dev/null

chmod -R a+rX "$APP_DIR"
chmod 0755 "$APP_DIR/start-shell.sh" "$APP_DIR/tools/bootstrap.sh" \
           "$APP_DIR/tools/install-plugins.sh" 2>/dev/null || true
chmod 0644 "$APP_DIR/config.json" "$APP_DIR/package.json" 2>/dev/null || true

# ── 内嵌运行时压缩包（Electron / Node）─────────────────────────────────
say "内嵌运行时压缩包…"
RT_DIR="$APP_DIR/runtimes"
mkdir -p "$RT_DIR"
for f in "$NODE_TARBALL" "$ELECTRON_ZIP"; do
  [ -f "$OUTPUT_DIR/$f" ] || err "缺 $OUTPUT_DIR/$f（先下载官方压缩包）"
  cp "$OUTPUT_DIR/$f" "$RT_DIR/"
done
# 同镜像的 SHASUMS256.txt 一并内嵌，离线机器解包时也能校验
NODE_MIRROR="${NODE_MIRROR_URL:-https://npmmirror.com/mirrors/node}"
ELECTRON_MIRROR="${ELECTRON_MIRROR_URL:-https://npmmirror.com/mirrors/electron}"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$NODE_MIRROR/$NODE_VER/SHASUMS256.txt" \
    -o "$RT_DIR/SHASUMS256.node.$NODE_VER.txt" 2>/dev/null \
    || say "  ⚠ node 的 SHASUMS256.txt 拉取失败，离线校验将跳过"
  curl -fsSL "$ELECTRON_MIRROR/$ELECTRON_VER/SHASUMS256.txt" \
    -o "$RT_DIR/SHASUMS256.electron.$ELECTRON_VER.txt" 2>/dev/null \
    || say "  ⚠ electron 的 SHASUMS256.txt 拉取失败，离线校验将跳过"
else
  say "  ⚠ 无 curl，跳过校验清单内嵌"
fi
touch "$RT_DIR/FULL-OFFLINE"
chmod 0644 "$RT_DIR"/*

# ── 内嵌 dsh 内核树 ────────────────────────────────────────────────────
say "内嵌 dsh 内核树…"
KERNEL_SRC="$ROOT/resources/kernel"
[ -f "$KERNEL_SRC/node_modules/@deepseek-ai/dsh/lib/bin.js" ] \
  || err "缺内核树：$KERNEL_SRC（先在联网 $NODE_ARCH_LABEL 机器上跑 node tools/install-kernel.js）"
[ -x "$KERNEL_SRC/node" ] || err "缺内核自带 Node：$KERNEL_SRC/node"
mkdir -p "$APP_DIR/resources"
cp -a "$KERNEL_SRC" "$APP_DIR/resources/kernel"
chmod -R a+rX "$APP_DIR/resources/kernel"
chmod 0755 "$APP_DIR/resources/kernel/node"

# ── 生成安装 / 卸载脚本 ────────────────────────────────────────────────
say "生成 install.sh / uninstall.sh…"
cat > "$TB_ROOT/install.sh" <<'INSTALL_EOF'
#!/usr/bin/env bash
# DeepSeek Harness Desktop __VERSION__ 全离线便携包安装脚本
# 无需 root：全部文件装在用户自己的目录里。
#
# 用法：
#   bash install.sh                       # 装到 ~/.local/share/deepseek-harness-desktop
#   bash install.sh --prefix /data/dsh    # 装到指定目录（需有写权限）
#   bash install.sh --no-warmup           # 跳过 Electron 预解包（留给首次启动）
#   bash install.sh --no-desktop          # 不建桌面图标/命令行启动器
set -uo pipefail

PKG_NAME="__PKG_NAME__"
VERSION="__VERSION__"
DEFAULT_PREFIX="${HOME}/.local/share/${PKG_NAME}"

PREFIX=""
NO_WARMUP=0
NO_DESKTOP=0

usage() {
  cat <<'U'
用法：bash install.sh [选项]
  --prefix DIR    安装目录（默认 ~/.local/share/deepseek-harness-desktop）
  --no-warmup     不预解包 Electron（首次启动时再解）
  --no-desktop    不创建桌面图标与 ~/.local/bin/dsh-desktop
  -h, --help      显示本帮助
U
}

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix)     PREFIX="$2"; shift 2 ;;
    --prefix=*)   PREFIX="${1#*=}"; shift ;;
    --no-warmup)  NO_WARMUP=1; shift ;;
    --no-desktop) NO_DESKTOP=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "✖ 未知参数: $1" >&2; usage; exit 2 ;;
  esac
done

die() { echo "✖ $*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
ok()  { printf '  ✅ %s\n' "$*"; }
info(){ printf '  · %s\n' "$*"; }

[ -z "$PREFIX" ] && PREFIX="${DSH_PREFIX:-$DEFAULT_PREFIX}"
case "$PREFIX" in
  '~')     PREFIX="$HOME" ;;
  '~/'*)   PREFIX="$HOME/${PREFIX#\~/}" ;;
esac
mkdir -p "$PREFIX" 2>/dev/null || die "无法创建安装目录：$PREFIX（没有写权限？）"
[ -w "$PREFIX" ] || die "安装目录不可写：$PREFIX（换一个目录或加 --prefix）"
PREFIX="$(cd "$PREFIX" && pwd)"

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_SRC="$SRC_DIR/app"
[ -d "$APP_SRC" ] || die "找不到 app/ 目录：$APP_SRC（压缩包解压不完整？）"

say ""
say "DeepSeek Harness Desktop $VERSION —— 全离线便携安装（无需 root）"
say "  源   : $APP_SRC"
say "  目标 : $PREFIX"
say ""

# 已装过 → 升级：只清应用文件，用户数据（DSH_HOME / ~/.dsh）与用户配置不动
if [ -f "$PREFIX/start-shell.sh" ]; then
  info "检测到已安装，清理旧版本应用文件…"
  rm -rf "$PREFIX/src" "$PREFIX/tools" "$PREFIX/assets" "$PREFIX/renderer" \
         "$PREFIX/resources" "$PREFIX/runtimes" \
         "$PREFIX/config.json" "$PREFIX/start-shell.sh" "$PREFIX/package.json" \
         "$PREFIX/LICENSE" "$PREFIX/NOTICE"
fi

info "复制文件（含内核，约几百 MB，请稍候）…"
cp -a "$APP_SRC"/. "$PREFIX"/ || die "复制失败（磁盘空间不足？）"
chmod 0755 "$PREFIX/start-shell.sh" "$PREFIX/tools/bootstrap.sh" \
           "$PREFIX/tools/install-plugins.sh" 2>/dev/null || true
[ -f "$PREFIX/resources/kernel/node" ] && chmod 0755 "$PREFIX/resources/kernel/node"
ok "应用文件已就位"

# ── 用户配置：把「本次安装前缀」写进用户覆盖份 ──────────────────────────
# 全局 $PREFIX/config.json 保持原样，这样同一个包能装到任意前缀；
# start-shell.sh 读用户覆盖份优先，落在 ~/.config 下也不需要 root。
USER_CFG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/dsh-desktop"
USER_CFG="$USER_CFG_DIR/config.json"
mkdir -p "$USER_CFG_DIR" || die "无法创建配置目录：$USER_CFG_DIR"
[ -f "$USER_CFG" ] && cp -f "$USER_CFG" "$USER_CFG.bak-install" 2>/dev/null || true
cp -f "$PREFIX/config.json" "$USER_CFG.tmp.$$"
set_kv() {
  local key="$1" value="$2"
  sed -i "s|\"${key}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"|\"${key}\": \"${value}\"|" "$USER_CFG.tmp.$$"
}
set_kv systemDsh  "$PREFIX/resources/kernel/node_modules/@deepseek-ai/dsh/lib/bin.js"
set_kv nodeBinDir "$PREFIX/resources/kernel"
mv -f "$USER_CFG.tmp.$$" "$USER_CFG"
ok "用户配置已写入：$USER_CFG"

# ── 命令行启动器 + 桌面图标 ────────────────────────────────────────────
if [ "$NO_DESKTOP" -eq 0 ]; then
  BIN_DIR="${HOME}/.local/bin"
  mkdir -p "$BIN_DIR" 2>/dev/null || true
  if [ -d "$BIN_DIR" ] && [ -w "$BIN_DIR" ]; then
    cat > "$BIN_DIR/dsh-desktop" <<LAUNCH
#!/usr/bin/env bash
# DeepSeek Harness Desktop 启动器（由 install.sh 生成）
exec bash "$PREFIX/start-shell.sh" "\$@"
LAUNCH
    chmod 0755 "$BIN_DIR/dsh-desktop"
    ok "命令行启动器：$BIN_DIR/dsh-desktop"
    case ":$PATH:" in
      *":$BIN_DIR:"*) ;;
      *)
        info "提示：$BIN_DIR 不在 PATH 中，命令行里直接敲 dsh-desktop 会找不到。"
        info "加入方法：echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc && source ~/.bashrc"
        ;;
    esac
  fi

  XDG_DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
  APPS="$XDG_DATA/applications"
  ICONS="$XDG_DATA/icons/hicolor/128x128/apps"
  mkdir -p "$APPS" "$ICONS" 2>/dev/null || true
  if [ -d "$APPS" ] && [ -w "$APPS" ] && [ -f "$PREFIX/assets/icon.png" ]; then
    cp -f "$PREFIX/assets/icon.png" "$ICONS/$PKG_NAME.png" 2>/dev/null || true
    cat > "$APPS/$PKG_NAME.desktop" <<DESKTOP
[Desktop Entry]
Name=DeepSeek Harness Desktop
GenericName=DeepSeek Harness 桌面壳
Comment=DeepSeek Harness agent 运行时的桌面壳（离线版，无需 root）
Exec=bash $PREFIX/start-shell.sh
Terminal=false
Type=Application
Icon=$ICONS/$PKG_NAME.png
StartupWMClass=DeepSeek Harness Desktop
Categories=Development;Utility;
DESKTOP
    chmod 0644 "$APPS/$PKG_NAME.desktop"
    ok "桌面图标：$APPS/$PKG_NAME.desktop"
  fi
fi

# ── 预热：立刻解包内置 Electron，首次启动不再等待 ──────────────────────
if [ "$NO_WARMUP" -eq 0 ]; then
  info "解包内置 Electron（约 1 分钟，之后启动即为秒开）…"
  if bash "$PREFIX/tools/bootstrap.sh" install; then
    ok "运行时就绪（Electron 已解包到 ~/.dsh-desktop/runtime）"
  else
    echo "  ⚠ 预热未完全成功；首次启动时会自动再试一次"
  fi
fi

say ""
say "════════════════════════════════════════════════"
say " 安装完成"
say "════════════════════════════════════════════════"
say " 启动方式（任选）："
say "   1) 应用菜单里搜「DeepSeek Harness Desktop」"
say "   2) 命令行：dsh-desktop        （~/.local/bin 已在 PATH 时）"
say "   3) 直接跑：bash $PREFIX/start-shell.sh"
say ""
say " 安装目录：$PREFIX"
say " 用户配置：$USER_CFG"
say " 数据与日志：${HOME}/.local/share/dsh-desktop/data-shell"
say " 卸载：bash \"\$(dirname \"\$0\")\"/uninstall.sh  （或重新解压包里的 uninstall.sh）"
say ""
say " 首次使用需要你自己的 DeepSeek API Key（产品登录逻辑，与网络无关）。"
say ""
INSTALL_EOF

cat > "$TB_ROOT/uninstall.sh" <<'UNINSTALL_EOF'
#!/usr/bin/env bash
# 卸载 DeepSeek Harness Desktop（同样无需 root）
set -uo pipefail

PKG_NAME="__PKG_NAME__"
PREFIX="${1:-${DSH_PREFIX:-$HOME/.local/share/${PKG_NAME}}}"
case "$PREFIX" in
  '~')   PREFIX="$HOME" ;;
  '~/'*) PREFIX="$HOME/${PREFIX#\~/}" ;;
esac

confirm() {
  [ "${ASSUME_YES:-0}" = "1" ] && return 0
  printf '%s [y/N] ' "$1"
  read -r ans || ans="n"
  case "$ans" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

if [ ! -d "$PREFIX" ]; then
  echo "未找到安装目录：$PREFIX（可用第一个参数指定，或 DSH_PREFIX 环境变量）"
  exit 1
fi

echo "即将删除安装目录：$PREFIX"
confirm "确认删除？" || { echo "已取消"; exit 0; }

rm -rf "$PREFIX"
echo "  ✅ 已删除 $PREFIX"
rm -f "${HOME}/.local/bin/dsh-desktop" && echo "  ✅ 已删除 ~/.local/bin/dsh-desktop"
rm -f "${XDG_DATA_HOME:-$HOME/.local/share}/applications/${PKG_NAME}.desktop" \
      "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/128x128/apps/${PKG_NAME}.png" \
  && echo "  ✅ 已删除桌面图标"

if confirm "是否同时删除运行时缓存 ~/.dsh-desktop（约 400MB，删了下次要重新解包）？"; then
  rm -rf "${HOME}/.dsh-desktop" && echo "  ✅ 已删除 ~/.dsh-desktop"
fi
if confirm "是否删除用户配置 ~/.config/dsh-desktop（含已记录的路径）？"; then
  rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/dsh-desktop" && echo "  ✅ 已删除用户配置"
fi
echo "注：内核数据 DSH_HOME（默认 ~/.local/share/dsh-desktop/data-shell 或 ~/.dsh）未删除。"
echo "卸载完成。"
UNINSTALL_EOF

cat > "$TB_ROOT/安装说明.md" <<'DOC_EOF'
# DeepSeek Harness Desktop __VERSION__ · 全离线便携包（Linux __ARCH__）

内嵌 Electron + Node + dsh 内核，**安装与运行都不需要 root、不需要网络**。

## 安装

```bash
tar -xzf DeepSeek-Harness-Desktop-__VERSION__-full-offline-__ARCH__.tar.gz
cd __PKG_NAME__-__VERSION__-full-offline-__ARCH__
bash install.sh
```

可选参数：

| 参数 | 作用 |
|---|---|
| `--prefix DIR` | 指定安装目录（默认 `~/.local/share/deepseek-harness-desktop`） |
| `--no-warmup` | 跳过 Electron 预解包（留给首次启动做，会多等约 1 分钟） |
| `--no-desktop` | 不建桌面图标、不建 `~/.local/bin/dsh-desktop` |

## 启动

- 应用菜单搜索 **DeepSeek Harness Desktop**；
- 或命令行 `dsh-desktop`；
- 或 `bash <安装目录>/start-shell.sh`。

## 卸载

```bash
bash uninstall.sh            # 默认前缀
bash uninstall.sh /data/dsh  # 指定前缀
```

## 目录说明

| 路径 | 内容 |
|---|---|
| `<安装目录>` | 壳代码 + 内核树 + 内置运行时压缩包 |
| `~/.config/dsh-desktop/config.json` | 用户配置（记录本次安装路径，改动请改这份） |
| `~/.dsh-desktop/runtime` | Electron 解包位置（post-install 预热生成） |
| `~/.local/share/dsh-desktop/data-shell` | 壳的 userData 与日志，DSH_HOME 默认在其下 |

同机多用户各自安装互不干扰；同一份包可以装到任意前缀（U 盘、/data 均可）。
DOC_EOF

sed -i "s|__PKG_NAME__|$PKG_NAME|g; s|__VERSION__|$VERSION|g; s|__ARCH__|$ARCH|g" \
  "$TB_ROOT/install.sh" "$TB_ROOT/uninstall.sh" "$TB_ROOT/安装说明.md"
chmod 0755 "$TB_ROOT/install.sh" "$TB_ROOT/uninstall.sh"
chmod 0644 "$TB_ROOT/安装说明.md"

# ── 打包 ───────────────────────────────────────────────────────────────
mkdir -p "$OUTPUT_DIR"
TB_FILE="$OUTPUT_DIR/DeepSeek-Harness-Desktop-${VERSION}-full-offline-${ARCH}.tar.gz"
say "打包 $TB_FILE …"
tar -czf "$TB_FILE" -C "$STAGE" "$TB_NAME" || err "tar 打包失败"
rm -rf "$STAGE"

SIZE=$(du -h "$TB_FILE" | cut -f1)
say ""
say "✅ 完成：$TB_FILE"
say "   体积：$SIZE"
say ""
say "目标机安装（无需 root）："
say "  tar -xzf $(basename "$TB_FILE")"
say "  cd $TB_NAME && bash install.sh"
say ""


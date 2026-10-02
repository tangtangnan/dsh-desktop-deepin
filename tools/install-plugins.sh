#!/usr/bin/env bash
# 默认插件安装：随运行时自举一并装好，开箱即用。
#
# 用法：
#   bash tools/install-plugins.sh            # 检测 + 补装缺失的
#   bash tools/install-plugins.sh force      # 无视已装，强制全部重装
#
# 设计：
# - 幂等：用 `dsh plugin list` 查重，已装的跳过（force 除外）
# - 静默降级：某个插件装失败只告警，不阻塞其余插件与启动流程
# - 只在有 dsh 时工作：dsh 是内核命令，没有它本脚本直接退出（bootstrap 时序保证）
set -uo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
SCRIPT_DIR="${SCRIPT_PATH%/*}"
[ "$SCRIPT_DIR" = "$SCRIPT_PATH" ] && SCRIPT_DIR="."
SHELL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FORCE="${1:-}"

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ✅ %s\n' "$*"; }
bad()  { printf '  ❌ %s\n' "$*"; }
info() { printf '  · %s\n' "$*"; }

# ── 找 dsh 可执行文件（与 bootstrap.sh 的检测顺序一致，但这里只需要一个）──
DSH_BIN=""
for c in "$(command -v dsh 2>/dev/null)" \
         /usr/local/bin/dsh /usr/bin/dsh /usr/local/nodejs/bin/dsh \
         "${HOME}/.nvm/versions/node/"*/bin/dsh \
         "${HOME}/.config/dsh-desktop/bin-shims/dsh" \
         "$SHELL_DIR"/../runtime/dsh*/dsh; do
  [ -n "$c" ] && [ -x "$c" ] && { DSH_BIN="$c"; break; }
done
[ -z "$DSH_BIN" ] && { say "未找到 dsh，跳过默认插件安装（内核装好后会再触发）"; exit 0; }
info "使用内核: $DSH_BIN"

# ── 默认插件清单（npm 包名）────────────────────────────────────────────
# dsh-market 的 npm 包名是无连字符的 dshmarket（作者命名如此）；
# dsh-im 的 npm 包名是 scoped 的 @xmanrui/dsh-im。
PLUGINS=("@xmanrui/dsh-im" dsh-pocket-relay dsh-mcp-panel dshmarket)
NPM_REGISTRY="https://registry.npmmirror.com"

# 已装清单（一次查询，循环里查子串）。plugin list 输出是 pnpm 依赖树
# （形如 "├── @xmanrui/dsh-im@4.34.0"），子串匹配足够且天然兼容 scoped 名。
LIST_OUT="$("$DSH_BIN" plugin list --profile web 2>/dev/null || true)"

installed() {
  local pkg="$1"
  printf '%s' "$LIST_OUT" | grep -q "$pkg"
}

say ""
say "════════════════════════════════════════════════"
say " 默认插件安装（dsh-im / pocket-relay / mcp-panel / market）"
say "════════════════════════════════════════════════"

fail=0
for pkg in "${PLUGINS[@]}"; do
  if [ "$FORCE" != "force" ] && installed "$pkg"; then
    ok "$pkg 已安装，跳过"
    continue
  fi
  info "安装 $pkg …"
  # registry 双保险：--registry flag + npm_config_registry 环境变量（pnpm 两者都认，
  # 某些版本/环境下 flag 可能被上游忽略）。失败时必须把输出打出来——吞掉报错
  # 曾导致真机四个插件全失败却查不到原因（v0.2.7 事故）。
  err_file="$(mktemp -u "$HOME/.dsh-desktop/plugin-add.XXXXXX")"
  mkdir -p "$HOME/.dsh-desktop" 2>/dev/null
  # --profile 是 dsh 全局选项，必须在 plugin 之前（实测：放在 plugin add 之后会报
  # "required option '--profile <name>' not specified"）。
  if npm_config_registry="$NPM_REGISTRY" "$DSH_BIN" --profile web plugin add "$pkg" \
       --registry "$NPM_REGISTRY" 2>"$err_file" \
     || npm_config_registry="$NPM_REGISTRY" "$DSH_BIN" --profile web plugin add "$pkg" 2>>"$err_file"; then
    ok "$pkg 安装成功"
    rm -f "$err_file"
  else
    bad "$pkg 安装失败，dsh/pnpm 输出如下："
    sed 's/^/    | /' "$err_file" 2>/dev/null | tail -15
    rm -f "$err_file"
    fail=$((fail + 1))
  fi
done

say ""
if [ "$fail" -eq 0 ]; then
  ok "默认插件全部就绪"
else
  bad "$fail 个插件安装失败（可稍后手动执行：bash $SCRIPT_PATH force）"
fi
exit 0   # 插件失败不阻塞启动，永远 0

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
NPM_REGISTRY="https://registry.npmmirror.com"

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ✅ %s\n' "$*"; }
bad()  { printf '  ❌ %s\n' "$*"; }
info() { printf '  · %s\n' "$*"; }

# ── 找 dsh 可执行文件 ─────────────────────────────────────────────────
DSH_BIN=""
for c in "$(command -v dsh 2>/dev/null)" \
         /usr/local/bin/dsh /usr/bin/dsh /usr/local/nodejs/bin/dsh \
         "${HOME}/.nvm/versions/node/"*/bin/dsh \
         "${HOME}/.config/dsh-desktop/bin-shims/dsh"; do
  [ -n "$c" ] && [ -x "$c" ] && { DSH_BIN="$c"; break; }
done
if [ -z "$DSH_BIN" ]; then
  say "未找到 dsh，跳过默认插件安装（内核装好后会再触发）。"
  exit 0
fi
info "使用内核: $DSH_BIN"

# ── 默认插件清单（npm 真实包名）──────────────────────────────────────────
# 注意：dsh-market 在 npm 上的包名是无连字符的 dshmarket；
# dsh-im 的 npm 包名是 scoped 的 @xmanrui/dsh-im。
# 安装命令：dsh plugin --profile web add <包名>（--profile 是必填全局选项）。
PLUGINS=("@xmanrui/dsh-im" dsh-pocket-relay dsh-mcp-panel dshmarket)

# 已装清单（一次查询，循环里查子串）。
# 语序实测：`dsh plugin --profile web ...` 正确（--profile 跟在 plugin 后）；
# `dsh --profile web plugin ...` 是错误语序——会被解析成主服务参数。
LIST_OUT="$("$DSH_BIN" plugin --profile web list 2>/dev/null || true)"

installed() {
  local pkg="$1"
  printf '%s' "$LIST_OUT" | grep -q "$pkg"
}

say ""
say "════════════════════════════════════════════════════════════════════════════════════════════════════════════"
say " 默认插件安装（dsh-im / pocket-relay / mcp-panel / market）"
say "══════════════════════════════════════════════════════════════════════════════════════════════════════════"

fail=0
for pkg in "${PLUGINS[@]}"; do
  if [ "$FORCE" != "force" ] && installed "$pkg"; then
    ok "$pkg 已安装，跳过"
    continue
  fi
  info "安装 $pkg …"
  # registry 只能通过环境变量传给 pnpm：`dsh plugin add` 不认 --registry
  # （实测报 unknown option '--registry' 且触发 too many arguments）。
  # 语序实测：`dsh plugin --profile web add <pkg>` 正确。
  output="$(npm_config_registry="$NPM_REGISTRY" "$DSH_BIN" plugin --profile web add "$pkg" 2>&1)"
  if [ $? -eq 0 ]; then
    ok "$pkg 安装成功"
  else
    bad "$pkg 安装失败，dsh/pnpm 输出如下："
    printf '%s\n' "$output" | sed 's/^/    | /' | tail -15
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

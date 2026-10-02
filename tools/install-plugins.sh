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
# 注意：「使用内核」这行不能在 check 模式打印——check 的 stdout 只允许是
# 缺失包名（start-shell.sh 会 $(...) 捕获它）。故留到 check 分支之后再打。

# ── 确保 pnpm 可用 ─────────────────────────────────────────────────────
# dsh 的 plugin 子命令底层调用 pnpm；PATH 上没有 pnpm 时 dsh 会直接报
#   dsh: pnpm was not found; install pnpm and make it available on PATH.
# 真机实测（arm64 + nvm 装的 Node）就是踩在这里：nvm 的 node 不带 pnpm，
# 于是四个插件全失败。这里按「复用已有 → corepack 启用 → 用户级安装」的
# 顺序保证 pnpm 可用，并把它的目录加进 PATH（dsh 靠 PATH 找 pnpm）。
PNPM_BIN=""
ensure_pnpm() {
  local p ndir npm_bin corepack_bin
  # 1) PATH 里已有（最常见：系统级 node 环境自带）
  p="$(command -v pnpm 2>/dev/null || true)"
  if [ -n "$p" ]; then PNPM_BIN="$p"; info "pnpm: $p"; return 0; fi

  # 2) 与 dsh（即 node）同目录，以及几个常见位置——命中即复用，零下载
  ndir="$(dirname "$DSH_BIN")"
  for p in "$ndir/pnpm" /usr/local/bin/pnpm /usr/bin/pnpm \
           "${HOME}/.local/bin/pnpm" "${HOME}/.local/share/pnpm/pnpm"; do
    if [ -x "$p" ]; then
      export PATH="$(dirname "$p"):$PATH"
      PNPM_BIN="$p"; info "pnpm: $p（已加入 PATH）"; return 0
    fi
  done

  # 3) corepack（Node ≥16.9 自带）——能就地启用 pnpm，不必手动安装。
  # 注意：postinst 经 runuser 调用时 PATH 是精简的，`command -v corepack`
  # 可能找不到，故同样回退查与 dsh 同目录（nvm 场景 corepack 就在那儿）。
  corepack_bin="$(command -v corepack 2>/dev/null || true)"
  if [ -z "$corepack_bin" ] && [ -x "$ndir/corepack" ]; then corepack_bin="$ndir/corepack"; fi
  if [ -n "$corepack_bin" ]; then
    info "未找到 pnpm，尝试用 Node 自带的 corepack 启用…"
    # corepack 下载 pnpm 时只认 COREPACK_NPM_REGISTRY（不认 npm_config_registry），
    # 必须显式指向国内镜像，否则走 registry.npmjs.org——真机实测「非常慢」。
    # 且 enable 只建 shim，真正的下载发生在「首次调用 pnpm」时，所以这里
    # export 让后续所有 pnpm 调用（含 dsh plugin）都走镜像。
    export COREPACK_NPM_REGISTRY="$NPM_REGISTRY"
    if [ "${DSH_PLUGIN_DRYRUN:-}" = "1" ]; then
      info "[dryrun] COREPACK_NPM_REGISTRY=$NPM_REGISTRY $corepack_bin enable pnpm"
    else
      "$corepack_bin" enable pnpm >/dev/null 2>&1 || true
    fi
    # corepack 的 shim 落在 node bin 目录；PATH 未必含它，故两处都查。
    p="$(command -v pnpm 2>/dev/null || true)"
    if [ -z "$p" ] && [ -x "$ndir/pnpm" ]; then
      export PATH="$ndir:$PATH"; p="$ndir/pnpm"
    fi
    if [ -n "$p" ]; then
      # 预热：把 corepack 首次下载 pnpm 的耗时显式暴露出来并给出预期，
      # 免得用户以为卡死（真机反馈「这块非常慢」正是这里）。
      info "首次启用需下载 pnpm（走国内镜像，通常 10~30 秒，请稍候）…"
      if [ "${DSH_PLUGIN_DRYRUN:-}" = "1" ]; then
        info "[dryrun] $p --version（预热 corepack 下载）"
      else
        "$p" --version >/dev/null 2>&1 || true
      fi
      PNPM_BIN="$p"; ok "pnpm 已就绪: $p"; return 0
    fi
  fi

  # 4) 兜底：npm 装到用户目录（--prefix ~/.local，不需要 root、不碰系统目录）
  npm_bin="$(command -v npm 2>/dev/null || true)"
  if [ -z "$npm_bin" ] && [ -x "$ndir/npm" ]; then npm_bin="$ndir/npm"; fi
  if [ -n "$npm_bin" ] && [ -x "$npm_bin" ]; then
    info "未找到 pnpm，改为用户级安装（~/.local，无需 root）…"
    if [ "${DSH_PLUGIN_DRYRUN:-}" = "1" ]; then
      info "[dryrun] $npm_bin install -g --prefix $HOME/.local pnpm --registry=$NPM_REGISTRY"
    else
      "$npm_bin" install -g --prefix "$HOME/.local" pnpm \
        --registry="$NPM_REGISTRY" >/dev/null 2>&1 || true
    fi
    if [ -x "${HOME}/.local/bin/pnpm" ]; then
      export PATH="${HOME}/.local/bin:$PATH"
      PNPM_BIN="${HOME}/.local/bin/pnpm"; ok "pnpm 已装到 $PNPM_BIN"; return 0
    fi
  fi
  return 1
}

# 注意：ensure_pnpm 的「调用」放在下面清单/查重定义之后——check 模式是纯查询，
# 不该因为缺 pnpm 就触发下载（启动时每次调用必须是零副作用、快速返回）。

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

# ── check 模式：只查询、不安装、零副作用 ─────────────────────────────────
# 用法：bash install-plugins.sh check
#   全部已装 → 无输出、exit 0
#   有缺失   → 打印缺失包名（空格分隔）、exit 1
# start-shell.sh 启动时用它决定「是否需要弹终端补装」，因此这里绝不能
# 触发任何下载（不能调 ensure_pnpm）。dsh 缺失时视为未知，返回 0 不打扰。
if [ "$FORCE" = "check" ]; then
  [ -n "$DSH_BIN" ] || exit 0
  miss=""
  for pkg in "${PLUGINS[@]}"; do
    installed "$pkg" || miss="$miss $pkg"
  done
  if [ -n "$miss" ]; then
    printf '%s\n' "${miss# }"
    exit 1
  fi
  exit 0
fi

# ── 安装模式：打印环境信息后开始 ─────────────────────────────────────────
info "使用内核: $DSH_BIN"

if ! ensure_pnpm; then
  bad "没有 pnpm，且自动安装失败——dsh 的 plugin 命令依赖它，插件无法安装。"
  say ""
  say "  任选一种装上后重跑本脚本："
  say "    corepack enable pnpm                      # Node 自带，最省事"
  say "    npm i -g --prefix \"\$HOME/.local\" pnpm      # 用户级，不需要 root"
  say ""
  exit 0   # 缺 pnpm 不阻塞壳本身启动
fi

say ""
say "════════════════════════════════════════════════════════════════════════════════════════════════════════════"
say " 默认插件安装（dsh-im / pocket-relay / mcp-panel / market）"
say "══════════════════════════════════════════════════════════════════════════════════════════════════════════"

fail=0
total="${#PLUGINS[@]}"
idx=0
t_all=0
for pkg in "${PLUGINS[@]}"; do
  idx=$((idx + 1))
  if [ "$FORCE" != "force" ] && installed "$pkg"; then
    ok "[$idx/$total] $pkg 已安装，跳过"
    continue
  fi
  info "[$idx/$total] 安装 $pkg …（下载依赖中，请稍候）"
  # registry 只能通过环境变量传给 pnpm：`dsh plugin add` 不认 --registry
  # （实测报 unknown option '--registry' 且触发 too many arguments）。
  # 语序实测：`dsh plugin --profile web add <pkg>` 正确。
  t0="$(date +%s)"
  output="$(npm_config_registry="$NPM_REGISTRY" "$DSH_BIN" plugin --profile web add "$pkg" 2>&1)"
  rc=$?
  t1="$(date +%s)"
  dur=$((t1 - t0)); t_all=$((t_all + dur))
  if [ "$rc" -eq 0 ]; then
    ok "[$idx/$total] $pkg 安装成功（${dur}s）"
  else
    bad "[$idx/$total] $pkg 安装失败（${dur}s），dsh/pnpm 输出如下："
    printf '%s\n' "$output" | sed 's/^/    | /' | tail -15
    fail=$((fail + 1))
  fi
done

say ""
[ "$total" -gt 1 ] && info "本轮共 ${t_all}s（已装的插件不重装；下次运行会直接跳过）"
if [ "$fail" -eq 0 ]; then
  ok "默认插件全部就绪"
  # 成功印记：记下「本壳版本下插件已齐」。start-shell.sh 用它做快路径，
  # 免得每次启动都跑一次 `dsh plugin list`（要拉起 pnpm，1~3 秒）。
  # 版本号取自壳的 package.json——升级后版本变化 → 印记失配 → 重新查一次。
  ver="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
          "$SHELL_DIR/package.json" 2>/dev/null | head -1)"
  if [ -n "$ver" ]; then
    mkdir -p "${HOME}/.dsh-desktop" 2>/dev/null
    printf '%s\n' "$ver" > "${HOME}/.dsh-desktop/.plugins-ok" 2>/dev/null || true
  fi
else
  bad "$fail 个插件安装失败（可稍后手动执行：bash $SCRIPT_PATH force）"
fi
exit 0   # 插件失败不阻塞启动，永远 0

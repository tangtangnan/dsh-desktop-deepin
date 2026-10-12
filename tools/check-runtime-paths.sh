#!/usr/bin/env bash
# 校验 start-shell.sh 与 tools/bootstrap.sh 的运行时候选名单是否一致。
#
# 两处必须是同一份名单：bootstrap 负责「装」，start-shell.sh 负责「认」。
# 名单一旦漂移，bootstrap 装好的运行时 start-shell.sh 认不出，表现为
# 「下载完启动还是说缺 node」（issue #1 的近亲）。这个脚本把那份一致性
# 变成可以断言的东西，而不是靠人记得同步。
#
# 用法：bash tools/check-runtime-paths.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
start="$here/../start-shell.sh"
bootstrap="$here/bootstrap.sh"
plugins="$here/install-plugins.sh"

fail=0
say_ok()   { printf '  ✅ %s\n' "$*"; }
say_bad()  { printf '  ❌ %s\n' "$*"; fail=1; }

# 版本管理器相关的模式：两处都必须出现，否则某类用户（nvm/fnm/volta/asdf）
# 的运行时在其中一处永远找不到。
patterns=(
  '.nvm/versions/node'
  '.fnm/node-versions'
  '.volta/bin'
  '.asdf/installs/nodejs'
  '.asdf/shims'
)

printf 'start-shell.sh vs bootstrap.sh 运行时候选一致性\n\n'
for p in "${patterns[@]}"; do
  in_start=$(grep -c -- "$p" "$start" 2>/dev/null || echo 0)
  in_boot=$(grep -c -- "$p" "$bootstrap" 2>/dev/null || echo 0)
  if [ "$in_start" -gt 0 ] && [ "$in_boot" -gt 0 ]; then
    say_ok "$p → 两处都有（start:$in_start boot:$in_boot）"
  else
    say_bad "$p → 缺失（start:$in_start boot:$in_boot）"
  fi
done

printf '\n内核识别（桌面壳 shim vs 真内核）\n'
# 桌面壳把「启动壳自己」的命令发布成 ~/.local/bin/dsh（src/cli-command.js），
# 与真内核同名，而 ~/.local/bin 通常排在 PATH 最前。两个脚本都必须识破它，
# 否则 install-plugins.sh 会拿壳 shim 当内核 —— 真机症状是它打印
# 「使用内核: /home/wangke/.local/bin/dsh」，与 start-shell.sh 打印的
# 「dsh : /usr/local/nodejs/bin/dsh」不一致，随后 pnpm 四层兜底全塌。
for f in "$start" "$plugins"; do
  if grep -q '^is_desktop_shell_shim() {' "$f" 2>/dev/null; then
    say_ok "$(basename "$f") 具备内核真伪判据"
  else
    say_bad "$(basename "$f") 缺少内核真伪判据（is_desktop_shell_shim）"
  fi
done

line_of() { grep -n "$2" "$1" 2>/dev/null | head -1 | cut -d: -f1; }
# PATH 兜底必须早于第一次 detect：GUI 会话（DDE 不读 ~/.bashrc）漏掉 node 的
# bin 目录，晚了 command -v pnpm/npm/corepack 已经落空，插件补装必报
# 「没有 pnpm，且自动安装失败」。
guard="$(line_of "$start" '^ensure_node_bin_on_path$')"
first_detect="$(line_of "$start" '^detect$')"
if [ -n "$guard" ] && [ -n "$first_detect" ] && [ "$guard" -lt "$first_detect" ]; then
  say_ok "PATH 兜底早于 detect（第 ${guard} 行 < 第 ${first_detect} 行）"
else
  say_bad "PATH 兜底缺失或晚于 detect（guard=${guard:-无} detect=${first_detect:-无}）"
fi

# 插件脚本必须以 start-shell.sh 探测到的内核为准。两处日志不一致的根因就是
# 这条传参缺失，而不是 PATH 顺序 —— 实测：PATH 完整的登录 shell 里，
# `command -v dsh` 同样被壳 shim 抢占。
if grep -q 'export DSH_KERNEL_BIN' "$start" 2>/dev/null \
   && grep -q 'DSH_KERNEL_BIN:-' "$plugins" 2>/dev/null; then
  say_ok "内核路径经 DSH_KERNEL_BIN 传给插件脚本"
else
  say_bad "缺少 DSH_KERNEL_BIN 传递（start-shell.sh 导出 / install-plugins.sh 消费）"
fi

printf '\n语法检查\n'
if bash -n "$start"; then say_ok "start-shell.sh 语法通过"; else say_bad "start-shell.sh 语法错误"; fi
if bash -n "$bootstrap"; then say_ok "bootstrap.sh 语法通过"; else say_bad "bootstrap.sh 语法错误"; fi
if bash -n "$plugins"; then say_ok "install-plugins.sh 语法通过"; else say_bad "install-plugins.sh 语法错误"; fi

printf '\n'
if [ "$fail" -eq 0 ]; then printf '结论：一致 ✅\n'; else printf '结论：不一致 ❌\n'; fi
exit "$fail"

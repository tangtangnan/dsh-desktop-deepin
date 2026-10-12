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

printf '\n语法检查\n'
if bash -n "$start"; then say_ok "start-shell.sh 语法通过"; else say_bad "start-shell.sh 语法错误"; fi
if bash -n "$bootstrap"; then say_ok "bootstrap.sh 语法通过"; else say_bad "bootstrap.sh 语法错误"; fi

printf '\n'
if [ "$fail" -eq 0 ]; then printf '结论：一致 ✅\n'; else printf '结论：不一致 ❌\n'; fi
exit "$fail"

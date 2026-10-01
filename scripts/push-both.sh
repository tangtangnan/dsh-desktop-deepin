#!/usr/bin/env bash
# 一次推送到两个远端：GitHub（origin）+ Gitee（gitee）。
#
# 为什么分开推而不是给 origin 塞两个 pushurl：GitHub 链路在本机会间歇性
# 超时，若绑在同一个 push 里，GitHub 一卡就把 Gitee 也拖死。分开推可以
# 各自独立报告，GitHub 失败不影响国内镜像更新。
#
# 用法：
#   bash scripts/push-both.sh                      # 已配好 gitee remote 时直接用
#   bash scripts/push-both.sh <gitee-repo-url>     # 首次：同时配好 gitee remote
#   GITEE_URL=... bash scripts/push-both.sh        # 也可用环境变量传入
#
# 分支可用 BRANCH 覆盖（默认 main）。
set -uo pipefail

BRANCH="${BRANCH:-main}"
GITEE_URL="${1:-${GITEE_URL:-}}"

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ✅ %s\n' "$*"; }
bad()  { printf '  ❌ %s\n' "$*"; }

# 首次使用时把 Gitee remote 配上（只配一次，已存在就跳过）
if [ -n "$GITEE_URL" ]; then
  if git remote get-url gitee >/dev/null 2>&1; then
    say "gitee remote 已存在，跳过配置：$(git remote get-url gitee)"
  else
    git remote add gitee "$GITEE_URL" && ok "已添加 gitee remote: $GITEE_URL"
  fi
fi

if ! git remote get-url gitee >/dev/null 2>&1; then
  bad "尚未配置 gitee remote"
  say ""
  say "首次使用请传入 Gitee 仓库地址，例如："
  say "  bash scripts/push-both.sh https://gitee.com/<你的用户名>/dsh-desktop-deepin.git"
  exit 1
fi

say "推送分支 $BRANCH 到两个远端（各自独立，互不影响）…"
say ""

fail=0

say "→ GitHub (origin)"
if git push origin "$BRANCH"; then ok "GitHub 推送成功"; else bad "GitHub 推送失败（本机 GitHub 链路会间歇性超时，可稍后重试或走 gh api）"; fail=1; fi
say ""

say "→ Gitee (gitee)"
if git push gitee "$BRANCH"; then ok "Gitee 推送成功"; else bad "Gitee 推送失败（检查网络/令牌权限）"; fail=1; fi
say ""

if [ "$fail" -eq 0 ]; then
  ok "两边都已更新"
else
  bad "至少有一个远端推送失败，见上方明细"
fi
exit "$fail"

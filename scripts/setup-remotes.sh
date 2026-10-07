#!/usr/bin/env bash
# 整理三个远端的命名与地址（幂等，可反复跑）。
#
# 目标约定：
#   origin   -> GitHub    https://github.com/westanke/dsh-desktop-deepin.git
#   gitee    -> Gitee     https://gitee.com/westanke/dsh-desktop-deepin.git
#   atomgit  -> AtomGit   https://atomgit.com/westanke163/dsh-desktop-deepin.git
#
# 为什么要整理：历史上 origin 曾被改指到 AtomGit、GitHub 被降级成 old-origin，
# 名字和实际平台对不上，容易误推。统一后 origin 永远是 GitHub，符合 git 惯例。
#
# 用法：bash scripts/setup-remotes.sh
set -uo pipefail

GITHUB_URL="https://github.com/westanke/dsh-desktop-deepin.git"
GITEE_URL="https://gitee.com/westanke/dsh-desktop-deepin.git"
ATOMGIT_URL="https://atomgit.com/westanke163/dsh-desktop-deepin.git"

say() { printf '%s\n' "$*"; }
ok()  { printf '  ✅ %s\n' "$*"; }
bad() { printf '  ❌ %s\n' "$*"; }

set_remote() {
  local name="$1" url="$2"
  if git remote get-url "$name" >/dev/null 2>&1; then
    local cur; cur="$(git remote get-url "$name")"
    if [ "$cur" = "$url" ]; then
      say "  $name 已就位：$url"
    else
      git remote set-url "$name" "$url" && ok "$name 改为：$url（原：$cur）"
    fi
  else
    git remote add "$name" "$url" && ok "新增 $name：$url"
  fi
}

say "整理三远端命名…"
say ""
set_remote origin  "$GITHUB_URL"
set_remote gitee   "$GITEE_URL"
set_remote atomgit "$ATOMGIT_URL"

# 清理历史遗留的 old-origin（内容已并入 origin）
if git remote get-url old-origin >/dev/null 2>&1; then
  git remote remove old-origin && ok "移除历史遗留 remote：old-origin"
fi

say ""
say "当前远端："
git remote -v | awk '!seen[$1]++ {print "  " $1 "\t" $2}'
say ""
ok "三远端命名已统一（origin=GitHub / gitee=Gitee / atomgit=AtomGit）"

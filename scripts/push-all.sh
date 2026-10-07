#!/usr/bin/env bash
# 一次推送到三个远端：GitHub（origin）+ Gitee（gitee）+ AtomGit（atomgit）。
#
# 为什么分开推而不是给 origin 塞三个 pushurl：GitHub 链路在本机会间歇性
# 超时，若绑在同一个 push 里，GitHub 一卡就把 Gitee、AtomGit 也一起拖死。
# 分开推可以各自独立报告，GitHub 失败不影响国内镜像更新。
#
# 远端约定（见 scripts/setup-remotes.sh）：
#   origin   -> GitHub   github.com/westanke/dsh-desktop-deepin.git
#   gitee    -> Gitee    gitee.com/westanke/dsh-desktop-deepin.git
#   atomgit  -> AtomGit  atomgit.com/westanke163/dsh-desktop-deepin.git
#
# 用法：
#   bash scripts/push-all.sh                      # 推分支到三个远端
#   PUSH_TAGS=1 bash scripts/push-all.sh           # 只推 tag 到三个远端
#   BRANCH=dev bash scripts/push-all.sh            # 换分支（默认 main）
#   FORCE=1 bash scripts/push-all.sh               # 历史分叉时强制覆盖
#
# 关于 FORCE：默认绝不强推。普通 push 失败且检测到历史分叉时，
# 脚本会打印提示；是否强推由你加 FORCE=1 决定。强推走 --force-with-lease，
# 若远端已有他人新提交会被拒绝（比裸 --force 安全）。
# 注意：本仓库 GitHub 端曾因作者名不同（westanke ↔ Wang Ke）导致内容相同
# 但 hash 分叉，这种情况下 FORCE=1 是安全且必要的。
#
# 首次配置远端：bash scripts/setup-remotes.sh
set -uo pipefail

BRANCH="${BRANCH:-main}"
PUSH_TAGS="${PUSH_TAGS:-0}"
FORCE="${FORCE:-0}"

REMOTE_GITHUB="origin"
REMOTE_GITEE="gitee"
REMOTE_ATOMGIT="atomgit"

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ✅ %s\n' "$*"; }
bad()  { printf '  ❌ %s\n' "$*"; }

# ── 远端自检 ────────────────────────────────────────────────────────────
missing=0
for r in "$REMOTE_GITHUB" "$REMOTE_GITEE" "$REMOTE_ATOMGIT"; do
  if ! git remote get-url "$r" >/dev/null 2>&1; then
    bad "尚未配置 $r remote"
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  say ""
  say "先配远端：bash scripts/setup-remotes.sh"
  exit 1
fi

# ── 推送工具函数 ────────────────────────────────────────────────────────
# push_one <remote> <平台标签> <普通失败提示>
# 默认绝不强推；失败且检测到历史分叉时打印明确提示。
push_one() {
  local name="$1" label="$2" hint="$3"
  say "→ $label ($name)"
  if [ "$FORCE" = "1" ]; then
    if git push --force-with-lease "$name" "$BRANCH"; then
      ok "$label 强制推送成功"
    else
      bad "$label 强制推送失败（--force-with-lease 被拒绝：远端可能有他人新提交，先 fetch 核对再决定）"
      fail=1
    fi
  else
    if git push "$name" "$BRANCH"; then
      ok "$label 推送成功"
    else
      bad "$label 推送失败：$hint"
      if ! git merge-base --is-ancestor "$name/$BRANCH" HEAD 2>/dev/null; then
        say "    ⚠️ 检测到历史分叉：$name/$BRANCH 不是本地 $BRANCH 的祖先"
        say "    确认内容一致后可用 FORCE=1 强制覆盖：FORCE=1 bash scripts/push-all.sh"
      fi
      fail=1
    fi
  fi
  say ""
}

# ── tag 模式 ────────────────────────────────────────────────────────────
if [ "$PUSH_TAGS" = "1" ]; then
  say "推送 tag 到三个远端…"
  [ "$FORCE" = "1" ] && say "（FORCE=1：走 --force-with-lease 强制覆盖）"
  say ""
  fail=0
  for pair in "$REMOTE_GITEE:Gitee" "$REMOTE_ATOMGIT:AtomGit" "$REMOTE_GITHUB:GitHub"; do
    r="${pair%%:*}"; label="${pair##*:}"
    say "→ $label ($r)"
    force_args=()
    [ "$FORCE" = "1" ] && force_args=(--force-with-lease)
    if git push "${force_args[@]}" "$r" --tags; then
      ok "$label tag 推送成功"
    else
      bad "$label tag 推送失败"
      fail=1
    fi
    say ""
  done
  if [ "$fail" -eq 0 ]; then
    ok "三端 tag 已同步"
  else
    bad "至少有一个远端 tag 推送失败，见上方明细"
  fi
  exit "$fail"
fi

# ── 分支模式：三个远端各自独立推 ──────────────────────────────────────
say "推送分支 $BRANCH 到三个远端（各自独立，互不影响）…"
[ "$FORCE" = "1" ] && say "（FORCE=1：走 --force-with-lease 强制覆盖）"
say ""

fail=0
push_one "$REMOTE_GITEE"   "Gitee"   "检查网络/令牌权限"
push_one "$REMOTE_ATOMGIT" "AtomGit" "检查凭证是否存入 git credential（PAT 需在 AtomGit 个人设置生成）"
push_one "$REMOTE_GITHUB"  "GitHub"  "本机 GitHub 链路会间歇性超时，可稍后重试"

if [ "$fail" -eq 0 ]; then
  ok "三端都已更新"
else
  bad "至少有一个远端推送失败，见上方明细"
fi
exit "$fail"

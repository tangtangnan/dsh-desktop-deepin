#!/usr/bin/env bash
# 上传 release 资产到 GitHub（v0.2.4 offline deb 等）。
#
# 【授权须知】本脚本读取 ~/.git-credentials 中的 GitHub 令牌并调用
# uploads.github.com 上传附件——属于「使用用户凭据操作远端」，必须获得用户
# 明确授权后才能执行。令牌解析用 URL 构造器（见 pitfall 记忆），全程不打印。
#
# 用法：bash scripts/upload-release-asset.sh [deb路径] [tag]
set -euo pipefail
DEB="${1:-release/DeepSeek-Harness-Desktop-0.2.4-offline-amd64.deb}"
TAG="${2:-v0.2.4}"
REPO="westanke/dsh-desktop-deepin"

[ -f "$DEB" ] || { echo "✖ 找不到 $DEB"; exit 1; }

# 用 URL 构造器严格解析凭据（不要用正则猜——两次翻车教训）
CRED_LINE=""
while IFS= read -r line; do
  case "$line" in *"$REPO"*|*github.com*) CRED_LINE="$line"; break ;; esac
done < ~/.git-credentials
[ -n "$CRED_LINE" ] || { echo "✖ 凭据里没有 github.com 条目"; exit 1; }
TOKEN=$(node -e "const u=new URL(process.argv[1]); console.log(u.password)" "$CRED_LINE")
[ -n "$TOKEN" ] || { echo "✖ 令牌解析为空"; exit 1; }
echo "令牌指纹: len=${#TOKEN} head=${TOKEN:0:3}***"

REL_ID=$(curl -s "https://api.github.com/repos/$REPO/releases/tags/$TAG" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).id||'')}catch(e){console.log('')}})")
[ -n "$REL_ID" ] || { echo "✖ 找不到 release $TAG"; exit 1; }
echo "release id = $REL_ID"

ASSET_NAME=$(basename "$DEB")
SIZE=$(du -h "$DEB" | cut -f1)
echo "上传 $ASSET_NAME（$SIZE，offline 包较大需数分钟）…"
HTTP=$(curl -s -o /tmp/gh-upload-resp.json -w "%{http_code}" -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @"$DEB" \
  "https://uploads.github.com/repos/$REPO/releases/$REL_ID/assets?name=$ASSET_NAME")
if [ "$HTTP" = "201" ]; then
  echo "✅ 上传成功：$ASSET_NAME"
else
  echo "✖ 上传失败 HTTP $HTTP"
  head -c 300 /tmp/gh-upload-resp.json; echo
  exit 1
fi

#!/usr/bin/env bash
# deb 安装后钩子（postinst）。
#
# 职责：装完后立刻跑一次运行时自检，让用户第一时间知道缺什么、怎么补齐。
# 不在这里做自动下载——下载可能耗时几分钟且依赖网络，安装流程不该被它卡住；
# 交给用户手动执行（或首次启动时由 start-shell.sh 自动处理）。
#
# 注意：deb 安装时这个脚本以 root 运行，但它只做「检测 + 提示」，
# 不写任何系统文件、不下载任何东西，因此安全。
set -uo pipefail

INSTALL_DIR="/opt/deepseek-harness-desktop"
BOOTSTRAP="$INSTALL_DIR/tools/bootstrap.sh"

echo ""
echo "DeepSeek Harness Desktop 已安装。"
echo ""

if [ -x "$BOOTSTRAP" ]; then
  echo "正在检查运行时依赖（Electron / Node / dsh）…"
  echo ""
  bash "$BOOTSTRAP" check || {
    echo ""
    echo "════════════════════════════════════════════════════════"
    echo " 提示：检测到缺少运行时依赖。"
    echo "════════════════════════════════════════════════════════"
    echo ""
    echo "  自动下载（国内镜像优先，会自动测速选最快的一个）："
    echo "    bash $BOOTSTRAP install"
    echo ""
    echo "  或者直接启动（首次启动时也会自动补齐）："
    echo "    bash $INSTALL_DIR/start-shell.sh"
    echo ""
  }
else
  echo "⚠ 未找到自检脚本 $BOOTSTRAP，跳过依赖检测。"
fi

# postinst 必须返回 0，否则 dpkg 会认为安装失败。
exit 0

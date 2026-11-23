#!/bin/bash
# 一条命令跑完所有验证。改完词库 / 改完前端，跑这个就够了。
#
#   bash tools/check_all.sh            # 全量检查
#   bash tools/check_all.sh --quick    # 跳过音频体检（只查数据和页面）
#
# 依赖本地服务在跑（双击「启动.bat」，或 KR_NO_BROWSER=1 python serve.py）。
set -u
cd "D:/workbuddy工作台/2026-11-22-20-01-46/krlearn" || exit 1

PY="C:/Users/27028/.workbuddy/binaries/python/versions/3.13.12/python.exe"
NODE="/c/Users/27028/.workbuddy/binaries/node/versions/22.22.2-2/node.exe"
NODE_MODULES="C:/Users/27028/.workbuddy/binaries/node/workspace/node_modules"
BASE="${KR_BASE:-http://127.0.0.1:8765/index.html}"
QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

FAIL=0
line() { printf '\n\033[1m%s\033[0m\n' "$1"; }

line "== 1/3 数据自检（结构 + 音频文件 + 指纹）=="
if "$PY" tools/check_data.py; then :; else FAIL=1; fi

line "== 2/3 视图回归（node + jsdom，不依赖浏览器）=="
# 注意：Windows 版 curl 写 /dev/null 会报 rc=23（Write error），必须让 shell 重定向
if curl -sf --noproxy '*' -m 3 "$BASE" > /dev/null 2>&1; then
  if NODE_PATH="$NODE_MODULES" "$NODE" tools/jsdom_check.js "$BASE"; then :; else FAIL=1; fi
else
  echo "✗ 本地服务没有响应（$BASE）"
  echo "  先双击「启动.bat」，或运行：KR_NO_BROWSER=1 python serve.py"
  FAIL=1
fi

if [ "$QUICK" = "0" ]; then
  line "== 3/3 音频体检（只报告，不修）=="
  # --stale 按 mtime 找「数据改过、音频没跟上」的条目；数量为 0 就是全齐
  if KR_CONC=8 "$PY" tools/audit_audio.py --stale --dry 2>&1 | tail -6; then :; else FAIL=1; fi
fi

echo
if [ "$FAIL" = "0" ]; then
  printf '\033[32mALL CHECKS PASSED\033[0m\n'
else
  printf '\033[31mSOME CHECKS FAILED\033[0m\n'
fi
exit $FAIL

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

# 跑一个 node 检查脚本，只回显最后 N 行，但退出码取脚本本身的。
# 不能写成 `node x.js | tail -9`：管道退出码来自 tail，脚本失败会被吞掉。
run_node() {   # $1=脚本  $2=回显行数
  local out rc
  out=$(NODE_PATH="$NODE_MODULES" "$NODE" "$1" 2>&1); rc=$?
  printf '%s\n' "$out" | tail -n "$2"
  [ "$rc" = "0" ] || FAIL=1
}

line "== 1/6 数据自检（结构 + 音频文件 + 指纹 + 语法）=="
if "$PY" tools/check_data.py; then :; else FAIL=1; fi

SERVED=0
# 注意：Windows 版 curl 写 /dev/null 会报 rc=23（Write error），必须让 shell 重定向
if curl -sf --noproxy '*' -m 3 "$BASE" > /dev/null 2>&1; then SERVED=1; fi

line "== 2/6 视图回归（node + jsdom，不依赖浏览器）=="
if [ "$SERVED" = "1" ]; then
  run_node tools/jsdom_check.js "$BASE" 30
else
  echo "✗ 本地服务没有响应（$BASE）"
  echo "  先双击「启动.bat」，或运行：KR_NO_BROWSER=1 python serve.py"
  FAIL=1
fi

line "== 3/6 语法栏目交互（筛选 / 搜索 / 详情 / 音频 / 返回保持状态）=="
if [ "$SERVED" = "1" ]; then run_node tools/check_grammar.js 14; else echo "跳过（服务未启动）"; FAIL=1; fi

line "== 4/6 赞赏页（收款码缺失时的降级）=="
if [ "$SERVED" = "1" ]; then run_node tools/check_pay.js 12; else echo "跳过（服务未启动）"; FAIL=1; fi

line "== 5/6 朗读兜底（缺音频才念 / 被拦不念 / 关掉不念 / 有音频不念）=="
if [ "$SERVED" = "1" ]; then run_node tools/check_tts.js 26; else echo "跳过（服务未启动）"; FAIL=1; fi

if [ "$QUICK" = "0" ]; then
  line "== 6/6 音频体检（只报告，不修）=="
  # --stale 按 mtime 找「数据改过、音频没跟上」的条目；数量为 0 就是全齐
  out=$(KR_CONC=8 "$PY" tools/audit_audio.py --stale --dry 2>&1); rc=$?
  printf '%s\n' "$out" | tail -6
  [ "$rc" = "0" ] || FAIL=1
fi

echo
if [ "$FAIL" = "0" ]; then
  printf '\033[32mALL CHECKS PASSED\033[0m\n'
else
  printf '\033[31mSOME CHECKS FAILED\033[0m\n'
fi
exit $FAIL

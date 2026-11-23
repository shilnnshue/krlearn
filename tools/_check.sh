#!/bin/bash
# 14 个视图的 JS 报错回归。
#   - 有可用的 CDP 浏览器 → 用真实浏览器跑（能出图，能测交互）
#   - 没有（这台机器 2026-11-23 起 Chrome/Edge 全都起不来）→ 自动降级到 node + jsdom
#
# 一般不用单独跑这个，直接 `bash tools/check_all.sh` 就行。
set -u
cd "D:/workbuddy工作台/2026-11-22-20-01-46/krlearn" || exit 1
export PATH="/c/Users/27028/.workbuddy/binaries/node/versions/22.22.2-2:$PATH"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
BASE="${KR_BASE:-http://127.0.0.1:8765/index.html}"
PORT="${CDP_PORT:-9333}"

# ---- 探测器：浏览器能不能起来 ----
CDP_OK=0
CP=""
if [ -x "$CHROME" ]; then
  env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY \
    "$CHROME" --headless=new --disable-gpu --no-sandbox --remote-debugging-port="$PORT" \
    --user-data-dir="C:/Windows/Temp/cb_krprobe" about:blank > /tmp/cdp_probe.log 2>&1 &
  CP=$!
  for _ in 1 2 3 4 5; do
    sleep 1
    if curl -sf --noproxy '*' -m 2 "http://127.0.0.1:$PORT/json/version" > /dev/null 2>&1; then
      CDP_OK=1
      break
    fi
  done
  if [ "$CDP_OK" = "0" ]; then
    kill $CP 2>/dev/null
    CP=""
    echo "浏览器没起来（CDP $PORT 无响应），降级到 node + jsdom"
  fi
fi

if [ "$CDP_OK" = "0" ]; then
  NODE_PATH="C:/Users/27028/.workbuddy/binaries/node/workspace/node_modules" \
    node tools/jsdom_check.js "$BASE"
  rc=$?
  echo "CHECK DONE (jsdom)"
  exit $rc
fi

# ---- 真实浏览器：带报错捕获逐个视图跑 ----
for v in home alpha dict stats settings list/wrong list/due list/learning note sent deck \
         "entry/w0001" "entry/w0035" "entry/w0004"; do
  printf "%-16s " "$v"
  node tools/shot.js "$BASE" "_shot/chk.png" 430 950 "location.hash='#$v'" 700 2>&1 \
    | grep -E "PAGE_ERRS|ERROR|FAIL" | tr '\n' ' '
  echo
done

[ -n "$CP" ] && kill $CP 2>/dev/null
echo "CHECK DONE (chrome)"

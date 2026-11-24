/* tools/check_layout.js —— 多设备布局 / 触控 / 左右滑动回归
 *
 * 自带无头 Chrome：脚本自己 spawn 浏览器、跑完自己 kill。
 * 不能先单独在 shell 里起 Chrome —— 那条命令一结束子进程就被收走，
 * 下一条命令连调试端口都连不上（日志还是 0 字节）。
 *
 *   node tools/check_layout.js            # 全部视口 + 截图
 *   KR_SHOT=0 node tools/check_layout.js  # 只跑断言不截图
 *
 * 断言：
 *   1. 每个视口 × 每个页面，没有横向溢出（scrollWidth 不超视口）
 *   2. 底部导航只在窄屏出现，且点得到、不压住正文
 *   3. 手指设备下触控目标够大、输入框字号 >= 16（否则 iOS 聚焦会放大页面）
 *   4. 学习页贴合视口，底部作答区不被顶出屏幕
 *   5. 左右滑动真的能翻栏目 / 返回 / 触发学习页动作
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const BASE = process.env.KR_BASE || 'http://127.0.0.1:8765/index.html';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = +(process.env.CDP_PORT || 9337);
const SHOT = process.env.KR_SHOT !== '0';
const OUT = path.resolve(__dirname, '..', 'shots');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const VIEWS = [
  { name: 'iphone-se',      w: 375,  h: 667,  mobile: true,  tab: true,  pic: false },
  { name: 'iphone-14',      w: 390,  h: 844,  mobile: true,  tab: true,  pic: true  },
  { name: 'iphone-promax',  w: 430,  h: 932,  mobile: true,  tab: true,  pic: false },
  { name: 'ipad-portrait',  w: 768,  h: 1024, mobile: true,  tab: true,  pic: true  },
  { name: 'ipad-landscape', w: 1024, h: 768,  mobile: true,  tab: false, pic: true  },
  { name: 'phone-landscape', w: 667, h: 375,  mobile: true,  tab: false, pic: true  },
  { name: 'laptop',         w: 1440, h: 900,  mobile: false, tab: false, pic: true  },
];
const PAGES = ['home', 'alpha', 'dict', 'grammar', 'settings'];

let FAIL = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('  ✓ ' + msg + (extra ? '：' + extra : ''));
  else { console.log('  ✗ ' + msg + (extra ? '：' + extra : '')); FAIL = 1; }
};
const head = t => console.log('\n\033[1m' + t + '\033[0m');

/* ---------- 最小 CDP 客户端 ---------- */
function req(p, method = 'GET') {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method }, resp => {
      let d = ''; resp.on('data', c => d += c); resp.on('end', () => res(d));
    });
    r.on('error', rej);
    r.setTimeout(2000, () => { r.destroy(new Error('timeout')); });
    r.end();
  });
}
async function waitPort(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { await req('/json/version'); return true; } catch (e) { await sleep(250); }
  }
  return false;
}
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(u) {
    const ws = new WebSocket(u);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && c.pending.has(m.id)) {
        const { res, rej } = c.pending.get(m.id);
        c.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    };
    return c;
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

async function ev(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception;
    throw new Error((d && (d.description || d.value)) || JSON.stringify(r.exceptionDetails));
  }
  return r.result.value;
}

/* 设 hash 触发路由；已经是这个 hash 时先去中转一下，否则 hashchange 不会触发 */
async function nav(cdp, hash) {
  await ev(cdp, `(() => {
    if (location.hash === ${JSON.stringify(hash)}) location.hash = '#__nav';
    location.hash = ${JSON.stringify(hash)};
  })()`);
  await sleep(200);
}

async function swipe(cdp, x0, x1, y) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
  const steps = 9;
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{ x: x0 + (x1 - x0) * i / steps, y }]
    });
    await sleep(10);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(430);          // 手势末尾有 120ms 的甩出动画
}

async function shot(cdp, name) {
  if (!SHOT) return;
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
}

(async () => {
  if (!fs.existsSync(CHROME)) {
    console.error('找不到 Chrome：' + CHROME);
    process.exit(1);
  }
  if (SHOT) fs.mkdirSync(OUT, { recursive: true });

  const env = { ...process.env };
  ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY'].forEach(k => delete env[k]);
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + path.join(process.env.TEMP || 'C:/Windows/Temp', 'cb_layout'),
    'about:blank'
  ], { env, stdio: 'ignore' });

  const cleanup = () => {
    try { spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {}
  };
  process.on('exit', cleanup);

  let cdp = null;
  try {
    if (!await waitPort(15000)) throw new Error('Chrome 调试端口没起来');
    const target = JSON.parse(await req('/json/new?about:blank', 'PUT'));
    cdp = await CDP.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // 强制不走缓存：profile 是复用的，查线上地址时会拿到 max-age=600 的旧 CSS，
    // 症状是「文件明明推上去了，断言还在按旧样式失败」。
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

    for (const v of VIEWS) {
      head(`== ${v.name}  ${v.w}×${v.h} ==`);
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: v.w, height: v.h, deviceScaleFactor: 2, mobile: v.mobile
      });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: v.mobile, maxTouchPoints: 5 });
      await cdp.send('Page.navigate', { url: BASE });
      await sleep(1200);
      // 过注册闸门：像老用户一样写一个本机会话（token=local → 不连云端，纯本地跑）
      await ev(cdp, `(() => { try { localStorage.setItem('krlearn.sess', JSON.stringify({ u: 'selftest', token: 'local', created: Date.now() })); } catch (e) {} })()`);
      await cdp.send('Page.reload');
      await sleep(1500);

      const errs = await ev(cdp, 'JSON.stringify(window.__errs || [])');
      ok(errs === '[]', '页面无 JS 错误', errs === '[]' ? '' : errs);

      /* 1. 逐页横向溢出 */
      for (const p of PAGES) {
        await nav(cdp, '#' + p);
        const m = await ev(cdp, `(() => {
          const de = document.documentElement, sh = document.getElementById('shell');
          return { over: de.scrollWidth - innerWidth, shell: Math.round(sh.getBoundingClientRect().width) };
        })()`);
        ok(m.over <= 1, `${p} 无横向溢出`, `溢出 ${m.over}px，正文栏 ${m.shell}px`);
      }

      /* 2. 底部导航 */
      const tb = await ev(cdp, `(() => {
        const b = document.getElementById('tabbar');
        const item = b.querySelector('.tb-item');
        return {
          display: getComputedStyle(b).display,
          h: Math.round(b.getBoundingClientRect().height),
          itemH: Math.round(item.getBoundingClientRect().height)
        };
      })()`);
      ok(v.tab ? tb.display === 'flex' : tb.display === 'none',
         '底部导航' + (v.tab ? '出现' : '隐藏'), tb.display);

      if (v.tab) {
        ok(tb.itemH >= 44, '底栏按钮高度够手指点', tb.itemH + 'px');
        await nav(cdp, '#settings');
        const gap = await ev(cdp, `(() => {
          window.scrollTo(0, document.body.scrollHeight);
          const bar = document.getElementById('tabbar').getBoundingClientRect();
          const last = document.getElementById('shell').lastElementChild.getBoundingClientRect().bottom;
          const g = Math.round(bar.top - last);
          window.scrollTo(0, 0);
          return g;
        })()`);
        ok(gap >= -2, '滚到底时正文不被底栏压住', `间距 ${gap}px`);
      }

      /* 3. 触控目标 / 输入框字号 */
      if (v.mobile) {
        const s = await ev(cdp, `(() => {
          const b = document.querySelector('#topbar .tb-btn:not(.hidden)');
          return {
            topBtn: b ? Math.round(b.getBoundingClientRect().width) : 0,
            coarse: matchMedia('(pointer: coarse)').matches
          };
        })()`);
        ok(s.coarse, '识别为手指设备（pointer: coarse）');
        ok(s.topBtn >= 40, '顶栏按钮点击区域够大', s.topBtn + 'px');

        await nav(cdp, '#grammar');
        const f1 = await ev(cdp, `(() => { const e = document.getElementById('g-search'); return e ? parseFloat(getComputedStyle(e).fontSize) : 0; })()`);
        ok(f1 >= 16, '语法搜索框字号 >= 16（防 iOS 聚焦放大）', f1 + 'px');

        await nav(cdp, '#dict');
        const f2 = await ev(cdp, `(() => { const e = document.querySelector('.search-bar input'); return e ? parseFloat(getComputedStyle(e).fontSize) : 0; })()`);
        ok(f2 >= 16, '词典搜索框字号 >= 16', f2 + 'px');
      }

      /* 4. 学习页贴合视口（用纯背模式，首屏就是卡片正面） */
      await nav(cdp, '#home');
      await ev(cdp, `(() => { const b = document.querySelector('[data-act="pure"]'); if (b) b.click(); })()`);
      await sleep(340);
      const st = await ev(cdp, `(() => {
        const w = document.getElementById('study-wrap');
        if (getComputedStyle(w).display === 'none') return null;
        const area = w.querySelector('.study-actions') || w.querySelector('.opts');
        return {
          h: Math.round(w.getBoundingClientRect().height), vh: innerHeight,
          btnBottom: area ? Math.round(area.getBoundingClientRect().bottom) : null,
          front: !!w.querySelector('.flashcard[data-flip="1"]')
        };
      })()`);
      if (st) {
        ok(Math.abs(st.h - st.vh) <= 1, '学习页铺满视口', `高 ${st.h} / 视口 ${st.vh}`);
        ok(st.btnBottom === null || st.btnBottom <= st.vh + 1, '作答区没被顶出屏幕', st.btnBottom + 'px');
        if (st.front) {
          await shot(cdp, 'resp-' + v.name + '-study');
          if (v.mobile) {
            await swipe(cdp, v.w * 0.28, v.w * 0.8, Math.round(v.h * 0.42));
            const hasMean = await ev(cdp, `!!document.querySelector('#study-wrap .meaning')`);
            ok(hasMean, '卡片正面右滑 → 翻到释义', hasMean ? '' : '没翻面');
          }
        } else if (v.mobile) {
          const locked = await ev(cdp, `document.querySelectorAll('#study-wrap .opt.locked').length`);
          ok(locked === 0, '进答题页时没有误选', locked + ' 个被选中');
        }
        await ev(cdp, `(() => { const b = document.querySelector('#study-wrap [data-ses="close"]'); if (b) b.click(); })()`);
        await sleep(240);
      } else {
        ok(false, '学习页能打开', '纯背模式没启动（词本可能为空）');
      }

      /* 4b. 答题页左右滑动换题：左滑跳过 / 右滑回看已答的题 */
      if (v.mobile) {
        await nav(cdp, '#home');
        await ev(cdp, `(() => { const b = document.querySelector('[data-act="test"]'); if (b) b.click(); })()`);
        await sleep(320);
        const q1 = await ev(cdp, `(() => {
          const w = document.getElementById('study-wrap');
          if (getComputedStyle(w).display === 'none') return null;
          const c = w.querySelector('.study-top > div:last-child');
          return {
            idx: c ? c.textContent.trim() : '',
            opts: w.querySelectorAll('.opt').length,
            skip: !!w.querySelector('.quiz-skip')
          };
        })()`);
        if (q1 && q1.opts > 0) {
          const Y = Math.round(v.h * 0.4);
          ok(q1.skip, '答题页有「跳过」入口（桌面上也能用）', q1.skip ? '' : '没找到 .quiz-skip');
          await shot(cdp, 'resp-' + v.name + '-quiz');

          await swipe(cdp, v.w * 0.78, v.w * 0.22, Y);          // 左滑（从右往左）→ 下一题
          const q2 = await ev(cdp, `(() => {
            const w = document.getElementById('study-wrap');
            const c = w.querySelector('.study-top > div:last-child');
            return { idx: c ? c.textContent.trim() : '', locked: w.querySelectorAll('.opt.locked').length };
          })()`);
          ok(q2.idx !== q1.idx && q2.locked === 0, '答题页左滑 → 换下一题，且没有误选',
            q1.idx + ' → ' + q2.idx);

          await swipe(cdp, v.w * 0.24, v.w * 0.78, Y);          // 右滑（从左往右）→ 回上一题
          const q3 = await ev(cdp, `(document.querySelector('#study-wrap .study-top > div:last-child') || {}).textContent.trim()`);
          ok(q3 === q1.idx, '答题页右滑 → 回上一题', q3);

          // 答掉当前题，再滑走、滑回：应该看到只读回顾，选项不能再点
          await ev(cdp, `(() => { const o = document.querySelector('#study-wrap .opt'); if (o) o.click(); })()`);
          await sleep(220);
          await swipe(cdp, v.w * 0.78, v.w * 0.22, Y);
          await swipe(cdp, v.w * 0.24, v.w * 0.78, Y);
          const rv = await ev(cdp, `(() => {
            const w = document.getElementById('study-wrap');
            return { review: !!w.querySelector('.feedback .fb-line'), opts: w.querySelectorAll('.opt').length,
                     tag: (w.querySelector('.q-tag') || {}).textContent || '' };
          })()`);
          await shot(cdp, 'resp-' + v.name + '-quiz-review');
          ok(rv.review && rv.opts === 0, '回看已答的题是只读回顾（不能重复作答）',
            rv.review ? rv.tag.trim() : '没出现回顾卡');
        } else {
          console.log('  · 这轮抽到连连看或没有进答题页，跳过答题页滑动断言');
        }
        await ev(cdp, `(() => { const b = document.querySelector('#study-wrap [data-ses="close"]'); if (b) b.click(); })()`);
        await sleep(240);
      }

      /* 5. 左右滑动 */
      if (v.mobile) {
        await nav(cdp, '#home');
        await swipe(cdp, v.w * 0.72, v.w * 0.2, Math.round(v.h * 0.45));
        let h = await ev(cdp, 'location.hash');
        ok(h === '#alpha', '左滑 → 下一个栏目', h);

        await swipe(cdp, v.w * 0.28, v.w * 0.8, Math.round(v.h * 0.45));
        h = await ev(cdp, 'location.hash');
        ok(h === '#home', '右滑 → 回到上一个栏目', h);

        await nav(cdp, '#grammar');
        const gid = await ev(cdp, `(() => { const g = document.querySelector('.g-item'); return g ? g.dataset.go : ''; })()`);
        if (gid) {
          await nav(cdp, '#' + gid);
          await swipe(cdp, v.w * 0.28, v.w * 0.8, Math.round(v.h * 0.45));
          h = await ev(cdp, 'location.hash');
          ok(h === '#grammar', '详情页右滑 → 回列表', h);
        } else {
          ok(false, '详情页右滑 → 回列表', '没找到语法条目');
        }

        /* 横滑不能被列表内的横滚吃掉：从筛选条本体上滑，应该只滚筛选条、不翻栏目 */
        await nav(cdp, '#grammar');
        const fr = await ev(cdp, `(() => {
          const f = document.querySelector('.g-filters');
          if (!f) return null;
          const r = f.getBoundingClientRect();
          return { l: Math.round(r.left), w: Math.round(r.width), y: Math.round(r.top + r.height / 2) };
        })()`);
        if (fr) {
          const before = await ev(cdp, `document.querySelector('.g-filters').scrollLeft`);
          await swipe(cdp, fr.l + fr.w * 0.78, fr.l + fr.w * 0.22, fr.y);
          const h2 = await ev(cdp, 'location.hash');
          const after = await ev(cdp, `document.querySelector('.g-filters').scrollLeft`);
          ok(h2 === '#grammar', '筛选条上的横滑不会误翻栏目', h2);
          if (fr.w < 200) console.log('  · 筛选条在窄屏下可滚动，横向滑动交给了它自己（' + before + ' → ' + after + '）');
        } else {
          ok(false, '筛选条上的横滑不会误翻栏目', '没找到筛选条');
        }
      }

      /* 截图 */
      if (v.pic) {
        for (const p of ['home', 'alpha', 'grammar', 'settings']) {
          await nav(cdp, '#' + p);
          await shot(cdp, 'resp-' + v.name + '-' + p);
        }
      }
      await nav(cdp, '#home');
    }

    cdp.close();
  } catch (e) {
    console.error('FAILED:', e.message);
    if (cdp) { try { cdp.close(); } catch (_) {} }
    FAIL = 1;
  } finally {
    cleanup();
  }

  console.log('');
  if (FAIL) { console.log('\033[31mLAYOUT CHECKS FAILED\033[0m'); process.exitCode = 1; }
  else console.log('\033[32mLAYOUT CHECKS PASSED\033[0m');
})();

/* tools/check_account.js —— 注册闸门 / 云同步 / 人数统计 的端到端回归
 *
 * 自己起三样东西：本地静态服务（外部已有）+ 假后端 mock_cloud.py + 无头 Chrome。
 * 假后端的接口形状和 server/worker.js 一致，所以这里过了，前端换真 Worker 只改一个地址。
 *
 *   node tools/check_account.js
 *   KR_BASE=https://shilnnshue.github.io/krlearn/index.html node tools/check_account.js   # 只测闸门，不测云端（线上没有 mock）
 *
 * 断言：
 *   1. 没有会话时，闸门挡住整页，App 不启动
 *   2. 注册成功 → 给出账号密码 → 「我保存好了」之后才进得去
 *   3. 进度按账号分仓（krlearn.v1.<用户名>），老键不动
 *   4. 存档推到云端；人数统计能读到 1
 *   5. 刷新后不用重新注册
 *   6. 密码错了不让进；密码对了能进
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const BASE = process.env.KR_BASE || 'http://127.0.0.1:8765/index.html';
const ONLINE = /^https?:/.test(BASE) && !/127\.0\.0\.1|localhost/.test(BASE);
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = +(process.env.CDP_PORT || 9341);
const MOCK_PORT = +(process.env.MOCK_PORT || 8790);
const MOCK = 'http://127.0.0.1:' + MOCK_PORT;
const PY = process.env.KR_PY || (fs.existsSync('C:/Users/27028/.workbuddy/binaries/python/versions/3.13.12/python.exe')
  ? 'C:/Users/27028/.workbuddy/binaries/python/versions/3.13.12/python.exe' : 'python');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAIL = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('  ✓ ' + msg + (extra ? '：' + extra : ''));
  else { console.log('  ✗ ' + msg + (extra ? '：' + extra : '')); FAIL = 1; }
};
const head = t => console.log('\n\033[1m' + t + '\033[0m');

/* ---------- CDP ---------- */
function req(p, method = 'GET') {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method }, resp => {
      let d = ''; resp.on('data', c => d += c); resp.on('end', () => res(d));
    });
    r.on('error', rej);
    r.setTimeout(1500, () => r.destroy(new Error('timeout')));
    r.end();
  });
}
async function waitPort(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { await req('/json/version'); return true; } catch (e) { await sleep(200); }
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
async function waitUntil(cdp, expr, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 8000)) {
    try { if (await ev(cdp, expr)) return true; } catch (e) {}
    await sleep(150);
  }
  return false;
}

const SHOT = process.env.KR_SHOT !== '0';
const OUT = path.resolve(__dirname, '..', 'shots');
async function shot(cdp, name) {
  if (!SHOT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
}
const getJson = async url => {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    return await r.json();
  } catch (e) { return null; }
};

(async () => {
  if (!fs.existsSync(CHROME)) { console.error('找不到 Chrome：' + CHROME); process.exit(1); }

  let mock = null;
  if (!ONLINE) {
    const env = { ...process.env };
    ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY'].forEach(k => delete env[k]);
    mock = spawn(PY, [path.join(__dirname, 'mock_cloud.py'), String(MOCK_PORT)], { env, stdio: 'ignore' });
    for (let i = 0; i < 40; i++) {
      const j = await getJson(MOCK + '/health');
      if (j && j.ok) break;
      await sleep(150);
    }
  }

  const env = { ...process.env };
  ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY'].forEach(k => delete env[k]);
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + path.join(process.env.TEMP || 'C:/Windows/Temp', 'cb_acct'),
    'about:blank'
  ], { env, stdio: 'ignore' });

  const cleanup = () => {
    try { spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {}
    if (mock) { try { mock.kill(); } catch (e) {} }
  };
  process.on('exit', cleanup);

  let cdp = null;
  try {
    if (!await waitPort(15000)) throw new Error('Chrome 调试端口没起来');
    const target = JSON.parse(await req('/json/new?about:blank', 'PUT'));
    cdp = await CDP.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

    const fresh = async (cloud) => {
      await cdp.send('Page.navigate', { url: BASE });
      await sleep(900);
      await ev(cdp, `(() => {
        localStorage.clear();
        ${cloud ? `localStorage.setItem('krlearn.cloud', ${JSON.stringify(cloud)});` : ''}
      })()`);
      await cdp.send('Page.reload');
      await waitUntil(cdp, `!!document.getElementById('gate') || !!document.querySelector('.hero')`, 12000);
    };

    /* 1. 闸门挡住整页 */
    head('== 1. 没有账号时，闸门挡住整页 ==');
    await fresh(ONLINE ? '' : MOCK);
    const g1 = await ev(cdp, `(() => {
      const g = document.getElementById('gate');
      return { has: !!g, view: (document.getElementById('view') || {}).innerHTML || '',
               cards: g ? g.querySelectorAll('.gate-card').length : 0,
               cloud: g ? (g.querySelector('.gate-cloud') || {}).className || '' : '',
               user: (document.getElementById('f-u') || {}).value || '' };
    })()`);
    ok(g1.has, '闸门出现');
    ok(!g1.view.trim(), 'App 没启动（#view 是空的）', g1.view ? '居然渲染了 ' + g1.view.length + ' 字' : '');
    ok(g1.cards === 1, '闸门里只有一张卡', g1.cards + ' 张');
    ok(ONLINE ? /off/.test(g1.cloud) : /on/.test(g1.cloud),
       ONLINE ? '线上没配云端 → 如实标「本地模式」' : '云端已连接时有绿色提示', g1.cloud);
    ok(/^kr-[a-z0-9]{6}$/.test(g1.user), '预填了随机用户名', g1.user);
    await shot(cdp, 'acct-gate');

    /* 2. 注册 */
    head('== 2. 注册 → 给账号密码 → 才能进 ==');
    const pw = await ev(cdp, `(document.getElementById('f-p') || {}).value || ''`);
    ok(pw.length >= 6, '预填了随机密码', pw.length + ' 位');
    await ev(cdp, `(() => { document.querySelector('#gate [data-g="go"]').click(); })()`);
    await waitUntil(cdp, `!!document.getElementById('g-u') || !!document.querySelector('.gate-err')`, 10000);
    const d1 = await ev(cdp, `(() => {
      const g = document.getElementById('gate');
      return { h: (g.querySelector('.gate-h') || {}).textContent || '',
               u: (document.querySelector('#g-u') || {}).textContent || '',
               p: (document.querySelector('#g-p') || {}).textContent || '',
               warn: !!g.querySelector('.gate-warn'),
               enter: !!g.querySelector('[data-g="enter"]') };
    })()`);
    const USER = d1.u;
    ok(/账号已创建/.test(d1.h), '注册成功，进入「保存账号」这一步', d1.h);
    ok(/^kr-[a-z0-9]{6}$/.test(USER), '账号卡上有用户名', USER);
    ok(d1.p === pw, '账号卡上的密码和预填的一致', d1.p);
    ok(d1.warn && d1.enter, '有「密码丢了找不回」的提醒 + 进入按钮');
    await shot(cdp, 'acct-done');

    // 这时还不能进 —— 必须先点「我保存好了」
    const still = await ev(cdp, `!!document.getElementById('gate')`);
    ok(still, '没点确认之前，闸门还在');

    await ev(cdp, `(() => { document.querySelector('#gate [data-g="enter"]').click(); })()`);
    await waitUntil(cdp, `!!document.querySelector('.hero')`, 12000);
    const inApp = await ev(cdp, `(() => ({
      gate: !!document.getElementById('gate'),
      hero: !!document.querySelector('.hero')
    }))()`);
    ok(!inApp.gate, '点「我保存好了」后闸门移除');
    ok(inApp.hero, 'App 真的启动了（首页 hero 在）');

    // 进设置页动一下开关，触发 save()：这时才真正写出这个账号的存档
    await ev(cdp, `location.hash = '#settings'`);
    await sleep(600);
    await shot(cdp, 'acct-settings');
    await ev(cdp, `(() => { const b = document.querySelector('[data-tg="autoWord"]'); if (b) b.click(); })()`);
    await sleep(600);
    const keyOk = await ev(cdp, `!!localStorage.getItem('krlearn.v1.' + ${JSON.stringify(USER)})`);
    ok(keyOk, '进度按账号分仓（krlearn.v1.<用户名>）', USER);
    const noOld = await ev(cdp, `!localStorage.getItem('krlearn.v1')`);
    ok(noOld, '老的无账号键没被复用（否则两个账号会互相覆盖）');

    /* 3. 同步到云端 + 人数统计 */
    if (!ONLINE) {
      head('== 3. 存档推到云端 · 注册人数能统计 ==');
      // 上面已经 save 过一次，这里直接手动推（不等 2.5 秒节流）
      const sy = await ev(cdp, `(async () => {
        const j = await KR.syncNow();
        return { ok: !!(j && j.ok), err: (j && j.err) || '' };
      })()`);
      ok(sy.ok, '同步成功', sy.err || 'rev 已推进');
      const cloudUsers = await getJson(MOCK + '/api/users');
      const rec = cloudUsers && cloudUsers.users && cloudUsers.users[USER];
      ok(!!rec, '云端有这个账号了', USER);
      ok(!!(rec && rec.hasDb), '云端收到了进度（不是空账号）');
      const st = await getJson(MOCK + '/api/stats');
      ok(st && st.users >= 1, '人数统计接口读得到', st ? st.users + ' 人 / 7 日活跃 ' + st.active7d : '');
      const inSettings = await ev(cdp, `(async () => {
        location.hash = '#settings';
        await new Promise(r => setTimeout(r, 500));
        const j = await KR.stats();
        location.hash = '#home';
        return j ? j.users : -1;
      })()`);
      ok(inSettings >= 1, '设置页拿得到注册人数', String(inSettings));
    } else {
      head('== 3. 线上：跳过云端断言（这里没有假后端）==');
    }

    /* 4. 刷新免注册 */
    head('== 4. 刷新 / 重进不用再注册 ==');
    await cdp.send('Page.reload');
    await waitUntil(cdp, `!document.getElementById('gate') && (document.getElementById('view') || {}).innerHTML.length > 200`, 12000);
    const again = await ev(cdp, `(() => ({
      gate: !!document.getElementById('gate'),
      view: ((document.getElementById('view') || {}).innerHTML || '').length,
      sess: !!localStorage.getItem('krlearn.sess'), url: location.href,
      errs: (window.__errs || []).join('|')
    }))()`);
    ok(!again.gate && again.view > 200, '刷新后直接进 App', '会话还在，页面渲染了 ' + again.view + ' 字');

    /* 5. 退出 → 密码错 → 密码对 */
    head('== 5. 退出后：密码错进不去，密码对能进 ==');
    await ev(cdp, `localStorage.removeItem('krlearn.sess')`);
    await cdp.send('Page.reload');
    await waitUntil(cdp, `!!document.getElementById('gate')`, 12000);
    await ev(cdp, `(() => { document.querySelector('#gate [data-g="tab"][data-v="login"]').click(); })()`);
    await sleep(200);
    await ev(cdp, `(() => {
      document.getElementById('f-u').value = ${JSON.stringify(USER)};
      document.getElementById('f-p').value = 'wrongpass';
      document.querySelector('#gate [data-g="go"]').click();
    })()`);
    await waitUntil(cdp, `!!document.querySelector('.gate-err')`, 10000);
    const bad = await ev(cdp, `(() => ({
      gate: !!document.getElementById('gate'),
      err: (document.querySelector('.gate-err') || {}).textContent || ''
    }))()`);
    ok(bad.gate && bad.err, '密码错了不让进，并给出原因', bad.err);

    await ev(cdp, `(() => {
      document.getElementById('f-p').value = ${JSON.stringify(pw)};
      document.querySelector('#gate [data-g="go"]').click();
    })()`);
    await waitUntil(cdp, `!document.getElementById('gate') && (document.getElementById('view') || {}).innerHTML.length > 200`, 12000);
    const good = await ev(cdp, `(() => ({
      gate: !!document.getElementById('gate'),
      view: ((document.getElementById('view') || {}).innerHTML || '').length
    }))()`);
    ok(!good.gate && good.view > 200, '密码对了进得去', '渲染了 ' + good.view + ' 字');

    /* 6. 存档跟着账号走 */
    head('== 6. 同一个账号重新登录，进度还在 ==');
    const prog = await ev(cdp, `(() => {
      const raw = localStorage.getItem('krlearn.v1.' + ${JSON.stringify(USER)});
      if (!raw) return null;
      const o = JSON.parse(raw);
      return { auto: o.settings && o.settings.autoWord, at: (o.meta && o.meta.updatedAt) || 0 };
    })()`);
    ok(prog && prog.auto === true, '重新登录后看到的还是自己的设置', prog ? String(prog.auto) : '读不到');

    /* 7. 纯本地模式（没配云端地址时线上就是这个形态） */
    head('== 7. 没配云端地址：本地注册也能进，且如实标「本地模式」==');
    await fresh('');
    await waitUntil(cdp, `!!document.getElementById('gate')`, 12000);
    const g7 = await ev(cdp, `(() => {
      const g = document.getElementById('gate');
      if (!g) return { cls: '', txt: '' };
      return { cls: (g.querySelector('.gate-cloud') || {}).className || '',
               txt: (g.querySelector('.gate-cloud') || {}).textContent || '' };
    })()`);
    ok(/off/.test(g7.cls) && /本地模式/.test(g7.txt), '闸门写明「本地模式」', g7.txt.trim());
    await ev(cdp, `(() => { document.querySelector('#gate [data-g="go"]').click(); })()`);
    await waitUntil(cdp, `!!document.getElementById('g-u') || !!document.querySelector('.gate-err')`, 10000);
    const d7 = await ev(cdp, `((document.querySelector('.gate-h') || {}).textContent || '')`);
    ok(/账号已创建/.test(d7), '本地模式也能注册', d7);
    await ev(cdp, `(() => { document.querySelector('#gate [data-g="enter"]').click(); })()`);
    await waitUntil(cdp, `!document.getElementById('gate') && (document.getElementById('view') || {}).innerHTML.length > 200`, 12000);
    const in7 = await ev(cdp, `(() => ({ gate: !!document.getElementById('gate'),
      view: ((document.getElementById('view') || {}).innerHTML || '').length }))()`);
    ok(!in7.gate && in7.view > 200, '本地账号进得去 App', '渲染了 ' + in7.view + ' 字');
    const local = await ev(cdp, `(KR.info().localToken === true)`);
    ok(local, '会话标记为本地（token=local，不会往云端推）');

    /* 8. 老存档迁移：无账号时代的进度，注册后要原样搬进新账号 */
    head('== 8. 老的无账号存档，注册后自动搬进新账号 ==');
    await fresh('');
    await waitUntil(cdp, `!!document.getElementById('gate')`, 12000);
    // 造一份「没用过账号系统」的存档
    await ev(cdp, `localStorage.setItem('krlearn.v1', JSON.stringify({
      progress: { '__probe': { state: 2, reps: 3, wrong: 1 } },
      settings: { autoWord: true },
      meta: { updatedAt: 111 }
    }))`);
    await cdp.send('Page.reload');
    await waitUntil(cdp, `!!document.getElementById('gate')`, 12000);
    await ev(cdp, `(() => { document.querySelector('#gate [data-g="go"]').click(); })()`);
    await waitUntil(cdp, `!!document.getElementById('g-u')`, 12000);
    const legacyUser = await ev(cdp, `((document.querySelector('#g-u') || {}).textContent || '')`);
    await ev(cdp, `(() => { document.querySelector('#gate [data-g="enter"]').click(); })()`);
    await waitUntil(cdp, `!document.getElementById('gate') && (document.getElementById('view') || {}).innerHTML.length > 200`, 12000);
    const mig = await ev(cdp, `(() => {
      const u = ${JSON.stringify(legacyUser)};
      const cur = localStorage.getItem('krlearn.v1.' + u);
      if (!cur) return { ok: false };
      const o = JSON.parse(cur);
      return {
        ok: true,
        probe: o.progress && o.progress.__probe ? o.progress.__probe.reps : 0,
        keep: !!localStorage.getItem('krlearn.v1.migrated'),
        gone: !localStorage.getItem('krlearn.v1')
      };
    })()`);
    ok(mig.ok && mig.probe === 3, '进度搬到了新账号底下', mig.ok ? 'reps=' + mig.probe : '新账号没有存档');
    ok(mig.keep, '原件留了一份 .migrated 备份');
    ok(mig.gone, '老键已清掉，避免两个账号抢同一份数据');

    /* 9. 本地账号 → 云端（先上线、后部署 Worker 的那条路） */
    if (!ONLINE) {
      head('== 9. 本地账号可以连接到云端，进度一起带上去 ==');
      await fresh('');
      await waitUntil(cdp, `!!document.getElementById('gate')`, 12000);
      await ev(cdp, `(() => { document.querySelector('#gate [data-g="go"]').click(); })()`);
      await waitUntil(cdp, `!!document.getElementById('g-u')`, 12000);
      const upUser = await ev(cdp, `((document.querySelector('#g-u') || {}).textContent || '')`);
      await ev(cdp, `(() => { document.querySelector('#gate [data-g="enter"]').click(); })()`);
      await waitUntil(cdp, `!document.getElementById('gate') && (document.getElementById('view') || {}).innerHTML.length > 200`, 12000);

      // 造点进度，再「上线云端」
      await ev(cdp, `location.hash = '#settings'`);
      await sleep(500);
      await ev(cdp, `(() => { const b = document.querySelector('[data-tg="autoWord"]'); if (b) b.click(); })()`);
      await sleep(400);
      await ev(cdp, `localStorage.setItem('krlearn.cloud', ${JSON.stringify(MOCK)})`);
      await cdp.send('Page.reload');
      await waitUntil(cdp, `!document.getElementById('gate') && (document.getElementById('view') || []).length !== 0`, 12000);
      await sleep(600);
      const beforeUp = await ev(cdp, `(() => ({
        gate: !!document.getElementById('gate'),
        row: !!document.querySelector('[data-act="upgrade"]'),
        local: KR.info().localToken
      }))()`);
      ok(!beforeUp.gate && beforeUp.local, '配好云端后，本地会话不会被踢出去重注册');
      ok(beforeUp.row, '设置页出现「连接到云端」');

      // prompt 会被弹出来，先把它顶掉
      await ev(cdp, `window.prompt = () => 'pa55word'`);
      await ev(cdp, `(() => { document.querySelector('[data-act="upgrade"]').click(); })()`);
      await waitUntil(cdp, `(() => { try { return KR.info().synced === true; } catch (e) { return false; } })()`, 15000);
      await sleep(800);
      const afterUp = await ev(cdp, `(KR.info().synced === true)`);
      ok(afterUp, '本机身份换成了云端 token');
      const upUsers = await getJson(MOCK + '/api/users');
      const ur = upUsers && upUsers.users && upUsers.users[upUser];
      ok(!!ur, '云端建了同名账号', upUser);
      ok(!!(ur && ur.hasDb), '进度一起传上去了');
      const st9 = await ev(cdp, `(async () => { const j = await KR.stats(); return j ? j.users : -1; })()`);
      ok(st9 >= 1, '换成云端后统计读得到', String(st9));
    }
  } catch (e) {
    console.log('  ✗ 脚本异常：' + (e && e.message || e));
    FAIL = 1;
  } finally {
    if (cdp) cdp.close();
    cleanup();
  }

  console.log(FAIL ? '\nACCOUNT CHECKS FAILED' : '\nACCOUNT CHECKS PASSED');
  process.exit(FAIL);
})();

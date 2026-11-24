/* 한글·学 —— 账号 · 云同步
 *
 * 设计取向
 *   1. 必须注册才能进：这是 App 的第一屏，没有「以后再说」。
 *   2. 不验证邮箱：用户名 + 密码，密码随机预填，用户自己截图保存；丢了找不回。
 *   3. 密码不落地：云端注册/登录由 Worker 做 PBKDF2，只回一个签名 token；
 *      本地模式存 PBKDF2 哈希。两种模式本地都不存明文密码。
 *   4. 进度按账号分仓：localStorage 键 = krlearn.v1.<用户名>。
 *      老的无账号存档（krlearn.v1）会在第一次注册时搬过去，不删原件。
 *   5. 云端可选：CFG.cloud 为空 = 纯本地。界面上如实写「未连接云端」，
 *      不假装在同步 —— 人数统计也就统计不到，这点必须让用户看见。
 *
 * 对外接口（app.js 用）
 *   KR.ready(fn)        有会话就直接 fn()，没有就先弹注册/登录，过了再 fn()
 *   KR.dbKey()          当前账号的存储键
 *   KR.onSave(db)       每次存档后调，节流推云端
 *   KR.info()           设置页展示用
 *   KR.stats()          注册人数（云端才有）
 *   KR.syncNow() / KR.logout()
 */
(function () {
'use strict';

/* ==================== 配置 ==================== */
/* 部署 server/worker.js 之后，把地址填这里（结尾不要斜杠）：
 *   const CLOUD_DEFAULT = 'https://krlearn-api.askdiandian.com';
 * 留空 = 纯本地模式。调试时也可以在控制台跑 KR.setCloud('http://127.0.0.1:8790')。 */
const CLOUD_DEFAULT = '';

const K_SESS = 'krlearn.sess';       // { u, token, created }
const K_ACC = 'krlearn.acc';         // 本地模式的账号表 { u: {h,s,iter,created} }
const K_OLD = 'krlearn.v1';          // 老的无账号存档
const K_CLOUD = 'krlearn.cloud';     // 覆盖云端地址（调试 / 换后端用，不进版本库）
const DB_PREFIX = 'krlearn.v1.';

let cloud = '';
try { cloud = localStorage.getItem(K_CLOUD) || CLOUD_DEFAULT; } catch (e) { cloud = CLOUD_DEFAULT; }

/* ==================== 小工具 ==================== */
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };
const lsDel = k => { try { localStorage.removeItem(k); } catch (e) {} };
const $ = s => document.querySelector(s);

const buf2hex = buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
const hex2buf = h => new Uint8Array((h.match(/../g) || []).map(x => parseInt(x, 16)));
const randHex = n => buf2hex(crypto.getRandomValues(new Uint8Array(n)));
const escq = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const NAME_RE = /^[a-z0-9_-]{3,20}$/;

/* 随机账号：去掉 l / o / 0 / 1，读给别人听也不容易错 */
const B36 = 'abcdefghijkmnpqrstuvwxyz23456789';
function rndName() {
  let s = 'kr-';
  for (let i = 0; i < 6; i++) s += B36[Math.floor(Math.random() * B36.length)];
  return s;
}
function rndPass() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

async function pbkdf2(pw, saltHex, iter) {
  if (!(window.crypto && crypto.subtle)) throw new Error('nossl');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hex2buf(saltHex), iterations: iter, hash: 'SHA-256' }, key, 256);
  return buf2hex(bits);
}

async function api(path, body, token) {
  const r = await fetch(cloud + path, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' },
      token ? { Authorization: 'Bearer ' + token } : {}),
    body: JSON.stringify(body || {})
  });
  let j = null;
  try { j = await r.json(); } catch (e) { j = { ok: false, err: 'badresp' }; }
  if (j && j.ok === undefined) j.ok = r.ok;
  if (!r.ok && !j.err) j.err = 'http' + r.status;
  return j;
}

/* ==================== 会话 ==================== */
let sess = lsGet(K_SESS, null);
if (sess && (!sess.u || !sess.token)) sess = null;

function setSession(s) { sess = s; lsSet(K_SESS, s); }
function clearSession() { sess = null; lsDel(K_SESS); }

/* ==================== 存档键 ==================== */
function dbKey(u) { return DB_PREFIX + (u || (sess && sess.u) || ''); }

/* 老存档搬一次：只搬一次，原件保留（改名为 .migrated，出问题还能回头捞） */
function migrateOld(u) {
  const old = lsGet(K_OLD, null);
  if (!old) return false;
  const key = DB_PREFIX + u;
  if (lsGet(key, null)) return false;
  lsSet(key, old);
  lsSet(K_OLD + '.migrated', old);
  lsDel(K_OLD);
  return true;
}

/* 服务端更新的存档直接覆盖本机（只在登录 / 启动时做，不中途抢数据） */
function adopt(u, db) {
  if (!db || typeof db !== 'object' || !db.progress) return false;
  const key = DB_PREFIX + u;
  const cur = lsGet(key, null);
  const a = (db.meta && db.meta.updatedAt) || 0;
  const b = (cur && cur.meta && cur.meta.updatedAt) || 0;
  if (cur && b >= a) return false;
  lsSet(key, db);
  return true;
}

/* ==================== 注册 / 登录 ==================== */
async function register(name, pass) {
  name = String(name || '').trim().toLowerCase();
  if (!NAME_RE.test(name)) return { err: '用户名 3–20 位，只能用小写字母、数字、- 和 _' };
  if (String(pass).length < 6) return { err: '密码至少 6 位' };

  if (!cloud) {
    const acc = lsGet(K_ACC, {});
    if (acc[name]) return { err: '本机已经有这个用户名了，直接登录就行' };
    const salt = randHex(16);
    let h;
    try { h = await pbkdf2(pass, salt, 120000); }
    catch (e) { return { err: '当前环境不支持加密（要 https 或 localhost 才行）' }; }
    acc[name] = { h, s: salt, iter: 120000, created: Date.now() };
    lsSet(K_ACC, acc);
    setSession({ u: name, token: 'local', created: Date.now() });
    migrateOld(name);
    return { ok: true, local: true };
  }

  const j = await api('/api/register', { u: name, p: pass });
  if (!j.ok) {
    if (j.err === 'exists') return { err: '这个用户名被别人占了，点「换一个」' };
    return { err: '注册失败：' + (j.msg || j.err) };
  }
  setSession({ u: name, token: j.token, created: Date.now() });
  if (!adopt(name, j.db)) migrateOld(name);
  return { ok: true };
}

async function login(name, pass) {
  name = String(name || '').trim().toLowerCase();
  if (!NAME_RE.test(name)) return { err: '用户名格式不对' };

  if (!cloud) {
    const acc = lsGet(K_ACC, {});
    const a = acc[name];
    if (!a) return { err: '本机没有这个账号。换过设备的话，账号只在原来那台机器上' };
    let h;
    try { h = await pbkdf2(pass, a.s, a.iter || 120000); } catch (e) { return { err: '当前环境不支持加密（需要 https 或 localhost）' }; }
    if (h !== a.h) return { err: '密码不对' };
    setSession({ u: name, token: 'local', created: Date.now() });
    return { ok: true, local: true };
  }

  const j = await api('/api/login', { u: name, p: pass });
  if (!j.ok) {
    if (j.err === 'nouser') return { err: '没有这个账号，检查一下用户名' };
    if (j.err === 'badpass') return { err: '密码不对' };
    if (j.err === 'rate') return { err: '密码错太多次了，等 15 分钟再试' };
    return { err: '登录失败：' + (j.msg || j.err) };
  }
  setSession({ u: name, token: j.token, created: Date.now() });
  adopt(name, j.db);
  return { ok: true };
}

/* 本地账号 → 云端账号
 * 「先在没配云端的时候注册了，之后才部署 Worker」这个顺序一定会发生，
 * 所以留一条迁移：用同名账号在云端建一份，本机进度原样带过去（云端更新则用云端的）。 */
async function upgrade(pass) {
  if (!cloud) return { err: '还没配置云端地址' };
  if (!sess) return { err: '先登录' };
  if (sess.token !== 'local') return { err: '这个账号已经在云端了' };
  if (!pass || String(pass).length < 6) return { err: '密码至少 6 位' };

  const u = sess.u;
  let j = await api('/api/register', { u, p: pass });
  if (!j.ok && j.err === 'exists') j = await api('/api/login', { u, p: pass });
  if (!j.ok) {
    if (j.err === 'badpass' || j.err === 'exists') return { err: '云端已经有人用这个名字，且密码不同。换个账号吧' };
    return { err: '连不上云端：' + (j.msg || j.err) };
  }
  setSession({ u, token: j.token, created: Date.now() });

  const cur = lsGet(dbKey(), null);
  const tookRemote = adopt(u, j.db || null);      // 云端更新就用云端的
  if (!tookRemote && cur) {
    cur.meta = Object.assign({}, cur.meta, { updatedAt: Date.now() });
    lsSet(dbKey(), cur);                          // 本机进度打个新时间戳，下一次推就会赢
    push(cur);
  }
  return { ok: true, tookRemote };
}

/* ==================== 云同步 ==================== */
const S = { last: 0, ok: null, rev: 0, syncing: false, pending: null, err: '', users: null, active7d: null, dirty: false };
let syncT = 0;

/* 推送节奏。KV 免费额度是「整个账号每天 1000 次写」，不是每用户 1000 —— 这个数字决定了节奏。
 * 背一个词存一次档，按 2.5 秒节流算，一个人背 10 分钟就能推 100 多次，十个人就把额度烧干。
 * 所以改成：平时攒 45 秒推一次；距上次推送超过 90 秒（新开一轮）就 5 秒后先推一次，
 * 这样「刚进来的进度」能尽快上云，而连续背词期间不会一直写 KV。
 * 真正的安全网是下面的 pagehide / visibilitychange —— 手机切后台、关页面都会补一次。 */
const PUSH_IDLE = 45000;    // 连续操作时的合并窗口
const PUSH_FRESH = 5000;    // 距上次推送超过 FRESH_GAP 时用的短窗口
const FRESH_GAP = 90000;

function onSave() {
  if (!cloud || !sess || sess.token === 'local') return;
  S.dirty = true;
  clearTimeout(syncT);
  const wait = (Date.now() - (S.last || 0) > FRESH_GAP) ? PUSH_FRESH : PUSH_IDLE;
  syncT = setTimeout(() => {
    if (!S.dirty) return;
    const db = lsGet(dbKey(), null);   // 到点再读，拿到的是最新档，不是 45 秒前那份
    if (db) push(db);
  }, wait);
}

async function push(db) {
  if (!cloud || !sess || sess.token === 'local') return { ok: false, err: 'local' };
  if (!db || typeof db !== 'object') return { ok: false, err: 'nodb' };   // 还没存过档，没什么可推
  if (S.syncing) { S.pending = db; return { ok: false, err: 'busy' }; }
  S.syncing = true;
  let out;
  try {
    const j = await api('/api/sync', { db, updatedAt: (db.meta && db.meta.updatedAt) || Date.now() }, sess.token);
    if (j.ok) {
      S.ok = true; S.last = Date.now(); S.rev = j.rev || S.rev; S.err = ''; S.dirty = false;
      if (j.users != null) S.users = j.users;
    } else {
      S.ok = false;
      S.err = j.err === 'auth' ? 'auth' : (j.err || 'fail');
    }
    out = j;
  } catch (e) {
    S.ok = false; S.err = 'offline';
    out = { ok: false, err: 'offline' };
  } finally {
    S.syncing = false;
    if (S.pending) { const d = S.pending; S.pending = null; push(d); }
  }
  return out;
}

async function syncNow(db) {
  const d = db || lsGet(dbKey(), null);
  if (!d) return { ok: false, err: 'nodb' };
  return await push(d);
}

async function stats() {
  if (!cloud) return null;
  try {
    const r = await fetch(cloud + '/api/stats', { method: 'GET' });
    const j = await r.json();
    if (j && j.ok) { S.users = j.users; S.active7d = j.active7d; return j; }
  } catch (e) { /* 离线就不显示，不要瞎编数字 */ }
  return null;
}

/* 页面要走了 / 切到后台：补一次，别把最后几步丢了。
 * 手机上是切后台更常见（pagehide 有时不触发），两个都听。 */
function flushNow() {
  if (!cloud || !sess || sess.token === 'local' || !S.dirty) return;
  clearTimeout(syncT);
  const db = lsGet(dbKey(), null);
  if (!db) return;
  const body = JSON.stringify({ db, updatedAt: (db.meta && db.meta.updatedAt) || Date.now() });
  // keepalive 的请求体有 64KB 上限，超了会静默失败 —— 那就退化成普通请求，
  // 反正 45 秒内已经推过一次，丢不了多少
  if (body.length > 60000) { push(db); return; }
  try {
    fetch(cloud + '/api/sync', {
      method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sess.token },
      body
    });
    S.last = Date.now();
    S.dirty = false;
  } catch (e) {}
}
window.addEventListener('pagehide', flushNow);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushNow();
});

/* ==================== 注册 / 登录 界面 ==================== */
let view = 'reg';             // reg | login | done | fail
let issued = null;            // 刚注册出来的账号密码，给「保存这页」用
let errMsg = '';
let busy = false;
let offlineOffer = false;

function gateEl() {
  let g = document.getElementById('gate');
  if (!g) {
    g = document.createElement('div');
    g.id = 'gate';
    g.className = 'gate';
    document.body.appendChild(g);
    document.body.classList.add('gated');
  }
  return g;
}

function cloudLine() {
  if (!cloud) return '<div class="gate-cloud off">本地模式 · 进度只存在这台设备，不会上传</div>';
  return '<div class="gate-cloud on">云端已连接 · 进度会同步，换设备登录同一个账号即可</div>';
}

function feeLine() {
  return `<div class="gate-fee">不收邮箱、不发验证码，也就不存在找回密码。
    注册完请<b>截图保存</b>，丢了只能重新注册${cloud ? '（旧进度还在云端，不会消失）' : '（进度只在这台设备，丢了就真没了）'}。</div>`;
}

function paint() {
  const g = gateEl();
  // 重绘前把已经敲进去的内容捞出来，否则报错重绘会把用户输入换成新的随机值
  const pu = (document.querySelector('#gate #f-u') || {}).value;
  const pp = (document.querySelector('#gate #f-p') || {}).value;
  const head = `<div class="gate-brand">
      <div class="gate-logo kr">한</div>
      <div class="gate-name">한글·学</div>
      <div class="gate-sub">识别型韩语学习</div>
    </div>`;

  if (view === 'done' && issued) {
    g.innerHTML = `<div class="gate-card">
      ${head}
      <div class="gate-h">账号已创建</div>
      <div class="acc-box">
        <div class="acc-row"><span>用户名</span><b class="mono" id="g-u">${issued.u}</b></div>
        <div class="acc-row"><span>密码</span><b class="mono" id="g-p">${issued.p}</b></div>
      </div>
      <button class="btn btn-ghost btn-block" data-g="copy">复制账号密码</button>
      <div class="gate-warn">现在截图，或者抄到备忘录里。这页关掉就再也看不到密码了。</div>
      <button class="btn btn-primary btn-block" data-g="enter">我保存好了，开始学习</button>
      ${cloudLine()}
    </div>`;
    return;
  }

  g.innerHTML = `<div class="gate-card">
    ${head}
    <div class="gate-tabs">
      <button data-g="tab" data-v="reg" class="${view === 'reg' ? 'on' : ''}">注册</button>
      <button data-g="tab" data-v="login" class="${view === 'login' ? 'on' : ''}">登录</button>
    </div>
    ${view === 'login' ? `
      <label class="gate-field"><span>用户名</span><input id="f-u" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="kr-xxxxxx" value="${pu || ''}"></label>
      <label class="gate-field"><span>密码</span><input id="f-p" type="password" autocomplete="current-password" placeholder="至少 6 位" value="${pp || ''}"></label>
    ` : `
      <label class="gate-field"><span>用户名<button class="mini" data-g="roll-u">换一个</button></span>
        <input id="f-u" autocomplete="off" autocapitalize="off" spellcheck="false" value="${pu || rndName()}"></label>
      <label class="gate-field"><span>密码<button class="mini" data-g="roll-p">换一个</button></span>
        <input id="f-p" autocomplete="off" value="${pp || rndPass()}"></label>
    `}
    ${errMsg ? `<div class="gate-err">${escq(errMsg)}</div>` : ''}
    <button class="btn btn-primary btn-block" data-g="go"${busy ? ' disabled' : ''}>
      ${busy ? '处理中…' : (view === 'login' ? '登录' : '创建账号')}</button>
    ${offlineOffer ? '<button class="btn btn-ghost btn-block" data-g="offline">连不上云端，先离线注册</button>' : ''}
    ${view === 'login' ? '<div class="gate-fee">没有邮箱找回。忘了密码就用「注册」开个新号。</div>' : feeLine()}
    ${cloudLine()}
  </div>`;
}

function gateErr(m) { errMsg = m; paint(); }

async function doRegister() {
  const u = ($('#f-u') || {}).value || '';
  const p = ($('#f-p') || {}).value || '';
  busy = true; errMsg = ''; paint();
  let j;
  try { j = await register(u, p); }
  catch (e) { j = { err: '网络不通：' + (e && e.message || e) }; }
  busy = false;
  if (j.ok) {
    issued = { u: u.trim().toLowerCase(), p };
    view = 'done'; errMsg = ''; paint();
    return;
  }
  if (cloud && /网络|offline|fetch|Failed/i.test(j.err || '')) offlineOffer = true;
  view = 'reg'; gateErr(j.err || '注册失败'); 
}

async function doLogin() {
  const u = ($('#f-u') || {}).value || '';
  const p = ($('#f-p') || {}).value || '';
  busy = true; errMsg = ''; paint();
  let j;
  try { j = await login(u, p); }
  catch (e) { j = { err: '网络不通：' + (e && e.message || e) }; }
  busy = false;
  if (j.ok) { errMsg = ''; start(); return; }
  gateErr(j.err || '登录失败');
}

function doOffline() {
  const u = ($('#f-u') || {}).value || rndName();
  const p = ($('#f-p') || {}).value || rndPass();
  const keep = cloud;
  cloud = '';                    // 临时按本地账号建，之后再连云端
  register(u, p).then(j => {
    cloud = keep;
    if (j.ok) { issued = { u: u.trim().toLowerCase(), p }; view = 'done'; offlineOffer = false; paint(); }
    else gateErr(j.err || '离线注册失败');
  });
}

document.addEventListener('click', e => {
  const t = e.target.closest && e.target.closest('#gate [data-g]');
  if (!t) return;
  const g = t.dataset.g;
  if (g === 'tab') { view = t.dataset.v; errMsg = ''; offlineOffer = false; paint(); return; }
  if (g === 'roll-u') { const i = $('#f-u'); if (i) i.value = rndName(); return; }
  if (g === 'roll-p') { const i = $('#f-p'); if (i) i.value = rndPass(); return; }
  if (g === 'go') { (view === 'login' ? doLogin() : doRegister()); return; }
  if (g === 'offline') { doOffline(); return; }
  if (g === 'copy') {
    const txt = '한글·学 账号\n用户名：' + issued.u + '\n密码：' + issued.p;
    if (navigator.clipboard) navigator.clipboard.writeText(txt).catch(() => {});
    t.textContent = '已复制';
    return;
  }
  if (g === 'enter') { start(); }
});

/* ==================== 启动闸门 ==================== */
let bootFn = null, started = false;

function start() {
  if (started) return;
  started = true;
  const g = document.getElementById('gate');
  if (g) g.remove();
  document.body.classList.remove('gated');
  if (bootFn) bootFn();
}

function ready(fn) {
  bootFn = fn;
  if (sess) { start(); return; }
  paint();
  const i = $('#f-u'); if (i && view === 'login') i.focus();
}

window.KR = {
  dbKey,
  ready,
  onSave,
  syncNow,
  upgrade,
  stats,
  logout() {
    clearSession();
    location.reload();
  },
  isLocal() { return !cloud || !sess || sess.token === 'local'; },
  cloudUrl() { return cloud; },
  setCloud(url) {
    if (url) { cloud = url.replace(/\/+$/, ''); try { localStorage.setItem(K_CLOUD, cloud); } catch (e) {} }
    else { cloud = ''; lsDel(K_CLOUD); }
    location.reload();
  },
  info() {
    return {
      u: sess ? sess.u : '',
      cloud: !!cloud,
      synced: !!(sess && sess.token !== 'local'),
      last: S.last, ok: S.ok, err: S.err, rev: S.rev,
      users: S.users, active7d: S.active7d,
      created: sess ? sess.created : 0,
      localToken: !!(sess && sess.token === 'local')
    };
  }
};
})();

/* 한글·学 账号服务 —— Cloudflare Worker + KV
 *
 * 接口
 *   POST /api/register  { u, p }                     → { ok, token }
 *   POST /api/login     { u, p }                     → { ok, token, db, updatedAt }
 *   POST /api/sync      { db, updatedAt } + Bearer   → { ok, rev } | { ok, adopted:true, db }
 *   GET  /api/stats                                  → { ok, users, active7d, active1d }
 *   GET  /api/me        + Bearer                     → { ok, u, created, updatedAt }
 *
 * 几个刻意的选择
 *   · 密码只存 PBKDF2-SHA256(120k) 的哈希 + 随机盐，不存明文，也不存可逆加密。
 *   · 登录后发的是 HMAC 签名 token，不是会话表 —— 少一次 KV 写，也不怕冷启动。
 *   · 同步是「谁的 updatedAt 新谁赢」。同一账号多设备同时背词会互相覆盖，
 *     这个取舍换来的是没有合并算法、没有冲突提示 —— 一个人用完全够。
 *   · 没做邮箱、没做找回。密码忘掉就是忘掉，用户注册时已经被明确告知。
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Max-Age': '86400',
};

const ITER = 120000;
const MAX_BODY = 1024 * 1024;      // 一份进度撑死几百 KB，超过就是有人在灌垃圾
const TOKEN_DAYS = 180;

const json = (o, status = 200, extra) =>
  new Response(JSON.stringify(o), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, CORS, extra || {})
  });

const hex = buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
const unhex = h => new Uint8Array((h.match(/../g) || []).map(x => parseInt(x, 16)));
const randHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));

async function pbkdf2(pw, saltHex, iter) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: unhex(saltHex), iterations: iter || ITER, hash: 'SHA-256' }, key, 256);
  return hex(bits);
}

async function secret(env) {
  let s = await env.KR.get('cfg:secret');
  if (!s) {
    s = randHex(32);
    await env.KR.put('cfg:secret', s);
  }
  return s;
}

async function sign(env, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(await secret(env)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return hex(sig).slice(0, 32);
}

const b64u = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));

async function makeToken(env, u) {
  const exp = Date.now() + TOKEN_DAYS * 86400000;
  return b64u(u) + '.' + exp + '.' + await sign(env, u + '.' + exp);
}

async function readToken(env, req) {
  const h = req.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return null;
  const parts = m[1].split('.');
  if (parts.length !== 3) return null;
  let u;
  try { u = unb64u(parts[0]); } catch (e) { return null; }
  const exp = Number(parts[1]);
  if (!u || !exp || exp < Date.now()) return null;
  if (await sign(env, u + '.' + exp) !== parts[2]) return null;
  return u;
}

const NAME_RE = /^[a-z0-9_-]{3,20}$/;

async function body(req) {
  const txt = await req.text();
  if (txt.length > MAX_BODY) throw new Error('toolarge');
  return JSON.parse(txt || '{}');
}

async function handleRegister(req, env) {
  const { u, p } = await body(req);
  const name = String(u || '').trim().toLowerCase();
  if (!NAME_RE.test(name)) return json({ ok: false, err: 'badname' }, 400);
  if (String(p || '').length < 6) return json({ ok: false, err: 'badpass' }, 400);

  const key = 'u:' + name;
  if (await env.KR.get(key)) return json({ ok: false, err: 'exists' }, 409);

  const salt = randHex(16);
  const rec = {
    u: name, salt, hash: await pbkdf2(p, salt), iter: ITER,
    created: Date.now(), lastSeen: Date.now(), rev: 0, updatedAt: 0, db: null
  };
  await env.KR.put(key, JSON.stringify(rec), { metadata: { created: rec.created, lastSeen: rec.lastSeen } });
  return json({ ok: true, token: await makeToken(env, name) });
}

async function handleLogin(req, env) {
  const { u, p } = await body(req);
  const name = String(u || '').trim().toLowerCase();
  if (!NAME_RE.test(name)) return json({ ok: false, err: 'nouser' }, 404);

  const fkey = 'fail:' + name;
  const fails = Number(await env.KR.get(fkey) || 0);
  if (fails >= 10) return json({ ok: false, err: 'rate' }, 429);

  const key = 'u:' + name;
  const rec = await env.KR.get(key, 'json');
  if (!rec) return json({ ok: false, err: 'nouser' }, 404);

  const h = await pbkdf2(p, rec.salt, rec.iter);
  if (h !== rec.hash) {
    await env.KR.put(fkey, String(fails + 1), { expirationTtl: 900 });
    return json({ ok: false, err: 'badpass' }, 401);
  }
  await env.KR.delete(fkey).catch(() => {});

  rec.lastSeen = Date.now();
  await env.KR.put(key, JSON.stringify(rec), { metadata: { created: rec.created, lastSeen: rec.lastSeen } });
  return json({ ok: true, token: await makeToken(env, name), db: rec.db, updatedAt: rec.updatedAt });
}

async function handleSync(req, env) {
  const name = await readToken(env, req);
  if (!name) return json({ ok: false, err: 'auth' }, 401);

  const { db, updatedAt } = await body(req);
  if (!db || typeof db !== 'object') return json({ ok: false, err: 'baddb' }, 400);

  const key = 'u:' + name;
  const rec = await env.KR.get(key, 'json');
  if (!rec) return json({ ok: false, err: 'auth' }, 401);

  const at = Number(updatedAt) || 0;
  if (at < rec.updatedAt) {
    // 云端更新：把云端那份推回去，客户端自己决定要不要覆盖本地
    return json({ ok: true, rev: rec.rev, adopted: true, db: rec.db, updatedAt: rec.updatedAt });
  }
  rec.db = db;
  rec.updatedAt = at;
  rec.rev = (rec.rev || 0) + 1;
  rec.lastSeen = Date.now();
  await env.KR.put(key, JSON.stringify(rec), { metadata: { created: rec.created, lastSeen: rec.lastSeen } });
  return json({ ok: true, rev: rec.rev, updatedAt: rec.updatedAt });
}

async function handleStats(env) {
  let users = 0, a7 = 0, a1 = 0, cursor = undefined;
  const now = Date.now();
  for (;;) {
    const page = await env.KR.list({ prefix: 'u:', limit: 1000, cursor });
    for (const k of page.keys) {
      users++;
      const ls = (k.metadata && k.metadata.lastSeen) || 0;
      if (now - ls < 7 * 86400000) a7++;
      if (now - ls < 86400000) a1++;
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return json({ ok: true, users, active7d: a7, active1d: a1 });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    try {
      if (url.pathname === '/api/register' && req.method === 'POST') return await handleRegister(req, env);
      if (url.pathname === '/api/login' && req.method === 'POST') return await handleLogin(req, env);
      if (url.pathname === '/api/sync' && req.method === 'POST') return await handleSync(req, env);
      if (url.pathname === '/api/stats' && req.method === 'GET') return await handleStats(env);
      if (url.pathname === '/api/me' && req.method === 'GET') {
        const name = await readToken(env, req);
        if (!name) return json({ ok: false, err: 'auth' }, 401);
        const rec = await env.KR.get('u:' + name, 'json');
        if (!rec) return json({ ok: false, err: 'auth' }, 401);
        return json({ ok: true, u: name, created: rec.created, updatedAt: rec.updatedAt, rev: rec.rev });
      }
      if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true, service: 'krlearn-api' });
      return json({ ok: false, err: 'notfound' }, 404);
    } catch (e) {
      const msg = String(e && e.message || e);
      if (msg === 'toolarge') return json({ ok: false, err: 'toolarge' }, 413);
      return json({ ok: false, err: 'server', msg }, 500);
    }
  }
};

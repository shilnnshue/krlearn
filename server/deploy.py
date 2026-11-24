#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
一步部署 krlearn-api 到 Cloudflare（不需要 wrangler login，只需要 API Token）

用法：
    python deploy.py                     # 读 .dev.vars 或环境变量
    python deploy.py --domain krlearn-api.askdiandian.com
    python deploy.py --dry               # 只体检 token / 账号 / 域名，不部署

Token 来源优先级：CLOUDFLARE_API_TOKEN 环境变量 > server/.dev.vars 里的同名行。

需要的权限（建 token 时选模板 "Edit Cloudflare Workers"，Zone Resources 选 All zones）：
    Account   Workers Scripts      Edit
    Account   Workers KV Storage   Edit
    Zone      Workers Routes       Edit      ← 只有挂自定义域才用到
"""
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
API = 'https://api.cloudflare.com/client/v4'
WRANGLER_TOML = os.path.join(HERE, 'wrangler.toml')
KV_TITLE = 'krlearn-KR'
WORKER_NAME = 'krlearn-api'


# ---------------------------------------------------------------- 输出
def say(msg=''):
    print(msg, flush=True)


def ok(msg):
    print('  \033[32m✓\033[0m ' + msg, flush=True)


def bad(msg):
    print('  \033[31m✗\033[0m ' + msg, flush=True)


def head(msg):
    print('\n\033[1m' + msg + '\033[0m', flush=True)


# ---------------------------------------------------------------- token
def load_token():
    t = os.environ.get('CLOUDFLARE_API_TOKEN', '').strip()
    if t:
        return t, '环境变量 CLOUDFLARE_API_TOKEN'
    p = os.path.join(HERE, '.dev.vars')
    if os.path.exists(p):
        for line in open(p, encoding='utf-8'):
            line = line.strip()
            if line.startswith('#'):
                continue
            m = re.match(r'^CLOUDFLARE_API_TOKEN\s*=\s*(.+)$', line)
            if m:
                return m.group(1).strip().strip('"').strip("'"), '.dev.vars'
    return '', ''


# ---------------------------------------------------------------- HTTP
def api(method, path, token, body=None):
    url = API + path
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Authorization', 'Bearer ' + token)
    req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode('utf-8') or '{}')
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8', 'replace')
        try:
            return json.loads(raw)
        except Exception:
            return {'success': False, 'errors': [{'message': 'HTTP %d %s' % (e.code, raw[:200])}]}
    except Exception as e:
        return {'success': False, 'errors': [{'message': '网络错误：%s' % e}]}


def errs(j):
    out = []
    for e in (j.get('errors') or []):
        out.append(e.get('message') or str(e))
    return '; '.join(out) or '未知错误'


# ---------------------------------------------------------------- 各步骤
def verify(token):
    head('1/5 验证 token')
    j = api('GET', '/user/tokens/verify', token)
    if not j.get('success'):
        bad('token 无效：' + errs(j))
        return None
    st = (j.get('result') or {}).get('status')
    ok('token 有效（状态 %s）' % st)
    return True


def pick_account(token):
    head('2/5 找账号')
    j = api('GET', '/accounts?per_page=50', token)
    if not j.get('success'):
        bad('列账号失败：' + errs(j))
        bad('多半是这个 token 没给 Account 级权限')
        return None
    accs = j.get('result') or []
    if not accs:
        bad('这个 token 看不到任何账号')
        return None
    env_aid = os.environ.get('CLOUDFLARE_ACCOUNT_ID', '').strip()
    if env_aid:
        for a in accs:
            if a['id'] == env_aid:
                ok('%s  (%s)' % (a['name'], a['id']))
                return a
    for a in accs:
        ok('%s  (%s)' % (a['name'], a['id']))
    if len(accs) > 1:
        say('  注意：有 %d 个账号，默认用第一个；要换请设 CLOUDFLARE_ACCOUNT_ID' % len(accs))
    return accs[0]


def ensure_kv(token, aid):
    head('3/5 准备 KV 命名空间')
    j = api('GET', '/accounts/%s/storage/kv/namespaces?per_page=100' % aid, token)
    if not j.get('success'):
        bad('列 KV 失败：' + errs(j))
        bad('token 缺 Workers KV Storage:Edit 权限')
        return None
    for ns in (j.get('result') or []):
        if ns.get('title') == KV_TITLE:
            ok('已有命名空间 %s' % KV_TITLE)
            return ns['id']
    j = api('POST', '/accounts/%s/storage/kv/namespaces' % aid, token, {'title': KV_TITLE})
    if not j.get('success'):
        bad('建 KV 失败：' + errs(j))
        return None
    nsid = (j.get('result') or {}).get('id')
    ok('新建命名空间 %s → %s' % (KV_TITLE, nsid))
    return nsid


def patch_toml(kv_id, account_id):
    head('4/5 写回 wrangler.toml')
    s = open(WRANGLER_TOML, encoding='utf-8').read()
    s2 = re.sub(r'(binding\s*=\s*"KR"\s*\n\s*id\s*=\s*")[^"]*(")',
                 lambda m: m.group(1) + kv_id + m.group(2), s, count=1)
    if s2 == s and kv_id not in s:
        bad('没找到 [[kv_namespaces]] 的 id 行，手动改一下')
        return False
    if not re.search(r'^account_id\s*=', s2, _re.M):
        s2 = re.sub(r'^(name\s*=\s*"[^"]*"\s*)$',
                     lambda m: m.group(1) + '\naccount_id = "%s"' % account_id, s2, count=1, flags=_re.M)
    open(WRANGLER_TOML, 'w', encoding='utf-8').write(s2)
    ok('KV id 已写入（account_id 也补上了）')
    return True


def find_zone(token, hostname):
    """从 api.xxx.com 里找最长的后缀，返回 (zone_id, zone_name)"""
    parts = hostname.split('.')
    for i in range(len(parts) - 1):
        cand = '.'.join(parts[i:])
        j = api('GET', '/zones?name=' + cand, token)
        for z in (j.get('result') or []):
            if z.get('name') == cand:
                return z['id'], cand
    return None, None


def add_domain(token, aid, domain):
    head('5/5 挂自定义域')
    zid, zname = find_zone(token, domain)
    if not zid:
        bad('这个 token 里看不到 %s 所在的域名（域名不在本账号，或 token 没给 Zone 权限）' % domain)
        say('  可以稍后在控制台手动加：Workers → %s → Settings → Domains & Routes' % WORKER_NAME)
        return False
    ok('域名在账号里：%s（zone %s）' % (zname, zid))
    j = api('PUT', '/accounts/%s/workers/domains' % aid, token, {
        'zone_id': zid, 'hostname': domain, 'service': WORKER_NAME, 'environment': 'production',
    })
    if j.get('success'):
        ok('已挂上 https://%s' % domain)
        return True
    msg = errs(j)
    if 'already' in msg.lower() or 'duplicate' in msg.lower():
        ok('已经挂过了')
        return True
    bad('挂域失败：' + msg)
    return False


def deploy(token, aid):
    head('部署 Worker')
    npm = os.environ.get('KR_NPX') or 'npx'
    if os.path.exists('C:/Users/27028/.workbuddy/binaries/node/versions/22.22.2-2/npx.cmd'):
        npm = 'C:/Users/27028/.workbuddy/binaries/node/versions/22.22.2-2/npx.cmd'
    env = dict(os.environ, CLOUDFLARE_API_TOKEN=token, CLOUDFLARE_ACCOUNT_ID=aid,
               WRANGLER_SEND_METRICS='false')
    env.pop('http_proxy', None)
    env.pop('https_proxy', None)
    env.pop('HTTP_PROXY', None)
    env.pop('HTTPS_PROXY', None)
    p = subprocess.run([npm, '--yes', 'wrangler@latest', 'deploy'],
                       cwd=HERE, env=env, capture_output=True, text=True,
                       encoding='utf-8', errors='replace')
    out = (p.stdout or '') + (p.stderr or '')
    keep = [l for l in out.splitlines()
            if l.strip() and not l.startswith('npm warn') and 'Progress:' not in l]
    for l in keep[-18:]:
        say('  ' + l)
    if p.returncode != 0:
        bad('deploy 失败（退出码 %d）' % p.returncode)
        return None
    m = re.search(r'https://([a-z0-9-]+\.workers\.dev)', out)
    url = m.group(0) if m else None
    if url:
        ok('已上线：' + url)
    return url or True


def main():
    dry = '--dry' in sys.argv
    domain = None
    for i, a in enumerate(sys.argv):
        if a == '--domain' and i + 1 < len(sys.argv):
            domain = sys.argv[i + 1].strip()

    token, src = load_token()
    if not token:
        bad('没找到 token')
        say('  把 token 写到 server/.dev.vars：')
        say('    CLOUDFLARE_API_TOKEN=你的token')
        say('  或临时用环境变量：export CLOUDFLARE_API_TOKEN=...')
        return 2
    say('token 来源：%s（长度 %d）' % (src, len(token)))

    if not verify(token):
        return 1
    acc = pick_account(token)
    if not acc:
        return 1
    aid = acc['id']

    kv = ensure_kv(token, aid)
    if not kv:
        return 1
    if dry:
        head('--dry：到此为止')
        say('  account_id = %s' % aid)
        say('  kv_id      = %s' % kv)
        if domain:
            zid, zname = find_zone(token, domain)
            ok('域名可挂：%s（zone %s）' % (zname, zid)) if zid else bad('看不到 %s 这个域' % domain)
        return 0

    if not patch_toml(kv, aid):
        return 1
    if not deploy(token, aid):
        return 1
    if domain:
        add_domain(token, aid, domain)
    head('完成')
    say('  下一步：把 Worker 地址填进 assets/account.js 的 CLOUD_DEFAULT，再推一次 GitHub')
    return 0


if __name__ == '__main__':
    sys.exit(main())

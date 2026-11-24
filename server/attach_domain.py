#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 krlearn-api 挂到 krlearn-api.askdiandian.com（Cloudflare Workers 自定义域）

前提：askdiandian.com 已经加到 Cloudflare 并激活（NS 生效）。
用法：
    python attach_domain.py --check      # 只看域有没有加进来、激活没有
    python attach_domain.py              # 激活了就挂域名 + 重新部署 + 从国内直连验证
    python attach_domain.py --domain foo.example.com

凭据：优先环境变量 CLOUDFLARE_API_TOKEN，其次 server/.dev.vars，
最后读 wrangler login 存下的 oauth_token（Windows 在 xdg.config 那层）。
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
API = 'https://api.cloudflare.com/client/v4'
TOML = os.path.join(HERE, 'wrangler.toml')
WRANGLER_CFG = os.path.expanduser(
    r'C:\Users\27028\AppData\Roaming\xdg.config\.wrangler\config\default.toml')
NPX = ('C:/Users/27028/.workbuddy/binaries/node/versions/22.22.2-2/npx.cmd'
       if os.path.exists('C:/Users/27028/.workbuddy/binaries/node/versions/22.22.2-2/npx.cmd')
       else 'npx')

ZONE = 'askdiandian.com'
WORKER = 'krlearn-api'


def say(m=''):
    print(m, flush=True)


def ok(m):
    print('  \033[32m✓\033[0m ' + m, flush=True)


def bad(m):
    print('  \033[31m✗\033[0m ' + m, flush=True)


def head(m):
    print('\n\033[1m' + m + '\033[0m', flush=True)


def load_token():
    t = os.environ.get('CLOUDFLARE_API_TOKEN', '').strip()
    if t:
        return t, '环境变量'
    p = os.path.join(HERE, '.dev.vars')
    if os.path.exists(p):
        for line in open(p, encoding='utf-8'):
            m = re.match(r'^\s*CLOUDFLARE_API_TOKEN\s*=\s*(.+)$', line.strip())
            if m:
                v = m.group(1).strip().strip('"').strip("'")
                if v:
                    return v, '.dev.vars'
    if os.path.exists(WRANGLER_CFG):
        for line in open(WRANGLER_CFG, encoding='utf-8'):
            m = re.match(r'^\s*oauth_token\s*=\s*"([^"]+)"', line)
            if m:
                return m.group(1), 'wrangler 登录态'
    return '', ''


def api(method, path, token, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header('Authorization', 'Bearer ' + token)
    req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8', 'replace')
        try:
            return json.loads(raw)
        except Exception:
            return {'success': False, 'errors': [{'message': 'HTTP %d %s' % (e.code, raw[:160])}]}


def errs(j):
    return '; '.join([e.get('message', str(e)) for e in (j.get('errors') or [])]) or '未知错误'


def get_zone(token):
    j = api('GET', '/zones?name=' + ZONE, token)
    if not j.get('success'):
        bad('查域名失败：' + errs(j))
        return None
    zs = j.get('result') or []
    return zs[0] if zs else None


def check(token):
    head('检查 %s 是否已经在 Cloudflare 里' % ZONE)
    z = get_zone(token)
    if not z:
        bad('还没加进来（或者还在等你改 NS）')
        say('  去 https://dash.cloudflare.com → Add a site → 输入 %s → 选 Free' % ZONE)
        say('  然后按提示把 NS 从 ns3/ns4.dnsv4.com 换成 Cloudflare 给的两个')
        return None
    ok('找到了：%s（状态 %s）' % (z['name'], z.get('status')))
    ns = z.get('name_servers') or []
    if ns:
        say('  应使用的 NS：' + ', '.join(ns))
    if z.get('status') != 'active':
        bad('还没激活。Cloudflare 说：%s' % (z.get('status')))
        say('  NS 改完后一般几分钟生效，最长几小时。改完再跑一次 --check')
        return None
    ok('已激活，可以挂域名了')
    return z


def patch_toml(host):
    head('写 routes 到 wrangler.toml')
    s = open(TOML, encoding='utf-8').read()
    if re.search(r'^\s*pattern\s*=\s*"%s"' % re.escape(host), s, re.M):
        ok('已经有了，不重复写')
        return True
    block = ('\n[[routes]]\npattern = "%s"\ncustom_domain = true\n' % host)
    s = s.rstrip('\n') + '\n' + block
    open(TOML, 'w', encoding='utf-8').write(s)
    ok('已追加 [[routes]] custom_domain = true')
    return True


def deploy():
    head('重新部署（带上自定义域）')
    env = dict(os.environ, WRANGLER_SEND_METRICS='false')
    for k in ('http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY'):
        env.pop(k, None)
    p = subprocess.run([NPX, '--yes', 'wrangler@latest', 'deploy'], cwd=HERE, env=env,
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    out = (p.stdout or '') + (p.stderr or '')
    for l in [x for x in out.splitlines() if x.strip() and not x.startswith('npm warn')][-14:]:
        say('  ' + l)
    if p.returncode != 0:
        bad('部署失败')
        return False
    return True


def verify(host):
    head('从本机（国内网络）直连验证 https://%s' % host)
    url = 'https://%s/api/stats' % host
    for i in range(1, 7):
        p = subprocess.run(['curl', '-s', '--noproxy', '*', '-m', '15',
                            '-o', os.devnull, '-w', '%{http_code} %{remote_ip} %{time_total}'],
                           capture_output=True, text=True)
        # 用 curl 抓 body 更实在
        r = subprocess.run(['curl', '-s', '--noproxy', '*', '-m', '15', url],
                           capture_output=True, text=True)
        body = (r.stdout or '').strip()
        code = p
        if body.startswith('{'):
            ok('通了：' + body[:160])
            return True
        if body:
            bad('有响应但不是 JSON：' + body[:120])
        say('  第 %d 次还没通（DNS 可能还在传播）' % i)
        time.sleep(10)
    bad('没通。检查：① krlearn-api 的 DNS 记录是否由 CF 自动生成 ② 本地 DNS 缓存（ipconfig /flushdns）')
    return False


def main():
    args = sys.argv[1:]
    dry = '--check' in args
    host = 'krlearn-api.askdiandian.com'
    if '--domain' in args:
        host = args[args.index('--domain') + 1].strip()

    token, src = load_token()
    if not token:
        bad('没有凭据：先跑 wrangler login，或把 token 写进 server/.dev.vars')
        return 2
    say('凭据来源：%s' % src)

    z = check(token)
    if not z:
        return 1
    if dry:
        return 0

    if not patch_toml(host):
        return 1
    if not deploy():
        return 1
    return 0 if verify(host) else 1


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
"""tools/mock_cloud.py —— 本地假后端，用来测前端账号 / 同步 / 人数统计

不是给生产用的。内存存储，进程一停数据就没了。
接口形状跟 server/worker.js 一致，方便前端不区分环境。

    python tools/mock_cloud.py            # 听 8790
    python tools/mock_cloud.py 8899
"""
import hashlib
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

USERS = {}          # u -> {salt, hash, created, lastSeen, rev, updatedAt, db}

MAX_BODY = 1024 * 1024


def pbkdf2(pw: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac('sha256', pw.encode(), bytes.fromhex(salt), 120000).hex()


class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        pass

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type,Authorization')
        self.send_header('Access-Control-Max-Age', '86400')

    def _json(self, obj, code=200):
        raw = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self._cors()
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    def _token(self):
        h = self.headers.get('Authorization') or ''
        if not h.startswith('Bearer '):
            return None
        t = h[7:]
        return t[5:] if t.startswith('mock.') else None

    def do_GET(self):
        if self.path in ('/', '/health'):
            return self._json({'ok': True, 'service': 'mock-cloud'})
        if self.path == '/api/stats':
            now = time.time()
            a7 = sum(1 for r in USERS.values() if now - r['lastSeen'] < 7 * 86400)
            a1 = sum(1 for r in USERS.values() if now - r['lastSeen'] < 86400)
            return self._json({'ok': True, 'users': len(USERS), 'active7d': a7, 'active1d': a1})
        if self.path == '/api/users':          # 只给测试看，生产没有这个
            return self._json({'ok': True, 'users': {
                u: {'created': r['created'], 'rev': r['rev'], 'updatedAt': r['updatedAt'],
                    'hasDb': bool(r['db'])} for u, r in USERS.items()}})
        return self._json({'ok': False, 'err': 'notfound'}, 404)

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > MAX_BODY:
            return self._json({'ok': False, 'err': 'toolarge'}, 413)
        try:
            body = json.loads(self.rfile.read(n) or b'{}')
        except Exception:
            return self._json({'ok': False, 'err': 'badjson'}, 400)

        if self.path == '/api/register':
            u = str(body.get('u', '')).strip().lower()
            p = str(body.get('p', ''))
            if not (3 <= len(u) <= 20):
                return self._json({'ok': False, 'err': 'badname'}, 400)
            if len(p) < 6:
                return self._json({'ok': False, 'err': 'badpass'}, 400)
            if u in USERS:
                return self._json({'ok': False, 'err': 'exists'}, 409)
            salt = os.urandom(16).hex()
            USERS[u] = {'salt': salt, 'hash': pbkdf2(p, salt), 'created': time.time(),
                        'lastSeen': time.time(), 'rev': 0, 'updatedAt': 0, 'db': None}
            return self._json({'ok': True, 'token': 'mock.' + u})

        if self.path == '/api/login':
            u = str(body.get('u', '')).strip().lower()
            rec = USERS.get(u)
            if not rec:
                return self._json({'ok': False, 'err': 'nouser'}, 404)
            if pbkdf2(str(body.get('p', '')), rec['salt']) != rec['hash']:
                return self._json({'ok': False, 'err': 'badpass'}, 401)
            rec['lastSeen'] = time.time()
            return self._json({'ok': True, 'token': 'mock.' + u, 'db': rec['db'], 'updatedAt': rec['updatedAt']})

        if self.path == '/api/sync':
            u = self._token()
            rec = USERS.get(u)
            if not rec:
                return self._json({'ok': False, 'err': 'auth'}, 401)
            db = body.get('db')
            if not isinstance(db, dict):
                return self._json({'ok': False, 'err': 'baddb'}, 400)
            at = float(body.get('updatedAt') or 0)
            if at < rec['updatedAt']:
                return self._json({'ok': True, 'rev': rec['rev'], 'adopted': True,
                                   'db': rec['db'], 'updatedAt': rec['updatedAt']})
            rec['db'] = db
            rec['updatedAt'] = at
            rec['rev'] += 1
            rec['lastSeen'] = time.time()
            return self._json({'ok': True, 'rev': rec['rev'], 'updatedAt': rec['updatedAt']})

        return self._json({'ok': False, 'err': 'notfound'}, 404)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
    srv = ThreadingHTTPServer(('127.0.0.1', port), H)
    print('mock cloud on http://127.0.0.1:%d' % port, flush=True)
    srv.serve_forever()

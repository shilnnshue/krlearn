# -*- coding: utf-8 -*-
"""한글·学 本地服务器
零依赖：只用 Python 标准库

调试开关（命令行设置环境变量）：
  KR_NO_BROWSER=1   不自动开浏览器
  KR_PORT=8800      指定起始端口
"""
import http.server
import socketserver
import webbrowser
import threading
import socket
import json
import os
import sys
import time
import traceback

ROOT = os.path.dirname(os.path.abspath(__file__))
BASE_PORT = int(os.environ.get('KR_PORT') or 8765)
APP_TAG = 'krlearn'
ALIVE_PATH = '/__alive'


# --------------------------------------------------------------------------
# 控制台输出兜底：老终端（GBK 代码页）里 print 韩文会抛 UnicodeEncodeError
# 直接把进程打死，且双击 bat 时窗口一闪就没，用户看不到任何原因。
# 另外统一 flush —— stdout 被重定向时是块缓冲，不 flush 就永远看不到启动信息。
# --------------------------------------------------------------------------
def _safe_console():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors='replace', line_buffering=True)
        except Exception:
            try:
                stream.reconfigure(errors='replace')
            except Exception:
                pass


def say(line=''):
    """任何字符都写得出去，写不出去也不许崩。"""
    try:
        print(line, flush=True)
    except Exception:
        try:
            sys.stdout.write(line.encode('ascii', 'replace').decode('ascii') + '\n')
            sys.stdout.flush()
        except Exception:
            pass


def open_browser(url):
    time.sleep(0.7)
    try:
        if webbrowser.open(url):
            return
    except Exception:
        pass
    try:
        os.startfile(url)  # noqa: 仅 Windows
    except Exception:
        pass


def probe_alive(port, timeout=0.6):
    """8765 上是否已经有本程序在跑。有的话不能再起第二个 —— 端口一换，
    localStorage 就按新 origin 隔离，用户之前的背词进度会看起来「全丢了」。"""
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=timeout) as s:
            s.sendall(('GET %s HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n' % ALIVE_PATH).encode())
            data = b''
            while len(data) < 2048:
                chunk = s.recv(512)
                if not chunk:
                    break
                data += chunk
            body = data.split(b'\r\n\r\n', 1)[-1]
            return APP_TAG.encode() in body
    except Exception:
        return False


def port_free(p):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.35)
        return s.connect_ex(('127.0.0.1', p)) != 0


def find_port(start, span=30):
    for p in range(start, start + span):
        if port_free(p):
            return p
    return None


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass  # 静音

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        if self.path.split('?')[0] == ALIVE_PATH:
            body = json.dumps({'app': APP_TAG, 'port': self.server.server_address[1]}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


def main():
    _safe_console()
    os.chdir(ROOT)

    if not os.path.isfile(os.path.join(ROOT, 'index.html')):
        say('  [X] 当前目录找不到 index.html')
        say('      目录：%s' % ROOT)
        return 2

    # ---- 已经在跑：不再起第二个，直接把浏览器指过去 ----
    if probe_alive(BASE_PORT):
        url = 'http://127.0.0.1:%d/index.html' % BASE_PORT
        say()
        say('  程序已经在运行了，正在为你重新打开页面：')
        say('  %s' % url)
        say('  （不要再开第二个，否则进度会分裂到不同端口下）')
        say()
        if os.environ.get('KR_NO_BROWSER') != '1':
            threading.Thread(target=open_browser, args=(url,), daemon=True).start()
            time.sleep(1.6)
        return 0

    port = find_port(BASE_PORT)
    if port is None:
        say('  [X] %d-%d 端口全被占用，请先关掉占用的程序' % (BASE_PORT, BASE_PORT + 29))
        return 3
    if port != BASE_PORT:
        say('  ! 端口 %d 被别的程序占用，改用 %d' % (BASE_PORT, port))
        say('  ! 注意：换个端口等于换个存档位置，之前的进度不会带过来')

    url = 'http://127.0.0.1:%d/index.html' % port

    # Windows 上 SO_REUSEADDR 的语义和 Unix 不同：它允许两个 socket 抢同一个
    # 端口（后绑的那个常常拿不到连接）。所以只在非 Windows 上开，避免
    # find_port 刚测出「空闲」就被另一个实例抢占。
    socketserver.ThreadingTCPServer.allow_reuse_address = (os.name != 'nt')
    socketserver.ThreadingTCPServer.daemon_threads = True
    try:
        httpd = socketserver.ThreadingTCPServer(('127.0.0.1', port), Handler)
    except OSError as e:
        say('  [X] 无法绑定端口 %d：%s' % (port, e))
        return 4

    say()
    say('  韩语识别型学习  krlearn')
    say('  ' + '-' * 44)
    say('  地址：%s' % url)
    say('  关闭此窗口，或按 Ctrl+C 退出')
    say()

    if os.environ.get('KR_NO_BROWSER') != '1':
        threading.Thread(target=open_browser, args=(url,), daemon=True).start()
    else:
        say('  （已禁用自动打开浏览器，请手动访问上面的地址）')
        say()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        say('\n  已退出')
    finally:
        try:
            httpd.server_close()
        except Exception:
            pass
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        say()
        say('  [X] 启动失败，详情：')
        try:
            traceback.print_exc()
        except Exception:
            pass
        try:
            input('\n  按回车关闭...')
        except Exception:
            pass
        sys.exit(1)

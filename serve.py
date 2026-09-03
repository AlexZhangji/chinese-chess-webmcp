#!/usr/bin/env python3
"""象棋页面的静态服务器。

比普通静态服务器多做三件事:

1. 发 COOP/COEP 两个头。没有这两个头浏览器不给 SharedArrayBuffer,
   Emscripten 的 pthread 版引擎就起不来 (或者退回单线程, 慢好几倍)。

2. 一个可选的 POST /api/board 参考端点, 给回归测试和批量标注用。
   产品里的照片上传已经直接在浏览器运行同一套 ONNX 模型。

3. 标注模式的三个端点 (/api/labelset, /api/labelimg/<name>, /api/label)。
   只在设了 XQ_LABEL_DIR / XQ_LABEL_SET 时有意义, 平时是死的。
"""
import http.server
import json
import socketserver
import os
import sys
from urllib.parse import unquote

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tools'))

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8794
HOST = os.environ.get('XQ_HOST', '127.0.0.1')
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/api/labelset':
            return self._do_labelset()
        if path.startswith('/api/labelimg/'):
            return self._do_labelimg(unquote(path[len('/api/labelimg/'):]))
        return super().do_GET()

    # 引擎和字体是不会变的大文件 (权重 11MB), 必须让浏览器缓存,
    # 否则每次打开都重下一遍 —— 之前整站 no-store, 和 README 里
    # "首次加载后走浏览器缓存" 那句话是相反的。
    IMMUTABLE = ('.wasm', '.nnue', '.woff2', '.onnx')

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'cross-origin')
        path = self.path.split('?')[0].lower()
        if path.endswith(self.IMMUTABLE):
            self.send_header('Cache-Control', 'public, max-age=604800, immutable')
        else:
            # 页面和脚本改得勤, 不缓存
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    # 一张 1600px 的 JPEG base64 之后两三 MB; 16MB 是给意外留的余量, 不是目标
    MAX_BODY = 16 * 1024 * 1024

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ── 标注模式 ──
    # 识别的准确率数字只有在 ground truth 可信时才有意义, 而 ground truth 只能人来定。
    # 与其另做一个标注工具, 不如让确认盘兼任: 用户核对识别结果和标注一批测试图,
    # 是同一个动作 —— 看着原图, 在盘上把错的点改过来。
    # XQ_LABEL_DIR 指向待标的图片目录, XQ_LABEL_SET 指向要写进去的 cases json。
    LABEL_DIR = os.environ.get('XQ_LABEL_DIR', '')
    LABEL_SET = os.environ.get('XQ_LABEL_SET', '')
    IMG_EXT = ('.jpg', '.jpeg', '.png', '.webp')

    def _label_set(self):
        if not self.LABEL_SET or not os.path.exists(self.LABEL_SET):
            return []
        try:
            with open(self.LABEL_SET, encoding='utf-8') as fh:
                return json.load(fh)
        except (ValueError, OSError):
            return []

    def _do_labelset(self):
        if not self.LABEL_DIR or not os.path.isdir(self.LABEL_DIR):
            return self._json(200, {'ok': False, 'error': '没有配 XQ_LABEL_DIR'})
        done = {c.get('img'): c for c in self._label_set()}
        items = []
        for name in sorted(os.listdir(self.LABEL_DIR)):
            if name.lower().endswith(self.IMG_EXT):
                c = done.get(name) or {}
                items.append({'img': name, 'fen': c.get('fen'), 'tag': c.get('tag')})
        return self._json(200, {'ok': True, 'items': items})

    def _do_labelimg(self, name):
        # 只允许目录里那一层的文件名, 不接受任何路径
        if not self.LABEL_DIR or '/' in name or '\\' in name or name.startswith('.'):
            return self._json(404, {'ok': False, 'error': '不是这个目录里的文件'})
        path = os.path.join(self.LABEL_DIR, name)
        if not os.path.isfile(path) or not name.lower().endswith(self.IMG_EXT):
            return self._json(404, {'ok': False, 'error': '没有这张图'})
        with open(path, 'rb') as fh:
            body = fh.read()
        self.send_response(200)
        self.send_header('Content-Type', 'image/jpeg' if name.lower().endswith(('.jpg', '.jpeg'))
                         else 'image/png')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _do_label_save(self, req):
        if not self.LABEL_SET:
            return self._json(200, {'ok': False, 'error': '没有配 XQ_LABEL_SET'})
        img, fen = req.get('img'), (req.get('fen') or '').strip()
        if not img or not fen:
            return self._json(400, {'ok': False, 'error': '要有 img 和 fen'})
        cases = self._label_set()
        for c in cases:
            if c.get('img') == img:
                c['fen'] = fen.split()[0]
                if req.get('tag'):
                    c['tag'] = req['tag']
                break
        else:
            cases.append({'tag': req.get('tag') or os.path.splitext(img)[0],
                          'img': img, 'fen': fen.split()[0]})
        tmp = self.LABEL_SET + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as fh:
            json.dump(cases, fh, ensure_ascii=False, indent=1)
        os.replace(tmp, self.LABEL_SET)   # 原子替换, 免得写一半被读到
        return self._json(200, {'ok': True, 'count': len(cases)})

    def do_POST(self):
        path = self.path.split('?')[0]
        if path == '/api/label':
            try:
                n = int(self.headers.get('Content-Length') or 0)
                req = json.loads(self.rfile.read(n).decode()) if n else {}
            except (ValueError, UnicodeDecodeError) as e:
                return self._json(400, {'ok': False, 'error': str(e)})
            return self._do_label_save(req)
        if path != '/api/board':
            return self._json(404, {'ok': False, 'error': '没有这个端点'})
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            n = 0
        if n <= 0 or n > self.MAX_BODY:
            return self._json(413, {'ok': False, 'error': '请求体大小不对 (%d)' % n})
        try:
            req = json.loads(self.rfile.read(n).decode())
            img = req.get('image')
            # 标注模式下图片本来就在服务器上, 让浏览器再搬一趟纯属浪费
            if not img and req.get('labelimg'):
                name = req['labelimg']
                if '/' in name or '\\' in name or name.startswith('.'):
                    raise ValueError('不是这个目录里的文件')
                img = os.path.join(self.LABEL_DIR, name)
                if not os.path.isfile(img):
                    raise ValueError('没有这张图')
            if not img:
                raise ValueError('没有 image 字段')
        except (ValueError, UnicodeDecodeError) as e:
            return self._json(400, {'ok': False, 'error': str(e)})

        # 每次现 import: 改了识别那边的代码不用重启服务器
        try:
            import importlib
            import base64
            import tempfile
            import board_cv
            importlib.reload(board_cv)

            # 专用本地 ONNX: 四角检测、透视矫正、90 点分类。零外发。
            tmp = None
            path = img if not str(img).startswith('data:') else None
            if path is None:
                head, _, b64 = str(img).partition(',')
                ext = '.png' if 'png' in head else '.jpg'
                fd, tmp = tempfile.mkstemp(suffix=ext)
                with os.fdopen(fd, 'wb') as fh:
                    fh.write(base64.b64decode(b64, validate=False))
                path = tmp
            try:
                if not board_cv.available():
                    res = {'ok': False, 'error': '专用 ONNX 识别器未安装'}
                else:
                    res = board_cv.extract(path)
            finally:
                if tmp:
                    try:
                        os.unlink(tmp)
                    except OSError:
                        pass
        except Exception as e:                      # noqa: BLE001 - 什么都不能让它把服务打死
            sys.stderr.write('识别失败: %r\n' % (e,))
            return self._json(500, {'ok': False, 'error': '%s: %s' % (type(e).__name__, e)})
        return self._json(200, res)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


Handler.extensions_map['.wasm'] = 'application/wasm'
Handler.extensions_map['.js'] = 'text/javascript'

socketserver.TCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer((HOST, PORT), Handler) as httpd:
    print(f'xiangqi on http://{HOST}:{PORT}/', flush=True)
    httpd.serve_forever()

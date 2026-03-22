#!/usr/bin/env python3
"""Unified server: serves AIRI SPA + proxies /api and /health to backend on port 3000."""
import http.server
import os
import sys
import urllib.request
import urllib.error

DIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "apps/stage-web/dist")
BACKEND = "http://127.0.0.1:3000"
ELEVENLABS = "https://api.elevenlabs.io"
UNSPEECH = "http://127.0.0.1:5933"
SYNC_BACKEND = "http://127.0.0.1:3031"

class UnifiedHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=DIST, **kw)

    def _proxy_to_backend(self):
        url = BACKEND + self.path
        headers = {}
        for key, val in self.headers.items():
            if key.lower() in ('host', 'transfer-encoding'):
                continue
            headers[key] = val

        body = None
        content_length = self.headers.get('Content-Length')
        if content_length:
            body = self.rfile.read(int(content_length))

        try:
            req = urllib.request.Request(url, data=body, headers=headers, method=self.command)
            with urllib.request.urlopen(req, timeout=30) as resp:
                self.send_response(resp.status)
                for key, val in resp.getheaders():
                    if key.lower() in ('transfer-encoding', 'connection'):
                        continue
                    self.send_header(key, val)
                # Add CORS headers
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
                self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
                self.end_headers()
                self.wfile.write(resp.read())
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            for key, val in e.headers.items():
                if key.lower() in ('transfer-encoding', 'connection'):
                    continue
                self.send_header(key, val)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(e.read())
        except Exception as e:
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"error":"backend unavailable"}')

    def _is_unspeech_route(self):
        return self.path.startswith('/unspeech/')

    def _proxy_to_unspeech(self):
        real_path = self.path[len('/unspeech'):]
        url = UNSPEECH + real_path
        headers = {}
        for key, val in self.headers.items():
            if key.lower() in ('host', 'transfer-encoding'):
                continue
            headers[key] = val
        body = None
        content_length = self.headers.get('Content-Length')
        if content_length:
            body = self.rfile.read(int(content_length))
        try:
            req = urllib.request.Request(url, data=body, headers=headers, method=self.command)
            with urllib.request.urlopen(req, timeout=30) as resp:
                self.send_response(resp.status)
                for key, val in resp.getheaders():
                    if key.lower() in ('transfer-encoding', 'connection'):
                        continue
                    self.send_header(key, val)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
                self.send_header('Access-Control-Allow-Headers', '*')
                self.end_headers()
                self.wfile.write(resp.read())
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            for key, val in e.headers.items():
                if key.lower() in ('transfer-encoding', 'connection'):
                    continue
                self.send_header(key, val)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(e.read())
        except Exception:
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"error":"unspeech proxy unavailable"}')

    def _is_elevenlabs_route(self):
        return self.path.startswith('/elevenlabs/')

    def _proxy_to_elevenlabs(self):
        # Strip /elevenlabs prefix, forward to real ElevenLabs API
        real_path = self.path[len('/elevenlabs'):]
        url = ELEVENLABS + real_path
        headers = {}
        for key, val in self.headers.items():
            if key.lower() in ('host', 'transfer-encoding'):
                continue
            headers[key] = val
        body = None
        content_length = self.headers.get('Content-Length')
        if content_length:
            body = self.rfile.read(int(content_length))
        try:
            req = urllib.request.Request(url, data=body, headers=headers, method=self.command)
            with urllib.request.urlopen(req, timeout=30) as resp:
                self.send_response(resp.status)
                for key, val in resp.getheaders():
                    if key.lower() in ('transfer-encoding', 'connection'):
                        continue
                    self.send_header(key, val)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
                self.send_header('Access-Control-Allow-Headers', '*')
                self.end_headers()
                self.wfile.write(resp.read())
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            for key, val in e.headers.items():
                if key.lower() in ('transfer-encoding', 'connection'):
                    continue
                self.send_header(key, val)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(e.read())
        except Exception:
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"error":"elevenlabs proxy unavailable"}')

    def _is_sync_route(self):
        return self.path.startswith('/sync/')

    def _proxy_to_sync(self):
        url = SYNC_BACKEND + self.path
        headers = {}
        for key, val in self.headers.items():
            if key.lower() in ('host', 'transfer-encoding'):
                continue
            headers[key] = val
        body = None
        content_length = self.headers.get('Content-Length')
        if content_length:
            body = self.rfile.read(int(content_length))
        try:
            req = urllib.request.Request(url, data=body, headers=headers, method=self.command)
            with urllib.request.urlopen(req, timeout=10) as resp:
                self.send_response(resp.status)
                for key, val in resp.getheaders():
                    if key.lower() in ('transfer-encoding', 'connection'):
                        continue
                    self.send_header(key, val)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(resp.read())
        except Exception:
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"error":"sync server unavailable"}')

    def _is_backend_route(self):
        return self.path.startswith('/api/') or self.path == '/health'

    def end_headers(self):
        # Prevent caching of SW and HTML so updates propagate immediately
        if self.path in ('/sw.js', '/index.html', '/'):
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
        super().end_headers()

    def do_GET(self):
        if self._is_unspeech_route():
            return self._proxy_to_unspeech()
        if self._is_elevenlabs_route():
            return self._proxy_to_elevenlabs()
        if self._is_sync_route():
            return self._proxy_to_sync()
        if self._is_backend_route():
            return self._proxy_to_backend()
        path = os.path.join(DIST, self.path.lstrip("/"))
        if not os.path.exists(path) and not os.path.splitext(self.path)[1]:
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        if self._is_unspeech_route():
            return self._proxy_to_unspeech()
        if self._is_elevenlabs_route():
            return self._proxy_to_elevenlabs()
        if self._is_sync_route():
            return self._proxy_to_sync()
        if self._is_backend_route():
            return self._proxy_to_backend()
        self.send_response(404)
        self.end_headers()

    def do_PUT(self):
        if self._is_backend_route():
            return self._proxy_to_backend()
        self.send_response(404)
        self.end_headers()

    def do_PATCH(self):
        if self._is_backend_route():
            return self._proxy_to_backend()
        self.send_response(404)
        self.end_headers()

    def do_DELETE(self):
        if self._is_backend_route():
            return self._proxy_to_backend()
        self.send_response(404)
        self.end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()

    def log_message(self, fmt, *args):
        pass  # quiet

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3030
    with http.server.HTTPServer(("0.0.0.0", port), UnifiedHandler) as s:
        print(f"Serving AIRI (unified) on http://0.0.0.0:{port}")
        print(f"  Frontend: static files from {DIST}")
        print(f"  Backend:  proxying /api/* → {BACKEND}")
        s.serve_forever()

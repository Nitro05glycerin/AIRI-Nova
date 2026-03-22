#!/usr/bin/env python3
"""Simple SPA-aware static file server."""
import http.server
import os
import sys

DIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "apps/stage-web/dist")

class SPAHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=DIST, **kw)

    def do_GET(self):
        path = os.path.join(DIST, self.path.lstrip("/"))
        if not os.path.exists(path) and not os.path.splitext(self.path)[1]:
            self.path = "/index.html"
        return super().do_GET()

    def log_message(self, fmt, *args):
        pass  # quiet

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3030
    with http.server.HTTPServer(("0.0.0.0", port), SPAHandler) as s:
        print(f"Serving AIRI on http://0.0.0.0:{port}")
        s.serve_forever()

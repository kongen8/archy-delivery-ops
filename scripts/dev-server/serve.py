#!/usr/bin/env python3
"""Dev http server for the Archy app — same as `python3 -m http.server 8765`
but adds `Cache-Control: no-store` so browser disk cache never serves stale
JSX/JS during local dev (the in-browser babel transformer otherwise pinned us
to old code even after edits)."""
import http.server
import socketserver
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

os.chdir(os.path.join(os.path.dirname(__file__), '../../public'))
with socketserver.TCPServer(('', PORT), NoCacheHandler) as httpd:
    print(f'serving public/ on http://localhost:{PORT} (no-store)')
    httpd.serve_forever()

#!/usr/bin/env python3
"""Local development server for Spotter's Companion.

Run from the project folder:   python3 scripts/dev_server.py
Then open:                      http://localhost:8000

It does two things:
  1. Serves the static files (index.html, js/, css/ ...), like `python3 -m http.server`.
  2. Relays API calls: /relay?url=<provider URL>. Some providers don't send CORS headers,
     so a browser page can't read their answers directly. This server fetches the data
     for the page instead. It only relays to the hosts in ALLOWED_HOSTS, and never more
     than once per second, so it can't be misused as an open proxy or hammer a provider.

Only Python's standard library is used, so there is nothing to install.
"""

import http.server
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PORT = 8000
ALLOWED_HOSTS = {"api.adsb.lol", "api.airplanes.live", "api.planespotters.net"}
MIN_GAP_SECONDS = 1.1  # providers ask for at most 1 request per second
USER_AGENT = "SpottersCompanion/1.0 (personal non-commercial project; +https://github.com/Themagicianleo/spotter-companion)"

PROJECT_ROOT = Path(__file__).resolve().parent.parent
_last_upstream = 0.0
_lock = threading.Lock()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        # Serve files from the project root no matter where the script is started from.
        super().__init__(*args, directory=str(PROJECT_ROOT), **kwargs)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/relay":
            self.relay(urllib.parse.parse_qs(parsed.query).get("url", [""])[0])
        else:
            super().do_GET()

    def relay(self, target):
        global _last_upstream
        host = urllib.parse.urlparse(target).hostname
        if not target.startswith("https://") or host not in ALLOWED_HOSTS:
            self.send_error(400, "Relay only allows: " + ", ".join(sorted(ALLOWED_HOSTS)))
            return

        # Space out upstream requests (the lock makes parallel requests wait their turn).
        with _lock:
            wait = _last_upstream + MIN_GAP_SECONDS - time.time()
            if wait > 0:
                time.sleep(wait)
            _last_upstream = time.time()

        request = urllib.request.Request(target, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=12) as upstream:
                status, body = upstream.status, upstream.read()
                retry_after = None
        except urllib.error.HTTPError as err:  # provider answered with an error code
            status, body = err.code, err.read()
            retry_after = err.headers.get("Retry-After")
        except Exception as err:  # provider unreachable
            self.send_error(502, f"Relay could not reach provider: {err}")
            return

        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if retry_after:
            self.send_header("Retry-After", retry_after)
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    print(f"Serving {PROJECT_ROOT} at http://localhost:{PORT}  (Ctrl+C to stop)")
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

"""
VATFLOW Tower Cab - web page mirror for an in-cab screen (Windows).

Some pages can't run inside MSFS's instrument browser: they need a real login (VATSIM
SSO) or a modern browser. This opens the page in Microsoft Edge on your PC, keeps it
there, and serves a picture of it to the cab screen several times a second. Clicks and
scrolling on the cab screen are passed back to the page, so it stays usable.

  python web_mirror.py                      the vZDC IDS for KDCA (the TMU desk's third screen)
  python web_mirror.py <url> [port]         any page

The first time, log in in the Edge window that opens (VATSIM SSO). The login is kept in
the "browser-profile" folder next to this file, so later runs are already logged in.
Then minimize the window (don't close it): closing it stops the cab screen.

Needs:  pip install playwright   (uses the Edge already on Windows; no browser download)
The cab screen reads http://127.0.0.1:8777 (common/airport.js, mirror.base).
"""

import http.server
import json
import os
import queue
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_URL = "https://ids.vzdc.org/app/airport/KDCA"
DEFAULT_PORT = 8777
SCREEN_W, SCREEN_H = 1024, 768    # the cab screen (panel.cfg); clicks arrive in these pixels
# The page is laid out in a bigger window and the picture scaled down to the screen: the
# IDS refuses windows narrower than a desktop monitor. Same 4:3 shape as the screen.
WIDTH, HEIGHT = int(os.environ.get("VATFLOW_MIRROR_WIDTH", 1600)), 0
HEIGHT = WIDTH * SCREEN_H // SCREEN_W
FRAME_EVERY_S = 0.5
PROFILE = os.path.join(HERE, "browser-profile")


class Shared:
    def __init__(self):
        self.frame = None              # latest JPEG bytes
        self.frame_time = 0.0
        self.title = ""
        self.inputs = queue.Queue()     # ("click", x, y) / ("scroll", dy) from the cab screen
        self.lock = threading.Lock()


def make_handler(shared):
    class Handler(http.server.BaseHTTPRequestHandler):
        def _send(self, code, body, ctype):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            self._send(204, b"", "text/plain")

        def do_GET(self):
            path = self.path.split("?")[0]
            if path == "/frame.jpg":
                with shared.lock:
                    frame = shared.frame
                if frame is None:
                    self._send(503, b"no frame yet", "text/plain")
                else:
                    self._send(200, frame, "image/jpeg")
            elif path == "/status":
                with shared.lock:
                    st = {"ok": shared.frame is not None, "age": round(time.time() - shared.frame_time, 1),
                          "title": shared.title, "pageWidth": WIDTH, "pageHeight": HEIGHT}
                self._send(200, json.dumps(st).encode(), "application/json")
            else:
                self._send(404, b"not found", "text/plain")

        def do_POST(self):
            n = int(self.headers.get("Content-Length") or 0)
            try:
                data = json.loads(self.rfile.read(n) or b"{}")
            except ValueError:
                data = {}
            path = self.path.split("?")[0]
            if path == "/click" and "x" in data and "y" in data:
                shared.inputs.put(("click", float(data["x"]), float(data["y"])))
            elif path == "/scroll" and "dy" in data:
                shared.inputs.put(("scroll", float(data["dy"])))
            self._send(204, b"", "text/plain")

        def log_message(self, fmt, *args):  # keep the console quiet
            pass

    return Handler


def main(argv):
    url = argv[1] if len(argv) > 1 else DEFAULT_URL
    port = int(argv[2]) if len(argv) > 2 else DEFAULT_PORT
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.exit("Playwright is not installed: run 1-setup.bat again (or  pip install playwright).")

    shared = Shared()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), make_handler(shared))
    threading.Thread(target=server.serve_forever, daemon=True).start()

    with sync_playwright() as pw:
        # VATFLOW_MIRROR_TEST=<chromium path> runs it headless with that browser (tests only)
        test_browser = os.environ.get("VATFLOW_MIRROR_TEST")
        launch = {"executable_path": test_browser, "headless": True} if test_browser else \
            {"channel": "msedge", "headless": False}
        ctx = pw.chromium.launch_persistent_context(
            os.environ.get("VATFLOW_MIRROR_PROFILE", PROFILE), **launch,
            viewport={"width": WIDTH, "height": HEIGHT},
            # keep drawing while the window is minimized or covered by the sim
            args=["--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
                  "--disable-background-timer-throttling"])
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(url)
        print("Mirroring %s to the cab screen (http://127.0.0.1:%d)." % (url, port))
        print("First time: log in in the Edge window. Then minimize it - don't close it.")
        print("Close this window (or press Ctrl+C) to stop.")
        try:
            while True:
                if page.is_closed():
                    page = ctx.pages[0] if ctx.pages else ctx.new_page()
                    page.goto(url)
                while not shared.inputs.empty():
                    item = shared.inputs.get()
                    try:
                        if item[0] == "click":       # screen pixels -> page pixels
                            page.mouse.click(item[1] * WIDTH / SCREEN_W, item[2] * HEIGHT / SCREEN_H)
                        else:
                            page.mouse.move(WIDTH / 2, HEIGHT / 2)
                            page.mouse.wheel(0, item[1])
                    except Exception as e:  # a click on a page that is navigating
                        print("  (input skipped: %s)" % e)
                try:
                    jpg = page.screenshot(type="jpeg", quality=75)
                    with shared.lock:
                        shared.frame, shared.frame_time, shared.title = jpg, time.time(), page.title()
                except Exception as e:  # page navigating / login redirect
                    print("  (no picture right now: %s)" % e)
                time.sleep(FRAME_EVERY_S)
        except KeyboardInterrupt:
            pass
        finally:
            server.shutdown()
            ctx.close()


if __name__ == "__main__":
    main(sys.argv)

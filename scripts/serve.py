#!/usr/bin/env python3
"""Static file server with HTTP Range support for local PMTiles preview.

Python's stdlib http.server returns 200 OK for Range requests, which the
pmtiles.js client rejects. This handler returns 206 Partial Content with
a proper Content-Range header.
"""
import http.server
import os
import re
import socketserver
import subprocess
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class RangeHandler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        rng = self.headers.get("Range")
        if not rng:
            return super().send_head()

        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            return super().send_head()

        m = re.match(r"bytes=(\d+)-(\d*)", rng)
        if not m:
            return super().send_head()

        size = os.path.getsize(path)
        start = int(m.group(1))
        end = int(m.group(2)) if m.group(2) else size - 1
        end = min(end, size - 1)
        if start > end:
            self.send_error(416, "Requested Range Not Satisfiable")
            return None

        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self._range_remaining = end - start + 1
        return f

    def copyfile(self, source, outputfile):
        remaining = getattr(self, "_range_remaining", None)
        if remaining is None:
            return super().copyfile(source, outputfile)
        while remaining > 0:
            chunk = source.read(min(64 * 1024, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)


class ReusableServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


if __name__ == "__main__":
    os.chdir(os.path.join(os.path.dirname(__file__), ".."))
    subprocess.check_call(["bash", "scripts/assemble-tiles.sh"])
    with ReusableServer(("127.0.0.1", PORT), RangeHandler) as httpd:
        print(f"serving at http://127.0.0.1:{PORT}")
        httpd.serve_forever()

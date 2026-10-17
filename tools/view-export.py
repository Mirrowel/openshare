#!/usr/bin/env python3
"""Open(code)Share view-export: view any exported opencode session locally.

Serves the real share viewer (the vendored upstream page, share-viewer/dist)
on localhost with the exported session(s) injected, exactly like a live
share page: same rendering, same 11 views, subagent pages included when the
exports cover the family.

No crypto, no network beyond localhost. (The encrypted artifact pipeline is
the agent deployment's expansion; this tool is the plain local viewer.)

Usage:
  view-export.py                       newest session in the local opencode db
                                       (plus its subagent family)
  view-export.py --session-id ID       that session (plus family)
  view-export.py file.json [more...]   one or more `opencode export` JSON files
                                       (gzip accepted); several files merge into
                                       one view (main + children)
Options:
  --port N          localhost port (default 7789)
  --no-open         do not open the browser
  --dist PATH       viewer dist override (default: ../share-viewer/dist next to
                   this script, or OPENSHARE_VIEWER_DIST env)
  --model-label T   label template, $Provider/$Model placeholders (default);
                   literal text passes through; empty string hides the model
  --db PATH         opencode db override (default discovery otherwise)
"""

import argparse
import gzip
import json
import os
import subprocess
import sys
import threading
import urllib.parse
import webbrowser
from pathlib import Path


# ----------------------------------------------------------------------------
# export JSON -> share Data[] items (the one data contract: the same items the
# live plugin streams, the viewer renders, and the passive artifacts carry)
# ----------------------------------------------------------------------------

def format_label(template: str, model: dict) -> str:
    if template == "":
        return ""
    if not model:
        return template
    return (template
            .replace("$Provider", model.get("providerID") or "")
            .replace("$provider", model.get("providerID") or "")
            .replace("$Model", model.get("modelID") or "")
            .replace("$model", model.get("modelID") or ""))


def export_to_data(export: dict, session_id: str, label_template: str) -> list[dict]:
    """v1 {info, messages:[{info, parts[]}]} -> [{type, data}] items."""
    items: list[dict] = []
    info = export.get("info")
    if info:
        items.append({"type": "session", "data": info})
    for m in export.get("messages") or []:
        minfo = m.get("info") or {}
        items.append({"type": "message", "data": minfo})
        if minfo.get("role") == "user" and minfo.get("model"):
            model = minfo["model"]
            label = format_label(label_template, model)
            items.append({
                "type": "model",
                "sessionID": session_id,
                "data": [{
                    "id": model.get("modelID"),
                    "providerID": model.get("providerID"),
                    "name": label,
                }],
            })
        for part in m.get("parts") or []:
            items.append({"type": "part", "data": part})
    return items


def load_export_file(path: Path) -> dict:
    raw = path.read_bytes()
    if raw[:2] == b"\x1f\x8b" or path.suffix == ".gz":
        raw = gzip.decompress(raw)
    text = raw.decode("utf-8", errors="replace")
    i = text.find("{")
    if i < 0:
        sys.exit(f"error: no JSON found in {path}")
    try:
        return json.loads(text[i:])
    except json.JSONDecodeError as exc:
        sys.exit(f"error: {path}: JSON parse failed: {exc}")


# ----------------------------------------------------------------------------
# optional discovery: newest session + subagent family from the opencode db
# ----------------------------------------------------------------------------

def find_db(explicit: str | None) -> Path:
    if explicit:
        p = Path(explicit)
        if not p.exists():
            sys.exit(f"error: db not found: {p}")
        return p
    base = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    p = Path(base) / "opencode" / "opencode.db"
    if not p.exists():
        sys.exit("error: opencode db not found (pass --db or export files)")
    return p


def newest_session_id(db: Path) -> str:
    import sqlite3
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        row = con.execute(
            "SELECT id FROM session ORDER BY time_updated DESC LIMIT 1"
        ).fetchone()
    finally:
        con.close()
    if not row or not row[0]:
        sys.exit("error: no sessions found in the opencode db")
    return str(row[0])


def session_family(db: Path, main_id: str) -> list[str]:
    """The main session plus every session whose root ancestor is the main."""
    import sqlite3
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            rows = con.execute("SELECT id, parent_id FROM session").fetchall()
        finally:
            con.close()
    except Exception:
        return [main_id]
    parent = {sid: (pid or None) for sid, pid in rows}

    def root_of(sid: str) -> str:
        seen = set()
        while parent.get(sid) and sid not in seen:
            seen.add(sid)
            sid = parent[sid]
        return sid

    return [sid for sid in parent if sid == main_id or root_of(sid) == main_id]


def opencode_export(session_id: str, exe: str) -> dict:
    cmd = [exe] if exe else ["opencode"]
    cmd += ["export", session_id]
    # capture BYTES + decode UTF-8 explicitly: text=True uses the locale
    # codec on Windows and dies on non-ASCII content (live-caught upstream)
    p = subprocess.run(cmd, capture_output=True, timeout=300)
    if p.returncode != 0:
        sys.exit(f"error: opencode export failed: "
                 f"{p.stderr.decode('utf-8', errors='replace').strip()[:400]}")
    raw = p.stdout.decode("utf-8", errors="replace")
    i = raw.find("{")
    if i < 0:
        sys.exit("error: export produced no JSON")
    try:
        return json.loads(raw[i:])
    except json.JSONDecodeError as exc:
        sys.exit(f"error: export JSON parse failed: {exc}")


# ----------------------------------------------------------------------------
# local viewer server (serves share-viewer/dist + the injected snapshot)
# ----------------------------------------------------------------------------

def find_viewer_dist(explicit: str | None) -> Path:
    candidates = []
    if explicit:
        candidates.append(Path(explicit))
    if os.environ.get("OPENSHARE_VIEWER_DIST"):
        candidates.append(Path(os.environ["OPENSHARE_VIEWER_DIST"]))
    candidates.append(Path(__file__).resolve().parent.parent / "share-viewer" / "dist")
    for c in candidates:
        if (c / "index.html").exists():
            return c
    sys.exit("error: viewer dist not found (build share-viewer first: "
             "npm install && npm run build), or pass --dist")


def serve(dist: Path, snapshot_json: str, main_id: str, port: int) -> None:
    import http.server

    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def _send(self, code, ctype, body, cache=True):
            self.send_response(code)
            self.send_header("content-type", ctype)
            self.send_header("content-length", str(len(body)))
            if cache:
                self.send_header("cache-control", "max-age=3600")
            self.end_headers()
            # chunked write: one huge socket write on Windows loopback
            # resets the connection for multi-MB bodies
            for i in range(0, len(body), 65536):
                self.wfile.write(body[i:i + 65536])

        def do_GET(self):
            try:
                self._route(urllib.parse.urlparse(self.path).path)
            except BrokenPipeError:
                pass
            except Exception as exc:
                try:
                    body = f"handler error: {exc}".encode()
                    self.send_response(500)
                    self.send_header("content-type", "text/plain")
                    self.send_header("content-length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                except Exception:
                    pass

        def _route(self, path):
            if path in ("/", "/index.html", "/s", "/s/"):
                self.send_response(302)
                self.send_header("location", f"/s/{main_id}")
                self.send_header("content-length", "0")
                self.end_headers()
                return
            if path == "/branding":
                self._send(200, "application/json", b"{}")
                return
            if urllib.parse.urlparse(self.path).path.startswith("/s/"):
                html = (dist / "index.html").read_text(encoding="utf-8")
                inject = (f'<script>window.__MIRROBOT_SNAPSHOT__ = '
                          f'{snapshot_json};</script>')
                # plain string insert: the payload JSON contains regex
                # escapes like \u that re.sub would misread
                html = html.replace('<script type="module"',
                                    inject + '<script type="module"', 1)
                self._send(200, "text/html; charset=utf-8",
                           html.encode("utf-8"), cache=False)
                return
            rel = path.lstrip("/")
            f = dist / rel
            if f.exists() and f.is_file() and f.resolve().is_relative_to(dist.resolve()):
                ctype = "application/javascript" if f.suffix == ".js" else (
                    "text/css" if f.suffix == ".css" else (
                        "image/svg+xml" if f.suffix == ".svg" else (
                            "font/woff2" if f.suffix == ".woff2" else "application/octet-stream")))
                self._send(200, ctype, f.read_bytes())
                return
            self._send(404, "text/plain", b"not found")

    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), H)
    print(f"viewing at http://127.0.0.1:{port}/s/{main_id} (Ctrl+C to stop)")
    httpd.serve_forever()


# ----------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------

def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("files", nargs="*", help="opencode export JSON file(s)")
    ap.add_argument("--session-id", default=None)
    ap.add_argument("--port", type=int, default=7789)
    ap.add_argument("--no-open", action="store_true")
    ap.add_argument("--dist", default=None)
    ap.add_argument("--model-label", default=os.environ.get("SHARE_MODEL_LABEL", "$Provider/$Model"))
    ap.add_argument("--db", default=None)
    ap.add_argument("--opencode", default=None)
    args = ap.parse_args(argv[1:])

    dist = find_viewer_dist(args.dist)
    exports: list[tuple[str, dict]] = []  # (session_id, export)

    if args.files:
        for fp in args.files:
            ex = load_export_file(Path(fp))
            sid = (ex.get("info") or {}).get("id") or Path(fp).stem
            exports.append((sid, ex))
    elif args.session_id or not args.files:
        db = find_db(args.db)
        sid = args.session_id or newest_session_id(db)
        family = session_family(db, sid)
        print(f"exporting {len(family)} session(s): {', '.join(family)}")
        for s in family:
            exports.append((s, opencode_export(s, args.opencode)))

    if not exports:
        sys.exit("error: nothing to view")

    # main session: the one without a parent among the set, else the first
    ids = {sid for sid, _ in exports}
    main_id = next((sid for sid, ex in exports
                    if not (ex.get("info") or {}).get("parentID")
                    or (ex.get("info") or {}).get("parentID") not in ids),
                   exports[0][0])

    items: list[dict] = []
    for sid, ex in exports:
        items.extend(export_to_data(ex, sid, args.model_label))
    if not items:
        sys.exit("error: exports contained no items")

    # the </ escape keeps the payload from closing the script tag
    snapshot_json = json.dumps(
        {"items": items, "sessionID": main_id},
        ensure_ascii=False).replace("</", "<\\/")

    url = f"http://127.0.0.1:{args.port}/s/{main_id}"
    print(f"{len(items)} items, {len(exports)} session(s), main {main_id}")

    t = threading.Thread(
        target=serve, args=(dist, snapshot_json, main_id, args.port), daemon=True)
    t.start()
    if not args.no_open:
        webbrowser.open(url)
    try:
        t.join()
    except KeyboardInterrupt:
        print("\nbye")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

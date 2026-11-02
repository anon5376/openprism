#!/usr/bin/env python3
"""The local server: python3 app/server.py [--port 8771]. It listens on this machine only."""
from __future__ import annotations

import argparse
import hmac
import json
import os
import re
import secrets
import shutil
import sys
import tempfile
import threading
import uuid
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from assistant import (DEFAULT_EFFORT, EFFORTS, SYSTEM_PROMPT, TYPES, Keychain, Proposals, Providers,  # noqa: E402
                       Request, list_models, plain_history, run_turn, scrub)
from core import AppError, Project, copy_project, export_zip, import_zip  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "web", "dist")
MAX_JSON = 16 * 1024 * 1024
MAX_ZIP_UPLOAD = 512 * 1024 * 1024
CSP = ("default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; "
       "base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".wasm": "application/wasm",
        ".map": "application/json"}
STARTER = r"""\documentclass{article}
\title{Untitled}
\begin{document}
\maketitle

\section{Introduction}
Write here.

\end{document}
"""


APPEARANCE_CHOICES = {"theme": ("system", "dark", "light"), "motion": ("full", "reduced", "none")}
APPEARANCE_RANGES = {"uiSize": (11, 18), "editorSize": (10, 24), "editorLeading": (1.2, 2.4), "corners": (0, 2)}
APPEARANCE_COLORS = ("accent", "background", "panel", "text")
APPEARANCE_FONTS = ("uiFont", "editorFont")


def clean_settings(data: dict) -> dict:
    """Settings end up in the page's CSS and in requests, so only known keys with sane values are kept."""
    clean: dict = {}
    appearance = data.get("appearance")
    if isinstance(appearance, dict):
        clean["appearance"] = {}
        for name, value in appearance.items():
            if name in APPEARANCE_CHOICES:
                good = value in APPEARANCE_CHOICES[name]
            elif name in APPEARANCE_RANGES:
                low, high = APPEARANCE_RANGES[name]
                good = isinstance(value, (int, float)) and not isinstance(value, bool) and low <= value <= high
            elif name in APPEARANCE_COLORS:
                good = isinstance(value, str) and re.fullmatch(r"|#[0-9a-fA-F]{6}", value) is not None
            elif name in APPEARANCE_FONTS:
                good = isinstance(value, str) and re.fullmatch(r"[\w .,'\"-]{0,80}", value) is not None
            else:
                good = False
            if not good:
                raise AppError("bad_setting", f"That value for {str(name)[:40]} cannot be used.")
            clean["appearance"][name] = value
    selection = data.get("selection")
    if isinstance(selection, dict):
        fields = {name: selection.get(name) or "" for name in ("provider", "model", "name")}
        if not all(isinstance(value, str) and len(value) <= 200 for value in fields.values()):
            raise AppError("bad_setting", "That model choice cannot be used.")
        clean["selection"] = fields
    if "effort" in data:
        if data["effort"] not in EFFORTS:
            raise AppError("bad_setting", "That effort level does not exist.")
        clean["effort"] = data["effort"]
    return clean


class App:
    def __init__(self, home: str, projects_dir: str, port: int):
        self.home = home
        self.projects_dir = projects_dir
        self.port = port
        os.makedirs(home, mode=0o700, exist_ok=True)
        self.token = self._load_token()
        self.keychain = Keychain()
        self.providers = Providers(os.path.join(home, "providers.json"), self.keychain)
        self.proposals = Proposals()
        self.projects: dict[str, Project] = {}
        self.conversations: dict[str, dict] = {}
        self.requests: dict[str, Request] = {}
        self.lock = threading.Lock()

    def _load_token(self) -> str:
        path = os.path.join(self.home, "token")
        try:
            with open(path, encoding="utf-8") as handle:
                token = handle.read().strip()
            if token:
                return token
        except FileNotFoundError:
            pass
        token = secrets.token_urlsafe(32)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(token)
        return token

    def open_project(self, path: str) -> dict:
        project = Project(path)
        with self.lock:
            project = self.projects.setdefault(project.root, project)
        self._remember(project.root)
        return self.describe(project)

    def project(self, data: dict) -> Project:
        project = self.projects.get(data.get("project") or "")
        if project is None:
            raise AppError("not_open", "That project is not open.")
        return project

    def describe(self, project: Project) -> dict:
        return {"root": project.root, "name": project.name, "main": project.main_file_detect(),
                "tree": project.tree()}

    def new_project_dir(self, name: str) -> str:
        slug = re.sub(r"[^A-Za-z0-9._ -]+", "", name or "").strip(" .") or "project"
        os.makedirs(self.projects_dir, exist_ok=True)
        path = os.path.join(self.projects_dir, slug)
        counter = 2
        while os.path.exists(path):
            path = os.path.join(self.projects_dir, f"{slug} {counter}")
            counter += 1
        return path

    def project_rows(self) -> list[dict]:
        paths = list(self.recent())
        if os.path.isdir(self.projects_dir):
            for entry in os.scandir(self.projects_dir):
                if entry.is_dir(follow_symlinks=False) and not entry.name.startswith("."):
                    paths.append(os.path.realpath(entry.path))
        rows = {}
        for path in paths:
            if path not in rows and os.path.isdir(path):
                rows[path] = {"path": path, "name": os.path.basename(path), "modified": int(os.path.getmtime(path))}
        return sorted(rows.values(), key=lambda row: -row["modified"])

    def duplicate(self, project: Project) -> dict:
        dest = self.new_project_dir(f"{project.name} copy")
        os.makedirs(dest)
        copy_project(project, dest)
        return self.open_project(dest)

    def rename(self, project: Project, name: str) -> dict:
        name = (name or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9._ -]+", name) or name.startswith("."):
            raise AppError("bad_name", "Use letters, digits, spaces, dots, dashes or underscores.")
        target = os.path.join(os.path.dirname(project.root), name)
        if os.path.exists(target):
            raise AppError("bad_name", "A folder with that name already exists.")
        if project.compile_lock.locked():
            raise AppError("busy", "A compile is running.")
        os.rename(project.root, target)
        with self.lock:
            self.projects.pop(project.root, None)
        self._forget(project.root)
        return self.open_project(target)

    def _settings_path(self) -> str:
        return os.path.join(self.home, "settings.json")

    def settings(self) -> dict:
        try:
            with open(self._settings_path(), encoding="utf-8") as handle:
                return json.load(handle)
        except (FileNotFoundError, ValueError):
            return {}

    def save_settings(self, data: dict) -> dict:
        settings = self.settings()
        settings.update(clean_settings(data))
        tmp = self._settings_path() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(settings, handle, indent=2)
        os.replace(tmp, self._settings_path())
        return settings

    def _instructions_path(self) -> str:
        return os.path.join(self.home, "instructions.txt")

    def instructions(self) -> str:
        try:
            with open(self._instructions_path(), encoding="utf-8") as handle:
                return handle.read().strip() or SYSTEM_PROMPT
        except FileNotFoundError:
            return SYSTEM_PROMPT

    def save_instructions(self, text: str) -> None:
        text = (text or "").strip()
        if not text or text == SYSTEM_PROMPT:
            if os.path.exists(self._instructions_path()):
                os.unlink(self._instructions_path())
            return
        with open(self._instructions_path(), "w", encoding="utf-8") as handle:
            handle.write(text)

    def _recent_path(self) -> str:
        return os.path.join(self.home, "recent.json")

    def recent(self) -> list[str]:
        try:
            with open(self._recent_path(), encoding="utf-8") as handle:
                return [p for p in json.load(handle) if os.path.isdir(p)]
        except (FileNotFoundError, ValueError):
            return []

    def _remember(self, root: str) -> None:
        self._write_recent([root] + [p for p in self.recent() if p != root])

    def _forget(self, root: str) -> None:
        self._write_recent([p for p in self.recent() if p != root])

    def _write_recent(self, rows: list[str]) -> None:
        with open(self._recent_path(), "w", encoding="utf-8") as handle:
            json.dump(rows[:50], handle)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "openprism"
    sys_version = ""
    app: App

    def log_message(self, fmt, *args):
        pass

    def log_request(self, code="-", size="-"):
        # Failures only, and only the path, because a query string can hold the session token.
        if str(code)[:1] in "45":
            sys.stderr.write(f"{self.command} {urlsplit(self.path).path} -> {code}\n")

    # Plumbing

    def _send(self, status: int, body: bytes, content_type: str, extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self._common_headers()
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def _common_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")

    def _json(self, data, status: int = 200) -> None:
        self._send(status, json.dumps(data).encode(), "application/json")

    def _error(self, err: AppError, status: int = 400) -> None:
        self._json({"error": {"code": err.code, "message": err.message}}, status)

    def _host_ok(self) -> bool:
        allowed = {f"127.0.0.1:{self.app.port}", f"localhost:{self.app.port}"}
        return self.headers.get("Host") in allowed

    def _cookie_name(self) -> str:
        return f"openprism_{self.app.port}"

    def _authed(self) -> bool:
        supplied = self.headers.get("X-OpenPrism-Token")
        if not supplied:
            cookie = SimpleCookie(self.headers.get("Cookie") or "")
            morsel = cookie.get(self._cookie_name())
            supplied = morsel.value if morsel else None
        return bool(supplied) and hmac.compare_digest(supplied, self.app.token)

    def _origin_ok(self) -> bool:
        origin = self.headers.get("Origin")
        return origin is None or origin == f"http://{self.headers.get('Host')}"

    def _read_body(self, limit: int) -> bytes:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length < 0 or length > limit:
            self.close_connection = True
            raise AppError("too_large", "That request is too large.")
        return self.rfile.read(length)

    # Streams are chunked NDJSON: one event per line.

    def _start_stream(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Transfer-Encoding", "chunked")
        self._common_headers()
        self.end_headers()

    def _emit(self, event: dict) -> None:
        data = (json.dumps(event) + "\n").encode()
        self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
        self.wfile.flush()

    def _end_stream(self) -> None:
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    # GET

    def do_GET(self):
        if not self._host_ok():
            return self._send(403, b"Wrong host", "text/plain")
        parts = urlsplit(self.path)
        query = parse_qs(parts.query)
        supplied = (query.get("t") or [""])[0]
        if parts.path == "/" and supplied:
            if not hmac.compare_digest(supplied, self.app.token):
                return self._send(401, b"Wrong link. Use the one printed in the terminal.", "text/plain")
            cookie = f"{self._cookie_name()}={self.app.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000"
            return self._send(303, b"", "text/plain", {"Location": "/", "Set-Cookie": cookie})
        if not self._authed():
            return self._send(401, b"Open the link printed in the terminal where OpenPrism started.", "text/plain")
        if parts.path == "/":
            return self._static("index.html", {"Content-Security-Policy": CSP})
        if parts.path.startswith("/static/"):
            return self._static(parts.path[len("/static/"):])
        try:
            if parts.path == "/api/pdf":
                return self._get_pdf(query)
            if parts.path == "/api/project/export":
                return self._get_export(query)
        except AppError as err:
            return self._error(err)
        return self._send(404, b"Not found", "text/plain")

    def _static(self, rel: str, extra: dict | None = None) -> None:
        full = os.path.realpath(os.path.join(DIST, rel))
        if not full.startswith(os.path.realpath(DIST) + os.sep) or not os.path.isfile(full):
            return self._send(404, b"Not found", "text/plain")
        with open(full, "rb") as handle:
            body = handle.read()
        self._send(200, body, MIME.get(os.path.splitext(full)[1], "application/octet-stream"), extra)

    def _get_pdf(self, query: dict) -> None:
        project = self.app.project({"project": (query.get("project") or [""])[0]})
        path = project.last["pdf"] if project.last else None
        if not path or not os.path.exists(path):
            raise AppError("no_pdf", "There is no PDF yet.")
        with open(path, "rb") as handle:
            self._send(200, handle.read(), "application/pdf")

    def _get_export(self, query: dict) -> None:
        project = self.app.project({"project": (query.get("project") or [""])[0]})
        with tempfile.TemporaryDirectory() as tmp:
            dest = os.path.join(tmp, "export.zip")
            export_zip(project, dest)
            with open(dest, "rb") as handle:
                body = handle.read()
        name = re.sub(r"[^A-Za-z0-9._-]+", "-", project.name) or "project"
        self._send(200, body, "application/zip", {"Content-Disposition": f'attachment; filename="{name}.zip"'})

    # POST

    def do_POST(self):
        if not self._host_ok() or not self._origin_ok():
            return self._send(403, b"Refused", "text/plain")
        if not self._authed():
            return self._send(401, b"Not signed in", "text/plain")
        path = urlsplit(self.path).path
        try:
            if path == "/api/project/import":
                return self._post_import()
            if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
                raise AppError("bad_request", "Send JSON.")
            data = json.loads(self._read_body(MAX_JSON) or b"{}")
            if not isinstance(data, dict):
                raise AppError("bad_request", "Send a JSON object.")
            if path == "/api/compile":
                return self._post_compile(data)
            if path == "/api/assistant/send":
                return self._post_send(data)
            handler = ROUTES.get(path)
            if handler is None:
                return self._send(404, b"Not found", "text/plain")
            return self._json(handler(self.app, data))
        except AppError as err:
            return self._error(err)
        except ValueError:
            return self._error(AppError("bad_request", "That request could not be read."))

    def _post_import(self) -> None:
        name = (parse_qs(urlsplit(self.path).query).get("name") or ["project"])[0]
        stem = os.path.splitext(os.path.basename(name))[0]
        body = self._read_body(MAX_ZIP_UPLOAD)
        dest = self.app.new_project_dir(stem)
        with tempfile.TemporaryDirectory() as tmp:
            upload = os.path.join(tmp, "upload.zip")
            with open(upload, "wb") as handle:
                handle.write(body)
            import_zip(upload, dest)
        self._json(self.app.open_project(dest))

    def _post_compile(self, data: dict) -> None:
        project = self.app.project(data)
        main = data.get("main")
        streaming = [False]

        def on_line(line: str) -> None:
            if streaming[0]:
                try:
                    self._emit({"type": "line", "text": line})
                except OSError:
                    # The page went away, so nobody is waiting for this compile.
                    streaming[0] = False
                    project.cancel()

        if not project.compile_lock.locked():
            self._start_stream()
            streaming[0] = True
        else:
            raise AppError("busy", "A compile is already running.")
        try:
            result = project.compile(main, on_line)
            event = {"type": "result", **result}
        except AppError as err:
            event = {"type": "error", "code": err.code, "message": err.message}
        if streaming[0]:
            self._emit(event)
            self._end_stream()

    def _post_send(self, data: dict) -> None:
        app = self.app
        project = app.project(data)
        provider = app.providers.get(data.get("provider") or "")
        if not provider.get("consented"):
            raise AppError("needs_consent", "Confirm what gets sent to this provider first.")
        key = app.keychain.get(provider["id"])
        if not key:
            raise AppError("no_key", "This provider has no API key yet. Add it in Settings.")
        text = (data.get("text") or "").strip()
        if not text:
            raise AppError("bad_request", "Write a message first.")
        model = data.get("model")
        if not isinstance(model, str) or not 0 < len(model.strip()) <= 200:
            raise AppError("no_model", "Choose a model first.")
        effort = data.get("effort") or DEFAULT_EFFORT
        if effort not in EFFORTS:
            raise AppError("bad_request", "That effort level does not exist.")
        provider = {**provider, "model": model.strip(), "effort": effort}
        conversation_id = data.get("conversation")
        row = app.conversations.get(conversation_id or "")
        if row is None or row["project"] != project.root:
            conversation_id = uuid.uuid4().hex
            row = {"project": project.root, "messages": [], "lock": threading.Lock()}
            app.conversations[conversation_id] = row
        if not row["lock"].acquire(blocking=False):
            raise AppError("busy", "The assistant is already answering.")
        answered_by = (provider["id"], provider["model"])
        if row["messages"] and row.get("answered_by") != answered_by:
            row["messages"] = plain_history(row["messages"])
        row["answered_by"] = answered_by
        req = Request()
        app.requests[req.id] = req
        alive = [True]

        def emit(event: dict) -> None:
            if not alive[0]:
                return
            try:
                self._emit(json.loads(scrub(json.dumps(event), key)))
            except OSError:
                alive[0] = False
                req.stop()

        try:
            self._start_stream()
            emit({"type": "start", "request": req.id, "conversation": conversation_id})
            try:
                run_turn(project, provider, key, row["messages"], text, data.get("context") or {}, app.proposals,
                         emit, req, app.instructions())
                emit({"type": "done", "stopped": req.stopped.is_set()})
            except AppError as err:
                emit({"type": "error", "code": err.code, "message": scrub(err.message, key)})
            if alive[0]:
                self._end_stream()
        finally:
            app.requests.pop(req.id, None)
            row["lock"].release()


# JSON routes. Each takes the app and the request's data, and returns what goes back.

def _project_new(app, d):
    path = app.new_project_dir(d.get("name"))
    os.makedirs(path)
    with open(os.path.join(path, "main.tex"), "w", encoding="utf-8") as handle:
        handle.write(STARTER)
    return app.open_project(path)


def _state(app, d):
    return {"providers": app.providers.list(), "projects": app.project_rows(), "projects_dir": app.projects_dir,
            "settings": app.settings()}


def _synctex_to_pdf(app, d):
    return {"target": app.project(d).synctex_to_pdf(d.get("rel"), d.get("line"))}


def _synctex_to_source(app, d):
    return {"target": app.project(d).synctex_to_source(d.get("page"), d.get("x"), d.get("y"))}


def _key_set(app, d):
    app.providers.get(d.get("provider") or "")
    app.keychain.set(d["provider"], d.get("key"))
    return {"has_key": True}


def _key_delete(app, d):
    app.providers.get(d.get("provider") or "")
    app.keychain.delete(d["provider"])
    return {"has_key": False}


def _provider_models(app, d):
    """A pasted key asks at the URL in the form. A saved key only ever goes to its own provider's URL."""
    if d.get("provider"):
        row = app.providers.get(d["provider"])
        key = app.keychain.get(row["id"])
        if not key:
            raise AppError("no_key", "Paste your key to see your models.")
        return {"models": list_models(row["type"], row["base_url"], key)}
    if d.get("type") not in TYPES:
        raise AppError("bad_provider", "Type must be Anthropic or OpenAI-compatible.")
    return {"models": list_models(d["type"], d.get("base_url"), d.get("key"))}


def _settings_save(app, d):
    return app.save_settings(d)


def _instructions_get(app, d):
    text = app.instructions()
    return {"text": text, "default": SYSTEM_PROMPT, "custom": text != SYSTEM_PROMPT}


def _instructions_save(app, d):
    app.save_instructions(d.get("text"))
    return _instructions_get(app, d)


def _provider_consent(app, d):
    app.providers.get(d.get("provider") or "")
    app.providers.consent(d["provider"])
    return {"consented": True}


def _provider_delete(app, d):
    app.providers.delete(d.get("provider") or "")
    return {"deleted": True}


def _assistant_stop(app, d):
    req = app.requests.get(d.get("request") or "")
    if req:
        req.stop()
    return {"stopped": bool(req)}


ROUTES = {
    "/api/state": _state,
    "/api/project/open": lambda app, d: app.open_project(d.get("path") or ""),
    "/api/project/new": _project_new,
    "/api/project/duplicate": lambda app, d: app.duplicate(app.project(d)),
    "/api/project/rename": lambda app, d: app.rename(app.project(d), d.get("name")),
    "/api/project/search": lambda app, d: {"results": app.project(d).search(d.get("query"))},
    "/api/project/tree": lambda app, d: {"tree": app.project(d).tree(), "main": app.project(d).main_file_detect()},
    "/api/file/read": lambda app, d: app.project(d).file_read(d.get("rel")),
    "/api/file/write": lambda app, d: {"hash": app.project(d).file_write(d.get("rel"), d.get("text") or "",
                                                                         d.get("expected_hash"))},
    "/api/compile/cancel": lambda app, d: {"cancelled": app.project(d).cancel()},
    "/api/synctex/to_pdf": _synctex_to_pdf,
    "/api/synctex/to_source": _synctex_to_source,
    "/api/provider/save": lambda app, d: app.providers.save(d),
    "/api/provider/delete": _provider_delete,
    "/api/provider/models": _provider_models,
    "/api/provider/consent": _provider_consent,
    "/api/settings/save": _settings_save,
    "/api/instructions/get": _instructions_get,
    "/api/instructions/save": _instructions_save,
    "/api/key/set": _key_set,
    "/api/key/delete": _key_delete,
    "/api/assistant/stop": _assistant_stop,
    "/api/edit/apply": lambda app, d: app.proposals.apply(app.project(d), d.get("proposal")),
    "/api/edit/undo": lambda app, d: app.proposals.undo(app.project(d), d.get("proposal")),
    "/api/history/commit": lambda app, d: {"commit": app.project(d).history_commit(d.get("message"))},
    "/api/history/list": lambda app, d: {"commits": app.project(d).history_list()},
    "/api/history/restore": lambda app, d: {"commit": app.project(d).history_restore(d.get("commit"))},
}


def default_home() -> str:
    return os.environ.get("OPENPRISM_HOME") or os.path.expanduser("~/Library/Application Support/OpenPrism")


def default_projects_dir() -> str:
    return os.environ.get("OPENPRISM_PROJECTS") or os.path.expanduser("~/openprism-projects")


def main() -> int:
    parser = argparse.ArgumentParser(description="OpenPrism local server")
    parser.add_argument("--port", type=int, default=8771)
    args = parser.parse_args()
    if not os.path.exists(os.path.join(DIST, "index.html")):
        print("The interface is not built. Run: cd app/web && npm install --ignore-scripts && npm run build")
        return 1
    if shutil.which("git") is None:
        print("git is missing, so history will not work.")
    app = App(default_home(), default_projects_dir(), args.port)
    handler = type("BoundHandler", (Handler,), {"app": app})
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    except OSError as err:
        print(f"Port {args.port} is taken ({err.strerror}). Choose another with --port.")
        return 1
    server.daemon_threads = True
    print(f"OpenPrism is running: http://127.0.0.1:{args.port}/?t={app.token}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())

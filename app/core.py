"""Projects, files, compile, SyncTeX and history. Nothing here knows about HTTP."""
from __future__ import annotations

import gzip
import hashlib
import os
import re
import shutil
import signal
import stat
import subprocess
import tempfile
import threading
import time
import zipfile

PRIVATE_DIRS = {".git", ".openprism"}
HIDDEN_NAMES = PRIVATE_DIRS | {"__MACOSX", "node_modules", ".DS_Store"}
MAX_TEXT_BYTES = 5 * 1024 * 1024
MAX_TREE_NODES = 5000
MAX_ZIP_ENTRIES = 20000
MAX_ZIP_BYTES = 1024 * 1024 * 1024
COMPILE_TIMEOUT_S = 900
BP_PER_SP = 1 / 65781.76


class AppError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe_path(root: str, rel: str) -> str:
    """Resolve rel inside root, or refuse. Symlinks are followed before the check."""
    if not isinstance(rel, str) or not rel or "\0" in rel or os.path.isabs(rel):
        raise AppError("path_refused", f"Path refused: {rel!r}")
    parts = rel.replace("\\", "/").split("/")
    if ".." in parts or PRIVATE_DIRS.intersection(parts):
        raise AppError("path_refused", f"Path refused: {rel!r}")
    full = os.path.realpath(os.path.join(root, rel))
    if not full.startswith(root + os.sep):
        raise AppError("path_refused", f"Path refused: {rel!r}")
    return full


class Project:
    def __init__(self, path: str):
        root = os.path.realpath(os.path.expanduser(path))
        if not os.path.isdir(root):
            raise AppError("not_found", f"No such folder: {path}")
        if root in ("/", os.path.realpath(os.path.expanduser("~"))):
            raise AppError("path_refused", "Open a project folder, not the whole disk or home folder.")
        self.root = root
        self.name = os.path.basename(root)
        self.compile_lock = threading.Lock()
        self.proc: subprocess.Popen | None = None
        self.cancelled = False
        self.last: dict | None = None
        self._synctex: tuple[float, SyncTex] | None = None

    # Files

    def tree(self) -> list[dict]:
        count = 0

        def walk(dir_rel: str) -> list[dict]:
            nonlocal count
            nodes = []
            base = os.path.join(self.root, dir_rel) if dir_rel else self.root
            entries = sorted(os.scandir(base), key=lambda e: (not e.is_dir(follow_symlinks=False), e.name.lower()))
            for entry in entries:
                if entry.name in HIDDEN_NAMES:
                    continue
                count += 1
                if count > MAX_TREE_NODES:
                    raise AppError("too_many_files", "This folder has too many files to show.")
                rel = f"{dir_rel}/{entry.name}" if dir_rel else entry.name
                if entry.is_symlink():
                    try:
                        if os.path.isfile(safe_path(self.root, rel)):
                            nodes.append({"rel": rel, "name": entry.name, "type": "file"})
                    except AppError:
                        pass
                elif entry.is_dir():
                    nodes.append({"rel": rel, "name": entry.name, "type": "dir", "children": walk(rel)})
                elif entry.is_file():
                    nodes.append({"rel": rel, "name": entry.name, "type": "file"})
            return nodes

        return walk("")

    def file_list(self) -> list[str]:
        out = []

        def collect(nodes: list[dict]) -> None:
            for node in nodes:
                if node["type"] == "dir":
                    collect(node["children"])
                else:
                    out.append(node["rel"])

        collect(self.tree())
        return out

    def file_read(self, rel: str) -> dict:
        full = safe_path(self.root, rel)
        if not os.path.isfile(full):
            raise AppError("not_found", f"No such file: {rel}")
        if os.path.getsize(full) > MAX_TEXT_BYTES:
            raise AppError("too_large", f"{rel} is too large to open as text.")
        with open(full, "rb") as handle:
            data = handle.read()
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            raise AppError("binary", f"{rel} is not a text file.") from None
        return {"rel": rel, "text": text, "hash": sha256(data)}

    def file_write(self, rel: str, text: str, expected_hash: str | None) -> str:
        """Write text. expected_hash None means the file must not exist yet."""
        full = safe_path(self.root, rel)
        if expected_hash is None:
            if os.path.lexists(full):
                raise AppError("stale", f"{rel} already exists.")
        else:
            try:
                with open(full, "rb") as handle:
                    current = sha256(handle.read())
            except FileNotFoundError:
                raise AppError("stale", f"{rel} was removed on disk.") from None
            if current != expected_hash:
                raise AppError("stale", f"{rel} changed on disk.")
        data = text.encode("utf-8")
        os.makedirs(os.path.dirname(full), exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(full), prefix=".openprism-tmp-")
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
            if os.path.exists(full):
                shutil.copymode(full, tmp)
            else:
                os.chmod(tmp, 0o644)
            os.replace(tmp, full)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise
        return sha256(data)

    def main_file_detect(self) -> str | None:
        found = []
        for rel in self.file_list():
            if not rel.endswith(".tex"):
                continue
            try:
                text = self.file_read(rel)["text"]
            except AppError:
                continue
            if re.search(r"^[ \t]*\\documentclass\b", text, re.M):
                found.append(rel)
        if not found:
            return None
        found.sort(key=lambda rel: (os.path.basename(rel) != "main.tex", rel.count("/"), rel))
        return found[0]

    def search(self, query: str, limit: int = 200) -> list[dict]:
        needle = (query or "").lower()
        if not needle:
            return []
        out = []
        for rel in self.file_list():
            try:
                text = self.file_read(rel)["text"]
            except AppError:
                continue
            for number, line in enumerate(text.splitlines(), 1):
                if needle in line.lower():
                    out.append({"rel": rel, "line": number, "text": line.strip()[:200]})
                    if len(out) >= limit:
                        return out
        return out

    # Compile

    def compile(self, main: str, on_line=lambda line: None) -> dict:
        main_path = safe_path(self.root, main)
        if not os.path.isfile(main_path):
            raise AppError("not_found", f"No such file: {main}")
        engine = find_engine()
        if not self.compile_lock.acquire(blocking=False):
            raise AppError("busy", "A compile is already running.")
        try:
            return self._compile(engine, main, main_path, on_line)
        finally:
            self.proc = None
            self.compile_lock.release()

    def _compile(self, engine: str, main: str, main_path: str, on_line) -> dict:
        outdir = os.path.join(self.root, ".openprism", "build")
        os.makedirs(outdir, exist_ok=True)
        stem = os.path.splitext(os.path.basename(main))[0]
        pdf = os.path.join(outdir, stem + ".pdf")
        synctex = os.path.join(outdir, stem + ".synctex.gz")
        log = os.path.join(outdir, stem + ".log")
        for path in (pdf, synctex, log):
            if os.path.exists(path):
                os.unlink(path)
        cwd = os.path.dirname(main_path)
        # --untrusted turns shell escape off. continue-on-errors reports every error, not only the first.
        cmd = [engine, "-X", "compile", os.path.basename(main), "--untrusted", "--synctex",
               "--keep-logs", "--outdir", outdir, "-Z", "continue-on-errors"]
        started = time.monotonic()
        self.cancelled = False
        proc = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                errors="replace", start_new_session=True)
        self.proc = proc
        timer = threading.Timer(COMPILE_TIMEOUT_S, self.cancel)
        timer.start()
        lines = []
        try:
            for raw in proc.stdout:
                line = raw.rstrip("\n")
                lines.append(line)
                on_line(line)
            code = proc.wait()
        finally:
            timer.cancel()
        log_text = ""
        if os.path.exists(log):
            with open(log, encoding="utf-8", errors="replace") as handle:
                log_text = handle.read()
        cwd_rel = os.path.relpath(cwd, self.root)
        diagnostics = parse_diagnostics(lines, log_text, self.root, cwd_rel)
        errors = [d for d in diagnostics if d["severity"] == "error"]
        has_pdf = os.path.exists(pdf)
        if code != 0 and not errors and not self.cancelled:
            message = next((l[7:] for l in reversed(lines) if l.startswith("error: ")), "The engine failed.")
            errors.append({"rel": None, "line": None, "severity": "error", "message": message})
            diagnostics.insert(0, errors[-1])
        self.last = {"main": main, "pdf": pdf if has_pdf else None,
                     "synctex": synctex if os.path.exists(synctex) else None, "diagnostics": diagnostics}
        return {
            "ok": code == 0 and not errors and has_pdf and not self.cancelled,
            "cancelled": self.cancelled,
            "main": main,
            "has_pdf": has_pdf,
            "has_synctex": self.last["synctex"] is not None,
            "log": log_text or "\n".join(lines),
            "duration_ms": int((time.monotonic() - started) * 1000),
            "diagnostics": diagnostics,
        }

    def cancel(self) -> bool:
        proc = self.proc
        if proc is None or proc.poll() is not None:
            return False
        self.cancelled = True
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=2)
        except ProcessLookupError:
            pass
        return True

    def errors_summary(self) -> list[dict]:
        return self.last["diagnostics"] if self.last else []

    # SyncTeX

    def _sync(self) -> SyncTex | None:
        path = self.last["synctex"] if self.last else None
        if not path or not os.path.exists(path):
            return None
        mtime = os.path.getmtime(path)
        if self._synctex is None or self._synctex[0] != mtime:
            self._synctex = (mtime, SyncTex(path, self.root))
        return self._synctex[1]

    def synctex_to_pdf(self, rel: str, line: int) -> dict | None:
        safe_path(self.root, rel)
        sync = self._sync()
        return sync.to_pdf(rel, int(line)) if sync else None

    def synctex_to_source(self, page: int, x: float, y: float) -> dict | None:
        sync = self._sync()
        return sync.to_source(int(page), float(x), float(y)) if sync else None

    # History

    def _git(self, *args: str, check: bool = True) -> str:
        cmd = ["git", "-C", self.root, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", *args]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if check and result.returncode != 0:
            raise AppError("git", result.stderr.strip()[:500] or "git failed")
        return result.stdout

    def _ensure_repo(self) -> None:
        if not os.path.isdir(os.path.join(self.root, ".git")):
            self._git("init", "-q")
        exclude = os.path.join(self.root, ".git", "info", "exclude")
        os.makedirs(os.path.dirname(exclude), exist_ok=True)
        existing = ""
        if os.path.exists(exclude):
            with open(exclude, encoding="utf-8") as handle:
                existing = handle.read()
        if ".openprism/" not in existing:
            with open(exclude, "a", encoding="utf-8") as handle:
                handle.write("\n.openprism/\n")

    def _commit(self, message: str) -> str | None:
        self._git("add", "-A")
        if not self._git("status", "--porcelain").strip():
            return None
        identity = []
        if not self._git("config", "user.email", check=False).strip():
            identity = ["-c", "user.name=openprism", "-c", "user.email=openprism@localhost"]
        self._git(*identity, "commit", "-q", "-m", message)
        return self._git("rev-parse", "HEAD").strip()

    def history_commit(self, message: str) -> str | None:
        message = (message or "").strip() or "Saved version"
        self._ensure_repo()
        return self._commit(message[:200])

    def history_list(self) -> list[dict]:
        if not os.path.isdir(os.path.join(self.root, ".git")):
            return []
        out = self._git("log", "-n", "200", "--format=%H%x09%ct%x09%s", check=False)
        commits = []
        for row in out.splitlines():
            parts = row.split("\t", 2)
            if len(parts) == 3:
                commits.append({"id": parts[0], "time": int(parts[1]), "message": parts[2]})
        return commits

    def history_restore(self, commit: str) -> str | None:
        """Bring back an earlier version as a new commit, so nothing is lost."""
        if not re.fullmatch(r"[0-9a-f]{7,64}", commit or ""):
            raise AppError("bad_commit", "That is not a version id.")
        self._ensure_repo()
        self._git("cat-file", "-e", commit + "^{commit}")
        self._commit("Saved before restoring " + commit[:7])
        self._git("restore", f"--source={commit}", "--staged", "--worktree", "--", ".")
        return self._commit("Restored " + commit[:7])


def find_engine() -> str:
    path = os.environ.get("TECTONIC_PATH") or shutil.which("tectonic")
    for candidate in (path, "/opt/homebrew/bin/tectonic", "/usr/local/bin/tectonic"):
        if candidate and os.path.exists(candidate):
            return candidate
    raise AppError("no_engine", "Tectonic is not installed. Run: brew install tectonic")


_ENGINE_LINE = re.compile(r"^(error|warning): (?:(.+?):(\d+): )?(.*)$")
_ENGINE_NOISE = ("the XeTeX engine had", "errors were issued", "warnings were issued", "halted on")
_LOG_WARNING = re.compile(r"^(?:LaTeX|Package \S+|Class \S+) Warning: (.*?)(?: on input line (\d+))?\.?$")
_PAREN = re.compile(r"\(([^\s()]*)|\)")


def _project_rel(name: str, root: str, cwd_rel: str) -> str | None:
    """The engine names files relative to the main file and may drop .tex."""
    for candidate in (name, name + ".tex"):
        joined = os.path.normpath(os.path.join(cwd_rel, candidate))
        if not joined.startswith("..") and os.path.isfile(os.path.join(root, joined)):
            return joined
    return None


def parse_diagnostics(lines: list[str], log_text: str, root: str, cwd_rel: str = ".") -> list[dict]:
    """Errors and warnings from the engine's output, plus LaTeX warnings it only writes to the log."""
    last_pass = 0
    for index, line in enumerate(lines):
        if line.startswith("note: Rerunning TeX"):
            last_pass = index + 1
    seen = set()
    out = []

    def add(rel, line_no, severity, message):
        key = (rel, line_no, severity, message)
        if key not in seen:
            seen.add(key)
            out.append({"rel": rel, "line": line_no, "severity": severity, "message": message})

    for line in lines[last_pass:]:
        match = _ENGINE_LINE.match(line)
        if not match or match.group(4).startswith(_ENGINE_NOISE):
            continue
        severity, name, number, message = match.groups()
        if "biber" in message.lower():
            message += " (Biblatex projects need biber: brew install biber)"
        rel = _project_rel(name, root, cwd_rel) if name else None
        add(rel, int(number) if number and rel else None, severity, message)

    stack: list[str] = []
    skip = False
    for line in log_text.splitlines():
        match = _LOG_WARNING.match(line)
        if match:
            current = next((r for r in map(lambda n: _project_rel(n, root, cwd_rel), reversed(stack)) if r), None)
            number = int(match.group(2)) if match.group(2) else None
            add(current if number else None, number, "warning", match.group(1))
            continue
        # Error context and box excerpts quote document text, whose brackets would unbalance the stack.
        if line.startswith(("!", "l.", "Overfull", "Underfull")):
            skip = True
        elif not line.strip():
            skip = False
        if skip:
            continue
        for token in _PAREN.finditer(line):
            if token.group(0) == ")":
                if stack:
                    stack.pop()
            else:
                stack.append(token.group(1))
    out.sort(key=lambda d: d["severity"] != "error")
    return out


_RECORD = re.compile(r"^([\[(hvxkg$])(\d+),(\d+):(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?$")
_POINT_KINDS = "xkg$"
_BOX_KINDS = "(h"


class SyncTex:
    """Reads .synctex.gz directly. All positions are PDF points from the page's top left."""

    def __init__(self, path: str, root: str):
        self.inputs: dict[int, str] = {}
        self.records: list[tuple] = []
        unit = 1.0
        mag = 1000.0
        x_offset = 0.0
        y_offset = 0.0
        page = 0
        with gzip.open(path, "rt", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.rstrip("\n")
                if line.startswith("Input:"):
                    _, tag, name = line.split(":", 2)
                    rel = _input_rel(name, root)
                    if rel:
                        self.inputs[int(tag)] = rel
                elif line.startswith("Unit:"):
                    unit = float(line[5:])
                elif line.startswith("Magnification:"):
                    mag = float(line[14:])
                elif line.startswith("X Offset:"):
                    x_offset = float(line[9:])
                elif line.startswith("Y Offset:"):
                    y_offset = float(line[9:])
                elif line.startswith("{"):
                    page = int(line[1:])
                else:
                    match = _RECORD.match(line)
                    if not match or not page:
                        continue
                    kind, tag, number, x, y, w, h, d = match.groups()
                    if int(tag) not in self.inputs:
                        continue
                    scale = unit * mag / 1000 * BP_PER_SP
                    self.records.append((page, kind, int(tag), int(number),
                                         (int(x) + x_offset) * scale, (int(y) + y_offset) * scale,
                                         int(w or 0) * scale, int(h or 0) * scale, int(d or 0) * scale))

    def to_pdf(self, rel: str, line: int) -> dict | None:
        tags = {tag for tag, name in self.inputs.items() if name == rel}
        candidates = [r for r in self.records if r[2] in tags and r[1] in _POINT_KINDS + _BOX_KINDS]
        if not candidates:
            return None
        nearest = min(candidates, key=lambda r: (abs(r[3] - line), r[3] < line))
        same_line = [r for r in candidates if r[3] == nearest[3]]
        # Paragraph boxes carry the paragraph's last line; points inside them carry the exact one.
        best = next((r for r in same_line if r[1] in _POINT_KINDS), same_line[0])
        return {"page": best[0], "x": best[4], "y": best[5], "line": best[3]}

    def to_source(self, page: int, x: float, y: float) -> dict | None:
        best = None
        best_key = None
        for record in self.records:
            if record[0] != page:
                continue
            kind, rx, ry, rw, rh, rd = record[1], record[4], record[5], record[6], record[7], record[8]
            if kind in _BOX_KINDS:
                if rw <= 0 or rh + rd <= 0:
                    continue
                dy = max(ry - rh - y, y - (ry + rd), 0)
                dx = max(rx - x, x - (rx + rw), 0)
                key = (round(dy), 1, dx, rw * (rh + rd))
            elif kind in _POINT_KINDS:
                # A point sits on the baseline, and a click lands on the glyphs above it.
                dy = max(ry - 10 - y, y - (ry + 3), 0)
                key = (round(dy), 0, abs(rx - x), 0)
            else:
                continue
            if best_key is None or key < best_key:
                best_key = key
                best = record
        if best is None:
            return None
        return {"rel": self.inputs[best[2]], "line": best[3]}


def _input_rel(name: str, root: str) -> str | None:
    if not name:
        return None
    full = os.path.realpath(name)
    if not full.startswith(root + os.sep):
        return None
    return os.path.relpath(full, root)


def import_zip(zip_path: str, dest: str) -> None:
    """Unpack into dest. The whole archive is checked first, so a bad one writes nothing."""
    if os.path.exists(dest) and os.listdir(dest):
        raise AppError("dest_not_empty", f"{dest} is not empty.")
    try:
        archive = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile:
        raise AppError("bad_zip", "That file is not a readable zip.") from None
    with archive:
        infos = archive.infolist()
        if len(infos) > MAX_ZIP_ENTRIES:
            raise AppError("bad_zip", "That zip has too many files.")
        wanted = []
        total = 0
        for info in infos:
            name = info.filename.replace("\\", "/")
            parts = [p for p in name.split("/") if p not in ("", ".")]
            if name.startswith("/") or ".." in parts or (parts and ":" in parts[0]):
                raise AppError("unsafe_zip", f"Refused: an entry escapes the project ({info.filename}).")
            if stat.S_ISLNK(info.external_attr >> 16):
                raise AppError("unsafe_zip", f"Refused: the zip holds a symlink ({info.filename}).")
            if not parts or HIDDEN_NAMES.intersection(parts):
                continue
            total += info.file_size
            if total > MAX_ZIP_BYTES:
                raise AppError("bad_zip", "That zip unpacks to more than 1 GB.")
            wanted.append((info, parts))
        os.makedirs(dest, exist_ok=True)
        for info, parts in wanted:
            target = os.path.join(dest, *parts)
            if info.is_dir():
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with archive.open(info) as source, open(target, "wb") as sink:
                shutil.copyfileobj(source, sink)


def copy_project(project: Project, dest: str) -> None:
    """A clean copy of the files. History and build output stay behind."""
    for rel in project.file_list():
        target = os.path.join(dest, rel)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copyfile(safe_path(project.root, rel), target)


def export_zip(project: Project, dest: str) -> None:
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as archive:
        for rel in project.file_list():
            archive.write(safe_path(project.root, rel), rel)

"""
Thin Python HTTP wrapper for sandboxed code execution.

Runs code directly via subprocess for supported runtimes (python, javascript/node).
Falls back to llm-sandbox (Docker-in-Docker) for other languages if available.

Runs inside the code-sandbox Docker container.
"""

from __future__ import annotations

import json
import os
import socket as _unix_socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

SANDBOX_PORT = int(os.environ.get("SANDBOX_SERVICE_PORT", "8080"))
SANDBOX_SOCKET_PATH = os.environ.get("SANDBOX_SOCKET_PATH", "/var/run/atlas/sandbox.sock")

# Language name aliases
LANG_MAP: dict[str, str] = {
    "python":     "python",
    "javascript": "javascript",
    "js":         "javascript",
    "typescript": "typescript",
    "ts":         "typescript",
    "go":         "go",
    "java":       "java",
    "r":          "r",
}

# Map language → (runtime_cmd, file_extension)
# None means no local runtime; will fall back to llm-sandbox.
LOCAL_RUNTIMES: dict[str, tuple[list[str], str] | None] = {
    "python":     ([sys.executable], ".py"),
    "javascript": None,   # filled in at startup if node is found
    "typescript": None,   # filled in at startup if tsx is found
    "go":         None,
    "java":       None,
    "r":          None,
}

LANG_EXTENSIONS: dict[str, str] = {
    "python":     ".py",
    "javascript": ".js",
    "typescript": ".ts",
    "go":         ".go",
    "java":       ".java",
    "r":          ".r",
}


def _find_node() -> list[str] | None:
    for cmd in ("node", "nodejs"):
        try:
            subprocess.run([cmd, "--version"], capture_output=True, timeout=3, check=True)
            return [cmd]
        except Exception:
            pass
    return None


def _find_runtime(cmd: str) -> list[str] | None:
    try:
        subprocess.run([cmd, "--version"], capture_output=True, timeout=3, check=True)
        return [cmd]
    except Exception:
        return None


def _init_runtimes() -> None:
    node = _find_node()
    if node:
        LOCAL_RUNTIMES["javascript"] = (node, ".js")
    # tsx runs TypeScript natively via Node
    tsx = _find_runtime("tsx")
    if tsx:
        LOCAL_RUNTIMES["typescript"] = (["tsx"], ".ts")
    rscript = _find_runtime("Rscript")
    if rscript:
        LOCAL_RUNTIMES["r"] = (["Rscript"], ".r")
    # Go uses `go version`, not `go --version`
    try:
        subprocess.run(["go", "version"], capture_output=True, timeout=3, check=True)
        LOCAL_RUNTIMES["go"] = (["go"], ".go")
    except Exception:
        pass


def run_code_subprocess(
    language: str,
    code: str,
    libraries: list[str],
    timeout_s: float,
    session_id: str | None = None,
    tools: str = "",
) -> dict:
    """Execute code in a subprocess. Fast path — no Docker involved."""
    runtime_info = LOCAL_RUNTIMES.get(language)
    if runtime_info is None:
        return {
            "success": False,
            "exit_code": -1,
            "stdout": "",
            "stderr": f"Runtime '{language}' not available locally.",
            "execution_time_ms": 0,
        }

    cmd_prefix, ext = runtime_info

    # Go needs its own temp module directory
    if language == "go":
        return _run_go(code, timeout_s)

    # Install Python libraries if requested
    if libraries and language == "python":
        pip_result = subprocess.run(
            [sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", *libraries],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if pip_result.returncode != 0:
            return {
                "success": False,
                "exit_code": pip_result.returncode,
                "stdout": "",
                "stderr": f"pip install failed:\n{pip_result.stderr}",
                "execution_time_ms": 0,
            }

    # Install Node packages if requested
    if libraries and language in ("javascript", "typescript"):
        npm_result = subprocess.run(
            ["npm", "install", "--no-save", "--silent", *libraries],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if npm_result.returncode != 0:
            return {
                "success": False,
                "exit_code": npm_result.returncode,
                "stdout": "",
                "stderr": f"npm install failed:\n{npm_result.stderr}",
                "execution_time_ms": 0,
            }

    with tempfile.NamedTemporaryFile(mode="w", suffix=ext, delete=False) as f:
        f.write(code)
        tmp_path = f.name

    try:
        cmd = [*cmd_prefix, tmp_path]
        # Build subprocess env: propagate tool bridge vars for sitecustomize.py (Python)
        # and for the JS preamble fallback (JS/TS already has them inlined).
        proc_env = os.environ.copy()
        if tools:
            # sitecustomize.py uses Unix socket directly; no ATLAS_BRIDGE_URL needed
            proc_env["ATLAS_TOOLS"] = tools
            if session_id:
                proc_env["ATLAS_SESSION_ID"] = session_id
            else:
                proc_env.pop("ATLAS_SESSION_ID", None)
        else:
            # Ensure stubs are NOT injected when enable_tools=false
            proc_env.pop("ATLAS_TOOLS", None)
            proc_env.pop("ATLAS_SESSION_ID", None)
        start = time.time()
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s, env=proc_env)
        except subprocess.TimeoutExpired:
            return {
                "success": False,
                "exit_code": -1,
                "stdout": "",
                "stderr": f"Execution timed out after {timeout_s:.0f}s",
                "execution_time_ms": int(timeout_s * 1000),
            }
        elapsed_ms = int((time.time() - start) * 1000)
        return {
            "success": result.returncode == 0,
            "exit_code": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "execution_time_ms": elapsed_ms,
        }
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def _run_go(code: str, timeout_s: float) -> dict:
    """Run Go code via `go run` inside a temporary module directory."""
    import shutil
    tmp_dir = tempfile.mkdtemp(prefix="go_sandbox_")
    try:
        src_path = os.path.join(tmp_dir, "main.go")
        with open(src_path, "w") as f:
            f.write(code)

        # Initialise a throw-away Go module
        subprocess.run(
            ["go", "mod", "init", "sandbox"],
            cwd=tmp_dir,
            capture_output=True,
            timeout=30,
        )

        start = time.time()
        try:
            result = subprocess.run(
                ["go", "run", "main.go"],
                cwd=tmp_dir,
                capture_output=True,
                text=True,
                timeout=timeout_s,
            )
        except subprocess.TimeoutExpired:
            return {
                "success": False,
                "exit_code": -1,
                "stdout": "",
                "stderr": f"Execution timed out after {timeout_s:.0f}s",
                "execution_time_ms": int(timeout_s * 1000),
            }
        elapsed_ms = int((time.time() - start) * 1000)
        return {
            "success": result.returncode == 0,
            "exit_code": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "execution_time_ms": elapsed_ms,
        }
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def run_code_llmsandbox(
    language: str,
    code: str,
    libraries: list[str],
    timeout_s: float,
    socket_host_path: str | None,
) -> dict:
    """Fallback: execute via llm-sandbox (Docker-in-Docker). Slow on first use."""
    try:
        from llm_sandbox import SandboxSession  # type: ignore
    except ImportError:
        return {
            "success": False,
            "exit_code": -1,
            "stdout": "",
            "stderr": "llm-sandbox not available and no local runtime found for this language.",
            "execution_time_ms": 0,
        }

    volumes: dict[str, dict] = {}
    if socket_host_path:
        volumes[socket_host_path] = {"bind": "/var/run/atlas/tools.sock", "mode": "rw"}

    start = time.time()
    try:
        with SandboxSession(lang=language, verbose=False) as session:
            result = session.run(code, libraries=libraries)
        elapsed_ms = int((time.time() - start) * 1000)
        return {
            "success": result.exit_code == 0,
            "exit_code": result.exit_code,
            "stdout": result.stdout or "",
            "stderr": result.stderr or "",
            "execution_time_ms": elapsed_ms,
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "success": False,
            "exit_code": -1,
            "stdout": "",
            "stderr": str(exc),
            "execution_time_ms": int((time.time() - start) * 1000),
        }


def run_code(
    code: str,
    language: str,
    libraries: list[str],
    timeout_s: float,
    network: str,  # kept for API compat; subprocess mode ignores network isolation
    socket_host_path: str | None,
    session_id: str | None = None,
    tools: str = "",
) -> dict:
    lang = LANG_MAP.get(language.lower(), language)

    # Use fast subprocess path if runtime is available locally
    if LOCAL_RUNTIMES.get(lang) is not None:
        result = run_code_subprocess(lang, code, libraries, timeout_s, session_id, tools)
    else:
        # Slow path: Docker-in-Docker via llm-sandbox
        result = run_code_llmsandbox(lang, code, libraries, timeout_s, socket_host_path)

    result["language"] = lang
    return result


class SandboxHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: object) -> None:
        pass  # suppress default request logs

    def do_GET(self) -> None:
        if self.path == "/health":
            available = [lang for lang, rt in LOCAL_RUNTIMES.items() if rt is not None]
            self._respond(200, {"status": "ok", "runtimes": available})
        else:
            self._respond(404, {"error": "not found"})

    def do_POST(self) -> None:
        # /execute is now handled exclusively via Unix socket (security: no HTTP execution)
        self._respond(404, {"error": "use Unix socket"})

    def _respond(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


if __name__ == "__main__":
    _init_runtimes()
    available = [lang for lang, rt in LOCAL_RUNTIMES.items() if rt is not None]
    print(f"[sandbox_service] Starting | socket: {SANDBOX_SOCKET_PATH} | HTTP health: :{SANDBOX_PORT} | runtimes: {available}", flush=True)

    def _handle_socket_conn(conn: _unix_socket.socket) -> None:
        """Handle a single Unix socket execution request (newline-delimited JSON)."""
        try:
            buf = b""
            while b"\n" not in buf:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                buf += chunk

            line = buf.split(b"\n")[0].strip()
            if not line:
                conn.sendall(json.dumps({"error": "empty request"}).encode() + b"\n")
                return

            try:
                data = json.loads(line)
            except json.JSONDecodeError as exc:
                conn.sendall(json.dumps({"error": f"invalid JSON: {exc}"}).encode() + b"\n")
                return

            code: str = data.get("code", "")
            language: str = data.get("language", "python")
            libraries: list = data.get("libraries", [])
            timeout_ms: int = data.get("timeout_ms", 30_000)
            network: str = data.get("network", "none")
            socket_host_path = data.get("socket_host_path")
            session_id = data.get("session_id") or None
            tools: str = data.get("tools", "")

            if not code:
                conn.sendall(json.dumps({"error": "code is required"}).encode() + b"\n")
                return

            result = run_code(
                code=code,
                language=language,
                libraries=libraries,
                timeout_s=timeout_ms / 1000,
                network=network,
                socket_host_path=socket_host_path,
                session_id=session_id,
                tools=tools,
            )
            conn.sendall(json.dumps(result).encode() + b"\n")
        except Exception as exc:
            try:
                conn.sendall(json.dumps({"error": str(exc), "success": False}).encode() + b"\n")
            except Exception:
                pass
        finally:
            conn.close()

    def _start_socket_server() -> None:
        """Start Unix domain socket server for execution requests."""
        sock_path = SANDBOX_SOCKET_PATH
        if os.path.exists(sock_path):
            os.unlink(sock_path)
        server_sock = _unix_socket.socket(_unix_socket.AF_UNIX, _unix_socket.SOCK_STREAM)
        server_sock.bind(sock_path)
        os.chmod(sock_path, 0o660)
        server_sock.listen(16)
        print(f"[sandbox_service] Unix socket listening on {sock_path}", flush=True)
        while True:
            conn, _ = server_sock.accept()
            threading.Thread(target=_handle_socket_conn, args=(conn,), daemon=True).start()

    # Start Unix socket server in a background thread
    sock_thread = threading.Thread(target=_start_socket_server, daemon=False)
    sock_thread.start()

    # HTTP server for health-checks only (no /execute)
    server = HTTPServer(("0.0.0.0", SANDBOX_PORT), SandboxHandler)
    server.serve_forever()

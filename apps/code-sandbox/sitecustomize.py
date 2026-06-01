"""
Fredo Tool Bridge — sitecustomize hook.

Python executes this file automatically before every script (including user
sandbox code). When FREDO_TOOLS is set we inject call_tool() and per-tool
stubs directly into builtins so user code can call e.g. logs_query(...) with
no import — identical to the old string-preamble but without polluting
tracebacks or adding extra lines to the user's script.

Env vars (set per-invocation by sandbox_service.py):
  FREDO_SESSION_ID   — MCP session ID so events land in the right Redis stream
  FREDO_TOOLS        — comma-separated list of tool names to expose
"""

import builtins
import json
import os
import socket as _socket

_SESSION_ID = os.environ.get("FREDO_SESSION_ID") or None
_TOOLS_CSV  = os.environ.get("FREDO_TOOLS", "")
_TOOLS_SOCK = "/var/run/fredo/tools.sock"

if _TOOLS_CSV:
    def _call_tool(tool_name: str, input_data: dict) -> dict:
        payload: dict = {"tool": tool_name, "input": input_data}
        if _SESSION_ID:
            payload["sessionId"] = _SESSION_ID
        body = (json.dumps(payload) + "\n").encode()
        try:
            s = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)
            s.settimeout(60)
            s.connect(_TOOLS_SOCK)
            s.sendall(body)
            # Read until newline — server sends one JSON line per request and keeps connection open
            data = b""
            while b"\n" not in data:
                chunk = s.recv(4096)
                if not chunk:
                    break  # unexpected close; try to parse what arrived
                data += chunk
            s.close()
            line = data.split(b"\n")[0].decode().strip()
            return json.loads(line) if line else {"error": "empty response"}
        except Exception as e:
            return {"error": str(e)}

    # Expose as builtins so user code requires no import
    builtins.call_tool = _call_tool  # type: ignore[attr-defined]

    def _make_stub(name: str):
        def _stub(**kwargs):
            return _call_tool(name, kwargs)
        _stub.__name__ = name
        _stub.__qualname__ = name
        return _stub

    for _t in _TOOLS_CSV.split(","):
        _t = _t.strip()
        if _t:
            setattr(builtins, _t, _make_stub(_t))

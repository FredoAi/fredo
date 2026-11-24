"""Minimal client for Blender's official Lab MCP add-on (id="mcp", null-terminated JSON over TCP).

Usage: python blender_client.py path/to/script.py
The script runs inside Blender's namespace; set RESULT to return JSON-able data.
"""
import json, socket, sys

HOST, PORT = "127.0.0.1", 9876


def run(code: str, timeout: float = 120.0, strict_json: bool = True) -> dict:
    s = socket.create_connection((HOST, PORT), 5)
    s.settimeout(timeout)
    try:
        s.sendall(json.dumps({"type": "execute", "code": code, "strict_json": strict_json}).encode("utf-8") + b"\0")
        buf = b""
        while b"\0" not in buf:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
    finally:
        s.close()
    frame = buf.split(b"\0", 1)[0].decode("utf-8", "replace")
    try:
        return json.loads(frame)
    except json.JSONDecodeError:
        return {"status": "error", "message": f"non-JSON frame: {frame[:600]}"}


if __name__ == "__main__":
    code = open(sys.argv[1], "r", encoding="utf-8").read()
    res = run(code)
    print(json.dumps(res, indent=2)[:4000])

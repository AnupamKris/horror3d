"""Client for the Blender Lab MCP extension socket (localhost:9876).

Protocol: JSON request terminated by NUL byte: {"type":"execute","code":...,"strict_json":false}
The executed code must assign a dict to `result`.

Usage:
  uv run tools/bl.py <script.py> [more.py ...]   run file(s) inside Blender
  uv run tools/bl.py -c "code"                   run inline code
"""
import json
import socket
import sys


PRELUDE = r'''
import sys, os, importlib
_p = r"C:\Users\anupa\Code\horror3d\tools"
if _p not in sys.path:
    sys.path.insert(0, _p)
import hb
_m = os.path.getmtime(hb.__file__)
if getattr(hb, "_mtime", None) != _m:
    hb = importlib.reload(hb)
    hb._mtime = _m
import bpy, bmesh, math
from mathutils import Vector, Matrix, Euler
result = {}
'''


def run(code: str, host: str = "localhost", port: int = 9876, timeout: float = 900) -> dict:
    code = PRELUDE + code
    s = socket.create_connection((host, port), timeout=timeout)
    s.sendall(json.dumps({"type": "execute", "code": code, "strict_json": False}).encode() + b"\x00")
    buf = b""
    while not buf.endswith(b"\x00"):
        chunk = s.recv(1 << 16)
        if not chunk:
            break
        buf += chunk
    s.close()
    return json.loads(buf.rstrip(b"\x00").decode("utf-8"))


def main() -> int:
    args = sys.argv[1:]
    codes = [args[1]] if args[0] == "-c" else [open(p, encoding="utf-8").read() for p in args]
    rc = 0
    for code in codes:
        r = run(code)
        if r.get("stdout"):
            print(r["stdout"], end="")
        if r.get("stderr"):
            print(r["stderr"], end="", file=sys.stderr)
        if r.get("status") != "ok":
            print("ERROR:", r.get("message"), file=sys.stderr)
            rc = 1
        elif r.get("result"):
            print(json.dumps(r["result"], indent=1))
    return rc


if __name__ == "__main__":
    sys.exit(main())

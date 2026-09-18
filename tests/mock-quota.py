#!/usr/bin/env python3
"""Mock of GLM's quota API for E2E tests.

Serves GET /api/monitor/usage/quota/limit with a response driven by a JSON
state file, re-read on every request, so a test can flip the quota mid-run:

    {"status": 200, "tokensPct": 100, "tokensResetMs": 1789754284657,
     "monthlyPct": 12, "monthlyResetMs": 1792127323997}

    status 500 (or "fail": true) makes the endpoint fail, exercising the
    wrapper's fallback paths. tokensResetMs/monthlyResetMs of null omit the
    stamp.

Usage: mock-quota.py <port> <state-file>
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


def make_handler(state_path: str):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 - http.server API
            try:
                with open(state_path) as f:
                    state = json.load(f)
            except Exception:
                state = {"status": 200, "tokensPct": 50, "tokensResetMs": None}

            if state.get("status", 200) != 200 or state.get("fail"):
                self.send_response(500)
                self.end_headers()
                self.wfile.write(b"boom")
                return

            def window(pct, reset):
                entry = {"type": "PLACEHOLDER", "percentage": pct}
                if reset is not None:
                    entry["nextResetTime"] = reset
                return entry

            limits = []
            tokens = window(state.get("tokensPct", 0), state.get("tokensResetMs"))
            tokens["type"] = "TOKENS_LIMIT"
            limits.append(tokens)
            monthly = window(state.get("monthlyPct", 0), state.get("monthlyResetMs"))
            monthly["type"] = "TIME_LIMIT"
            monthly.update({
                "unit": 5, "number": 1, "usage": 4000,
                "currentValue": int(4000 * state.get("monthlyPct", 0) / 100),
                "remaining": 4000 - int(4000 * state.get("monthlyPct", 0) / 100),
            })
            limits.append(monthly)

            body = json.dumps({
                "code": 200, "msg": "Operation successful",
                "data": {"limits": limits, "level": "max"},
                "success": True,
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):  # silence request logging
            pass

    return Handler


def main() -> None:
    port, state_path = int(sys.argv[1]), sys.argv[2]
    HTTPServer(("127.0.0.1", port), make_handler(state_path)).serve_forever()


if __name__ == "__main__":
    main()

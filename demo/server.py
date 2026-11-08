#!/usr/bin/env python3
"""Site de test urban-http — serveur local, bibliothèque standard uniquement.

Lance une petite page web qui analyse en direct n'importe quelle commande curl
ou collection Postman via le paquet urban_http, et exécute les requêtes HTTP.

Usage :
    python demo/server.py          # http://127.0.0.1:8000
    python demo/server.py 9000     # port au choix
"""
from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Rend urban_http importable depuis src/ sans installation.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from urban_http import (  # noqa: E402
    execute,
    is_postman_collection,
    openapi_to_curl,
    parse_command,
    parse_postman,
    register_default_adapters,
)
from urban_http.model import HttpRequestModel, ParseWarning  # noqa: E402

register_default_adapters()

HERE = os.path.dirname(__file__)


def _warning(w: ParseWarning) -> dict:
    return {"code": w.code, "level": w.level, "message": w.message, "option": w.option}


def _http_request(req: HttpRequestModel) -> dict:
    body = None
    if req.body:
        if req.body.kind == "multipart":
            body = {"kind": "multipart", "parts": [
                {"name": p.name, "value": p.value, "file_path": p.file_path, "content_type": p.content_type}
                for p in (req.body.parts or [])
            ]}
        elif req.body.kind == "file":
            body = {"kind": "file", "file_path": req.body.file_path}
        else:
            body = {"kind": req.body.kind, "text": req.body.text}
    opts = req.options
    option_chips = []
    if opts.follow_redirects:
        option_chips.append("suit les redirections")
    if opts.max_redirs is not None:
        option_chips.append(f"max-redirs: {opts.max_redirs}")
    if opts.timeout_ms:
        option_chips.append(f"timeout: {opts.timeout_ms} ms")
    if opts.retry:
        option_chips.append(f"retry: {opts.retry}")
    if opts.insecure:
        option_chips.append("insecure (-k)")
    if opts.compressed:
        option_chips.append("compressed")
    if opts.proxy:
        option_chips.append(f"proxy: {opts.proxy}")
    return {
        "name": req.name,
        "method": req.method,
        "url": req.url,
        "headers": [list(h) for h in req.headers],
        "auth": ({"kind": req.auth.kind, "username": req.auth.username, "token": req.auth.token} if req.auth else None),
        "body": body,
        "options": option_chips,
        "warnings": [_warning(w) for w in req.warnings],
    }


def _protocol_request(scheme: str, request, warnings) -> dict:
    if request is None:
        return {"scheme": scheme, "request": None, "warnings": [_warning(w) for w in warnings]}
    r = request
    rows = [["hôte", r.host], ["port", r.port], ["chemin", r.path], ["sens", r.direction],
            ["TLS", "oui" if r.secure else ("opportuniste" if r.tls_opportunistic else "non")]]
    if r.username:
        rows.append(["utilisateur", r.username + (" : ••••••" if r.password else "")])
    if r.smtp:
        rows.append(["de", r.smtp.from_addr or "—"])
        rows.append(["destinataires", ", ".join(r.smtp.recipients) or "—"])
    if r.ftp and r.ftp.quote:
        rows.append(["commandes -Q", " ; ".join(r.ftp.quote)])
    if r.mqtt:
        rows.append(["qos", r.mqtt.qos])
        rows.append(["retain", "oui" if r.mqtt.retain else "non"])
    if r.ws:
        if r.ws.subprotocols:
            rows.append(["sous-protocoles", ", ".join(r.ws.subprotocols)])
        if r.ws.messages:
            rows.append(["messages", " | ".join(r.ws.messages)])
    if r.imap:
        rows.append(["dossier", r.imap.mailbox])
        if r.imap.uid is not None:
            rows.append(["uid", r.imap.uid])
    if r.payload:
        rows.append(["charge", ("@" + r.payload.file_path) if r.payload.file_path else (r.payload.text or "")])
    if r.output:
        rows.append(["sortie -o", r.output])
    return {"scheme": r.scheme, "direction": r.direction, "url": r.url,
            "rows": [[k, str(v)] for k, v in rows],
            "warnings": [_warning(w) for w in (list(warnings) + list(r.warnings))]}


def _analyze(command: str, variables: dict) -> dict:
    if is_postman_collection(command):
        result = parse_postman(command, variables)
        return {"kind": "postman", "requests": [_http_request(r) for r in result.requests],
                "warnings": [_warning(w) for w in result.warnings]}
    parsed = parse_command(command, variables)
    if parsed.kind == "http":
        return {"kind": "http", "requests": [_http_request(r) for r in parsed.requests],
                "warnings": [_warning(w) for w in parsed.warnings]}
    return {"kind": "protocol", "protocol": _protocol_request(parsed.scheme, parsed.request, parsed.warnings)}


def _openapi(contract: str) -> dict:
    operations = openapi_to_curl(contract)
    return {"operations": [
        {
            "method": op.method, "path": op.path, "operation_id": op.operation_id,
            "summary": op.summary, "curl": op.curl, "variables": op.variables,
            "example_variables": op.example_variables, "content_type": op.content_type,
            "parameters": [
                {"name": p.name, "location": p.location, "required": p.required,
                 "type": p.type, "example": p.example, "placeholder": p.placeholder}
                for p in op.parameters
            ],
            "body_example": op.body_example,
        }
        for op in operations
    ]}


def _run_http(command: str, variables: dict) -> dict:
    parsed = parse_command(command, variables)
    if parsed.kind != "http" or not parsed.requests:
        return {"error": "Seules les requêtes HTTP s'exécutent depuis le site de test."}
    result = execute(parsed.requests[0])
    resp = result.response
    body = resp.text()
    if len(body) > 50000:
        body = body[:50000] + "\n… (tronqué)"
    return {"status": resp.status, "reason": resp.reason, "ok": resp.ok,
            "attempts": result.attempts, "headers": [list(h) for h in resp.headers],
            "body": body, "issues": result.issues}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # silencieux
        pass

    def _send(self, code: int, payload: dict, content_type="application/json"):
        data = json.dumps(payload, ensure_ascii=False).encode() if content_type == "application/json" else payload
        self.send_response(code)
        self.send_header("Content-Type", content_type + ("; charset=utf-8" if "json" in content_type or "html" in content_type else ""))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            with open(os.path.join(HERE, "index.html"), "rb") as f:
                self._send(200, f.read(), "text/html")
        else:
            self._send(404, {"error": "introuvable"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            self._send(400, {"error": "JSON invalide"})
            return
        command = payload.get("command", "")
        variables = payload.get("variables", {}) or {}
        try:
            if self.path == "/api/analyze":
                self._send(200, _analyze(command, variables))
            elif self.path == "/api/run":
                self._send(200, _run_http(command, variables))
            elif self.path == "/api/openapi":
                self._send(200, _openapi(payload.get("contract", "")))
            else:
                self._send(404, {"error": "introuvable"})
        except Exception as e:  # noqa: BLE001
            self._send(200, {"error": str(e)})


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Site de test urban-http : http://127.0.0.1:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()

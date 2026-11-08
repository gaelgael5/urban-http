"""Interface en ligne de commande : `urban-http "curl ..."`.

Analyse une commande curl / Postman et affiche la requête obtenue, ou l'exécute
avec --run.
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Dict, List

from . import parse_command, parse_postman, is_postman_collection, register_default_adapters, run
from .model import HttpRequestModel


def _parse_vars(pairs: List[str]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for p in pairs or []:
        if "=" in p:
            k, v = p.split("=", 1)
            out[k] = v
    return out


def _print_http(req: HttpRequestModel) -> None:
    print(f"{req.method} {req.url}")
    for n, v in req.headers:
        print(f"  {n}: {v}")
    if req.body and req.body.text:
        print(f"  corps: {req.body.text}")
    for w in req.warnings:
        print(f"  [{w.level}] {w.message}", file=sys.stderr)


def main(argv: List[str] = None) -> int:
    parser = argparse.ArgumentParser(prog="urban-http", description="Transformer une commande curl / Postman en appel exécutable.")
    parser.add_argument("command", help="commande curl (entre guillemets), ou '-' pour lire une collection Postman sur stdin")
    parser.add_argument("--run", action="store_true", help="exécuter la requête au lieu de seulement l'analyser")
    parser.add_argument("--var", action="append", default=[], metavar="CLE=VALEUR", help="variable (répétable)")
    parser.add_argument("--json", action="store_true", help="sortie JSON de la requête analysée")
    args = parser.parse_args(argv)

    variables = _parse_vars(args.var)
    command = sys.stdin.read() if args.command == "-" else args.command

    if is_postman_collection(command):
        result = parse_postman(command, variables)
        for req in result.requests:
            _print_http(req)
            print()
        return 0

    if args.run:
        register_default_adapters()
        res = run(command, variables)
        if res.kind == "http":
            resp = res.http.response
            print(f"{resp.status} {resp.reason}")
            print(resp.text())
        else:
            r = res.protocol
            print(r.summary)
            if r.body:
                sys.stdout.buffer.write(r.body)
        return 0

    parsed = parse_command(command, variables)
    if parsed.kind == "http":
        if args.json:
            print(json.dumps([_req_to_dict(r) for r in parsed.requests], indent=2, ensure_ascii=False))
        else:
            for req in parsed.requests:
                _print_http(req)
                print()
    else:
        r = parsed.request
        if r is None:
            for w in parsed.warnings:
                print(f"[{w.level}] {w.message}", file=sys.stderr)
            return 1
        print(f"{r.scheme}:// {r.direction} {r.host}:{r.port}{r.path}")
    return 0


def _req_to_dict(req: HttpRequestModel) -> dict:
    return {
        "method": req.method,
        "url": req.url,
        "headers": [list(h) for h in req.headers],
        "body": req.body.text if req.body else None,
        "warnings": [{"code": w.code, "level": w.level, "message": w.message} for w in req.warnings],
    }


if __name__ == "__main__":
    raise SystemExit(main())

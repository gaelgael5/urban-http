"""Interface en ligne de commande : `urban-http "curl ..."`.

Analyse une commande curl / Postman et affiche la requête obtenue, ou l'exécute
avec --run.
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Dict, List

from . import parse_command, parse_postman, is_postman_collection, openapi_to_curl, register_default_adapters, run
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
    parser.add_argument("command", nargs="?", help="commande curl (entre guillemets), ou '-' pour lire une collection Postman sur stdin")
    parser.add_argument("--run", action="store_true", help="exécuter la requête au lieu de seulement l'analyser")
    parser.add_argument("--var", action="append", default=[], metavar="CLE=VALEUR", help="variable (répétable)")
    parser.add_argument("--json", action="store_true", help="sortie JSON")
    parser.add_argument("--openapi", metavar="FICHIER", help="générer les commandes curl d'un contrat OpenAPI (ou '-' pour stdin)")
    args = parser.parse_args(argv)

    variables = _parse_vars(args.var)

    if args.openapi:
        return _openapi_mode(args.openapi, args.json)

    if not args.command:
        parser.error("une commande curl ou --openapi est requis")
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


def _openapi_mode(source: str, as_json: bool) -> int:
    contract = sys.stdin.read() if source == "-" else open(source, "r", encoding="utf-8").read()
    operations = openapi_to_curl(contract)
    if as_json:
        print(json.dumps([op.to_dict() for op in operations], indent=2, ensure_ascii=False))
        return 0
    for op in operations:
        print(f"# {op.method} {op.path}" + (f" — {op.summary}" if op.summary else ""))
        print(op.curl)
        if op.example_variables:
            print("# variables : " + ", ".join(f"{k}={v}" for k, v in op.example_variables.items()))
        print()
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

import { describe, expect, it } from "vitest";
import { tokenize } from "../src/tokenize.js";

describe("tokenize", () => {
  it("découpe une commande simple et retire le mot curl", () => {
    expect(tokenize("curl https://example.com")).toEqual(["https://example.com"]);
  });

  it("gère les quotes simples", () => {
    expect(tokenize(`curl -d '{"a": 1}' url`)).toEqual(["-d", '{"a": 1}', "url"]);
  });

  it("gère les quotes doubles avec échappements", () => {
    expect(tokenize(`curl -H "X: \\"quoted\\"" url`)).toEqual(["-H", 'X: "quoted"', "url"]);
  });

  it("gère les continuations de ligne bash", () => {
    expect(tokenize("curl -X POST \\\n  https://example.com")).toEqual(["-X", "POST", "https://example.com"]);
  });

  it("gère les continuations de ligne cmd (^)", () => {
    expect(tokenize('curl -X POST ^\n "https://example.com"')).toEqual(["-X", "POST", "https://example.com"]);
  });

  it("gère les doubles quotes doublées du cmd Windows", () => {
    expect(tokenize('curl -d "{""a"":1}" ^\n url')).toEqual(["-d", '{"a":1}', "url"]);
  });

  it("gère le quoting ANSI-C $'...'", () => {
    expect(tokenize(`curl -d $'line1\\nline2' url`)).toEqual(["-d", "line1\nline2", "url"]);
  });

  it("retire un prompt $ en tête", () => {
    expect(tokenize("$ curl https://example.com")).toEqual(["https://example.com"]);
  });

  it("accepte une commande sans le mot curl", () => {
    expect(tokenize("-X GET https://example.com")).toEqual(["-X", "GET", "https://example.com"]);
  });

  it("gère curl.exe", () => {
    expect(tokenize("curl.exe https://example.com")).toEqual(["https://example.com"]);
  });
});

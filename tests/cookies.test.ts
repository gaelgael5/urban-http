import { describe, expect, it } from "vitest";
import { cookiesForUrl, parseNetscapeCookies } from "../src/cookies.js";
import { parseCurl } from "../src/parse.js";
import { toFetch } from "../src/to-fetch.js";

const JAR = [
  "# Netscape HTTP Cookie File",
  "# https://curl.se/docs/http-cookies.html",
  "",
  ".example.com\tTRUE\t/\tFALSE\t0\tsession\tabc123",
  "api.example.com\tFALSE\t/v2\tFALSE\t0\tscope\tv2only",
  ".example.com\tTRUE\t/\tTRUE\t0\tsecure_only\ts3cret",
  ".example.com\tTRUE\t/\tFALSE\t1\texpired\tdead",
  "#HttpOnly_.example.com\tTRUE\t/\tFALSE\t0\thttponly\thidden",
  ".autre.com\tTRUE\t/\tFALSE\t0\tother\tx",
].join("\n");

describe("parseNetscapeCookies", () => {
  it("parse le format Netscape, #HttpOnly_ inclus", () => {
    const entries = parseNetscapeCookies(JAR);
    expect(entries).toHaveLength(6);
    expect(entries[0]).toMatchObject({ domain: "example.com", includeSubdomains: true, name: "session", value: "abc123" });
    expect(entries.find((e) => e.name === "httponly")).toBeDefined();
  });

  it("tolère les lignes nom=valeur simples", () => {
    const entries = parseNetscapeCookies("theme=dark\n");
    expect(entries).toEqual([
      { domain: "", includeSubdomains: true, path: "/", secure: false, expires: 0, name: "theme", value: "dark" },
    ]);
  });
});

describe("cookiesForUrl", () => {
  const entries = parseNetscapeCookies(JAR);

  it("filtre par domaine (sous-domaines inclus)", () => {
    const header = cookiesForUrl(entries, "http://www.example.com/");
    expect(header).toContain("session=abc123");
    expect(header).toContain("httponly=hidden");
    expect(header).not.toContain("other=x");
    expect(header).not.toContain("scope=v2only"); // domaine exact api.example.com
  });

  it("filtre par chemin", () => {
    expect(cookiesForUrl(entries, "http://api.example.com/v2/users")).toContain("scope=v2only");
    expect(cookiesForUrl(entries, "http://api.example.com/v1/users")).not.toContain("scope=v2only");
  });

  it("filtre secure et expiration", () => {
    expect(cookiesForUrl(entries, "https://example.com/")).toContain("secure_only=s3cret");
    const http = cookiesForUrl(entries, "http://example.com/");
    expect(http).not.toContain("secure_only");
    expect(http).not.toContain("expired=dead");
  });
});

describe("toFetch — fichier de cookies (-b fichier)", () => {
  it("résout le fichier et construit l'en-tête Cookie", () => {
    const req = parseCurl(`curl -b cookies.txt -b 'inline=1' https://www.example.com/`).requests[0]!;
    expect(req.cookieFiles).toEqual(["cookies.txt"]);
    const plan = toFetch(req, { readFile: () => JAR });
    const cookie = (plan.init.headers as Headers).get("cookie");
    expect(cookie).toContain("inline=1");
    expect(cookie).toContain("session=abc123");
    expect(plan.issues).toHaveLength(0);
  });

  it("sans readFile : signalé dans issues", () => {
    const req = parseCurl(`curl -b cookies.txt https://e.com/`).requests[0]!;
    const plan = toFetch(req);
    expect(plan.issues.some((i) => i.includes("cookies.txt"))).toBe(true);
  });
});

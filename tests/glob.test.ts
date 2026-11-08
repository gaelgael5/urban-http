import { describe, expect, it } from "vitest";
import { GlobError, expandCurlGlobs } from "../src/glob.js";
import { parseCurl } from "../src/parse.js";

describe("expandCurlGlobs", () => {
  it("alternatives {a,b,c}", () => {
    expect(expandCurlGlobs("https://e.com/{api,www}/ping")).toEqual([
      "https://e.com/api/ping",
      "https://e.com/www/ping",
    ]);
  });

  it("plage numérique [1-3]", () => {
    expect(expandCurlGlobs("https://e.com/p/[1-3]")).toEqual([
      "https://e.com/p/1",
      "https://e.com/p/2",
      "https://e.com/p/3",
    ]);
  });

  it("zéro-padding [01-03]", () => {
    expect(expandCurlGlobs("https://e.com/img[01-03].png")).toEqual([
      "https://e.com/img01.png",
      "https://e.com/img02.png",
      "https://e.com/img03.png",
    ]);
  });

  it("pas [0-100:50]", () => {
    expect(expandCurlGlobs("https://e.com/[0-100:50]")).toEqual([
      "https://e.com/0",
      "https://e.com/50",
      "https://e.com/100",
    ]);
  });

  it("plage alphabétique [a-c]", () => {
    expect(expandCurlGlobs("https://e.com/[a-c]")).toEqual([
      "https://e.com/a",
      "https://e.com/b",
      "https://e.com/c",
    ]);
  });

  it("produit cartésien {}+[]", () => {
    expect(expandCurlGlobs("https://{eu,us}.e.com/p/[1-2]")).toEqual([
      "https://eu.e.com/p/1",
      "https://eu.e.com/p/2",
      "https://us.e.com/p/1",
      "https://us.e.com/p/2",
    ]);
  });

  it("rejette une plage invalide (IPv6 par exemple)", () => {
    expect(() => expandCurlGlobs("http://[::1]:8080/")).toThrow(GlobError);
  });

  it("rejette une expansion trop large", () => {
    expect(() => expandCurlGlobs("https://e.com/[1-100000]")).toThrow(/limite/);
  });
});

describe("parseCurl — globbing", () => {
  it("développe l'URL en plusieurs requêtes", () => {
    const { requests } = parseCurl(`curl 'https://httpbin.org/anything/[1-3]'`);
    expect(requests.map((r) => r.url)).toEqual([
      "https://httpbin.org/anything/1",
      "https://httpbin.org/anything/2",
      "https://httpbin.org/anything/3",
    ]);
  });

  it("-g désactive le globbing", () => {
    const { requests } = parseCurl(`curl -g 'https://e.com/literal[1-3]'`);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://e.com/literal[1-3]");
  });

  it("motif invalide : warning et URL littérale", () => {
    const { requests } = parseCurl(`curl 'http://[::1]:8080/sante'`);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("http://[::1]:8080/sante");
    expect(requests[0]!.warnings.some((w) => w.code === "url-globbing")).toBe(true);
  });

  it("le globbing se combine avec la config partagée", () => {
    const { requests } = parseCurl(`curl -H 'X: 1' 'https://e.com/{a,b}'`);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.headers).toEqual([["X", "1"]]);
  });
});

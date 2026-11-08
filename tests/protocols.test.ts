import { describe, expect, it } from "vitest";
import { parseCurl } from "../src/parse.js";

const one = (cmd: string, vars?: Record<string, string>) => {
  const result = parseCurl(cmd, vars ? { variables: vars } : {});
  expect(result.requests.length).toBeGreaterThan(0);
  return result.requests[0]!;
};

describe("protocoles non-HTTP : signalés proprement", () => {
  it("smtp:// (envoi de mail) : erreur claire + options mail reconnues", () => {
    const r = one(`curl smtp://mail.example.com --mail-from moi@example.com --mail-rcpt toi@example.com -T message.txt`);
    expect(r.warnings.some((w) => w.code === "unsupported-protocol" && w.message.includes("smtp") && w.message.includes("nodemailer"))).toBe(true);
    const mailOpts = r.warnings.filter((w) => w.code === "unsupported-protocol-option");
    expect(mailOpts).toHaveLength(2);
    expect(mailOpts[0]!.message).toContain("SMTP");
  });

  it("ftp:// et commandes -Q", () => {
    const r = one(`curl -Q "DELE vieux.txt" ftp://ftp.example.com/fichier.txt`);
    expect(r.warnings.some((w) => w.code === "unsupported-protocol" && w.message.includes("ftp"))).toBe(true);
    expect(r.warnings.some((w) => w.code === "unsupported-protocol-option" && w.option === "-Q/--quote")).toBe(true);
  });

  it("ws:// suggère l'API WebSocket", () => {
    const r = one(`curl ws://echo.example.com/socket`);
    expect(r.warnings.some((w) => w.code === "unsupported-protocol" && w.message.includes("WebSocket"))).toBe(true);
  });

  it("http et https ne déclenchent rien", () => {
    expect(one("curl https://e.com").warnings.filter((w) => w.code === "unsupported-protocol")).toHaveLength(0);
    expect(one("curl http://e.com").warnings.filter((w) => w.code === "unsupported-protocol")).toHaveLength(0);
  });

  it("options reconnues : netrc, time-cond, continue-at, socks", () => {
    const r = one(`curl -n -z "10 Nov 2026" -C 1024 --socks5 localhost:1080 https://e.com`);
    const codes = r.warnings.filter((w) => w.code === "unsupported-option").map((w) => w.option);
    expect(codes).toContain("-n/--netrc");
    expect(codes).toContain("-z/--time-cond");
    expect(codes).toContain("-C/--continue-at");
    expect(codes).toContain("--socks5");
    expect(r.warnings.some((w) => w.code === "unknown-option")).toBe(false);
  });

  it("-Z/--parallel : info, pas d'option inconnue", () => {
    const r = one(`curl -Z --parallel-max 10 https://a.com https://b.com`);
    expect(r.warnings.some((w) => w.code === "cli-only-option" && w.message.includes("Promise.all"))).toBe(true);
    expect(r.warnings.some((w) => w.code === "unknown-option")).toBe(false);
  });
});

describe("--url-query", () => {
  it("ajoute des paramètres encodés à l'URL, même avec un corps", () => {
    const r = one(`curl --url-query 'q=crème brûlée' --url-query 'page=2' -d 'corps=1' https://e.com/search`);
    expect(r.url).toBe("https://e.com/search?q=cr%C3%A8me+br%C3%BBl%C3%A9e&page=2");
    expect(r.method).toBe("POST");
    expect(r.body?.text).toBe("corps=1");
  });

  it("forme +brut sans encodage", () => {
    const r = one(`curl --url-query '+a=b%20c' https://e.com`);
    expect(r.url).toBe("https://e.com?a=b%20c");
  });

  it("s'ajoute à une query string existante", () => {
    const r = one(`curl --url-query 'b=2' 'https://e.com/x?a=1'`);
    expect(r.url).toBe("https://e.com/x?a=1&b=2");
  });
});

describe("--variable / --expand-* (curl 8.3+)", () => {
  it("NOM=valeur utilisable en {{NOM}} dans toute la commande", () => {
    const r = one(`curl --variable host=api.e.com --expand-url 'https://{{host}}/ping'`);
    expect(r.url).toBe("https://api.e.com/ping");
  });

  it("%NOM importe depuis options.variables, avec défaut", () => {
    const r1 = one(`curl --variable %region --expand-url 'https://{{region}}.e.com'`, { region: "eu" });
    expect(r1.url).toBe("https://eu.e.com");
    const r2 = one(`curl --variable %region=us --expand-url 'https://{{region}}.e.com'`);
    expect(r2.url).toBe("https://us.e.com");
  });

  it("%NOM sans valeur ni défaut : warning", () => {
    const { warnings } = parseCurl(`curl --variable %absent https://e.com`);
    expect(warnings.some((w) => w.code === "unresolved-variable" && w.message.includes("absent"))).toBe(true);
  });

  it("--expand-data et --expand-header", () => {
    const r = one(`curl --variable v=42 --expand-header 'X-V: {{v}}' --expand-data 'val={{v}}' https://e.com`);
    expect(r.headers).toContainEqual(["X-V", "42"]);
    expect(r.body?.text).toBe("val=42");
  });
});

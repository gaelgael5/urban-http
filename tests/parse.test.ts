import { describe, expect, it } from "vitest";
import { parseCurl } from "../src/parse.js";
import { authHeader, toFetch, toFetchCode } from "../src/to-fetch.js";

const one = (cmd: string) => {
  const result = parseCurl(cmd);
  expect(result.requests.length).toBeGreaterThan(0);
  return result.requests[0]!;
};

const header = (req: ReturnType<typeof one>, name: string) =>
  req.headers.find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1];

describe("parseCurl — basiques", () => {
  it("GET simple", () => {
    const r = one("curl https://api.example.com/users");
    expect(r.method).toBe("GET");
    expect(r.url).toBe("https://api.example.com/users");
  });

  it("ajoute http:// si le schéma manque", () => {
    const r = one("curl example.com");
    expect(r.url).toBe("http://example.com");
    expect(r.warnings.some((w) => w.code === "default-scheme")).toBe(true);
  });

  it("-X définit la méthode", () => {
    expect(one("curl -X DELETE https://e.com").method).toBe("DELETE");
    expect(one("curl --request put https://e.com").method).toBe("PUT");
  });

  it("-XPOST collé fonctionne", () => {
    expect(one("curl -XPOST https://e.com").method).toBe("POST");
  });

  it("-I donne HEAD, mais -X l'emporte", () => {
    expect(one("curl -I https://e.com").method).toBe("HEAD");
    const r = one("curl -I -X GET https://e.com");
    expect(r.method).toBe("GET");
    expect(r.warnings.some((w) => w.code === "method-conflict")).toBe(true);
  });

  it("--url fonctionne", () => {
    expect(one("curl --url https://e.com").url).toBe("https://e.com");
  });

  it("options courtes groupées -sSL", () => {
    const r = one("curl -sSL https://e.com");
    expect(r.options.followRedirects).toBe(true);
  });
});

describe("parseCurl — en-têtes", () => {
  it("-H multiples, ordre préservé", () => {
    const r = one(`curl -H 'Accept: application/json' -H 'X-Trace: abc' https://e.com`);
    expect(r.headers).toEqual([
      ["Accept", "application/json"],
      ["X-Trace", "abc"],
    ]);
  });

  it(`-H "Header;" envoie un en-tête vide`, () => {
    const r = one(`curl -H "X-Empty;" https://e.com`);
    expect(header(r, "X-Empty")).toBe("");
  });

  it(`-H "Header:" supprime l'en-tête généré`, () => {
    const r = one(`curl -A agent -H "User-Agent:" https://e.com`);
    expect(header(r, "User-Agent")).toBeUndefined();
  });

  it("-A, -e, -r deviennent des en-têtes", () => {
    const r = one(`curl -A "MyAgent/1.0" -e "https://ref.com" -r 0-499 https://e.com`);
    expect(header(r, "User-Agent")).toBe("MyAgent/1.0");
    expect(header(r, "Referer")).toBe("https://ref.com");
    expect(header(r, "Range")).toBe("bytes=0-499");
  });

  it("--compressed ajoute Accept-Encoding", () => {
    const r = one("curl --compressed https://e.com");
    expect(header(r, "Accept-Encoding")).toContain("gzip");
  });
});

describe("parseCurl — corps", () => {
  it("-d simple : POST + urlencoded", () => {
    const r = one(`curl -d "name=jean&age=30" https://e.com`);
    expect(r.method).toBe("POST");
    expect(r.body?.text).toBe("name=jean&age=30");
    expect(header(r, "Content-Type")).toBe("application/x-www-form-urlencoded");
  });

  it("-d multiples concaténés avec &", () => {
    const r = one(`curl -d a=1 -d b=2 https://e.com`);
    expect(r.body?.text).toBe("a=1&b=2");
  });

  it("-d JSON avec Content-Type explicite", () => {
    const r = one(`curl -d '{"a":1}' -H 'Content-Type: application/json' https://e.com`);
    expect(r.body?.text).toBe('{"a":1}');
    expect(header(r, "Content-Type")).toBe("application/json");
    expect(r.headers.filter(([n]) => n.toLowerCase() === "content-type")).toHaveLength(1);
  });

  it("--data-urlencode encode la valeur", () => {
    const r = one(`curl --data-urlencode "q=héllo wörld" https://e.com`);
    expect(r.body?.text).toBe("q=h%C3%A9llo+w%C3%B6rld");
  });

  it("--data-urlencode '=contenu' encode tout", () => {
    const r = one(`curl --data-urlencode "=a&b" https://e.com`);
    expect(r.body?.text).toBe("a%26b");
  });

  it("--data-raw ne traite pas @ comme un fichier", () => {
    const r = one(`curl --data-raw "@notafile" https://e.com`);
    expect(r.body?.text).toBe("@notafile");
  });

  it("-d @fichier crée une référence de fichier", () => {
    const r = one(`curl -d @payload.json https://e.com`);
    expect(r.body?.items?.[0]?.filePath).toBe("payload.json");
    expect(r.warnings.some((w) => w.code === "file-reference")).toBe(true);
  });

  it("--json : body + les deux en-têtes", () => {
    const r = one(`curl --json '{"tool": "curl"}' https://e.com`);
    expect(r.method).toBe("POST");
    expect(r.body?.text).toBe('{"tool": "curl"}');
    expect(header(r, "Content-Type")).toBe("application/json");
    expect(header(r, "Accept")).toBe("application/json");
  });

  it("-G transfère les données en query string", () => {
    const r = one(`curl -G -d "q=test" -d "page=2" https://e.com/search`);
    expect(r.method).toBe("GET");
    expect(r.url).toBe("https://e.com/search?q=test&page=2");
    expect(r.body).toBeUndefined();
    expect(r.query).toEqual([
      ["q", "test"],
      ["page", "2"],
    ]);
  });

  it("-G + --data-urlencode encode dans l'URL", () => {
    const r = one(`curl -G --data-urlencode "q=a b" https://e.com`);
    expect(r.url).toBe("https://e.com?q=a+b");
  });
});

describe("parseCurl — multipart", () => {
  it("-F champs texte et fichier", () => {
    const r = one(`curl -F "name=jean" -F "avatar=@photo.png;type=image/png" https://e.com/upload`);
    expect(r.method).toBe("POST");
    expect(r.body?.kind).toBe("multipart");
    expect(r.body?.parts).toEqual([
      { name: "name", value: "jean" },
      { name: "avatar", filePath: "photo.png", contentType: "image/png" },
    ]);
  });

  it("-F avec filename=", () => {
    const r = one(`curl -F 'file=@a.txt;filename=renamed.txt' https://e.com`);
    expect(r.body?.parts?.[0]?.fileName).toBe("renamed.txt");
  });

  it("--form-string n'interprète pas @", () => {
    const r = one(`curl --form-string "text=@literal" https://e.com`);
    expect(r.body?.parts?.[0]?.value).toBe("@literal");
  });

  it("-F name=<file envoie le contenu comme champ texte", () => {
    const r = one(`curl -F "notes=<notes.txt" https://e.com`);
    expect(r.body?.parts?.[0]?.contentFromFile).toBe("notes.txt");
  });
});

describe("parseCurl — auth et cookies", () => {
  it("-u user:pass donne du Basic", () => {
    const r = one(`curl -u alice:secret https://e.com`);
    expect(r.auth).toEqual({ kind: "basic", username: "alice", password: "secret" });
    expect(authHeader(r)).toEqual(["Authorization", `Basic ${btoa("alice:secret")}`]);
  });

  it("--oauth2-bearer donne du Bearer", () => {
    const r = one(`curl --oauth2-bearer TOKEN123 https://e.com`);
    expect(authHeader(r)).toEqual(["Authorization", "Bearer TOKEN123"]);
  });

  it("--digest émet un warning", () => {
    const r = one(`curl --digest -u a:b https://e.com`);
    expect(r.auth?.kind).toBe("digest");
    expect(r.warnings.some((w) => w.code === "unsupported-auth")).toBe(true);
  });

  it("-b nom=valeur devient l'en-tête Cookie", () => {
    const r = one(`curl -b "session=abc" -b "theme=dark" https://e.com`);
    expect(header(r, "Cookie")).toBe("session=abc; theme=dark");
  });

  it("-b fichier émet un warning", () => {
    const r = one(`curl -b cookies.txt https://e.com`);
    expect(r.warnings.some((w) => w.code === "unsupported-option")).toBe(true);
  });
});

describe("parseCurl — options de transfert", () => {
  it("-L, --max-redirs, -k, -m", () => {
    const r = one(`curl -L --max-redirs 3 -k -m 2.5 https://e.com`);
    expect(r.options.followRedirects).toBe(true);
    expect(r.options.maxRedirs).toBe(3);
    expect(r.options.insecure).toBe(true);
    expect(r.options.timeoutMs).toBe(2500);
  });

  it("--retry et --retry-delay", () => {
    const r = one(`curl --retry 3 --retry-delay 2 https://e.com`);
    expect(r.options.retry).toBe(3);
    expect(r.options.retryDelayMs).toBe(2000);
  });

  it("--proxy est signalé non supporté", () => {
    const r = one(`curl -x http://proxy:8080 https://e.com`);
    expect(r.options.proxy).toBe("http://proxy:8080");
    expect(r.warnings.some((w) => w.code === "unsupported-option")).toBe(true);
  });

  it("-T donne un PUT de fichier", () => {
    const r = one(`curl -T rapport.pdf https://e.com/files/`);
    expect(r.method).toBe("PUT");
    expect(r.body).toEqual({ kind: "file", filePath: "rapport.pdf" });
  });

  it("les options d'affichage sont ignorées sans erreur", () => {
    const r = one(`curl -s -S -v -o out.txt -w "%{http_code}" https://e.com`);
    expect(r.method).toBe("GET");
  });
});

describe("parseCurl — plusieurs requêtes", () => {
  it("plusieurs URLs partagent la configuration", () => {
    const { requests } = parseCurl(`curl -H "X: 1" https://a.com https://b.com`);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.url).toBe("https://a.com");
    expect(requests[1]!.url).toBe("https://b.com");
    expect(requests[1]!.headers).toEqual([["X", "1"]]);
  });

  it("--next sépare des requêtes indépendantes", () => {
    const { requests } = parseCurl(`curl -d a=1 https://a.com --next -I https://b.com`);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[1]!.method).toBe("HEAD");
    expect(requests[1]!.body).toBeUndefined();
  });

  it("commande sans URL : erreur dans les warnings globaux", () => {
    const { requests, warnings } = parseCurl("curl -s");
    expect(requests).toHaveLength(0);
    expect(warnings.some((w) => w.code === "no-url")).toBe(true);
  });

  it("option inconnue : warning mais parsing poursuivi", () => {
    const r = one(`curl --frobnicate https://e.com`);
    expect(r.url).toBe("https://e.com");
    expect(r.warnings.some((w) => w.code === "unknown-option")).toBe(true);
  });
});

describe("toFetch / toFetchCode", () => {
  it("construit un plan fetch complet", () => {
    const r = one(`curl -X POST -H 'Content-Type: application/json' -d '{"a":1}' -u u:p -L -m 5 https://e.com`);
    const plan = toFetch(r);
    expect(plan.url).toBe("https://e.com");
    expect(plan.init.method).toBe("POST");
    expect(plan.init.body).toBe('{"a":1}');
    expect(plan.init.redirect).toBe("follow");
    expect((plan.init.headers as Headers).get("authorization")).toMatch(/^Basic /);
    expect(plan.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("sans -L, les redirections ne sont pas suivies (comme curl)", () => {
    const plan = toFetch(one("curl https://e.com"));
    expect(plan.init.redirect).toBe("manual");
  });

  it("multipart devient un FormData", () => {
    const plan = toFetch(one(`curl -F a=1 -F b=2 https://e.com`));
    expect(plan.init.body).toBeInstanceOf(FormData);
  });

  it("résout les fichiers via readFile", () => {
    const r = one(`curl -d @data.txt https://e.com`);
    const plan = toFetch(r, { readFile: () => "ligne1\nligne2" });
    // --data supprime les retours à la ligne, comme curl
    expect(plan.init.body).toBe("ligne1ligne2");
    expect(plan.issues).toHaveLength(0);
  });

  it("signale les fichiers non résolus sans planter", () => {
    const plan = toFetch(one(`curl -d @missing.txt https://e.com`));
    expect(plan.issues.length).toBeGreaterThan(0);
  });

  it("génère du code fetch lisible", () => {
    const code = toFetchCode(one(`curl -X POST -d 'x=1' https://e.com`));
    expect(code).toContain('await fetch("https://e.com"');
    expect(code).toContain('method: "POST"');
    expect(code).toContain('body: "x=1"');
  });
});

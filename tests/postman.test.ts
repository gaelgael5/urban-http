import { describe, expect, it } from "vitest";
import { isPostmanCollection, parsePostman } from "../src/postman.js";
import { authHeader } from "../src/to-fetch.js";

const collection = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  info: { name: "Test", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  item: items,
  ...extra,
});

const header = (req: { headers: Array<[string, string]> }, name: string) =>
  req.headers.find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1];

describe("isPostmanCollection", () => {
  it("reconnaît une collection", () => {
    expect(isPostmanCollection(JSON.stringify(collection([])))).toBe(true);
    expect(isPostmanCollection("curl https://e.com")).toBe(false);
    expect(isPostmanCollection('{"a": 1}')).toBe(false);
  });
});

describe("parsePostman — basiques", () => {
  it("requête GET avec URL objet et query params", () => {
    const { requests } = parsePostman(collection([{
      name: "Liste des produits",
      request: {
        method: "GET",
        url: {
          raw: "https://api.example.com/products?limit=10&debug=1",
          host: ["api", "example", "com"],
          path: ["products"],
          query: [
            { key: "limit", value: "10" },
            { key: "debug", value: "1", disabled: true },
          ],
        },
      },
    }]));
    expect(requests).toHaveLength(1);
    const r = requests[0]!;
    expect(r.name).toBe("Liste des produits");
    expect(r.method).toBe("GET");
    // Le paramètre désactivé ne part pas sur le réseau
    expect(r.url).toBe("https://api.example.com/products?limit=10");
  });

  it("forme courte : request est une chaîne", () => {
    const { requests } = parsePostman(collection([{ request: "https://e.com/ping" }]));
    expect(requests[0]!.url).toBe("https://e.com/ping");
    expect(requests[0]!.method).toBe("GET");
  });

  it("URL composée sans raw", () => {
    const { requests } = parsePostman(collection([{
      request: { method: "GET", url: { protocol: "https", host: ["api", "e", "com"], port: "8443", path: ["v1", "ping"] } },
    }]));
    expect(requests[0]!.url).toBe("https://api.e.com:8443/v1/ping");
  });

  it("en-têtes : les désactivés sont ignorés", () => {
    const { requests } = parsePostman(collection([{
      request: {
        method: "GET",
        url: "https://e.com",
        header: [
          { key: "Accept", value: "application/json" },
          { key: "X-Debug", value: "1", disabled: true },
        ],
      },
    }]));
    expect(requests[0]!.headers).toEqual([["Accept", "application/json"]]);
  });

  it("dossiers imbriqués : toutes les requêtes sont trouvées", () => {
    const { requests } = parsePostman(collection([
      { name: "Dossier", item: [
        { name: "Sous-dossier", item: [{ name: "Profonde", request: "https://e.com/deep" }] },
        { name: "Directe", request: "https://e.com/direct" },
      ]},
    ]));
    expect(requests.map((r) => r.url)).toEqual(["https://e.com/deep", "https://e.com/direct"]);
  });

  it("Postman suit les redirections par défaut, sauf protocolProfileBehavior", () => {
    const { requests } = parsePostman(collection([
      { request: "https://e.com/a" },
      { request: "https://e.com/b", protocolProfileBehavior: { followRedirects: false } },
    ]));
    expect(requests[0]!.options.followRedirects).toBe(true);
    expect(requests[1]!.options.followRedirects).toBe(false);
  });
});

describe("parsePostman — corps", () => {
  it("raw JSON : Content-Type déduit du language", () => {
    const { requests } = parsePostman(collection([{
      request: {
        method: "POST",
        url: "https://e.com",
        body: { mode: "raw", raw: '{"a": 1}', options: { raw: { language: "json" } } },
      },
    }]));
    expect(requests[0]!.body?.text).toBe('{"a": 1}');
    expect(header(requests[0]!, "Content-Type")).toBe("application/json");
  });

  it("urlencoded : paires encodées, désactivées ignorées", () => {
    const { requests } = parsePostman(collection([{
      request: {
        method: "POST",
        url: "https://e.com",
        body: { mode: "urlencoded", urlencoded: [
          { key: "q", value: "crème brûlée" },
          { key: "skip", value: "1", disabled: true },
        ]},
      },
    }]));
    expect(requests[0]!.body?.text).toBe("q=cr%C3%A8me+br%C3%BBl%C3%A9e");
    expect(header(requests[0]!, "Content-Type")).toBe("application/x-www-form-urlencoded");
  });

  it("formdata : champs texte et fichier", () => {
    const { requests } = parsePostman(collection([{
      request: {
        method: "POST",
        url: "https://e.com",
        body: { mode: "formdata", formdata: [
          { key: "name", value: "jean", type: "text" },
          { key: "file", src: "/tmp/photo.png", type: "file", contentType: "image/png" },
        ]},
      },
    }]));
    const parts = requests[0]!.body?.parts;
    expect(requests[0]!.body?.kind).toBe("multipart");
    expect(parts).toEqual([
      { name: "name", value: "jean", contentType: undefined },
      { name: "file", filePath: "/tmp/photo.png", contentType: "image/png" },
    ]);
  });

  it("graphql : corps JSON avec query et variables", () => {
    const { requests } = parsePostman(collection([{
      request: {
        method: "POST",
        url: "https://e.com/graphql",
        body: { mode: "graphql", graphql: { query: "query { me { id } }", variables: '{"id": 7}' } },
      },
    }]));
    expect(JSON.parse(requests[0]!.body!.text!)).toEqual({ query: "query { me { id } }", variables: { id: 7 } });
    expect(header(requests[0]!, "Content-Type")).toBe("application/json");
  });
});

describe("parsePostman — authentification", () => {
  it("basic au niveau de la requête", () => {
    const { requests } = parsePostman(collection([{
      request: {
        method: "GET",
        url: "https://e.com",
        auth: { type: "basic", basic: [{ key: "username", value: "alice" }, { key: "password", value: "secret" }] },
      },
    }]));
    expect(authHeader(requests[0]!)).toEqual(["Authorization", `Basic ${btoa("alice:secret")}`]);
  });

  it("bearer hérité du niveau collection", () => {
    const { requests } = parsePostman(collection(
      [{ request: "https://e.com/a" }],
      { auth: { type: "bearer", bearer: [{ key: "token", value: "TOK" }] } }
    ));
    expect(authHeader(requests[0]!)).toEqual(["Authorization", "Bearer TOK"]);
  });

  it("apikey en en-tête", () => {
    const { requests } = parsePostman(collection([{
      request: {
        method: "GET",
        url: "https://e.com",
        auth: { type: "apikey", apikey: [{ key: "key", value: "X-Api-Key" }, { key: "value", value: "k123" }] },
      },
    }]));
    expect(header(requests[0]!, "X-Api-Key")).toBe("k123");
  });

  it("auth non supportée : warning", () => {
    const { requests } = parsePostman(collection([{
      request: { method: "GET", url: "https://e.com", auth: { type: "oauth1" } },
    }]));
    expect(requests[0]!.warnings.some((w) => w.code === "unsupported-auth")).toBe(true);
  });
});

describe("parsePostman — variables", () => {
  it("variables de collection substituées", () => {
    const { requests } = parsePostman(collection(
      [{ request: "{{baseUrl}}/users" }],
      { variable: [{ key: "baseUrl", value: "https://api.e.com" }] }
    ));
    expect(requests[0]!.url).toBe("https://api.e.com/users");
  });

  it("options.variables prioritaires sur la collection", () => {
    const { requests } = parsePostman(
      collection([{ request: "{{baseUrl}}/users" }], { variable: [{ key: "baseUrl", value: "https://prod.e.com" }] }),
      { variables: { baseUrl: "https://staging.e.com" } }
    );
    expect(requests[0]!.url).toBe("https://staging.e.com/users");
  });

  it("variable non résolue : conservée + warning global", () => {
    const { requests, warnings } = parsePostman(collection([{ request: "{{baseUrl}}/users" }]));
    expect(requests[0]!.url).toBe("{{baseUrl}}/users");
    expect(warnings.some((w) => w.code === "unresolved-variable")).toBe(true);
  });
});

describe("parsePostman — erreurs et divers", () => {
  it("JSON invalide", () => {
    const { requests, warnings } = parsePostman("{pas du json");
    expect(requests).toHaveLength(0);
    expect(warnings[0]!.code).toBe("invalid-json");
  });

  it("JSON qui n'est pas une collection", () => {
    const { warnings } = parsePostman('{"a": 1}');
    expect(warnings[0]!.code).toBe("not-a-collection");
  });

  it("scripts pre-request signalés", () => {
    const { requests } = parsePostman(collection([{
      request: "https://e.com",
      event: [{ listen: "prerequest", script: { exec: ["pm.environment.set('x', 1);"] } }],
    }]));
    expect(requests[0]!.warnings.some((w) => w.code === "scripts-not-executed")).toBe(true);
  });
});

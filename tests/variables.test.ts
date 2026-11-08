import { describe, expect, it } from "vitest";
import { parseCurl } from "../src/parse.js";
import { parsePostman } from "../src/postman.js";
import { parsePostmanEnvironment } from "../src/variables.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("parseCurl — placeholders {{...}}", () => {
  it("substitue dans l'URL, les en-têtes et le corps", () => {
    const { requests, warnings } = parseCurl(
      `curl -H 'X-Api-Key: {{apiKey}}' -d '{"env": "{{env}}"}' {{baseUrl}}/users`,
      { variables: { baseUrl: "https://api.e.com", apiKey: "k-123", env: "prod" } }
    );
    const r = requests[0]!;
    expect(r.url).toBe("https://api.e.com/users");
    expect(r.headers).toContainEqual(["X-Api-Key", "k-123"]);
    expect(r.body?.text).toBe('{"env": "prod"}');
    expect(warnings).toHaveLength(0);
  });

  it("variable non résolue : laissée telle quelle + warning", () => {
    const { requests, warnings } = parseCurl(`curl https://e.com/{{tenant}}/info`);
    expect(requests[0]!.url).toBe("https://e.com/{{tenant}}/info");
    expect(warnings.some((w) => w.code === "unresolved-variable" && w.message.includes("tenant"))).toBe(true);
  });
});

describe("parseCurl — variables shell $VAR", () => {
  const vars = { TOKEN: "tok-42", HOST: "api.e.com" };

  it("substitue à nu et dans les quotes doubles", () => {
    const { requests } = parseCurl(`curl -H "Authorization: Bearer $TOKEN" https://$HOST/me`, { variables: vars });
    expect(requests[0]!.headers).toContainEqual(["Authorization", "Bearer tok-42"]);
    expect(requests[0]!.url).toBe("https://api.e.com/me");
  });

  it("forme ${VAR}", () => {
    const { requests } = parseCurl(`curl https://\${HOST}/sante`, { variables: vars });
    expect(requests[0]!.url).toBe("https://api.e.com/sante");
  });

  it("jamais dans les quotes simples (comme bash)", () => {
    const { requests } = parseCurl(`curl -d '$TOKEN' https://e.com`, { variables: vars });
    expect(requests[0]!.body?.text).toBe("$TOKEN");
  });

  it("sans option variables : aucun $ touché, aucun warning", () => {
    const { requests, warnings } = parseCurl(`curl -u 'pa$$word:x' https://e.com/$path`);
    expect(requests[0]!.url).toBe("https://e.com/$path");
    expect(warnings).toHaveLength(0);
  });

  it("variable shell absente de la map : conservée + warning", () => {
    const { requests, warnings } = parseCurl(`curl https://e.com/$MISSING`, { variables: vars });
    expect(requests[0]!.url).toBe("https://e.com/$MISSING");
    expect(warnings.some((w) => w.code === "unresolved-shell-variable" && w.message.includes("MISSING"))).toBe(true);
  });
});

describe("variables dynamiques {{$...}}", () => {
  it("{{$guid}} et {{$randomUUID}} génèrent des UUID différents", () => {
    const { requests } = parseCurl(`curl -d '{"a": "{{$guid}}", "b": "{{$randomUUID}}"}' https://e.com`);
    const body = JSON.parse(requests[0]!.body!.text!);
    expect(body.a).toMatch(UUID_RE);
    expect(body.b).toMatch(UUID_RE);
    expect(body.a).not.toBe(body.b);
  });

  it("{{$timestamp}}, {{$isoTimestamp}}, {{$randomInt}}", () => {
    const { requests } = parseCurl(
      `curl -d 'ts={{$timestamp}}&iso={{$isoTimestamp}}&n={{$randomInt}}' https://e.com`
    );
    const text = requests[0]!.body!.text!;
    const ts = /ts=(\d+)/.exec(text)![1]!;
    expect(Math.abs(parseInt(ts, 10) - Date.now() / 1000)).toBeLessThan(5);
    expect(text).toMatch(/iso=\d{4}-\d{2}-\d{2}T[\d:.]+Z/);
    const n = parseInt(/n=(\d+)/.exec(text)![1]!, 10);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThanOrEqual(1000);
  });

  it("dynamique inconnue : conservée + warning", () => {
    const { requests, warnings } = parseCurl(`curl https://e.com/{{$randomCity}}`);
    expect(requests[0]!.url).toBe("https://e.com/{{$randomCity}}");
    expect(warnings.some((w) => w.code === "unsupported-dynamic-variable")).toBe(true);
  });

  it("fonctionne aussi côté Postman", () => {
    const { requests } = parsePostman({
      info: { name: "t", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
      item: [{ request: { method: "POST", url: "https://e.com", body: { mode: "raw", raw: '{"id": "{{$guid}}"}' } } }],
    });
    expect(JSON.parse(requests[0]!.body!.text!).id).toMatch(UUID_RE);
  });
});

describe("parsePostmanEnvironment", () => {
  it("lit un export d'environnement Postman", () => {
    const env = JSON.stringify({
      name: "Staging",
      values: [
        { key: "baseUrl", value: "https://staging.e.com", enabled: true },
        { key: "off", value: "x", enabled: false },
        { key: "token", value: "t1" },
      ],
    });
    expect(parsePostmanEnvironment(env)).toEqual({ baseUrl: "https://staging.e.com", token: "t1" });
  });

  it("tolère un objet clé/valeur simple", () => {
    expect(parsePostmanEnvironment({ a: "1", b: "2" })).toEqual({ a: "1", b: "2" });
  });

  it("alimente parsePostman via options.variables", () => {
    const env = parsePostmanEnvironment({ values: [{ key: "baseUrl", value: "https://env.e.com" }] });
    const { requests } = parsePostman(
      {
        info: { name: "t", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
        variable: [{ key: "baseUrl", value: "https://collection.e.com" }],
        item: [{ request: "{{baseUrl}}/x" }],
      },
      { variables: env }
    );
    // L'environnement est prioritaire sur la variable de collection
    expect(requests[0]!.url).toBe("https://env.e.com/x");
  });
});

import { describe, expect, it } from "vitest";
import { parseCurl } from "../src/parse.js";
import { execute } from "../src/execute.js";

const first = (cmd: string) => parseCurl(cmd).requests[0]!;

describe("execute", () => {
  it("envoie la requête avec la bonne méthode et le bon corps", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      seen = { url: String(url), init };
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const result = await execute(first(`curl -X PUT -d 'x=1' https://e.com/item`), { fetchImpl });
    expect(result.response.status).toBe(200);
    expect(result.attempts).toBe(1);
    expect(seen?.url).toBe("https://e.com/item");
    expect(seen?.init?.method).toBe("PUT");
    expect(seen?.init?.body).toBe("x=1");
  });

  it("réessaie sur les statuts transitoires avec --retry", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(null, { status: calls < 3 ? 503 : 200 });
    }) as typeof fetch;

    const req = first(`curl --retry 5 --retry-delay 0.001 https://e.com`);
    const result = await execute(req, { fetchImpl });
    expect(result.response.status).toBe(200);
    expect(result.attempts).toBe(3);
  });

  it("ne réessaie pas sans --retry", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(null, { status: 503 });
    }) as typeof fetch;

    const result = await execute(first(`curl https://e.com`), { fetchImpl });
    expect(result.response.status).toBe(503);
    expect(calls).toBe(1);
  });

  it("relance l'erreur réseau après épuisement des retries", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      throw new Error("réseau coupé");
    }) as typeof fetch;

    const req = first(`curl --retry 2 --retry-delay 0.001 https://e.com`);
    await expect(execute(req, { fetchImpl })).rejects.toThrow("réseau coupé");
    expect(calls).toBe(3);
  });
});

import { describe, expect, it } from "vitest";
import { buildDigestAuthorization, md5Hex, parseDigestChallenge } from "../src/digest.js";
import { parseCurl } from "../src/parse.js";
import { execute } from "../src/execute.js";

describe("md5", () => {
  it("vecteurs de test RFC 1321", () => {
    expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5Hex("message digest")).toBe("f96b697d7cb7938d525a2f31aaf161d0");
    expect(md5Hex("12345678901234567890123456789012345678901234567890123456789012345678901234567890"))
      .toBe("57edf4a22be3c955ac49da2e2107b67a");
  });
});

describe("parseDigestChallenge", () => {
  it("parse un challenge complet", () => {
    const ch = parseDigestChallenge(
      `Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"`
    );
    expect(ch).toEqual({
      realm: "testrealm@host.com",
      qop: "auth,auth-int",
      nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093",
      opaque: "5ccc069c403ebaf9f0171e9517f40e41",
      algorithm: undefined,
      stale: false,
    });
  });

  it("trouve le Digest parmi plusieurs schémas", () => {
    const ch = parseDigestChallenge(`Basic realm="r1", Digest realm="r2", nonce="n"`);
    expect(ch?.nonce).toBe("n");
  });

  it("renvoie undefined sans challenge Digest", () => {
    expect(parseDigestChallenge(`Basic realm="r1"`)).toBeUndefined();
  });
});

describe("buildDigestAuthorization", () => {
  it("reproduit l'exemple MD5 de la RFC 2617", async () => {
    const header = await buildDigestAuthorization(
      {
        realm: "testrealm@host.com",
        nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093",
        qop: "auth,auth-int",
        opaque: "5ccc069c403ebaf9f0171e9517f40e41",
      },
      { username: "Mufasa", password: "Circle Of Life" },
      "GET",
      "/dir/index.html",
      { cnonce: "0a4f113b", nc: "00000001" }
    );
    expect(header).toContain(`response="6629fae49393a05397450978507c4ef1"`);
    expect(header).toContain(`username="Mufasa"`);
    expect(header).toContain(`qop=auth`);
    expect(header).toContain(`opaque="5ccc069c403ebaf9f0171e9517f40e41"`);
  });

  it("reproduit l'exemple SHA-256 de la RFC 7616", async () => {
    const header = await buildDigestAuthorization(
      {
        realm: "http-auth@example.org",
        nonce: "7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v",
        qop: "auth",
        opaque: "FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS",
        algorithm: "SHA-256",
      },
      { username: "Mufasa", password: "Circle of Life" },
      "GET",
      "/dir/index.html",
      { cnonce: "f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ", nc: "00000001" }
    );
    expect(header).toContain(`response="753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1"`);
    expect(header).toContain(`algorithm=SHA-256`);
  });

  it("refuse un algorithme inconnu", async () => {
    const header = await buildDigestAuthorization(
      { realm: "r", nonce: "n", algorithm: "MD4" },
      { username: "u", password: "p" },
      "GET",
      "/"
    );
    expect(header).toBeUndefined();
  });

  it("mode RFC 2069 (sans qop)", async () => {
    const header = await buildDigestAuthorization(
      { realm: "r", nonce: "n" },
      { username: "u", password: "p" },
      "GET",
      "/x"
    );
    expect(header).toMatch(/^Digest username="u", realm="r", nonce="n", uri="\/x", response="[0-9a-f]{32}"$/);
  });
});

describe("execute — négociation Digest", () => {
  it("répond au challenge 401 par une seconde requête authentifiée", async () => {
    const calls: Array<{ auth: string | null }> = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ auth: headers.get("authorization") });
      if (calls.length === 1) {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": `Digest realm="me@kennethreitz.com", nonce="abc123", qop="auth", opaque="xyz", algorithm=MD5`,
          },
        });
      }
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const req = parseCurl(`curl --digest -u alice:secret https://e.com/digest-auth/auth/alice/secret`).requests[0]!;
    const result = await execute(req, { fetchImpl });

    expect(result.response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.auth).toBeNull(); // première requête sans Authorization
    expect(calls[1]!.auth).toMatch(/^Digest username="alice", realm="me@kennethreitz\.com"/);
    expect(calls[1]!.auth).toContain(`uri="/digest-auth/auth/alice/secret"`);
    expect(calls[1]!.auth).toMatch(/response="[0-9a-f]{32}"/);
  });

  it("renvoie le 401 avec une explication si le challenge est illisible", async () => {
    const fetchImpl = (async () => new Response(null, { status: 401 })) as typeof fetch;
    const req = parseCurl(`curl --digest -u a:b https://e.com/`).requests[0]!;
    const result = await execute(req, { fetchImpl });
    expect(result.response.status).toBe(401);
    expect(result.issues.some((i) => i.includes("WWW-Authenticate"))).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { parseProtocolCommand } from "../src/protocols/parse.js";
import { parseCommand } from "../src/command.js";

const req = (cmd: string, vars?: Record<string, string>) => {
  const r = parseProtocolCommand(cmd, vars ? { variables: vars } : {});
  expect(r.request).toBeDefined();
  return r.request!;
};

describe("parseProtocolCommand — détection", () => {
  it("http/https routé vers parseCurl", () => {
    expect(parseProtocolCommand("curl https://e.com").isHttp).toBe(true);
    expect(parseProtocolCommand("curl http://e.com").isHttp).toBe(true);
  });

  it("parseCommand renvoie kind http ou protocol", () => {
    expect(parseCommand("curl https://e.com").kind).toBe("http");
    const p = parseCommand("curl ftp://ftp.e.com/f.txt");
    expect(p.kind).toBe("protocol");
    if (p.kind === "protocol") expect(p.scheme).toBe("ftp");
  });
});

describe("parseProtocolCommand — URL", () => {
  it("décompose hôte, port, chemin, identifiants", () => {
    const r = req("curl ftp://bob:s3cret@ftp.e.com:2121/dossier/f.txt");
    expect(r.host).toBe("ftp.e.com");
    expect(r.port).toBe(2121);
    expect(r.path).toBe("/dossier/f.txt");
    expect(r.username).toBe("bob");
    expect(r.password).toBe("s3cret");
  });

  it("port par défaut selon le schéma", () => {
    expect(req("curl ftp://e.com/f").port).toBe(21);
    expect(req("curl sftp://e.com/f").port).toBe(22);
    expect(req("curl pop3://e.com/").port).toBe(110);
    expect(req("curl smtp://e.com").port).toBe(25);
    expect(req("curl mqtt://e.com/t").port).toBe(1883);
    expect(req("curl tftp://e.com/f").port).toBe(69);
  });

  it("schémas sécurisés → TLS + ports", () => {
    expect(req("curl ftps://e.com/f").secure).toBe(true);
    expect(req("curl smtps://e.com").port).toBe(465);
    expect(req("curl pop3s://e.com/").secure).toBe(true);
    expect(req("curl mqtts://e.com/t").port).toBe(8883);
  });

  it("-u l'emporte sur les identifiants de l'URL", () => {
    const r = req("curl -u alice:pw ftp://bob:x@e.com/f");
    expect(r.username).toBe("alice");
    expect(r.password).toBe("pw");
  });
});

describe("parseProtocolCommand — SMTP", () => {
  it("mail-from, mail-rcpt (répétable), corps via -T", () => {
    const r = req("curl smtp://mail.e.com --mail-from moi@e.com --mail-rcpt a@e.com --mail-rcpt b@e.com -T message.txt");
    expect(r.direction).toBe("send");
    expect(r.smtp?.from).toBe("moi@e.com");
    expect(r.smtp?.recipients).toEqual(["a@e.com", "b@e.com"]);
    expect(r.payload?.filePath).toBe("message.txt");
  });

  it("sans destinataire : warning", () => {
    const r = req("curl smtp://mail.e.com --mail-from moi@e.com");
    expect(r.warnings.some((w) => w.code === "missing-recipient")).toBe(true);
  });
});

describe("parseProtocolCommand — FTP", () => {
  it("upload -T → direction upload", () => {
    const r = req("curl -T rapport.pdf ftp://e.com/incoming/");
    expect(r.direction).toBe("upload");
    expect(r.payload?.filePath).toBe("rapport.pdf");
  });

  it("-l → listage, -Q → quote", () => {
    const r = req(`curl -l -Q "CWD /pub" -Q "TYPE A" ftp://e.com/`);
    expect(r.direction).toBe("list");
    expect(r.ftp?.listOnly).toBe(true);
    expect(r.ftp?.quote).toEqual(["CWD /pub", "TYPE A"]);
  });

  it("--ftp-create-dirs", () => {
    expect(req("curl --ftp-create-dirs -T f ftp://e.com/a/b/f").ftp?.createDirs).toBe(true);
  });
});

describe("parseProtocolCommand — MQTT / TFTP / FILE / SMB", () => {
  it("MQTT publish si -d, sinon subscribe", () => {
    expect(req(`curl mqtt://courtier/capteurs/temp -d "21.5"`).direction).toBe("publish");
    expect(req("curl mqtt://courtier/capteurs/temp").direction).toBe("subscribe");
  });

  it("MQTT qos et retain", () => {
    const r = req(`curl mqtt://courtier/t -d "x" --qos 2 --retain`);
    expect(r.mqtt?.qos).toBe(2);
    expect(r.mqtt?.retain).toBe(true);
  });

  it("FILE download et upload", () => {
    expect(req("curl file:///etc/hosts").path).toBe("/etc/hosts");
    const up = req("curl -T data.bin file:///tmp/out.bin");
    expect(up.direction).toBe("upload");
    expect(up.path).toBe("/tmp/out.bin");
  });

  it("TFTP", () => {
    expect(req("curl tftp://10.0.0.1/firmware.bin").direction).toBe("download");
    expect(req("curl -T cfg.txt tftp://10.0.0.1/cfg.txt").direction).toBe("upload");
  });

  it("SMB : partage + chemin", () => {
    const r = req("curl smb://serveur/partage/dossier/f.txt");
    expect(r.scheme).toBe("smb");
    expect(r.path).toBe("/partage/dossier/f.txt");
  });
});

describe("parseProtocolCommand — variables", () => {
  it("{{...}} substitué dans l'URL protocolaire", () => {
    const r = req("curl ftp://{{ftpHost}}/f.txt", { ftpHost: "ftp.e.com" });
    expect(r.host).toBe("ftp.e.com");
  });
});

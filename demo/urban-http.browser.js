"use strict";
var UrbanHttp = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/index.ts
  var index_exports = {};
  __export(index_exports, {
    authHeader: () => authHeader,
    execute: () => execute,
    isPostmanCollection: () => isPostmanCollection,
    parseCurl: () => parseCurl,
    parsePostman: () => parsePostman,
    toFetch: () => toFetch,
    toFetchCode: () => toFetchCode,
    tokenize: () => tokenize
  });

  // src/tokenize.ts
  function tokenize(input) {
    const tokens = [];
    let current = "";
    let hasToken = false;
    let i = 0;
    const n = input.length;
    const push = () => {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
    };
    while (i < n) {
      const c = input[i];
      if ((c === "\\" || c === "^") && (input[i + 1] === "\n" || input.startsWith("\r\n", i + 1))) {
        i += input[i + 1] === "\r" ? 3 : 2;
        continue;
      }
      if (c === " " || c === "	" || c === "\n" || c === "\r") {
        push();
        i++;
        continue;
      }
      hasToken = true;
      if (c === "'") {
        const end = input.indexOf("'", i + 1);
        if (end === -1) {
          current += input.slice(i + 1);
          i = n;
        } else {
          current += input.slice(i + 1, end);
          i = end + 1;
        }
        continue;
      }
      if (c === '"') {
        i++;
        while (i < n) {
          const d = input[i];
          if (d === '"') {
            if (input[i + 1] === '"' && isCmdStyle(input)) {
              current += '"';
              i += 2;
              continue;
            }
            i++;
            break;
          }
          if (d === "\\") {
            const next = input[i + 1];
            if (next === '"' || next === "\\" || next === "$" || next === "`") {
              current += next;
              i += 2;
              continue;
            }
            if (next === "\n") {
              i += 2;
              continue;
            }
          }
          current += d;
          i++;
        }
        continue;
      }
      if (c === "$" && input[i + 1] === "'") {
        i += 2;
        while (i < n && input[i] !== "'") {
          if (input[i] === "\\") {
            const { text, consumed } = ansiCEscape(input, i + 1);
            current += text;
            i += 1 + consumed;
          } else {
            current += input[i];
            i++;
          }
        }
        i++;
        continue;
      }
      if (c === "\\") {
        if (i + 1 < n) {
          current += input[i + 1];
          i += 2;
        } else {
          i++;
        }
        continue;
      }
      current += c;
      i++;
    }
    push();
    return stripPromptAndCurl(tokens);
  }
  function isCmdStyle(input) {
    return /\^\r?\n/.test(input);
  }
  function ansiCEscape(input, i) {
    const c = input[i];
    switch (c) {
      case "n":
        return { text: "\n", consumed: 1 };
      case "t":
        return { text: "	", consumed: 1 };
      case "r":
        return { text: "\r", consumed: 1 };
      case "a":
        return { text: "\x07", consumed: 1 };
      case "b":
        return { text: "\b", consumed: 1 };
      case "f":
        return { text: "\f", consumed: 1 };
      case "v":
        return { text: "\v", consumed: 1 };
      case "\\":
        return { text: "\\", consumed: 1 };
      case "'":
        return { text: "'", consumed: 1 };
      case '"':
        return { text: '"', consumed: 1 };
      case "x": {
        const m = /^[0-9a-fA-F]{1,2}/.exec(input.slice(i + 1));
        if (m) return { text: String.fromCharCode(parseInt(m[0], 16)), consumed: 1 + m[0].length };
        return { text: "x", consumed: 1 };
      }
      case "u": {
        const m = /^[0-9a-fA-F]{1,4}/.exec(input.slice(i + 1));
        if (m) return { text: String.fromCharCode(parseInt(m[0], 16)), consumed: 1 + m[0].length };
        return { text: "u", consumed: 1 };
      }
      default: {
        const m = /^[0-7]{1,3}/.exec(input.slice(i));
        if (m) return { text: String.fromCharCode(parseInt(m[0], 8)), consumed: m[0].length };
        return { text: c ?? "", consumed: 1 };
      }
    }
  }
  function stripPromptAndCurl(tokens) {
    let start = 0;
    while (start < tokens.length && (tokens[start] === "$" || tokens[start] === ">" || tokens[start] === "sudo")) {
      start++;
    }
    const first = tokens[start]?.toLowerCase();
    if (first === "curl" || first === "curl.exe") {
      start++;
    }
    return tokens.slice(start);
  }

  // src/model.ts
  function defaultOptions() {
    return {
      followRedirects: false,
      insecure: false,
      compressed: false
    };
  }

  // src/parse.ts
  function newState() {
    return {
      urls: [],
      headMethod: false,
      get: false,
      headers: [],
      removedHeaders: [],
      dataItems: [],
      formFields: [],
      formIsMultipart: false,
      cookies: [],
      jsonMode: false,
      options: defaultOptions(),
      warnings: []
    };
  }
  function warn(st, code, message, option, level = "warning") {
    st.warnings.push({ code, message, option, level });
  }
  var noop = () => {
  };
  var noopInfo = (label) => (st) => warn(st, "cli-only-option", `${label} : option de ligne de commande sans effet sur la requ\xEAte HTTP, ignor\xE9e.`, label, "info");
  var LONG_OPTIONS = {
    // --- URL et méthode -------------------------------------------------
    "url": { takesValue: true, handler: (st, v) => st.urls.push(v) },
    "request": { takesValue: true, handler: (st, v) => st.explicitMethod = v.toUpperCase() },
    "head": { takesValue: false, handler: (st) => st.headMethod = true },
    "get": { takesValue: false, handler: (st) => st.get = true },
    // --- En-têtes ---------------------------------------------------------
    "header": { takesValue: true, handler: handleHeader },
    "user-agent": { takesValue: true, handler: (st, v) => st.userAgent = v },
    "referer": {
      takesValue: true,
      handler: (st, v) => {
        if (v === ";auto" || v.endsWith(";auto")) {
          warn(st, "partial-option", "--referer ;auto : le mode automatique n'est pas reproduit, seule la valeur explicite est envoy\xE9e.", "--referer", "info");
          v = v.replace(/;auto$/, "");
          if (!v) return;
        }
        st.referer = v;
      }
    },
    "range": { takesValue: true, handler: (st, v) => st.range = v },
    "compressed": { takesValue: false, handler: (st) => st.options.compressed = true },
    // --- Corps de requête ---------------------------------------------------
    "data": { takesValue: true, handler: (st, v) => pushData(st, "data", v) },
    "data-ascii": { takesValue: true, handler: (st, v) => pushData(st, "data", v) },
    "data-raw": { takesValue: true, handler: (st, v) => st.dataItems.push({ mode: "raw", value: v }) },
    "data-binary": { takesValue: true, handler: (st, v) => pushData(st, "binary", v) },
    "data-urlencode": { takesValue: true, handler: handleDataUrlencode },
    "json": {
      takesValue: true,
      handler: (st, v) => {
        st.jsonMode = true;
        pushData(st, "binary", v);
      }
    },
    "form": { takesValue: true, handler: (st, v) => handleForm(st, v, false) },
    "form-string": { takesValue: true, handler: (st, v) => handleForm(st, v, true) },
    "upload-file": { takesValue: true, handler: (st, v) => st.uploadFile = v },
    // --- Authentification ----------------------------------------------------
    "user": { takesValue: true, handler: handleUser },
    "oauth2-bearer": { takesValue: true, handler: (st, v) => st.auth = { kind: "bearer", token: v } },
    "basic": { takesValue: false, handler: (st) => st.authKindOverride = "basic" },
    "digest": {
      takesValue: false,
      handler: (st) => {
        st.authKindOverride = "digest";
        warn(st, "unsupported-auth", "--digest : l'authentification Digest n\xE9cessite une n\xE9gociation challenge/r\xE9ponse non prise en charge par fetch.", "--digest");
      }
    },
    "ntlm": {
      takesValue: false,
      handler: (st) => {
        st.authKindOverride = "ntlm";
        warn(st, "unsupported-auth", "--ntlm : authentification NTLM non prise en charge.", "--ntlm");
      }
    },
    "negotiate": {
      takesValue: false,
      handler: (st) => {
        st.authKindOverride = "negotiate";
        warn(st, "unsupported-auth", "--negotiate : authentification Negotiate/Kerberos non prise en charge.", "--negotiate");
      }
    },
    "anyauth": { takesValue: false, handler: noop },
    "aws-sigv4": {
      takesValue: true,
      handler: (st, v) => {
        st.auth = { kind: "aws-sigv4", token: v };
        warn(st, "unsupported-auth", "--aws-sigv4 : la signature AWS n'est pas calcul\xE9e par le SDK.", "--aws-sigv4");
      }
    },
    // --- Cookies -----------------------------------------------------------
    "cookie": { takesValue: true, handler: handleCookie },
    "cookie-jar": {
      takesValue: true,
      handler: (st) => warn(st, "cli-only-option", "--cookie-jar : l'\xE9criture d'un fichier de cookies est propre au CLI, ignor\xE9e.", "--cookie-jar", "info")
    },
    "junk-session-cookies": { takesValue: false, handler: noop },
    // --- Redirections --------------------------------------------------------
    "location": { takesValue: false, handler: (st) => st.options.followRedirects = true },
    "location-trusted": {
      takesValue: false,
      handler: (st) => {
        st.options.followRedirects = true;
        warn(st, "partial-option", "--location-trusted : les identifiants ne seront pas renvoy\xE9s aux h\xF4tes de redirection (limitation fetch).", "--location-trusted", "info");
      }
    },
    "max-redirs": { takesValue: true, handler: (st, v) => st.options.maxRedirs = parseInt(v, 10) },
    // --- TLS / réseau ----------------------------------------------------------
    "insecure": { takesValue: false, handler: (st) => st.options.insecure = true },
    "cacert": { takesValue: true, handler: unsupported("--cacert", "certificat CA personnalis\xE9") },
    "cert": { takesValue: true, handler: unsupported("--cert", "certificat client") },
    "key": { takesValue: true, handler: unsupported("--key", "cl\xE9 priv\xE9e cliente") },
    "proxy": {
      takesValue: true,
      handler: (st, v) => {
        st.options.proxy = v;
        warn(st, "unsupported-option", "--proxy : fetch ne permet pas de configurer un proxy par requ\xEAte (possible c\xF4t\xE9 Node via undici.ProxyAgent).", "--proxy");
      }
    },
    "proxy-user": { takesValue: true, handler: unsupported("--proxy-user", "authentification proxy") },
    "noproxy": { takesValue: true, handler: noop },
    "http1.0": { takesValue: false, handler: setHttpVersion("1.0") },
    "http1.1": { takesValue: false, handler: setHttpVersion("1.1") },
    "http2": { takesValue: false, handler: setHttpVersion("2") },
    "http2-prior-knowledge": { takesValue: false, handler: setHttpVersion("2") },
    "http3": { takesValue: false, handler: setHttpVersion("3") },
    "ipv4": { takesValue: false, handler: noop },
    "ipv6": { takesValue: false, handler: noop },
    "tlsv1.2": { takesValue: false, handler: noop },
    "tlsv1.3": { takesValue: false, handler: noop },
    "resolve": { takesValue: true, handler: unsupported("--resolve", "r\xE9solution DNS personnalis\xE9e") },
    "connect-to": { takesValue: true, handler: unsupported("--connect-to", "redirection de connexion") },
    "interface": { takesValue: true, handler: unsupported("--interface", "interface r\xE9seau") },
    "unix-socket": { takesValue: true, handler: unsupported("--unix-socket", "socket Unix") },
    // --- Timeouts / retries -------------------------------------------------------
    "max-time": { takesValue: true, handler: (st, v) => st.options.timeoutMs = Math.round(parseFloat(v) * 1e3) },
    "connect-timeout": {
      takesValue: true,
      handler: (st, v) => {
        st.options.connectTimeoutMs = Math.round(parseFloat(v) * 1e3);
        warn(st, "partial-option", "--connect-timeout : fetch n'a pas de timeout de connexion distinct, approxim\xE9 par un timeout global.", "--connect-timeout", "info");
      }
    },
    "retry": { takesValue: true, handler: (st, v) => st.options.retry = parseInt(v, 10) },
    "retry-delay": { takesValue: true, handler: (st, v) => st.options.retryDelayMs = Math.round(parseFloat(v) * 1e3) },
    "retry-max-time": { takesValue: true, handler: noop },
    "retry-all-errors": { takesValue: false, handler: noop },
    "limit-rate": { takesValue: true, handler: unsupported("--limit-rate", "limitation de d\xE9bit") },
    "speed-limit": { takesValue: true, handler: noop },
    "speed-time": { takesValue: true, handler: noop },
    "keepalive-time": { takesValue: true, handler: noop },
    "no-keepalive": { takesValue: false, handler: noop },
    // --- Sortie / affichage (sans effet sur la requête) ----------------------------
    "output": { takesValue: true, handler: noopInfo("--output") },
    "remote-name": { takesValue: false, handler: noopInfo("--remote-name") },
    "remote-header-name": { takesValue: false, handler: noopInfo("--remote-header-name") },
    "dump-header": { takesValue: true, handler: noopInfo("--dump-header") },
    "include": { takesValue: false, handler: noop },
    "silent": { takesValue: false, handler: noop },
    "show-error": { takesValue: false, handler: noop },
    "verbose": { takesValue: false, handler: noop },
    "progress-bar": { takesValue: false, handler: noop },
    "no-progress-meter": { takesValue: false, handler: noop },
    "write-out": { takesValue: true, handler: noopInfo("--write-out") },
    "trace": { takesValue: true, handler: noopInfo("--trace") },
    "trace-ascii": { takesValue: true, handler: noopInfo("--trace-ascii") },
    "fail": { takesValue: false, handler: noop },
    "fail-with-body": { takesValue: false, handler: noop },
    "styled-output": { takesValue: false, handler: noop },
    // --- Divers -------------------------------------------------------------------
    "globoff": { takesValue: false, handler: noop },
    "config": { takesValue: true, handler: unsupported("--config", "fichier de configuration curl") },
    "next": { takesValue: false, handler: noop },
    // géré en amont (séparateur de groupes)
    "help": { takesValue: false, handler: noopInfo("--help") },
    "version": { takesValue: false, handler: noopInfo("--version") },
    "raw": { takesValue: false, handler: noop },
    "path-as-is": { takesValue: false, handler: noop },
    "post301": { takesValue: false, handler: partialRedirect("--post301") },
    "post302": { takesValue: false, handler: partialRedirect("--post302") },
    "post303": { takesValue: false, handler: partialRedirect("--post303") }
  };
  var SHORT_OPTIONS = {
    "X": "request",
    "H": "header",
    "d": "data",
    "F": "form",
    "G": "get",
    "I": "head",
    "u": "user",
    "b": "cookie",
    "c": "cookie-jar",
    "j": "junk-session-cookies",
    "A": "user-agent",
    "e": "referer",
    "r": "range",
    "L": "location",
    "k": "insecure",
    "x": "proxy",
    "m": "max-time",
    "T": "upload-file",
    "o": "output",
    "O": "remote-name",
    "J": "remote-header-name",
    "D": "dump-header",
    "i": "include",
    "s": "silent",
    "S": "show-error",
    "v": "verbose",
    "#": "progress-bar",
    "f": "fail",
    "g": "globoff",
    "K": "config",
    "4": "ipv4",
    "6": "ipv6",
    "w": "write-out",
    "E": "cert",
    "U": "proxy-user",
    "Z": "parallel"
  };
  function unsupported(option, label) {
    return (st) => warn(st, "unsupported-option", `${option} (${label}) : non pris en charge par le SDK, option ignor\xE9e.`, option);
  }
  function setHttpVersion(v) {
    return (st) => {
      st.options.httpVersion = v;
      warn(st, "cli-only-option", `--http${v} : la version HTTP est n\xE9goci\xE9e par la plateforme, indication conserv\xE9e \xE0 titre informatif.`, `--http${v}`, "info");
    };
  }
  function partialRedirect(option) {
    return (st) => warn(st, "partial-option", `${option} : fetch suit la s\xE9mantique standard des redirections, ce r\xE9glage fin n'est pas appliqu\xE9.`, option, "info");
  }
  function handleHeader(st, v) {
    if (v.startsWith("@")) {
      warn(st, "unsupported-option", `-H ${v} : lecture d'en-t\xEAtes depuis un fichier non prise en charge.`, "-H");
      return;
    }
    const colon = v.indexOf(":");
    const semi = v.indexOf(";");
    if (colon === -1 && semi !== -1 && semi === v.length - 1) {
      st.headers.push([v.slice(0, semi).trim(), ""]);
      return;
    }
    if (colon === -1) {
      warn(st, "invalid-header", `-H "${v}" : format d'en-t\xEAte invalide (attendu "Nom: valeur"), ignor\xE9.`, "-H");
      return;
    }
    const name = v.slice(0, colon).trim();
    const value = v.slice(colon + 1).trim();
    if (value === "") {
      st.removedHeaders.push(name.toLowerCase());
      return;
    }
    st.headers.push([name, value]);
  }
  function pushData(st, mode, v) {
    if (v.startsWith("@")) {
      st.dataItems.push({ mode, filePath: v.slice(1) });
    } else {
      st.dataItems.push({ mode, value: v });
    }
  }
  function handleDataUrlencode(st, v) {
    if (v.startsWith("@")) {
      st.dataItems.push({ mode: "urlencode", filePath: v.slice(1) });
      return;
    }
    const eq = v.indexOf("=");
    const at = v.indexOf("@");
    if (eq === -1 && at > 0) {
      st.dataItems.push({ mode: "urlencode", name: v.slice(0, at), filePath: v.slice(at + 1) });
      return;
    }
    if (eq === 0) {
      st.dataItems.push({ mode: "urlencode", value: v.slice(1) });
      return;
    }
    if (eq > 0) {
      st.dataItems.push({ mode: "urlencode", name: v.slice(0, eq), value: v.slice(eq + 1) });
      return;
    }
    st.dataItems.push({ mode: "urlencode", value: v });
  }
  function handleForm(st, v, literal) {
    st.formIsMultipart = true;
    const eq = v.indexOf("=");
    if (eq === -1) {
      warn(st, "invalid-form", `-F "${v}" : format invalide (attendu nom=valeur), ignor\xE9.`, "-F");
      return;
    }
    const name = v.slice(0, eq);
    let rest = v.slice(eq + 1);
    const field = { name };
    if (!literal) {
      const segments = splitFormSegments(rest);
      rest = segments.shift() ?? "";
      for (const seg of segments) {
        const [attr, ...valParts] = seg.split("=");
        const val = unquote(valParts.join("="));
        const attrName = (attr ?? "").trim().toLowerCase();
        if (attrName === "type") field.contentType = val;
        else if (attrName === "filename") field.fileName = val;
        else if (attrName === "headers") {
          warn(st, "partial-option", `-F ;headers= : en-t\xEAtes de partie multipart non pris en charge, ignor\xE9s.`, "-F", "info");
        }
      }
      rest = unquote(rest);
      if (rest.startsWith("@")) {
        field.filePath = rest.slice(1);
      } else if (rest.startsWith("<")) {
        field.contentFromFile = rest.slice(1);
      } else {
        field.value = rest;
      }
    } else {
      field.value = rest;
    }
    st.formFields.push(field);
  }
  function splitFormSegments(s) {
    const out = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"') inQuotes = !inQuotes;
      if (c === ";" && !inQuotes) {
        out.push(cur);
        cur = "";
      } else {
        cur += c;
      }
    }
    out.push(cur);
    return out;
  }
  function unquote(s) {
    s = s.trim();
    if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
      return s.slice(1, -1).replace(/\\"/g, '"');
    }
    return s;
  }
  function handleUser(st, v) {
    const colon = v.indexOf(":");
    if (colon === -1) {
      st.auth = { kind: "basic", username: v, password: "" };
    } else {
      st.auth = { kind: "basic", username: v.slice(0, colon), password: v.slice(colon + 1) };
    }
  }
  function handleCookie(st, v) {
    if (v.includes("=")) {
      st.cookies.push(v);
    } else {
      warn(st, "unsupported-option", `-b ${v} : lecture d'un fichier de cookies non prise en charge (passez les cookies sous forme "nom=valeur").`, "-b");
    }
  }
  function parseCurl(command) {
    const tokens = tokenize(command);
    const groups = [[]];
    for (const t of tokens) {
      if (t === "--next" || t === "-:") {
        groups.push([]);
      } else {
        groups[groups.length - 1].push(t);
      }
    }
    const requests = [];
    const globalWarnings = [];
    for (const group of groups) {
      if (group.length === 0) continue;
      const st = parseGroup(group);
      if (st.urls.length === 0) {
        globalWarnings.push(...st.warnings);
        continue;
      }
      requests.push(...buildRequests(st));
    }
    if (requests.length === 0) {
      globalWarnings.push({
        code: "no-url",
        message: "Aucune URL trouv\xE9e dans la commande.",
        level: "error"
      });
    }
    return { requests, warnings: globalWarnings };
  }
  function parseGroup(tokens) {
    const st = newState();
    let i = 0;
    const nextValue = (option) => {
      const v = tokens[i + 1];
      if (v === void 0) {
        warn(st, "missing-value", `${option} attend une valeur mais la commande se termine.`, option, "error");
        return void 0;
      }
      i++;
      return v;
    };
    while (i < tokens.length) {
      const tok = tokens[i];
      if (tok === "-") {
        warn(st, "unsupported-option", `"-" (lecture depuis stdin) non pris en charge.`, "-");
        i++;
        continue;
      }
      if (tok.startsWith("--")) {
        let name = tok.slice(2);
        let inlineValue;
        const eq = name.indexOf("=");
        if (eq !== -1 && !LONG_OPTIONS[name]) {
          inlineValue = name.slice(eq + 1);
          name = name.slice(0, eq);
        }
        let negated = false;
        if (!LONG_OPTIONS[name] && name.startsWith("no-") && LONG_OPTIONS[name.slice(3)]) {
          negated = true;
          name = name.slice(3);
        }
        const def = LONG_OPTIONS[name];
        if (!def) {
          warn(st, "unknown-option", `--${name} : option inconnue, ignor\xE9e.`, `--${name}`);
          i++;
          continue;
        }
        if (negated) {
          applyNegation(st, name);
          i++;
          continue;
        }
        if (def.takesValue) {
          const v = inlineValue !== void 0 ? inlineValue : nextValue(`--${name}`);
          if (v !== void 0) def.handler(st, v);
        } else {
          def.handler(st, "");
        }
        i++;
        continue;
      }
      if (tok.startsWith("-") && tok.length > 1) {
        let j = 1;
        while (j < tok.length) {
          const ch = tok[j];
          const longName = SHORT_OPTIONS[ch];
          const def = longName ? LONG_OPTIONS[longName] : void 0;
          if (!def) {
            warn(st, "unknown-option", `-${ch} : option inconnue, ignor\xE9e.`, `-${ch}`);
            j++;
            continue;
          }
          if (def.takesValue) {
            const glued = tok.slice(j + 1);
            const v = glued !== "" ? glued : nextValue(`-${ch}`);
            if (v !== void 0) def.handler(st, v);
            j = tok.length;
          } else {
            def.handler(st, "");
            j++;
          }
        }
        i++;
        continue;
      }
      st.urls.push(tok);
      i++;
    }
    return st;
  }
  function applyNegation(st, name) {
    switch (name) {
      case "location":
        st.options.followRedirects = false;
        break;
      case "insecure":
        st.options.insecure = false;
        break;
      case "compressed":
        st.options.compressed = false;
        break;
      default:
        break;
    }
  }
  function buildRequests(st) {
    return st.urls.map((rawUrl) => buildOne(st, rawUrl, [...st.warnings]));
  }
  function buildOne(st, rawUrl, warnings) {
    const options = { ...st.options };
    const headers = [];
    const query = [];
    let url = rawUrl;
    if (url && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) {
      url = "http://" + url;
      pushWarn(warnings, "default-scheme", `Pas de sch\xE9ma dans l'URL : "http://" ajout\xE9 (comme curl).`, void 0, "info");
    }
    if (/[{}[\]]/.test(rawUrl)) {
      pushWarn(warnings, "url-globbing", "L'URL contient des caract\xE8res de globbing curl ({...} ou [...]) : le globbing n'est pas d\xE9velopp\xE9.", void 0, "warning");
    }
    let body;
    let bodyContentType;
    if (st.formFields.length > 0) {
      body = { kind: "multipart", parts: st.formFields };
    } else if (st.uploadFile) {
      body = { kind: "file", filePath: st.uploadFile };
    } else if (st.dataItems.length > 0 && !st.get) {
      const resolved = resolveDataItems(st.dataItems, warnings);
      body = resolved.hasFiles ? { kind: st.jsonMode ? "raw" : "urlencoded", items: st.dataItems, text: resolved.text } : { kind: st.jsonMode ? "raw" : "urlencoded", text: resolved.text };
      bodyContentType = st.jsonMode ? "application/json" : "application/x-www-form-urlencoded";
    }
    if (st.get && st.dataItems.length > 0) {
      const resolved = resolveDataItems(st.dataItems, warnings);
      if (resolved.text) {
        for (const pair of resolved.text.split("&")) {
          const eq = pair.indexOf("=");
          if (eq === -1) query.push([pair, ""]);
          else query.push([pair.slice(0, eq), pair.slice(eq + 1)]);
        }
        url = appendQuery(url, resolved.text);
      }
    }
    let method;
    if (st.explicitMethod) {
      method = st.explicitMethod;
      if (st.headMethod) {
        pushWarn(warnings, "method-conflict", `-I et -X ${st.explicitMethod} utilis\xE9s ensemble : -X l'emporte (comme curl).`, void 0, "info");
      }
    } else if (st.headMethod) {
      method = "HEAD";
    } else if (st.uploadFile) {
      method = "PUT";
    } else if (body && !st.get) {
      method = "POST";
    } else {
      method = "GET";
    }
    const userHeaderNames = new Set(st.headers.map(([n]) => n.toLowerCase()));
    const removed = new Set(st.removedHeaders);
    const addGenerated = (name, value) => {
      const lower = name.toLowerCase();
      if (userHeaderNames.has(lower) || removed.has(lower)) return;
      headers.push([name, value]);
    };
    if (bodyContentType) addGenerated("Content-Type", bodyContentType);
    if (st.jsonMode) addGenerated("Accept", "application/json");
    if (st.userAgent !== void 0) addGenerated("User-Agent", st.userAgent);
    if (st.referer) addGenerated("Referer", st.referer);
    if (st.range) addGenerated("Range", st.range.includes("-") ? `bytes=${st.range}` : `bytes=${st.range}-`);
    if (st.cookies.length > 0) addGenerated("Cookie", st.cookies.join("; "));
    if (st.options.compressed) addGenerated("Accept-Encoding", "gzip, deflate, br");
    for (const [n, v] of st.headers) {
      if (removed.has(n.toLowerCase())) continue;
      headers.push([n, v]);
    }
    let auth = st.auth ? { ...st.auth } : void 0;
    if (auth && st.authKindOverride && auth.kind === "basic") {
      auth.kind = st.authKindOverride;
    }
    return {
      method,
      url,
      query,
      headers,
      body,
      auth,
      options,
      warnings
    };
  }
  function pushWarn(warnings, code, message, option, level = "warning") {
    warnings.push({ code, message, option, level });
  }
  function resolveDataItems(items, warnings) {
    const parts = [];
    let hasFiles = false;
    for (const item of items) {
      if (item.filePath !== void 0) {
        hasFiles = true;
        const placeholder = item.name !== void 0 ? `${item.name}=@${item.filePath}` : `@${item.filePath}`;
        parts.push(placeholder);
        pushWarn(
          warnings,
          "file-reference",
          `Le corps r\xE9f\xE9rence le fichier "${item.filePath}" : il sera lu au moment de l'ex\xE9cution (Node) ou doit \xEAtre fourni via l'option readFile.`,
          void 0,
          "info"
        );
        continue;
      }
      const value = item.value ?? "";
      if (item.mode === "urlencode") {
        const encoded = encodeURIComponent(value).replace(/%20/g, "+");
        parts.push(item.name !== void 0 ? `${item.name}=${encoded}` : encoded);
      } else {
        parts.push(value);
      }
    }
    return { text: parts.join("&"), hasFiles };
  }
  function appendQuery(url, qs) {
    if (!qs) return url;
    if (!url) return url;
    return url + (url.includes("?") ? "&" : "?") + qs;
  }

  // src/postman.ts
  function isPostmanCollection(input) {
    try {
      const obj = typeof input === "string" ? JSON.parse(input) : input;
      return !!obj && typeof obj === "object" && !!obj.info && Array.isArray(obj.item);
    } catch {
      return false;
    }
  }
  function parsePostman(input, opts = {}) {
    const globalWarnings = [];
    let collection;
    try {
      collection = typeof input === "string" ? JSON.parse(input) : input;
    } catch (e) {
      return {
        requests: [],
        warnings: [{ code: "invalid-json", message: `JSON invalide : ${e.message}`, level: "error" }]
      };
    }
    if (!collection || typeof collection !== "object" || !Array.isArray(collection.item)) {
      return {
        requests: [],
        warnings: [{ code: "not-a-collection", message: "Ce JSON n'est pas une collection Postman (champs info/item absents).", level: "error" }]
      };
    }
    if (collection.info?.schema && !/collection\/v2\./.test(collection.info.schema)) {
      globalWarnings.push({
        code: "unknown-schema",
        message: `Sch\xE9ma "${collection.info.schema}" inattendu : seul le format Collection v2.x est pris en charge, l'import continue au mieux.`,
        level: "warning"
      });
    }
    const vars = /* @__PURE__ */ new Map();
    for (const v of collection.variable ?? []) {
      if (v.key !== void 0 && !v.disabled) vars.set(v.key, v.value ?? "");
    }
    for (const [k, v] of Object.entries(opts.variables ?? {})) vars.set(k, v);
    const unresolved = /* @__PURE__ */ new Set();
    const substitute = (s) => s.replace(/\{\{([^{}]+)\}\}/g, (whole, name) => {
      if (vars.has(name)) return vars.get(name);
      unresolved.add(name);
      return whole;
    });
    const requests = [];
    walkItems(collection.item, collection.auth, collection, substitute, requests);
    for (const name of unresolved) {
      globalWarnings.push({
        code: "unresolved-variable",
        message: `Variable {{${name}}} non r\xE9solue : passez sa valeur via options.variables.`,
        level: "warning"
      });
    }
    if (requests.length === 0) {
      globalWarnings.push({ code: "no-request", message: "La collection ne contient aucune requ\xEAte.", level: "error" });
    }
    return { requests, warnings: globalWarnings };
  }
  function walkItems(items, inheritedAuth, collection, substitute, out) {
    for (const item of items) {
      const auth = item.auth ?? (typeof item.request === "object" ? item.request?.auth : void 0) ?? inheritedAuth;
      if (Array.isArray(item.item)) {
        walkItems(item.item, auth, collection, substitute, out);
      }
      if (item.request !== void 0) {
        out.push(buildRequest(item, auth, substitute));
      }
    }
  }
  function buildRequest(item, auth, substitute) {
    const warnings = [];
    const options = defaultOptions();
    options.followRedirects = item.protocolProfileBehavior?.followRedirects !== false;
    const req = typeof item.request === "string" ? { method: "GET", url: item.request } : item.request ?? {};
    const method = (req.method ?? "GET").toUpperCase();
    const headers = [];
    const query = [];
    let url = "";
    if (typeof req.url === "string") {
      url = substitute(req.url);
    } else if (req.url) {
      const u = req.url;
      if (u.raw) {
        url = substitute(u.raw);
      } else {
        const host = Array.isArray(u.host) ? u.host.join(".") : u.host ?? "";
        const path = Array.isArray(u.path) ? u.path.join("/") : u.path ?? "";
        url = substitute(`${u.protocol ?? "http"}://${host}${u.port ? ":" + u.port : ""}${path ? "/" + path : ""}`);
      }
      if (Array.isArray(u.query) && u.query.length > 0) {
        const active = u.query.filter((q) => !q.disabled && q.key !== void 0);
        const base = url.split("?")[0] ?? url;
        const qs = active.map((q) => `${substitute(q.key)}${q.value !== void 0 ? "=" + substitute(q.value) : ""}`).join("&");
        for (const q of active) query.push([substitute(q.key), substitute(q.value ?? "")]);
        url = qs ? `${base}?${qs}` : base;
      }
    }
    if (typeof req.header === "string") {
      for (const line of req.header.split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon > 0) headers.push([substitute(line.slice(0, colon).trim()), substitute(line.slice(colon + 1).trim())]);
      }
    } else {
      for (const h of req.header ?? []) {
        if (h.disabled || h.key === void 0) continue;
        headers.push([substitute(h.key), substitute(h.value ?? "")]);
      }
    }
    const hasHeader = (name) => headers.some(([n]) => n.toLowerCase() === name.toLowerCase());
    let body;
    const b = req.body;
    if (b && !b.disabled && b.mode) {
      switch (b.mode) {
        case "raw": {
          const text = substitute(b.raw ?? "");
          body = { kind: "raw", text };
          const lang = b.options?.raw?.language;
          const ct = lang === "json" ? "application/json" : lang === "xml" ? "application/xml" : lang === "html" ? "text/html" : lang === "javascript" ? "application/javascript" : lang === "text" ? "text/plain" : void 0;
          if (ct && !hasHeader("content-type")) headers.push(["Content-Type", ct]);
          break;
        }
        case "urlencoded": {
          const pairs = (b.urlencoded ?? []).filter((p) => !p.disabled && p.key !== void 0).map((p) => `${encodeForm(substitute(p.key))}=${encodeForm(substitute(p.value ?? ""))}`);
          body = { kind: "urlencoded", text: pairs.join("&") };
          if (!hasHeader("content-type")) headers.push(["Content-Type", "application/x-www-form-urlencoded"]);
          break;
        }
        case "formdata": {
          const parts = [];
          for (const p of b.formdata ?? []) {
            if (p.disabled || p.key === void 0) continue;
            if (p.type === "file") {
              const srcs = Array.isArray(p.src) ? p.src : p.src ? [p.src] : [];
              if (srcs.length === 0) parts.push({ name: substitute(p.key), filePath: "" });
              for (const src of srcs) parts.push({ name: substitute(p.key), filePath: src, contentType: p.contentType });
            } else {
              parts.push({ name: substitute(p.key), value: substitute(p.value ?? ""), contentType: p.contentType });
            }
          }
          body = { kind: "multipart", parts };
          break;
        }
        case "file": {
          body = { kind: "file", filePath: b.file?.src ?? "" };
          break;
        }
        case "graphql": {
          let variables = void 0;
          const rawVars = b.graphql?.variables;
          if (rawVars) {
            try {
              variables = JSON.parse(substitute(rawVars));
            } catch {
              variables = substitute(rawVars);
            }
          }
          body = {
            kind: "raw",
            text: JSON.stringify({ query: substitute(b.graphql?.query ?? ""), ...variables !== void 0 ? { variables } : {} })
          };
          if (!hasHeader("content-type")) headers.push(["Content-Type", "application/json"]);
          break;
        }
        default:
          warnings.push({
            code: "unsupported-body-mode",
            message: `Mode de corps Postman "${b.mode}" non pris en charge.`,
            level: "warning"
          });
      }
    }
    const authSpec = convertAuth(auth, substitute, headers, query, warnings);
    const hasScript = (item.event ?? []).some((e) => {
      const exec = e.script?.exec;
      const text = Array.isArray(exec) ? exec.join("") : exec ?? "";
      return text.trim().length > 0;
    });
    if (hasScript) {
      warnings.push({
        code: "scripts-not-executed",
        message: "Cette requ\xEAte a des scripts Postman (pre-request/tests) : ils ne sont pas ex\xE9cut\xE9s par le SDK.",
        level: "info"
      });
    }
    return {
      name: item.name,
      method,
      url,
      query,
      headers,
      body,
      auth: authSpec,
      options,
      warnings
    };
  }
  function authParam(section, key) {
    if (Array.isArray(section)) {
      const entry = section.find((p) => p.key === key);
      return entry?.value !== void 0 ? String(entry.value) : void 0;
    }
    if (section && typeof section === "object") {
      const v = section[key];
      return v !== void 0 ? String(v) : void 0;
    }
    return void 0;
  }
  function convertAuth(auth, substitute, headers, query, warnings) {
    if (!auth?.type || auth.type === "noauth") return void 0;
    const section = auth[auth.type];
    const get = (key) => {
      const v = authParam(section, key);
      return v !== void 0 ? substitute(v) : void 0;
    };
    switch (auth.type) {
      case "basic":
        return { kind: "basic", username: get("username") ?? "", password: get("password") ?? "" };
      case "bearer":
        return { kind: "bearer", token: get("token") ?? "" };
      case "apikey": {
        const key = get("key") ?? "";
        const value = get("value") ?? "";
        if ((get("in") ?? "header") === "query") {
          query.push([key, value]);
          warnings.push({
            code: "apikey-query",
            message: `Auth "apikey" en query string : pensez \xE0 v\xE9rifier que l'URL finale contient bien ${key}=...`,
            level: "info"
          });
        } else if (key) {
          headers.push([key, value]);
        }
        return void 0;
      }
      case "digest":
        warnings.push({ code: "unsupported-auth", message: "Auth Digest : non prise en charge (n\xE9gociation challenge/r\xE9ponse).", level: "warning" });
        return { kind: "digest", username: get("username"), password: get("password") };
      case "ntlm":
        warnings.push({ code: "unsupported-auth", message: "Auth NTLM : non prise en charge.", level: "warning" });
        return { kind: "ntlm", username: get("username"), password: get("password") };
      default:
        warnings.push({
          code: "unsupported-auth",
          message: `Type d'auth Postman "${auth.type}" non pris en charge : ajoutez l'en-t\xEAte correspondant manuellement.`,
          level: "warning"
        });
        return void 0;
    }
  }
  function encodeForm(s) {
    return encodeURIComponent(s).replace(/%20/g, "+");
  }

  // src/to-fetch.ts
  function toBase64(s) {
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  function authHeader(req) {
    if (!req.auth) return void 0;
    if (req.auth.kind === "basic") {
      const cred = `${req.auth.username ?? ""}:${req.auth.password ?? ""}`;
      return ["Authorization", `Basic ${toBase64(cred)}`];
    }
    if (req.auth.kind === "bearer") {
      return ["Authorization", `Bearer ${req.auth.token ?? ""}`];
    }
    return void 0;
  }
  function toFetch(req, opts = {}) {
    const issues = [];
    const headers = new Headers();
    for (const [n, v] of req.headers) headers.append(n, v);
    const auth = authHeader(req);
    if (auth && !headers.has("authorization")) headers.set(auth[0], auth[1]);
    const read = (path) => {
      if (!opts.readFile) {
        issues.push(`Fichier "${path}" non r\xE9solu : fournissez options.readFile pour le lire.`);
        return void 0;
      }
      try {
        return opts.readFile(path);
      } catch (e) {
        issues.push(`Lecture du fichier "${path}" impossible : ${e.message}`);
        return void 0;
      }
    };
    let body;
    const b = req.body;
    if (b) {
      if (b.kind === "multipart") {
        const fd = new FormData();
        for (const part of b.parts ?? []) {
          if (part.filePath) {
            const content = read(part.filePath);
            const fileName = part.fileName ?? part.filePath.split(/[\\/]/).pop() ?? "file";
            if (content !== void 0) {
              const blob = new Blob([typeof content === "string" ? content : content], {
                type: part.contentType ?? "application/octet-stream"
              });
              fd.append(part.name, blob, fileName);
            } else {
              fd.append(part.name, new Blob([], { type: part.contentType ?? "application/octet-stream" }), fileName);
            }
          } else if (part.contentFromFile) {
            const content = read(part.contentFromFile);
            fd.append(part.name, content === void 0 ? "" : typeof content === "string" ? content : new TextDecoder().decode(content));
          } else {
            fd.append(part.name, part.value ?? "");
          }
        }
        body = fd;
      } else if (b.kind === "file") {
        const content = b.filePath ? read(b.filePath) : void 0;
        if (content !== void 0) {
          body = typeof content === "string" ? content : content;
        }
      } else if (b.items && b.items.some((it) => it.filePath)) {
        const parts = [];
        for (const item of b.items) {
          if (item.filePath) {
            const content = read(item.filePath);
            let text = content === void 0 ? "" : typeof content === "string" ? content : new TextDecoder().decode(content);
            if (item.mode === "data") {
              text = text.replace(/[\r\n]/g, "");
            }
            if (item.mode === "urlencode") {
              text = encodeURIComponent(text).replace(/%20/g, "+");
              parts.push(item.name !== void 0 ? `${item.name}=${text}` : text);
            } else {
              parts.push(text);
            }
          } else if (item.mode === "urlencode") {
            const enc = encodeURIComponent(item.value ?? "").replace(/%20/g, "+");
            parts.push(item.name !== void 0 ? `${item.name}=${enc}` : enc);
          } else {
            parts.push(item.value ?? "");
          }
        }
        body = parts.join("&");
      } else {
        body = b.text ?? "";
      }
    }
    const init = {
      method: req.method,
      headers,
      redirect: req.options.followRedirects ? "follow" : "manual"
    };
    if (body !== void 0) init.body = body;
    if (req.options.timeoutMs) init.signal = AbortSignal.timeout(req.options.timeoutMs);
    return { url: req.url, init, issues };
  }
  var js = (s) => JSON.stringify(s);
  function toFetchCode(req) {
    const lines = [];
    const headers = [...req.headers];
    const auth = authHeader(req);
    if (auth && !headers.some(([n]) => n.toLowerCase() === "authorization")) headers.push(auth);
    lines.push(`const response = await fetch(${js(req.url)}, {`);
    lines.push(`  method: ${js(req.method)},`);
    if (headers.length > 0) {
      lines.push(`  headers: {`);
      for (const [n, v] of headers) lines.push(`    ${js(n)}: ${js(v)},`);
      lines.push(`  },`);
    }
    const b = req.body;
    if (b) {
      if (b.kind === "multipart") {
        const pre = [`const form = new FormData();`];
        for (const part of b.parts ?? []) {
          if (part.filePath) {
            pre.push(`form.append(${js(part.name)}, fileInput.files[0]); // fichier : ${part.filePath}`);
          } else if (part.contentFromFile) {
            pre.push(`form.append(${js(part.name)}, contenuDe(${js(part.contentFromFile)}));`);
          } else {
            pre.push(`form.append(${js(part.name)}, ${js(part.value ?? "")});`);
          }
        }
        lines.unshift(...pre, "");
        lines.push(`  body: form,`);
      } else if (b.kind === "file") {
        lines.push(`  body: contenuDe(${js(b.filePath ?? "")}), // -T / --upload-file`);
      } else if (b.text !== void 0) {
        lines.push(`  body: ${js(b.text)},`);
      }
    }
    lines.push(`  redirect: ${js(req.options.followRedirects ? "follow" : "manual")},`);
    if (req.options.timeoutMs) {
      lines.push(`  signal: AbortSignal.timeout(${req.options.timeoutMs}),`);
    }
    lines.push(`});`);
    return lines.join("\n");
  }

  // src/execute.ts
  var RETRYABLE_STATUS = /* @__PURE__ */ new Set([408, 429, 500, 502, 503, 504]);
  async function execute(req, opts = {}) {
    const plan = toFetch(req, opts);
    const issues = [...plan.issues];
    const doFetch = opts.fetchImpl ?? fetch;
    await applyInsecure(req, plan, issues);
    const maxAttempts = 1 + Math.max(0, req.options.retry ?? 0);
    let attempt = 0;
    let lastError;
    while (attempt < maxAttempts) {
      attempt++;
      try {
        const response = await doFetch(plan.url, plan.init);
        if (attempt < maxAttempts && RETRYABLE_STATUS.has(response.status)) {
          await delay(retryDelayMs(req, attempt));
          continue;
        }
        return { response, attempts: attempt, issues };
      } catch (e) {
        lastError = e;
        if (attempt < maxAttempts) {
          await delay(retryDelayMs(req, attempt));
          continue;
        }
        throw e;
      }
    }
    throw lastError ?? new Error("ex\xE9cution impossible");
  }
  function retryDelayMs(req, attempt) {
    if (req.options.retryDelayMs) return req.options.retryDelayMs;
    return Math.min(1e3 * 2 ** (attempt - 1), 6e5);
  }
  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  async function applyInsecure(req, plan, issues) {
    if (!req.options.insecure) return;
    const proc = globalThis.process;
    if (!proc?.versions?.node) {
      issues.push("-k/--insecure : impossible de d\xE9sactiver la v\xE9rification TLS dans un navigateur.");
      return;
    }
    try {
      const moduleName = "undici";
      const undici = await import(
        /* @vite-ignore */
        moduleName
      );
      plan.init.dispatcher = new undici.Agent({
        connect: { rejectUnauthorized: false }
      });
    } catch {
      issues.push("-k/--insecure : le module undici n'est pas disponible, la v\xE9rification TLS reste active.");
    }
  }
  return __toCommonJS(index_exports);
})();

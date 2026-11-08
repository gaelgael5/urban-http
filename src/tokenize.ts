/**
 * Découpe une ligne de commande shell en tokens, comme le ferait bash.
 *
 * Pris en charge :
 * - quotes simples '...' (littérales)
 * - quotes doubles "..." avec échappements \" \\ \$ \`
 * - backslash hors quotes (échappe le caractère suivant)
 * - continuations de ligne : "\<newline>" (bash) et "^<newline>" (cmd Windows)
 * - quoting ANSI-C $'...' (\n, \t, \r, \\, \', \", \xHH, \uHHHH, \0, \NNN)
 * - les doubles quotes doublées "" du cmd Windows à l'intérieur de "..."
 */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
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
    const c = input[i]!;

    // Continuations de ligne (hors quotes)
    if ((c === "\\" || c === "^") && (input[i + 1] === "\n" || input.startsWith("\r\n", i + 1))) {
      i += input[i + 1] === "\r" ? 3 : 2;
      continue;
    }

    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      push();
      i++;
      continue;
    }

    hasToken = true;

    if (c === "'") {
      // Quote simple : tout est littéral jusqu'à la prochaine quote simple.
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
        const d = input[i]!;
        if (d === '"') {
          // "" à l'intérieur d'une chaîne cmd Windows = une double quote littérale
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

    // Quoting ANSI-C : $'...'
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
      i++; // quote fermante
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

/** Heuristique : la commande vient de cmd Windows (continuations ^). */
function isCmdStyle(input: string): boolean {
  return /\^\r?\n/.test(input);
}

function ansiCEscape(input: string, i: number): { text: string; consumed: number } {
  const c = input[i];
  switch (c) {
    case "n": return { text: "\n", consumed: 1 };
    case "t": return { text: "\t", consumed: 1 };
    case "r": return { text: "\r", consumed: 1 };
    case "a": return { text: "\x07", consumed: 1 };
    case "b": return { text: "\b", consumed: 1 };
    case "f": return { text: "\f", consumed: 1 };
    case "v": return { text: "\v", consumed: 1 };
    case "\\": return { text: "\\", consumed: 1 };
    case "'": return { text: "'", consumed: 1 };
    case '"': return { text: '"', consumed: 1 };
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

/**
 * Retire un éventuel prompt ("$", ">") et le mot "curl" lui-même
 * pour ne garder que les arguments.
 */
function stripPromptAndCurl(tokens: string[]): string[] {
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

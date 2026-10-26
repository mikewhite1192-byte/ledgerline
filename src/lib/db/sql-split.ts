// Splits a migration file into single statements, because the Data API runs one statement per
// call. A semicolon ends a statement only outside single-quoted strings ('' escape), double-quoted
// identifiers, -- line comments, /* */ block comments (which nest in Postgres) and dollar-quoted
// bodies ($$ or $tag$, closed by the same tag). Each statement starts at its first code
// character (comments before it are dropped), ends before its semicolon and is trimmed; pieces
// that are only whitespace and comments are dropped. Anything unterminated throws, so a
// malformed file fails instead of running half a statement.

const DOLLAR_TAG = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;
const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;

export function splitSql(text: string): string[] {
  const statements: string[] = [];
  // Index of the current statement's first code character, or -1 before it has any.
  let codeStart = -1;
  let i = 0;

  const markCode = () => {
    if (codeStart === -1) codeStart = i;
  };
  const push = (end: number) => {
    if (codeStart !== -1) statements.push(text.slice(codeStart, end).trim());
    codeStart = -1;
  };

  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "-" && next === "-") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end + 1;
    } else if (c === "/" && next === "*") {
      i = skipBlockComment(text, i);
    } else if (c === "'" || c === '"') {
      markCode();
      i = skipQuoted(text, i, c);
    } else if (c === "$" && (i === 0 || !IDENTIFIER_CHAR.test(text[i - 1]))) {
      DOLLAR_TAG.lastIndex = i;
      const tag = DOLLAR_TAG.exec(text)?.[0];
      markCode();
      if (tag) {
        const end = text.indexOf(tag, i + tag.length);
        if (end === -1) throw new Error(`unterminated dollar quote ${tag}`);
        i = end + tag.length;
      } else {
        i++;
      }
    } else if (c === ";") {
      push(i);
      i++;
    } else {
      if (!/\s/.test(c)) markCode();
      i++;
    }
  }
  push(text.length);
  return statements;
}

function skipQuoted(text: string, open: number, quote: string): number {
  let j = open + 1;
  while (j < text.length) {
    if (text[j] === quote) {
      if (text[j + 1] === quote) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  throw new Error("unterminated quoted string or identifier");
}

function skipBlockComment(text: string, open: number): number {
  let depth = 1;
  let j = open + 2;
  while (j < text.length && depth > 0) {
    if (text[j] === "/" && text[j + 1] === "*") {
      depth++;
      j += 2;
    } else if (text[j] === "*" && text[j + 1] === "/") {
      depth--;
      j += 2;
    } else {
      j++;
    }
  }
  if (depth > 0) throw new Error("unterminated block comment");
  return j;
}

// Reads the color tokens out of globals.css, so /design and contrast.test.ts measure the real
// values instead of a copy that could drift.

export type TokenSet = Record<string, string>;

// The custom properties declared in the first block whose selector matches.
function block(css: string, selector: RegExp): TokenSet {
  const m = selector.exec(css);
  if (!m) throw new Error(`no block for ${selector}`);
  const body = css.slice(m.index + m[0].length, css.indexOf("}", m.index));
  const tokens: TokenSet = {};
  for (const [, name, value] of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) tokens[name] = value.trim();
  return tokens;
}

export function parseTokens(css: string): { light: TokenSet; dark: TokenSet; darkMedia: TokenSet } {
  return {
    light: block(css, /:root,\s*\[data-theme="light"\]\s*\{/),
    darkMedia: block(css, /:root:not\(\[data-theme="light"\]\)\s*\{/),
    dark: block(css, /\n\[data-theme="dark"\]\s*\{/),
  };
}

export const isHex = (v: string | undefined): v is string => !!v && /^#[0-9a-fA-F]{6}$/.test(v);

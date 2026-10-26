import { randomInt } from "node:crypto";

// No look-alike characters (I, O, l, 0, 1), so a person can type it from the secret. The symbols
// are all in Cognito's allowed set.
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const DIGITS = "23456789";
const SYMBOLS = "!#%+-=?@^_";

// A random password that meets the pool's policy (12 or more characters with an upper, a lower,
// a digit and a symbol). randomInt is uniform, so no character is favored.
export function generatePassword(length = 24): string {
  if (!Number.isInteger(length) || length < 12) throw new Error("password length must be 12+");
  const all = UPPER + LOWER + DIGITS + SYMBOLS;
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

function pick(set: string): string {
  return set[randomInt(set.length)];
}

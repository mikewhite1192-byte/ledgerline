// The dollar amount a driver asked for, found in their own words without a model: "$300",
// "300 dollars", "300 dólares", "three hundred dollars", "trescientos dólares", "mil dólares".
// The first amount in the text wins. This is only the ask; the rules engine decides what can be
// advanced. null when no amount is stated, and the agent then asks instead of guessing.

const MAX_DOLLARS = 1_000_000;

const CURRENCY = new Set(["dollars", "dollar", "bucks", "dolares", "dolar"]);
const CONNECTORS = new Set(["and", "y"]);
const HUNDRED = new Set(["hundred"]);
const THOUSAND = new Set(["thousand", "mil"]);

// Word values after accents are removed. Spanish hundreds carry their own value.
const WORDS: Readonly<Record<string, number>> = {
  // English
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
  // Spanish
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8,
  nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16,
  diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, veintiun: 21, veintiuno: 21,
  veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26,
  veintisiete: 27, veintiocho: 28, veintinueve: 29, treinta: 30, cuarenta: 40, cincuenta: 50,
  sesenta: 60, setenta: 70, ochenta: 80, noventa: 90, cien: 100, ciento: 100, doscientos: 200,
  doscientas: 200, trescientos: 300, trescientas: 300, cuatrocientos: 400, cuatrocientas: 400,
  quinientos: 500, quinientas: 500, seiscientos: 600, seiscientas: 600, setecientos: 700,
  setecientas: 700, ochocientos: 800, ochocientas: 800, novecientos: 900, novecientas: 900,
};

type Token = { text: string; kind: "word" | "number" | "dollar" };

function tokens(text: string): Token[] {
  const plain = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const out: Token[] = [];
  for (const m of plain.matchAll(/\$|\d[\d,.]*\d|\d|[a-z]+/g)) {
    const t = m[0];
    out.push({ text: t, kind: t === "$" ? "dollar" : /^\d/.test(t) ? "number" : "word" });
  }
  return out;
}

// "300", "300.50", "1,200", "1,200.75" and the Spanish "1.200" (a dot before exactly three digits
// is a thousands mark). Cents only when there are exactly two digits after the point.
function numberCents(text: string): number | null {
  let whole: string;
  let fraction = "";
  if (/^\d{1,3}(,\d{3})+(\.\d{2})?$/.test(text)) {
    [whole, fraction = ""] = text.replace(/,/g, "").split(".");
  } else if (/^\d{1,3}(\.\d{3})+$/.test(text)) {
    whole = text.replace(/\./g, "");
  } else if (/^\d+(\.\d{2})?$/.test(text)) {
    [whole, fraction = ""] = text.split(".");
  } else {
    return null;
  }
  const dollars = Number(whole);
  if (!Number.isSafeInteger(dollars) || dollars > MAX_DOLLARS) return null;
  const cents = dollars * 100 + (fraction ? Number(fraction) : 0);
  return cents > 0 ? cents : null;
}

function isNumberWord(list: readonly Token[], i: number): boolean {
  const t = list[i];
  if (!t || t.kind !== "word") return false;
  if (Object.hasOwn(WORDS, t.text) || HUNDRED.has(t.text) || THOUSAND.has(t.text)) return true;
  // "a hundred", "a thousand"
  const next = list[i + 1];
  return t.text === "a" && next !== undefined && (HUNDRED.has(next.text) || THOUSAND.has(next.text));
}

// The value of a run of number words, or null when the run does not read as one number.
function wordsValue(run: readonly string[]): number | null {
  let total = 0;
  let current = 0;
  let seen = false;
  for (const w of run) {
    if (CONNECTORS.has(w)) continue;
    if (w === "a") {
      current += 1;
    } else if (HUNDRED.has(w)) {
      current = (current || 1) * 100;
    } else if (THOUSAND.has(w)) {
      total += (current || 1) * 1000;
      current = 0;
    } else if (Object.hasOwn(WORDS, w)) {
      current += WORDS[w];
    } else {
      return null;
    }
    seen = true;
  }
  const value = total + current;
  return seen && value > 0 && value <= MAX_DOLLARS ? value : null;
}

const isCurrency = (t: Token | undefined) => t !== undefined && t.kind === "word" && CURRENCY.has(t.text);

export function extractAmountCents(text: string): number | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const list = tokens(text);
  for (let i = 0; i < list.length; i += 1) {
    const t = list[i];
    // "$300" or "$ 300"
    if (t.kind === "dollar" && list[i + 1]?.kind === "number") {
      const cents = numberCents(list[i + 1].text);
      if (cents !== null) return cents;
      continue;
    }
    // "300 dollars"
    if (t.kind === "number" && isCurrency(list[i + 1])) {
      const cents = numberCents(t.text);
      if (cents !== null) return cents;
      continue;
    }
    // "three hundred dollars", "trescientos dolares", "treinta y cinco dolares"
    if (isNumberWord(list, i)) {
      const run: string[] = [];
      let j = i;
      while (j < list.length && (isNumberWord(list, j) || (run.length > 0 && CONNECTORS.has(list[j].text)))) {
        run.push(list[j].text);
        j += 1;
      }
      if (isCurrency(list[j])) {
        const dollars = wordsValue(run);
        if (dollars !== null) return dollars * 100;
      }
    }
  }
  return null;
}

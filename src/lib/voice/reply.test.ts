import { describe, expect, it } from "vitest";
import { figuresOf, parseTranslated, REPLY_MAX_CHARS, replyTemplate, type ReplyOutcome } from "./reply";

// The reply draft: a fixed sentence per outcome with the engine's numbers, and a translation kept
// only when it carries every dollar figure exactly as written and no number the template lacks.

describe("replyTemplate", () => {
  it.each<[ReplyOutcome, string]>([
    [{ kind: "received" }, "We got your voice note. The office is looking at it and will get back to you."],
    [{ kind: "need_amount" }, "We got your voice note asking for an advance. How much do you need? Reply with the amount in dollars."],
    [
      { kind: "proposed", amountCents: 30_000 },
      "We got your request for an advance of $300.00. It is waiting for approval, and we will let you know when it is paid.",
    ],
    [
      { kind: "approved", amountCents: 125_050 },
      "Your advance of $1,250.50 was approved. The payment has not gone through yet; the office will let you know when it does.",
    ],
    [
      { kind: "paid", amountCents: 30_000, feeCents: 500 },
      "Your advance of $300.00 was approved and sent. A fee of $5.00 applies, and both are repaid from your settlement pay.",
    ],
    [{ kind: "rejected", note: "expired" }, "Your advance request was not approved. No one decided in time, so it expired. Call the office if you have questions."],
    [{ kind: "rejected", note: null }, "Your advance request was not approved. Call the office if you have questions."],
  ])("%j", (outcome, text) => {
    expect(replyTemplate(outcome)).toBe(text);
    expect(text.length).toBeLessThanOrEqual(REPLY_MAX_CHARS);
  });
});

describe("parseTranslated", () => {
  const template = replyTemplate({ kind: "paid", amountCents: 30_000, feeCents: 500 });
  const spanish = "Tu adelanto de $300.00 fue aprobado y enviado. Se aplica una comisión de $5.00, y ambos se descuentan de tu pago.";

  it("finds every dollar figure in order", () => {
    expect(figuresOf(template)).toEqual(["$300.00", "$5.00"]);
    expect(figuresOf("$1,250.50 and $12,000.00")).toEqual(["$1,250.50", "$12,000.00"]);
  });

  it("keeps a translation with the same figures in the same order", () => {
    expect(parseTranslated(JSON.stringify({ reply: spanish }), template)).toBe(spanish);
  });

  it.each([
    ["not JSON", spanish],
    ["an extra field", JSON.stringify({ reply: spanish, note: "x" })],
    ["an empty reply", JSON.stringify({ reply: "  " })],
    ["a changed figure", JSON.stringify({ reply: spanish.replace("$300.00", "$3,000.00") })],
    ["a dropped figure", JSON.stringify({ reply: spanish.replace(" de $5.00", "") })],
    ["swapped figures", JSON.stringify({ reply: "Comisión $5.00, adelanto $300.00." })],
    ["an added figure", JSON.stringify({ reply: `${spanish} Bono de $50.00.` })],
    ["an added dollar amount with no cents", JSON.stringify({ reply: `${spanish} Bono de $50.` })],
    ["an added amount in dólares", JSON.stringify({ reply: `${spanish} Más 50 dólares de bono.` })],
    ["an added number with a thousands dot", JSON.stringify({ reply: `${spanish} Límite: 5.000.` })],
    ["an added number in another script", JSON.stringify({ reply: `${spanish} Bono de \uFF15\uFF10.` })],
    ["a figure repeated as a bare number", JSON.stringify({ reply: `${spanish} Son 300 en total.` })],
    ["a reply past the cap", JSON.stringify({ reply: "x".repeat(601) })],
  ])("refuses %s", (_label, answer) => {
    expect(parseTranslated(answer, template)).toBeNull();
  });
});

describe("parseTranslated over every template", () => {
  // A faithful Spanish translation of each template, kept as is.
  it.each<[ReplyOutcome, string]>([
    [{ kind: "received" }, "Recibimos tu nota de voz. La oficina la está revisando y te responderá pronto."],
    [
      { kind: "need_amount" },
      "Recibimos tu nota de voz pidiendo un adelanto. ¿Cuánto necesitas? Responde con la cantidad en dólares.",
    ],
    [
      { kind: "proposed", amountCents: 30_000 },
      "Recibimos tu solicitud de un adelanto de $300.00. Está esperando aprobación y te avisaremos cuando se pague.",
    ],
    [
      { kind: "approved", amountCents: 125_050 },
      "Tu adelanto de $1,250.50 fue aprobado. El pago todavía no se ha realizado; la oficina te avisará cuando se haga.",
    ],
    [
      { kind: "approved", amountCents: 1_200_000 },
      "Tu adelanto de $12,000.00 fue aprobado. El pago todavía no se ha realizado; la oficina te avisará cuando se haga.",
    ],
    [
      { kind: "paid", amountCents: 30_000, feeCents: 500 },
      "Tu adelanto de $300.00 fue aprobado y enviado. Se aplica una comisión de $5.00, y ambos se descuentan de tu pago.",
    ],
    [
      { kind: "rejected", note: "expired" },
      "Tu solicitud de adelanto no fue aprobada. Nadie decidió a tiempo, así que venció. Llama a la oficina si tienes preguntas.",
    ],
    [
      { kind: "rejected", note: "wrong_amount" },
      "Tu solicitud de adelanto no fue aprobada. Decisión: monto incorrecto. Llama a la oficina si tienes preguntas.",
    ],
    [
      { kind: "rejected", note: "stale_eligibility: amount_changed" },
      "Tu solicitud de adelanto no fue aprobada. Las cifras cambiaron antes de la aprobación (cambió el monto permitido), así que no se pagó nada. Llama a la oficina si tienes preguntas.",
    ],
    [{ kind: "rejected", note: null }, "Tu solicitud de adelanto no fue aprobada. Llama a la oficina si tienes preguntas."],
  ])("keeps a faithful translation of %j", (outcome, es) => {
    expect(parseTranslated(JSON.stringify({ reply: es }), replyTemplate(outcome))).toBe(es);
  });

  it("refuses a number added to a template that states none", () => {
    const template = replyTemplate({ kind: "received" });
    const es = "Recibimos tu nota de voz. Llama al 555 0100 y la oficina te responderá pronto.";
    expect(parseTranslated(JSON.stringify({ reply: es }), template)).toBeNull();
  });
});

describe("parseTranslated compares every amount, in order", () => {
  const template = replyTemplate({ kind: "paid", amountCents: 30_000, feeCents: 500 });
  const spanish = "Tu adelanto de $300.00 fue aprobado y enviado. Se aplica una comisión de $5.00, y ambos se descuentan de tu pago.";

  it("keeps a faithful translation with the same amounts", () => {
    expect(parseTranslated(JSON.stringify({ reply: spanish }), template)).toBe(spanish);
  });

  it("refuses an added spelled-out amount", () => {
    const es = `${spanish} Más cien dólares de bono.`;
    expect(parseTranslated(JSON.stringify({ reply: es }), template)).toBeNull();
  });

  it("refuses an added figure", () => {
    const es = `${spanish} Más $300.00 de bono.`;
    expect(parseTranslated(JSON.stringify({ reply: es }), template)).toBeNull();
  });

  it("refuses an amount added to a template that states none", () => {
    const received = replyTemplate({ kind: "received" });
    const es = "Recibimos tu nota de voz. La oficina la está revisando y te dará cien dólares.";
    expect(parseTranslated(JSON.stringify({ reply: es }), received)).toBeNull();
  });
});

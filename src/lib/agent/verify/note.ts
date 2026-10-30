// The fixed note the loop adds to a refused proposal's tool message (design-agents-102 3.2), so the
// model can revise or explain. It carries category codes, the attempt and the limit only: never
// raw upstream text, never the engine's reason sentence. A category that is not a plain code word
// is left out, and a limit that is not whole cents is not shown. Pure.

const CODE = /^[a-z_]{2,40}$/;

export function verificationNote(
  attempt: number,
  max: number,
  failed: readonly string[],
  limitCents?: number | null,
): string {
  const of = Number.isSafeInteger(max) && max >= 1 ? max : 1;
  const n = Number.isSafeInteger(attempt) ? Math.min(of, Math.max(1, attempt)) : of;
  const codes = [...new Set(failed.filter((c) => typeof c === "string" && CODE.test(c)))].slice(0, 4);
  const limit =
    typeof limitCents === "number" && Number.isSafeInteger(limitCents) && limitCents >= 0 ? `, limit ${limitCents} cents` : "";
  return (
    `Verification refused this proposal (attempt ${n} of ${of}): ${codes.length > 0 ? codes.join(", ") : "not_verified"}${limit}. ` +
    "Revise what you propose and call the tool again, or tell the person plainly why it cannot be done. " +
    `After ${of} refused attempts the request goes to a person.`
  );
}

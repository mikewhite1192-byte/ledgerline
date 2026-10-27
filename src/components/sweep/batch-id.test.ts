import { describe, expect, it } from "vitest";
import { batchFor, batchKey } from "./batch-id";

const A = "0b3c8f2e-6a1d-4c6e-9f00-000000000001";
const B = "0b3c8f2e-6a1d-4c6e-9f00-000000000002";
const C = "0b3c8f2e-6a1d-4c6e-9f00-000000000003";

function ids() {
  let n = 0;
  return () => `batch-${++n}`;
}

describe("the approve-all batch id", () => {
  it("keeps the id for the same list and total, in any order or case", () => {
    const next = ids();
    const first = batchFor(null, [A, B], 1250, next);
    expect(first.id).toBe("batch-1");
    expect(batchFor(first, [B, A], 1250, next)).toBe(first);
    expect(batchFor(first, [A.toUpperCase(), B], 1250, next)).toBe(first);
  });

  it("takes a new id when the list or the total changes", () => {
    const next = ids();
    const first = batchFor(null, [A, B], 1250, next);
    const moreFixes = batchFor(first, [A, B, C], 1250, next);
    expect(moreFixes.id).toBe("batch-2");
    const fewerFixes = batchFor(moreFixes, [A], 1250, next);
    expect(fewerFixes.id).toBe("batch-3");
    const newTotal = batchFor(fewerFixes, [A], 1251, next);
    expect(newTotal.id).toBe("batch-4");
    // Back to the first list: still a new id, never the old one.
    expect(batchFor(newTotal, [A, B], 1250, next).id).toBe("batch-5");
  });

  it("keys on the whole list and total, never a part of either", () => {
    expect(batchKey([A, B], 12)).not.toBe(batchKey([A, B], 125));
    expect(batchKey([A], 1)).not.toBe(batchKey([A, B], 1));
  });
});

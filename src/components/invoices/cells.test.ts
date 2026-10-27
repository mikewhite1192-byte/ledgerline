import { describe, expect, it } from "vitest";
import { agingBucket } from "@/lib/rules-engine/receivables";
import { BUCKET_WORDS } from "./cells";

describe("BUCKET_WORDS", () => {
  it("reads a balance due today as not late, the same as one due later", () => {
    expect(BUCKET_WORDS[agingBucket("2026-10-28", "2026-10-28")]).toBe("Not late");
    expect(BUCKET_WORDS[agingBucket("2026-11-15", "2026-10-28")]).toBe("Not late");
    expect(BUCKET_WORDS[agingBucket("2026-10-27", "2026-10-28")]).toBe("1 to 30 days late");
  });
});

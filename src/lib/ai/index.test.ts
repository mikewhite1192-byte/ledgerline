import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { DbError, type Param, type Queryable, type TenantDb } from "../db";
import { ForbiddenError } from "../tenant/context";
import { AiError, complete, type AiRequest } from "./index";
import { estimateReserve, NANOCENTS_PER_CENT, priceFor } from "./prices";
import type { FetchFn } from "./providers/http";

const KEY = "test-key-abcdefghijklmnop";
const PROMPT = "Say hello to the money desk.";
const SESSION: Session = {
  sub: "sub-test",
  email: "desk@example.test",
  tenantId: "11111111-1111-4111-8111-111111111111",
};
const REQUEST: AiRequest = {
  purpose: "proof",
  messages: [
    { role: "system", content: "Reply in one sentence." },
    { role: "user", content: PROMPT },
  ],
};
const USAGE = {
  input_tokens: 15,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 64,
  output_tokens_details: { reasoning_tokens: 50 },
};
const COST = 15 * 125_000 + 64 * 425_000;

function metaAnswer(status = "completed") {
  return {
    id: "resp_test1",
    status,
    output:
      status === "completed"
        ? [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Hello, money desk." }],
            },
          ]
        : [{ type: "reasoning", id: "rs_1", summary: [] }],
    usage: USAGE,
  };
}

// A ledger that behaves like the real one closely enough to read its end state, and records
// every step (and the fetch) in one list so the order can be checked.
function fakeLedger(start = { spent: 0, reserved: 0, calls: 0 }) {
  const steps: string[] = [];
  const counter = { ...start };
  const rows = new Map<string, { reserved: number; status: string }>();
  const breaks = { membership: false, settleThrows: false, rowLost: false };
  const q: Queryable = {
    async query<T>(sql: string, params: Param[] = []): Promise<T[]> {
      if (sql.includes("FROM memberships")) {
        steps.push("membership");
        return (breaks.membership ? [] : [{ ok: 1 }]) as T[];
      }
      if (sql.includes("FROM ops.ai_spend")) {
        steps.push("lock counter");
        return [
          {
            spent_nanocents: counter.spent,
            reserved_nanocents: counter.reserved,
            calls: counter.calls,
          },
        ] as T[];
      }
      if (sql.includes("FROM ai_calls")) {
        steps.push("lock call");
        const row = rows.get(String(params[0]));
        return (
          row?.status === "reserved" && !breaks.rowLost
            ? [{ reserved_nanocents: row.reserved }]
            : []
        ) as T[];
      }
      throw new Error("unexpected query");
    },
    async execute(sql: string, params: Param[] = []): Promise<number> {
      if (sql.startsWith("INSERT INTO ai_calls")) {
        steps.push("insert call");
        rows.set(String(params[0]), { reserved: Number(params[4]), status: "reserved" });
        return 1;
      }
      if (sql.includes("reserved_nanocents = reserved_nanocents + ")) {
        steps.push("reserve");
        counter.reserved += Number(params[0]);
        return 1;
      }
      if (sql.startsWith("UPDATE ai_calls")) {
        if (breaks.settleThrows) throw new DbError("unavailable");
        steps.push(`settle call ${params[1]}`);
        rows.get(String(params[0]))!.status = String(params[1]);
        return 1;
      }
      if (sql.includes("reserved_nanocents = reserved_nanocents - ")) {
        steps.push("settle counter");
        counter.reserved -= Number(params[0]);
        counter.spent += Number(params[1]);
        counter.calls += 1;
        return 1;
      }
      throw new Error("unexpected statement");
    },
  };
  const db: TenantDb = {
    async withTenant(tenantId, fn) {
      steps.push(`tx ${tenantId === SESSION.tenantId ? "tenant" : "other"}`);
      return fn(q);
    },
  };
  return { db, steps, counter, rows, breaks };
}

function fakeFetch(steps: string[], answer: () => Response | Promise<Response>) {
  return vi.fn<FetchFn>(async () => {
    steps.push("fetch");
    return answer();
  });
}

async function refusal(promise: Promise<unknown>): Promise<AiError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AiError);
  return err as AiError;
}

let logged: string[];

beforeEach(() => {
  flags.aiEnabled = true;
  logged = [];
  const record = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(record);
  vi.spyOn(console, "error").mockImplementation(record);
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DB_CLUSTER_ARN", "");
  vi.stubEnv("META_MODEL_ID", "muse-spark-1.3");
  vi.stubEnv("BASETEN_MODEL_ID", "meta-models/muse-spark-open-1026");
  vi.stubEnv("AI_SPEND_CAP_CENTS", "12000");
  vi.stubEnv("META_API_KEY", KEY);
});

afterEach(() => {
  flags.aiEnabled = false;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("complete, refusals before any reservation", () => {
  it("refuses while the switch is off", async () => {
    flags.aiEnabled = false;
    const ledger = fakeLedger();
    const fetchFn = fakeFetch(ledger.steps, () => Response.json(metaAnswer()));
    expect(
      (await refusal(complete("meta", REQUEST, SESSION, { fetch: fetchFn, db: ledger.db })))
        .category,
    ).toBe("disabled");
    expect(ledger.steps).toEqual([]);
  });

  it("refuses under test without an injected fetch, so no test reaches the network", async () => {
    const network = vi.spyOn(globalThis, "fetch");
    const ledger = fakeLedger();
    expect((await refusal(complete("meta", REQUEST, SESSION, { db: ledger.db }))).category).toBe(
      "not_configured",
    );
    expect(network).not.toHaveBeenCalled();
    expect(ledger.steps).toEqual([]);
  });

  it("refuses a model with no price, a cap that is unset or bad, a key that is missing, and a bad tenant", async () => {
    const cases: [string, string | undefined, Session?][] = [
      ["META_MODEL_ID", "muse-spark-1.3-contributor"],
      ["META_MODEL_ID", ""],
      ["AI_SPEND_CAP_CENTS", ""],
      ["AI_SPEND_CAP_CENTS", "15001"],
      ["AI_SPEND_CAP_CENTS", "120.50"],
      ["META_API_KEY", ""],
      ["META_API_KEY", "short"],
      ["META_MODEL_ID", "muse-spark-1.3", { ...SESSION, tenantId: "not-a-uuid" }],
    ];
    for (const [name, value, session] of cases) {
      vi.stubEnv(name, value);
      const ledger = fakeLedger();
      const fetchFn = fakeFetch(ledger.steps, () => Response.json(metaAnswer()));
      const err = await refusal(
        complete("meta", REQUEST, session ?? SESSION, { fetch: fetchFn, db: ledger.db }),
      );
      expect(err.category, `${name}=${value}`).toBe("not_configured");
      expect(ledger.steps).toEqual([]);
      vi.unstubAllEnvs();
      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv("DB_CLUSTER_ARN", "");
      vi.stubEnv("META_MODEL_ID", "muse-spark-1.3");
      vi.stubEnv("AI_SPEND_CAP_CENTS", "12000");
      vi.stubEnv("META_API_KEY", KEY);
    }
  });

  it("refuses a malformed request as bad_request", async () => {
    const assistant = { role: "assistant" as const, content: "Hi." };
    const replay = [{ type: "reasoning" as const, summary: [], encrypted_content: "enc" }];
    const bad: [AiRequest, "meta" | "baseten"][] = [
      [{ ...REQUEST, purpose: "Proof" }, "meta"],
      [{ ...REQUEST, purpose: "p" }, "meta"],
      [{ ...REQUEST, messages: [{ role: "system", content: "Only instructions." }] }, "meta"],
      [{ ...REQUEST, messages: [] }, "meta"],
      [{ ...REQUEST, maxOutputTokens: 8 }, "meta"],
      [{ ...REQUEST, maxOutputTokens: 8193 }, "meta"],
      [{ ...REQUEST, maxOutputTokens: 100.5 }, "meta"],
      [{ ...REQUEST, reasoningEffort: "none" as never }, "meta"],
      [{ ...REQUEST, maxCostCents: 0 }, "meta"],
      [{ ...REQUEST, timeoutMs: 60_001 }, "meta"],
      [{ ...REQUEST, tools: [{ name: "pay.read.all", description: "x", parameters: {} }] }, "meta"],
      [{ ...REQUEST, tools: [{ name: "pay read", description: "x", parameters: {} }] }, "meta"],
      [{ ...REQUEST, tools: [{ name: "pay", description: "x", parameters: [] as never }] }, "meta"],
      [
        {
          ...REQUEST,
          messages: [
            ...REQUEST.messages,
            { ...assistant, toolCalls: [{ id: "", name: "pay", argumentsJson: "{}" }] },
          ],
        },
        "meta",
      ],
      [
        {
          ...REQUEST,
          messages: [...REQUEST.messages, { role: "tool", toolCallId: "", content: "x" }],
        },
        "meta",
      ],
      [{ ...REQUEST, replay }, "meta"],
      [{ ...REQUEST, messages: [...REQUEST.messages, assistant], replay }, "baseten"],
      [
        {
          ...REQUEST,
          messages: [...REQUEST.messages, assistant],
          replay: [{ type: "message" } as never],
        },
        "meta",
      ],
    ];
    vi.stubEnv("BASETEN_API_KEY", KEY);
    for (const [request, provider] of bad) {
      const ledger = fakeLedger();
      const fetchFn = fakeFetch(ledger.steps, () => Response.json(metaAnswer()));
      const err = await refusal(
        complete(provider, request, SESSION, { fetch: fetchFn, db: ledger.db }),
      );
      expect(err.category, JSON.stringify(request)).toBe("bad_request");
      expect(ledger.steps).toEqual([]);
    }
  });

  it("refuses a call whose worst case is over its own limit", async () => {
    const ledger = fakeLedger();
    const fetchFn = fakeFetch(ledger.steps, () => Response.json(metaAnswer()));
    // 8192 output tokens could cost 3.48 cents.
    const err = await refusal(
      complete("meta", { ...REQUEST, maxOutputTokens: 8192, maxCostCents: 3 }, SESSION, {
        fetch: fetchFn,
        db: ledger.db,
      }),
    );
    expect(err.category).toBe("too_expensive");
    expect(ledger.steps).toEqual([]);
  });

  it("refuses at the cap with nothing written and no call made", async () => {
    const ledger = fakeLedger({
      spent: 12_000 * NANOCENTS_PER_CENT - 1_000_000,
      reserved: 0,
      calls: 7,
    });
    const fetchFn = fakeFetch(ledger.steps, () => Response.json(metaAnswer()));
    expect(
      (await refusal(complete("meta", REQUEST, SESSION, { fetch: fetchFn, db: ledger.db })))
        .category,
    ).toBe("cap");
    expect(ledger.steps).toEqual(["tx tenant", "membership", "lock counter"]);
    expect(ledger.counter).toEqual({
      spent: 12_000 * NANOCENTS_PER_CENT - 1_000_000,
      reserved: 0,
      calls: 7,
    });
  });

  it("refuses a login with no membership before reserving", async () => {
    const ledger = fakeLedger();
    ledger.breaks.membership = true;
    const fetchFn = fakeFetch(ledger.steps, () => Response.json(metaAnswer()));
    await expect(
      complete("meta", REQUEST, SESSION, { fetch: fetchFn, db: ledger.db }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(ledger.rows.size).toBe(0);
  });
});

describe("complete, one call", () => {
  it("reserves before the call, settles after, and returns the answer with its real cost", async () => {
    const ledger = fakeLedger();
    const fetchFn = fakeFetch(ledger.steps, () => Response.json(metaAnswer()));
    const result = await complete("meta", REQUEST, SESSION, { fetch: fetchFn, db: ledger.db });

    expect(ledger.steps).toEqual([
      "tx tenant",
      "membership",
      "lock counter",
      "insert call",
      "reserve",
      "fetch",
      "tx tenant",
      "lock call",
      "settle call ok",
      "settle counter",
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.meta.ai/v1/responses");
    expect(init.headers).toMatchObject({ authorization: `Bearer ${KEY}` });
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({
      model: "muse-spark-1.3",
      max_output_tokens: 1024,
      reasoning: { effort: "low" },
      store: false,
    });

    // The reservation was the worst case for this exact body; settling released all of it.
    const reserved = estimateReserve(
      priceFor("meta", "muse-spark-1.3")!,
      new TextEncoder().encode(String(init.body)).length,
      1024,
    );
    expect(ledger.rows.get(result.callId)).toEqual({ reserved, status: "ok" });
    expect(ledger.counter).toEqual({ spent: COST, reserved: 0, calls: 1 });

    expect(result).toEqual({
      callId: result.callId,
      status: "ok",
      text: "Hello, money desk.",
      toolCalls: [],
      usage: { input: 15, cached: 0, output: 64, reasoning: 50 },
      costNanocents: COST,
      upstreamId: "resp_test1",
      replay: [],
    });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(
      /^ai: meta muse-spark-1\.3 proof ok in=15 cached=0 out=64 reasoning=50 cost=0\.0291c ms=\d+ id=resp_test1 call=/,
    );
    expect(logged.join("\n")).not.toContain(PROMPT);
    expect(logged.join("\n")).not.toContain(KEY);
  });

  it("returns an out-of-budget answer as incomplete, charged from its usage", async () => {
    const ledger = fakeLedger();
    const fetchFn = fakeFetch(ledger.steps, () => Response.json(metaAnswer("incomplete")));
    const result = await complete("meta", REQUEST, SESSION, { fetch: fetchFn, db: ledger.db });
    expect(result).toMatchObject({ status: "incomplete", text: "", costNanocents: COST });
    expect(ledger.rows.get(result.callId)?.status).toBe("incomplete");
    expect(ledger.counter).toEqual({ spent: COST, reserved: 0, calls: 1 });
  });

  it("releases the reservation of a refused call and spends nothing, once, without retrying", async () => {
    for (const [status, category] of [
      [429, "rate_limited"],
      [402, "billing"],
      [400, "bad_request"],
    ] as const) {
      const ledger = fakeLedger();
      logged = [];
      const fetchFn = fakeFetch(ledger.steps, () =>
        Response.json({ error: { message: PROMPT } }, { status }),
      );
      const err = await refusal(
        complete("meta", REQUEST, SESSION, { fetch: fetchFn, db: ledger.db }),
      );
      expect(err.category).toBe(category);
      expect(err.httpStatus).toBe(status);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect([...ledger.rows.values()].map((r) => r.status)).toEqual(["failed"]);
      expect(ledger.counter).toEqual({ spent: 0, reserved: 0, calls: 1 });
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatch(
        new RegExp(`^ai: meta muse-spark-1\\.3 proof failed ${category} http=${status} `),
      );
      expect(logged[0]).not.toContain("reservation kept");
      expect(logged.join("\n")).not.toContain(PROMPT);
    }
  });

  it("keeps the reservation counted when the outcome is unknown", async () => {
    const answers: [() => Response, string][] = [
      [
        () => {
          throw new TypeError("fetch failed");
        },
        "network",
      ],
      [
        () => {
          throw new DOMException("timed out", "TimeoutError");
        },
        "timeout",
      ],
      [() => new Response("oops", { status: 500 }), "unavailable"],
      [() => Response.json({ status: "completed" }), "unknown"],
    ];
    for (const [answer, category] of answers) {
      const ledger = fakeLedger();
      logged = [];
      const fetchFn = fakeFetch(ledger.steps, answer);
      const err = await refusal(
        complete("meta", REQUEST, SESSION, { fetch: fetchFn, db: ledger.db }),
      );
      expect(err.category).toBe(category);
      const [row] = [...ledger.rows.values()];
      expect(row.status).toBe("unknown");
      expect(ledger.counter).toEqual({ spent: 0, reserved: row.reserved, calls: 1 });
      expect(logged[0]).toContain(`unknown ${category}`);
      expect(logged[0]).toContain("reservation kept");
    }
  });

  it("never returns an answer the ledger could not record", async () => {
    for (const broken of ["settleThrows", "rowLost"] as const) {
      const ledger = fakeLedger();
      ledger.breaks[broken] = true;
      logged = [];
      const fetchFn = fakeFetch(ledger.steps, () => Response.json(metaAnswer()));
      const err = await refusal(
        complete("meta", REQUEST, SESSION, { fetch: fetchFn, db: ledger.db }),
      );
      expect(err.category).toBe("unknown");
      const [row] = [...ledger.rows.values()];
      expect(row.status).toBe("reserved");
      expect(ledger.counter).toEqual({ spent: 0, reserved: row.reserved, calls: 0 });
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain(
        broken === "settleThrows"
          ? "not settled (unavailable); reservation kept"
          : "not settled (row not reserved)",
      );
      expect(logged.join("\n")).not.toContain("Hello, money desk.");
    }
  });
});

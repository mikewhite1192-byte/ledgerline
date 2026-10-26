import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flags } from "../../config/flags";
import type { Session } from "../auth/claims";
import { DbError, type Param, type Queryable, type TenantDb } from "../db";
import { ForbiddenError } from "../tenant/context";
import {
  AiError,
  complete,
  generateImage,
  segment,
  transcribe,
  type AiDeps,
  type AiRequest,
  type AiTextTarget,
} from "./index";
import {
  audioReserve,
  estimateReserve,
  NANOCENTS_PER_CENT,
  priceFor,
  type TokenPrice,
  VOICE_NANOCENTS_PER_SECOND,
} from "./prices";
import type { FetchFn } from "./providers/http";
import { JPEG_BYTES, makeWav, PDF_BYTES, PNG_BYTES } from "./test-fixtures";

const KEY = "test-key-abcdefghijklmnop";
const PROMPT = "Say hello to the money desk.";
const TRACE = "22222222-2222-4222-8222-222222222222";
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
const WONDER_COST = 15 * 400_000 + 64 * 2_000_000;
const CONTRIBUTOR_COST = 15 * 10_000 + 64 * 20_000;

const BASE_ENV: Record<string, string | undefined> = {
  NODE_ENV: "test",
  DB_CLUSTER_ARN: "",
  META_MODEL_SPARK: "muse-spark-1.3",
  META_MODEL_WONDER: "muse-wonder-1.0",
  META_MODEL_VOICE: "muse-voice-transcribe-1.0",
  META_MODEL_IMAGE: "muse-image-1.0",
  META_MODEL_SAM: "sam-3.1",
  BASETEN_MODEL_ID: "meta-models/muse-spark-open-1026",
  AI_SPEND_CAP_CENTS: "12000",
  AI_WONDER_CAP_CENTS: "3000",
  META_CONTRIBUTOR_MODE: undefined,
  META_API_KEY: KEY,
  BASETEN_API_KEY: KEY,
};

function baseEnv() {
  vi.unstubAllEnvs();
  for (const [name, value] of Object.entries(BASE_ENV)) vi.stubEnv(name, value);
}

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

function basetenAnswer() {
  return {
    id: "chatcmpl-1",
    choices: [{ finish_reason: "stop", message: { content: "triage: load" } }],
    usage: {
      prompt_tokens: 15,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens: 64,
      completion_tokens_details: { reasoning_tokens: 50 },
    },
  };
}

const B64_PNG = Buffer.from(PNG_BYTES).toString("base64");
const SAM_TEXT =
  "<0f>0<|box;x1=120;y1=50;x2=279;y2=259;w=400;h=300;c=0.58|><|mask;x=0;y=0;c=0.58;data=210,160,~ab=c|>\n";

// One answer per kind of call, by the URL it was sent to.
function answerFor(url: string): Response {
  if (url.endsWith("/v1/asr/transcribe")) {
    return Response.json({
      sessionId: "asr/1:abc",
      transcript: " load 421 delivered in Dallas.",
      audioDurationMs: 2240,
      turns: [],
    });
  }
  if (url.endsWith("/v1/images/generations")) {
    return Response.json({ output_format: "png", data: [{ b64_json: B64_PNG }] });
  }
  if (url.includes("baseten")) return Response.json(basetenAnswer());
  return Response.json(metaAnswer());
}

const samAnswer = () =>
  Response.json({
    id: "resp_sam1",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: SAM_TEXT }] }],
  });

type Row = {
  reserved: number;
  status: string;
  target: string;
  model: string;
  kind: string;
  effort: Param;
  trace: Param;
  units?: Param;
  cost?: Param;
};

// A ledger that behaves like the real one closely enough to read its end state, and records
// every step (and the fetch) in one list so the order can be checked.
function fakeLedger(
  start: Partial<
    Record<"spent" | "reserved" | "calls" | "wonderSpent" | "wonderReserved", number>
  > = {},
) {
  const steps: string[] = [];
  const counter = { spent: 0, reserved: 0, calls: 0, wonderSpent: 0, wonderReserved: 0, ...start };
  const rows = new Map<string, Row>();
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
            wonder_spent_nanocents: counter.wonderSpent,
            wonder_reserved_nanocents: counter.wonderReserved,
          },
        ] as T[];
      }
      if (sql.includes("FROM model_calls") && sql.includes("status = 'reserved'")) {
        steps.push("lock call");
        const row = rows.get(String(params[0]));
        return (
          row?.status === "reserved" && !breaks.rowLost
            ? [{ reserved_nanocents: row.reserved, target: row.target }]
            : []
        ) as T[];
      }
      throw new Error("unexpected query");
    },
    async execute(sql: string, params: Param[] = []): Promise<number> {
      if (sql.startsWith("INSERT INTO model_calls")) {
        steps.push("insert call");
        rows.set(String(params[0]), {
          target: String(params[1]),
          model: String(params[3]),
          kind: String(params[4]),
          effort: params[6],
          trace: params[7],
          reserved: Number(params[8]),
          status: "reserved",
        });
        return 1;
      }
      if (sql.includes("reserved_nanocents = reserved_nanocents + ")) {
        steps.push("reserve");
        counter.reserved += Number(params[0]);
        counter.wonderReserved += Number(params[1]);
        return 1;
      }
      if (sql.startsWith("UPDATE model_calls")) {
        if (breaks.settleThrows) throw new DbError("unavailable");
        steps.push(`settle call ${params[1]}`);
        const row = rows.get(String(params[0]))!;
        row.status = String(params[1]);
        row.cost = params[3];
        row.units = params[11];
        return 1;
      }
      if (sql.includes("reserved_nanocents = reserved_nanocents - ")) {
        steps.push("settle counter");
        counter.reserved -= Number(params[0]);
        counter.spent += Number(params[1]);
        counter.wonderReserved -= Number(params[2]);
        counter.wonderSpent += Number(params[3]);
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

function fakeFetch(
  steps: string[],
  answer: (url: string) => Response | Promise<Response> = answerFor,
) {
  return vi.fn<FetchFn>(async (url) => {
    steps.push("fetch");
    return answer(String(url));
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

// One valid call per target, so a refusal can be checked for every one of them.
const CALLS: Record<string, (deps: AiDeps, session?: Session) => Promise<unknown>> = {
  spark: (deps, session = SESSION) => complete("spark", REQUEST, session, deps),
  wonder: (deps, session = SESSION) => complete("wonder", REQUEST, session, deps),
  spark_open: (deps, session = SESSION) => complete("spark_open", REQUEST, session, deps),
  voice: (deps, session = SESSION) =>
    transcribe({ purpose: "intake", wav: makeWav({ seconds: 2 }) }, session, deps),
  image: (deps, session = SESSION) =>
    generateImage({ purpose: "demo_art", prompt: "a flatbed at dusk" }, session, deps),
  sam: (deps, session = SESSION) =>
    segment(
      { purpose: "crop", image: { mime: "image/png", bytes: PNG_BYTES }, prompt: "paper document" },
      session,
      deps,
    ),
};
const MODEL_VARS: Record<string, string> = {
  spark: "META_MODEL_SPARK",
  wonder: "META_MODEL_WONDER",
  spark_open: "BASETEN_MODEL_ID",
  voice: "META_MODEL_VOICE",
  image: "META_MODEL_IMAGE",
  sam: "META_MODEL_SAM",
};

let logged: string[];

beforeEach(() => {
  flags.aiEnabled = true;
  logged = [];
  const record = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(record);
  vi.spyOn(console, "error").mockImplementation(record);
  baseEnv();
});

afterEach(() => {
  flags.aiEnabled = false;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("every call, refusals before any reservation", () => {
  it("refuses every target while the switch is off", async () => {
    flags.aiEnabled = false;
    for (const [target, call] of Object.entries(CALLS)) {
      const ledger = fakeLedger();
      const fetchFn = fakeFetch(ledger.steps);
      expect((await refusal(call({ fetch: fetchFn, db: ledger.db }))).category, target).toBe(
        "disabled",
      );
      expect(ledger.steps).toEqual([]);
    }
  });

  it("refuses every target under test without an injected fetch, so no test reaches the network", async () => {
    const network = vi.spyOn(globalThis, "fetch");
    for (const [target, call] of Object.entries(CALLS)) {
      const ledger = fakeLedger();
      expect((await refusal(call({ db: ledger.db }))).category, target).toBe("not_configured");
      expect(ledger.steps).toEqual([]);
    }
    expect(network).not.toHaveBeenCalled();
  });

  it("refuses every target whose model variable is unset or names a model outside its own slot", async () => {
    for (const [target, call] of Object.entries(CALLS)) {
      // Another slot's id is never priced in this one.
      const wrong = target === "spark" ? "muse-wonder-1.0" : "muse-spark-1.3";
      for (const value of ["", undefined, wrong, "muse-spark-1.3-contributor"]) {
        baseEnv();
        vi.stubEnv(MODEL_VARS[target], value);
        const ledger = fakeLedger();
        const fetchFn = fakeFetch(ledger.steps);
        const err = await refusal(call({ fetch: fetchFn, db: ledger.db }));
        expect(err.category, `${target} ${String(value)}`).toBe("not_configured");
        expect(ledger.steps).toEqual([]);
      }
    }
  });

  it("refuses a cap that is unset or bad, a key that is missing, and a bad tenant", async () => {
    const cases: [string, string | undefined, Session?][] = [
      ["AI_SPEND_CAP_CENTS", ""],
      ["AI_SPEND_CAP_CENTS", "15001"],
      ["AI_SPEND_CAP_CENTS", "120.50"],
      ["META_API_KEY", ""],
      ["META_API_KEY", "short"],
      ["META_MODEL_SPARK", "muse-spark-1.3", { ...SESSION, tenantId: "not-a-uuid" }],
    ];
    for (const [name, value, session] of cases) {
      baseEnv();
      vi.stubEnv(name, value);
      const ledger = fakeLedger();
      const fetchFn = fakeFetch(ledger.steps);
      const err = await refusal(CALLS.spark({ fetch: fetchFn, db: ledger.db }, session));
      expect(err.category, `${name}=${value}`).toBe("not_configured");
      expect(ledger.steps).toEqual([]);
    }
  });

  it("refuses Spark Open without its own key, naming the provider in the log only", async () => {
    vi.stubEnv("BASETEN_API_KEY", undefined);
    const ledger = fakeLedger();
    const fetchFn = fakeFetch(ledger.steps);
    const err = await refusal(CALLS.spark_open({ fetch: fetchFn, db: ledger.db }));
    expect(err.category).toBe("not_configured");
    expect(ledger.steps).toEqual([]);
    expect(logged).toEqual(["ai: spark_open not configured (no baseten key)"]);
    // The Meta key does not stand in for it, and Meta calls still run.
    expect((await CALLS.spark({ fetch: fetchFn, db: ledger.db })) as object).toHaveProperty(
      "callId",
    );
  });

  it("refuses Wonder, and only Wonder, when its own cap is unset, bad or above the overall cap", async () => {
    for (const value of [undefined, "", "0", "12001", "30.5"]) {
      baseEnv();
      vi.stubEnv("AI_WONDER_CAP_CENTS", value);
      const ledger = fakeLedger();
      const fetchFn = fakeFetch(ledger.steps);
      const err = await refusal(CALLS.wonder({ fetch: fetchFn, db: ledger.db }));
      expect(err.category, String(value)).toBe("not_configured");
      expect(ledger.steps).toEqual([]);
      expect(
        ((await CALLS.spark({ fetch: fetchFn, db: ledger.db })) as { status: string }).status,
      ).toBe("ok");
    }
  });

  it("refuses every call when META_CONTRIBUTOR_MODE is anything but unset, true or false", async () => {
    for (const junk of ["", "TRUE", "1", "yes", " false"]) {
      for (const [target, call] of Object.entries(CALLS)) {
        baseEnv();
        vi.stubEnv("META_CONTRIBUTOR_MODE", junk);
        logged = [];
        const ledger = fakeLedger();
        const fetchFn = fakeFetch(ledger.steps);
        const err = await refusal(call({ fetch: fetchFn, db: ledger.db }));
        expect(err.category, `${target} ${JSON.stringify(junk)}`).toBe("not_configured");
        expect(ledger.steps).toEqual([]);
        expect(logged).toEqual([
          "ai: META_CONTRIBUTOR_MODE must be unset, true or false; every call is refused",
        ]);
      }
    }
  });

  it("refuses a malformed text request as bad_request", async () => {
    const assistant = { role: "assistant" as const, content: "Hi." };
    const replay = [{ type: "reasoning" as const, summary: [], encrypted_content: "enc" }];
    const schema = { type: "object", properties: {} };
    const user = (attachments: unknown[]) => ({
      ...REQUEST,
      messages: [{ role: "user" as const, content: "Read it.", attachments: attachments as never }],
    });
    const bad: [AiRequest, AiTextTarget][] = [
      [{ ...REQUEST, purpose: "Proof" }, "spark"],
      [{ ...REQUEST, purpose: "p" }, "spark"],
      [{ ...REQUEST, messages: [{ role: "system", content: "Only instructions." }] }, "spark"],
      [{ ...REQUEST, messages: [] }, "spark"],
      [{ ...REQUEST, maxOutputTokens: 8 }, "spark"],
      [{ ...REQUEST, maxOutputTokens: 8193 }, "spark"],
      [{ ...REQUEST, maxOutputTokens: 100.5 }, "spark"],
      [{ ...REQUEST, reasoningEffort: "none" as never }, "spark"],
      // max is a Meta setting only.
      [{ ...REQUEST, reasoningEffort: "max" }, "spark_open"],
      [{ ...REQUEST, maxCostCents: 0 }, "spark"],
      [{ ...REQUEST, timeoutMs: 60_001 }, "spark"],
      [{ ...REQUEST, traceId: "not-a-uuid" }, "spark"],
      [
        { ...REQUEST, tools: [{ name: "pay.read.all", description: "x", parameters: {} }] },
        "spark",
      ],
      [{ ...REQUEST, tools: [{ name: "pay read", description: "x", parameters: {} }] }, "spark"],
      [
        { ...REQUEST, tools: [{ name: "pay", description: "x", parameters: [] as never }] },
        "spark",
      ],
      [
        {
          ...REQUEST,
          messages: [
            ...REQUEST.messages,
            { ...assistant, toolCalls: [{ id: "", name: "pay", argumentsJson: "{}" }] },
          ],
        },
        "spark",
      ],
      [
        {
          ...REQUEST,
          messages: [...REQUEST.messages, { role: "tool", toolCallId: "", content: "x" }],
        },
        "spark",
      ],
      [{ ...REQUEST, replay }, "spark"],
      [{ ...REQUEST, messages: [...REQUEST.messages, assistant], replay }, "spark_open"],
      [
        {
          ...REQUEST,
          messages: [...REQUEST.messages, assistant],
          replay: [{ type: "message" } as never],
        },
        "spark",
      ],
      // Structured output: a bad name, a schema that is not an object.
      [{ ...REQUEST, format: { name: "bad name", schema } }, "spark"],
      [{ ...REQUEST, format: { name: "f", schema: [] as never } }, "wonder"],
      [{ ...REQUEST, format: { name: "f", schema, strict: "yes" as never } }, "spark"],
      // Attachments: a mislabeled image, an empty one, a PDF that is not one, a path as a file
      // name, nine of them, and attachments on a turn that is not the user's.
      [user([{ kind: "image", mime: "image/jpeg", bytes: PNG_BYTES }]), "spark"],
      [user([{ kind: "image", mime: "image/png", bytes: new Uint8Array() }]), "spark"],
      [user([{ kind: "image", mime: "image/tiff", bytes: PNG_BYTES }]), "spark"],
      [user([{ kind: "pdf", bytes: JPEG_BYTES }]), "spark"],
      [user([{ kind: "pdf", bytes: PDF_BYTES, filename: "../etc/passwd" }]), "spark"],
      [user([{ kind: "pdf", bytes: PDF_BYTES, filename: 'a".pdf' }]), "spark"],
      [
        user(
          Array.from({ length: 9 }, () => ({ kind: "image", mime: "image/png", bytes: PNG_BYTES })),
        ),
        "spark",
      ],
      [user([{ kind: "image", mime: "image/png", bytes: [1, 2] }]), "spark"],
      [
        {
          ...REQUEST,
          messages: [
            { role: "system", content: "x", attachments: [] } as never,
            { role: "user", content: "x" },
          ],
        },
        "spark",
      ],
      // Structured output and attachments are Meta only, for now.
      [{ ...REQUEST, format: { name: "f", schema } }, "spark_open"],
      [user([{ kind: "image", mime: "image/png", bytes: PNG_BYTES }]), "spark_open"],
      // Not a text target.
      [REQUEST, "meta" as never],
      [REQUEST, "voice" as never],
    ];
    for (const [request, target] of bad) {
      const ledger = fakeLedger();
      const fetchFn = fakeFetch(ledger.steps);
      const err = await refusal(
        complete(target, request, SESSION, { fetch: fetchFn, db: ledger.db }),
      );
      expect(err.category, `${target} ${JSON.stringify(request).slice(0, 200)}`).toBe(
        "bad_request",
      );
      expect(ledger.steps).toEqual([]);
    }
  });

  it("refuses a malformed transcription, image or segmentation request as bad_request", async () => {
    const wav = makeWav({ seconds: 2 });
    const deps = () => {
      const ledger = fakeLedger();
      return { ledger, deps: { fetch: fakeFetch(ledger.steps), db: ledger.db } };
    };
    const t = (r: object) => (d: AiDeps) =>
      transcribe({ purpose: "intake", wav, ...r } as never, SESSION, d);
    const g = (r: object) => (d: AiDeps) =>
      generateImage({ purpose: "demo_art", prompt: "a truck", ...r } as never, SESSION, d);
    const s = (r: object) => (d: AiDeps) =>
      segment(
        {
          purpose: "crop",
          image: { mime: "image/png", bytes: PNG_BYTES },
          prompt: "receipt",
          ...r,
        } as never,
        SESSION,
        d,
      );
    const cases = [
      t({ wav: makeWav({ channels: 2 }) }),
      t({ wav: makeWav({ sampleRate: 44_100 }) }),
      t({ wav: "not bytes" }),
      t({ mode: "STREAMING" }),
      t({ languageBias: ["French"] }),
      t({ languageBias: ["English", "English"] }),
      t({ keywords: Array.from({ length: 21 }, (_, i) => `k${i}`) }),
      t({ keywords: [" Dallas"] }),
      t({ keywords: ["line\nbreak"] }),
      t({ keywords: ["x".repeat(51)] }),
      g({ prompt: "" }),
      g({ prompt: "   " }),
      g({ prompt: "x".repeat(4_001) }),
      g({ n: 0 }),
      g({ n: 5 }),
      g({ size: "1024" }),
      g({ size: "1700x100" }),
      g({ size: "0x100" }),
      g({ outputFormat: "gif" }),
      g({ reasoningStrength: "medium" }),
      // SAM: a phrase only, so its box and point tokens cannot be written into the prompt.
      s({ prompt: "box;x1=1" }),
      s({ prompt: "receipt 2" }),
      s({ prompt: "two  spaces" }),
      s({ prompt: "x".repeat(41) }),
      s({ prompt: "" }),
      s({ image: { mime: "image/jpeg", bytes: PNG_BYTES } }),
      s({ image: { mime: "application/pdf", bytes: PDF_BYTES } }),
      s({ maskEncoding: "rle" }),
      s({ includeConfidence: "true" }),
    ];
    for (const [i, call] of cases.entries()) {
      const { ledger, deps: d } = deps();
      const err = await refusal(call(d));
      expect(err.category, `case ${i}`).toBe("bad_request");
      expect(ledger.steps).toEqual([]);
    }
  });

  it("refuses a call whose worst case is over its own limit", async () => {
    const ledger = fakeLedger();
    const fetchFn = fakeFetch(ledger.steps);
    // 8192 output tokens could cost 3.48 cents on Spark, 16.4 on Wonder.
    for (const [target, max] of [
      ["spark", 3],
      ["wonder", 16],
    ] as const) {
      const err = await refusal(
        complete(target, { ...REQUEST, maxOutputTokens: 8192, maxCostCents: max }, SESSION, {
          fetch: fetchFn,
          db: ledger.db,
        }),
      );
      expect(err.category, target).toBe("too_expensive");
    }
    // Four images are 4 cents.
    const err = await refusal(
      generateImage({ purpose: "demo_art", prompt: "x", n: 4, maxCostCents: 3 }, SESSION, {
        fetch: fetchFn,
        db: ledger.db,
      }),
    );
    expect(err.category).toBe("too_expensive");
    expect(ledger.steps).toEqual([]);
  });

  it("refuses at the cap with nothing written and no call made", async () => {
    const start = { spent: 12_000 * NANOCENTS_PER_CENT - 1_000_000, calls: 7 };
    const ledger = fakeLedger(start);
    const fetchFn = fakeFetch(ledger.steps);
    expect((await refusal(CALLS.spark({ fetch: fetchFn, db: ledger.db }))).category).toBe("cap");
    expect(ledger.steps).toEqual(["tx tenant", "membership", "lock counter"]);
    expect(ledger.counter).toMatchObject({ ...start, reserved: 0 });
  });

  it("refuses Wonder at its own cap while Spark still passes under the overall one", async () => {
    // Wonder has spent all but a tenth of a cent of its 30 dollars; the overall cap has room.
    const ledger = fakeLedger({
      spent: 3_000 * NANOCENTS_PER_CENT - 100_000_000,
      wonderSpent: 3_000 * NANOCENTS_PER_CENT - 100_000_000,
    });
    const fetchFn = fakeFetch(ledger.steps);
    expect((await refusal(CALLS.wonder({ fetch: fetchFn, db: ledger.db }))).category).toBe("cap");
    expect(ledger.rows.size).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
    await CALLS.spark({ fetch: fetchFn, db: ledger.db });
    expect([...ledger.rows.values()].map((r) => [r.target, r.status])).toEqual([["spark", "ok"]]);
  });

  it("refuses a login with no membership before reserving", async () => {
    const ledger = fakeLedger();
    ledger.breaks.membership = true;
    const fetchFn = fakeFetch(ledger.steps);
    await expect(CALLS.spark({ fetch: fetchFn, db: ledger.db })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(fetchFn).not.toHaveBeenCalled();
    expect(ledger.rows.size).toBe(0);
  });
});

describe("complete, one call", () => {
  it("reserves before the call, settles after, and returns the answer with its real cost", async () => {
    const ledger = fakeLedger();
    const fetchFn = fakeFetch(ledger.steps);
    const result = await complete("spark", { ...REQUEST, traceId: TRACE }, SESSION, {
      fetch: fetchFn,
      db: ledger.db,
    });

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
      priceFor("spark", "muse-spark-1.3") as TokenPrice,
      new TextEncoder().encode(String(init.body)).length,
      1024,
    );
    expect(ledger.rows.get(result.callId)).toEqual({
      target: "spark",
      model: "muse-spark-1.3",
      kind: "text",
      effort: "low",
      trace: TRACE,
      reserved,
      status: "ok",
      cost: COST,
      units: null,
    });
    expect(ledger.counter).toEqual({
      spent: COST,
      reserved: 0,
      calls: 1,
      wonderSpent: 0,
      wonderReserved: 0,
    });

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
      new RegExp(
        "^ai: spark muse-spark-1\\.3 text proof ok in=15 cached=0 out=64 reasoning=50 " +
          `cost=0\\.0291c ms=\\d+ id=resp_test1 call=${result.callId} trace=${TRACE}$`,
      ),
    );
    expect(logged.join("\n")).not.toContain(PROMPT);
    expect(logged.join("\n")).not.toContain(KEY);
  });

  it("reserves a token figure per image and per PDF page, not the base64 length", async () => {
    const ledger = fakeLedger();
    const fetchFn = fakeFetch(ledger.steps);
    const request: AiRequest = {
      ...REQUEST,
      reasoningEffort: "max",
      format: { name: "rate_con", schema: { type: "object" } },
      messages: [
        {
          role: "user",
          content: "Read these.",
          attachments: [
            { kind: "image", mime: "image/png", bytes: PNG_BYTES },
            { kind: "pdf", bytes: PDF_BYTES, filename: "rate-con.pdf" },
          ],
        },
      ],
    };
    const result = await complete("spark", request, SESSION, { fetch: fetchFn, db: ledger.db });
    const body = String(fetchFn.mock.calls[0][1].body);
    const sent = JSON.parse(body);
    expect(sent.reasoning).toEqual({ effort: "max" });
    expect(sent.text.format).toMatchObject({ type: "json_schema", name: "rate_con" });
    const dataChars =
      `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`.length +
      `data:application/pdf;base64,${Buffer.from(PDF_BYTES).toString("base64")}`.length;
    // One image (1,600) and a one-page PDF (4,000).
    const reserved = estimateReserve(
      priceFor("spark", "muse-spark-1.3") as TokenPrice,
      new TextEncoder().encode(body).length - dataChars,
      1024,
      5_600,
    );
    expect(ledger.rows.get(result.callId)).toMatchObject({ reserved, effort: "max" });
  });

  it("sends Spark to its Contributor tier in Contributor mode, records that id and charges its price", async () => {
    vi.stubEnv("META_CONTRIBUTOR_MODE", "true");
    const ledger = fakeLedger();
    const fetchFn = fakeFetch(ledger.steps);
    const result = await complete("spark", REQUEST, SESSION, { fetch: fetchFn, db: ledger.db });
    expect(JSON.parse(String(fetchFn.mock.calls[0][1].body)).model).toBe(
      "muse-spark-1.3-contributor",
    );
    expect(ledger.rows.get(result.callId)).toMatchObject({
      model: "muse-spark-1.3-contributor",
      cost: CONTRIBUTOR_COST,
    });
    expect(result.costNanocents).toBe(CONTRIBUTOR_COST);
    expect(logged[0]).toMatch(/^ai: spark muse-spark-1\.3-contributor text proof ok /);

    // Wonder has no Contributor tier: same id, same price.
    const wonder = await complete("wonder", REQUEST, SESSION, { fetch: fetchFn, db: ledger.db });
    expect(JSON.parse(String(fetchFn.mock.calls[1][1].body)).model).toBe("muse-wonder-1.0");
    expect(wonder.costNanocents).toBe(WONDER_COST);
    // Off again: Standard.
    vi.stubEnv("META_CONTRIBUTOR_MODE", "false");
    await complete("spark", REQUEST, SESSION, { fetch: fetchFn, db: ledger.db });
    expect(JSON.parse(String(fetchFn.mock.calls[2][1].body)).model).toBe("muse-spark-1.3");
  });

  it("moves Wonder's own counters with the overall ones, and only for Wonder", async () => {
    const ledger = fakeLedger();
    const fetchFn = fakeFetch(ledger.steps);
    const result = await complete("wonder", REQUEST, SESSION, { fetch: fetchFn, db: ledger.db });
    const row = ledger.rows.get(result.callId)!;
    expect(row).toMatchObject({ target: "wonder", model: "muse-wonder-1.0", status: "ok" });
    expect(row.reserved).toBeGreaterThan(1024 * 2_000_000);
    expect(ledger.counter).toEqual({
      spent: WONDER_COST,
      reserved: 0,
      calls: 1,
      wonderSpent: WONDER_COST,
      wonderReserved: 0,
    });
    await complete("spark", REQUEST, SESSION, { fetch: fetchFn, db: ledger.db });
    expect(ledger.counter).toMatchObject({ spent: WONDER_COST + COST, wonderSpent: WONDER_COST });
  });

  it("sends Spark Open to Baseten, records no reasoning setting, and charges Spark's price", async () => {
    const ledger = fakeLedger();
    const fetchFn = fakeFetch(ledger.steps);
    const result = await complete("spark_open", REQUEST, SESSION, {
      fetch: fetchFn,
      db: ledger.db,
    });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://inference.baseten.co/v1/chat/completions");
    expect(JSON.parse(String(init.body))).not.toHaveProperty("reasoning");
    expect(ledger.rows.get(result.callId)).toMatchObject({
      target: "spark_open",
      model: "meta-models/muse-spark-open-1026",
      effort: null,
      status: "ok",
    });
    expect(result).toMatchObject({ text: "triage: load", costNanocents: COST });
  });

  it("returns an out-of-budget answer as incomplete, charged from its usage", async () => {
    const ledger = fakeLedger();
    const fetchFn = fakeFetch(ledger.steps, () => Response.json(metaAnswer("incomplete")));
    const result = await complete("spark", REQUEST, SESSION, { fetch: fetchFn, db: ledger.db });
    expect(result).toMatchObject({ status: "incomplete", text: "", costNanocents: COST });
    expect(ledger.rows.get(result.callId)?.status).toBe("incomplete");
    expect(ledger.counter).toMatchObject({ spent: COST, reserved: 0, calls: 1 });
  });

  it("releases the reservation of a refused call and spends nothing, once, without retrying", async () => {
    for (const [status, category] of [
      [429, "rate_limited"],
      [402, "billing"],
      [400, "bad_request"],
      [413, "too_long"],
    ] as const) {
      for (const target of ["spark", "wonder"] as const) {
        const ledger = fakeLedger();
        logged = [];
        const fetchFn = fakeFetch(ledger.steps, () =>
          Response.json({ error: { message: PROMPT } }, { status }),
        );
        const err = await refusal(
          complete(target, REQUEST, SESSION, { fetch: fetchFn, db: ledger.db }),
        );
        expect(err.category).toBe(category);
        expect(err.httpStatus).toBe(status);
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect([...ledger.rows.values()].map((r) => r.status)).toEqual(["failed"]);
        // Both reservations released.
        expect(ledger.counter).toEqual({
          spent: 0,
          reserved: 0,
          calls: 1,
          wonderSpent: 0,
          wonderReserved: 0,
        });
        expect(logged).toHaveLength(1);
        expect(logged[0]).toMatch(
          new RegExp(`^ai: ${target} muse-\\S+ text proof failed ${category} http=${status} `),
        );
        expect(logged[0]).not.toContain("reservation kept");
        expect(logged.join("\n")).not.toContain(PROMPT);
      }
    }
  });

  it("keeps the reservation counted when the outcome is unknown, Wonder's too", async () => {
    const answers: [() => Response, string][] = [
      [
        () => {
          throw new TypeError("fetch failed");
        },
        "network",
      ],
      [() => new Response("oops", { status: 500 }), "unavailable"],
      [() => Response.json({ status: "completed" }), "unknown"],
    ];
    for (const [answer, category] of answers) {
      const ledger = fakeLedger();
      logged = [];
      const fetchFn = fakeFetch(ledger.steps, answer);
      const err = await refusal(
        complete("wonder", REQUEST, SESSION, { fetch: fetchFn, db: ledger.db }),
      );
      expect(err.category).toBe(category);
      const [row] = [...ledger.rows.values()];
      expect(row.status).toBe("unknown");
      expect(ledger.counter).toEqual({
        spent: 0,
        reserved: row.reserved,
        calls: 1,
        wonderSpent: 0,
        wonderReserved: row.reserved,
      });
      expect(logged[0]).toContain(`unknown ${category}`);
      expect(logged[0]).toContain("reservation kept");
    }
  });

  it("leaves a timed-out call reserved and unsettled, its reservation counted", async () => {
    const timeouts: (() => Response)[] = [
      () => {
        throw new DOMException("timed out", "TimeoutError");
      },
      () => new Response("gateway", { status: 504 }),
    ];
    for (const answer of timeouts) {
      const ledger = fakeLedger();
      logged = [];
      const fetchFn = fakeFetch(ledger.steps, answer);
      const err = await refusal(CALLS.spark({ fetch: fetchFn, db: ledger.db }));
      expect(err.category).toBe("timeout");
      const [row] = [...ledger.rows.values()];
      expect(row.status).toBe("reserved");
      // No settle ran: the steps end at the call.
      expect(ledger.steps.at(-1)).toBe("fetch");
      expect(ledger.counter).toMatchObject({ spent: 0, reserved: row.reserved, calls: 0 });
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain("unknown timeout");
      expect(logged[0]).toContain("row left reserved, reservation kept");
    }
  });

  it("never returns an answer the ledger could not record", async () => {
    for (const broken of ["settleThrows", "rowLost"] as const) {
      const ledger = fakeLedger();
      ledger.breaks[broken] = true;
      logged = [];
      const fetchFn = fakeFetch(ledger.steps);
      const err = await refusal(CALLS.spark({ fetch: fetchFn, db: ledger.db }));
      expect(err.category).toBe("unknown");
      const [row] = [...ledger.rows.values()];
      expect(row.status).toBe("reserved");
      expect(ledger.counter).toMatchObject({ spent: 0, reserved: row.reserved, calls: 0 });
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

describe("transcribe, generateImage and segment, one call each", () => {
  it("transcribes a WAV: two parts, JSON accepted, reserved by its length, charged by whole seconds", async () => {
    const ledger = fakeLedger();
    const fetchFn = fakeFetch(ledger.steps);
    const wav = makeWav({ seconds: 2.18 });
    const result = await transcribe(
      {
        purpose: "intake",
        wav,
        languageBias: ["English", "Spanish"],
        keywords: ["Dallas"],
        traceId: TRACE,
      },
      SESSION,
      { fetch: fetchFn, db: ledger.db },
    );
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.meta.ai/v1/asr/transcribe");
    expect(init.headers).toEqual({ authorization: `Bearer ${KEY}`, accept: "application/json" });
    const form = init.body as FormData;
    expect([...form.keys()]).toEqual(["request", "audio"]);
    expect(JSON.parse(await (form.get("request") as Blob).text())).toEqual({
      model: "muse-voice-transcribe-1.0",
      audioEncoding: "WAV",
      mode: "PUSH_TO_TALK",
      languageBias: ["English", "Spanish"],
      keywords: ["Dallas"],
    });
    expect((form.get("audio") as Blob).size).toBe(wav.length);
    // 2.18 s reserves 4 s; the answer's 2,240 ms is metered as 2 s, 0.01 cent.
    expect(ledger.rows.get(result.callId)).toEqual({
      target: "voice",
      model: "muse-voice-transcribe-1.0",
      kind: "transcribe",
      effort: null,
      trace: TRACE,
      reserved: audioReserve(VOICE_NANOCENTS_PER_SECOND, 34_880, 16_000),
      status: "ok",
      cost: 10_000_000,
      units: 2,
    });
    expect(result).toEqual({
      callId: result.callId,
      transcript: " load 421 delivered in Dallas.",
      turns: [],
      audioDurationMs: 2240,
      costNanocents: 10_000_000,
    });
    expect(logged[0]).toMatch(
      /^ai: voice muse-voice-transcribe-1\.0 transcribe intake ok units=2 cost=0\.0100c ms=\d+ id=asr\/1:abc call=/,
    );
    expect(logged[0]).not.toContain("Dallas");
  });

  it("generates images: base64 only, reserved per image asked, charged per image returned", async () => {
    const ledger = fakeLedger();
    const fetchFn = fakeFetch(ledger.steps);
    const result = await generateImage(
      { purpose: "demo_art", prompt: "a flatbed at dusk", n: 2 },
      SESSION,
      {
        fetch: fetchFn,
        db: ledger.db,
      },
    );
    const sent = JSON.parse(String(fetchFn.mock.calls[0][1].body));
    expect(sent).toEqual({
      model: "muse-image-1.0",
      prompt: "a flatbed at dusk",
      n: 2,
      response_format: "b64_json",
      output_format: "png",
      reasoning_strength: "high",
    });
    // Two asked, one returned: one cent.
    expect(ledger.rows.get(result.callId)).toMatchObject({
      target: "image",
      kind: "image",
      reserved: 2 * NANOCENTS_PER_CENT,
      cost: NANOCENTS_PER_CENT,
      units: 1,
    });
    expect(result.images).toEqual([{ bytes: new Uint8Array(PNG_BYTES), mime: "image/png" }]);
    expect(ledger.counter).toMatchObject({ spent: NANOCENTS_PER_CENT, reserved: 0 });
    expect(logged.join("\n")).not.toContain("flatbed");
  });

  it("segments an image: one image charged, boxes and masks returned", async () => {
    const ledger = fakeLedger();
    const fetchFn = fakeFetch(ledger.steps, samAnswer);
    const result = await segment(
      { purpose: "crop", image: { mime: "image/png", bytes: PNG_BYTES }, prompt: "paper document" },
      SESSION,
      { fetch: fetchFn, db: ledger.db },
    );
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.meta.ai/v1/responses");
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "sam-3.1",
      metadata: { mask_encoding: "lossless", include_confidence: "true" },
      store: false,
    });
    expect(ledger.rows.get(result.callId)).toMatchObject({
      target: "sam",
      kind: "segment",
      reserved: 250_000_000,
      cost: 250_000_000,
      units: 1,
    });
    expect(result).toEqual({
      callId: result.callId,
      imageWidth: 400,
      imageHeight: 300,
      matches: [
        {
          box: { x1: 120, y1: 50, x2: 279, y2: 259 },
          confidence: 0.58,
          mask: { x: 0, y: 0, height: 210, width: 160, encoding: "lossless", payload: "ab=c" },
        },
      ],
      costNanocents: 250_000_000,
    });
  });

  it("keeps the reservation when a segmentation answer cannot be read", async () => {
    const ledger = fakeLedger();
    const fetchFn = fakeFetch(ledger.steps, () =>
      Response.json({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "a cat" }] }],
      }),
    );
    expect((await refusal(CALLS.sam({ fetch: fetchFn, db: ledger.db }))).category).toBe("unknown");
    const [row] = [...ledger.rows.values()];
    expect(row.status).toBe("unknown");
    expect(ledger.counter).toMatchObject({ spent: 0, reserved: 250_000_000, calls: 1 });
  });
});

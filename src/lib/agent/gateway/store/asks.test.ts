import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../../auth/claims";
import { DbError, type Param, type Queryable, type TenantDb } from "../../../db";
import { dbTurnStore, readAgentThread } from ".";
import type { PersistInput } from "./types";

// The gateway store's two touches on the agent's questions, over fakes: a plain throw while
// writing the desk's question (a zone Intl cannot read) costs only the question and the proposal
// stays; a database error still goes up, since its transaction is already aborted. The thread's
// turn lookup reads only the carrier's own turns, as every other read does.

const mocks = vi.hoisted(() => ({
  askFor: vi.fn(),
  persistProposal: vi.fn(),
  readRecentTurnViews: vi.fn(),
}));

vi.mock("../tenant", () => ({
  withAgentTenant: async <T,>(db: TenantDb, s: Session, fn: (q: Queryable) => Promise<T>) => db.withTenant(s.tenantId, fn),
}));
vi.mock("./proposals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./proposals")>()),
  persistProposal: mocks.persistProposal,
  findProposalConflict: async () => null,
}));
vi.mock("./views", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./views")>()),
  readRecentTurnViews: mocks.readRecentTurnViews,
}));
vi.mock("../../../asks/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../asks/store")>()),
  askFor: mocks.askFor,
  asksForSession: () => true,
  readShowingAsks: async () => ({ asks: [], openCount: 0 }),
}));

const TENANT = "33333333-3333-4333-8333-333333333333";
const PROPOSAL = "44444444-4444-4444-8444-444444444444";
const TURN = "55555555-5555-4555-8555-555555555555";
const SESSION: Session = { sub: `service:sweep:${TENANT}`, email: "", tenantId: TENANT };
const INPUT = { turnId: TURN, conversationId: TURN, traceId: TURN } as unknown as PersistInput;

function fakeDb() {
  const reads: string[] = [];
  const q: Queryable = {
    async query<T>(sql: string, _params?: Param[]): Promise<T[]> {
      reads.push(sql);
      return [] as T[];
    },
    async execute(): Promise<number> {
      return 1;
    },
  };
  const db: TenantDb = { withTenant: async (_t, fn) => fn(q) };
  return { db, reads };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.persistProposal.mockResolvedValue({ kind: "created", proposalId: PROPOSAL, flagged: false });
});
afterEach(() => {
  warn.mockRestore();
  vi.clearAllMocks();
});

describe("dbTurnStore.persistProposal and the desk's question", () => {
  it("keeps the proposal when writing its question throws a plain error, and logs the name only", async () => {
    mocks.askFor.mockRejectedValue(new RangeError("Invalid time zone specified: Not/AZone"));
    const { db } = fakeDb();
    expect(await dbTurnStore(SESSION, { db }).persistProposal(INPUT)).toEqual({
      kind: "created",
      proposalId: PROPOSAL,
      flagged: false,
    });
    expect(mocks.askFor).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("gateway: the question could not be written:", "RangeError");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Not/AZone");
  });

  it("lets a database error from the question go up", async () => {
    mocks.askFor.mockRejectedValue(new DbError("sql", "40001"));
    const { db } = fakeDb();
    await expect(dbTurnStore(SESSION, { db }).persistProposal(INPUT)).rejects.toBeInstanceOf(DbError);
  });
});

describe("readAgentThread", () => {
  it("reads the turns' start times only within the carrier", async () => {
    mocks.readRecentTurnViews.mockResolvedValue([{ id: TURN }]);
    const { db, reads } = fakeDb();
    await readAgentThread(SESSION, { db });
    const lookup = reads.find((sql) => sql.includes("FROM turns"));
    expect(lookup).toBeDefined();
    expect(lookup).toContain("tenant_id = current_tenant_id()");
  });
});

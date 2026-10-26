import {
  BeginTransactionCommand,
  CommitTransactionCommand,
  ExecuteStatementCommand,
  RollbackTransactionCommand,
  type RDSDataClient,
} from "@aws-sdk/client-rds-data";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { BEGIN_ATTEMPTS, BEGIN_DELAY_MS, createDataApiDb } from "./data-api";
import { DbError, type Queryable } from "./types";

const TENANT = "3f6c1a52-8e0b-4f4e-9d7a-2b5c8e1f0a93";
const CONFIG = {
  clusterArn: "arn:aws:rds:us-east-2:000000000000:cluster:test",
  secretArn: "arn:aws:secretsmanager:us-east-2:000000000000:secret:test",
  database: "payday",
  region: "us-east-2",
};

type Sent = { name: string; input: Record<string, unknown> };

function sdkError(name: string, message = "upstream detail with personal data") {
  return Object.assign(new Error(message), { name });
}

// A stand-in client: records every command and answers from a per-command script.
function fakeClient(answer: (cmd: Sent) => unknown) {
  const sent: Sent[] = [];
  const client = {
    send: vi.fn(async (command: { constructor: { name: string }; input: object }) => {
      const cmd = { name: command.constructor.name, input: command.input as Record<string, unknown> };
      sent.push(cmd);
      const out = answer(cmd);
      if (out instanceof Error) throw out;
      return out;
    }),
    destroy: vi.fn(),
  };
  return { client: client as unknown as RDSDataClient, sent, destroy: client.destroy };
}

const ok = (cmd: Sent) => {
  if (cmd.name === BeginTransactionCommand.name) return { transactionId: "tx-1" };
  if (cmd.name === ExecuteStatementCommand.name) {
    return { formattedRecords: JSON.stringify([{ ok: 1 }]), numberOfRecordsUpdated: 1 };
  }
  return {};
};

describe("createDataApiDb", () => {
  let logged: MockInstance<typeof console.error>;

  beforeEach(() => {
    logged = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => logged.mockRestore());

  it("sets the tenant first, inside the transaction, then commits", async () => {
    const { client, sent } = fakeClient(ok);
    const db = createDataApiDb(CONFIG, { client });
    const rows = await db.withTenant(TENANT, (q) => q.query("SELECT 1 AS ok"));
    expect(rows).toEqual([{ ok: 1 }]);
    expect(sent.map((c) => c.name)).toEqual([
      BeginTransactionCommand.name,
      ExecuteStatementCommand.name,
      ExecuteStatementCommand.name,
      CommitTransactionCommand.name,
    ]);
    expect(sent[1].input).toMatchObject({
      sql: "SELECT set_config('app.tenant_id', :p1, true)",
      parameters: [{ name: "p1", value: { stringValue: TENANT } }],
      transactionId: "tx-1",
      formatRecordsAs: "JSON",
      database: "payday",
    });
    expect(sent[2].input).toMatchObject({ sql: "SELECT 1 AS ok", transactionId: "tx-1" });
  });

  it("sends SQL without parameters exactly as written", async () => {
    const { client, sent } = fakeClient(ok);
    const db = createDataApiDb(CONFIG, { client });
    const body = "DO $$ BEGIN PERFORM $1; END $$";
    await db.withoutTenant((q) => q.execute(body));
    expect(sent[1].input.sql).toBe(body);
    expect(sent[1].input.parameters).toBeUndefined();
  });

  it("refuses a tenant id that is not a UUID before calling AWS", async () => {
    const { client, sent } = fakeClient(ok);
    const db = createDataApiDb(CONFIG, { client });
    await expect(db.withTenant("blue-ridge", async () => 1)).rejects.toThrow(/not a UUID/);
    expect(sent).toHaveLength(0);
  });

  it("waits for a paused cluster to resume, only at BeginTransaction", async () => {
    let begins = 0;
    const { client } = fakeClient((cmd) => {
      if (cmd.name === BeginTransactionCommand.name && ++begins < 3) {
        return sdkError("DatabaseResumingException");
      }
      return ok(cmd);
    });
    const sleep = vi.fn(async () => {});
    const db = createDataApiDb(CONFIG, { client, sleep });
    await db.withTenant(TENANT, (q) => q.execute("SELECT 1"));
    expect(begins).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(BEGIN_DELAY_MS);
  });

  it("gives up after the last attempt with a resuming error", async () => {
    const { client, sent } = fakeClient(() => sdkError("DatabaseResumingException"));
    const sleep = vi.fn(async () => {});
    const db = createDataApiDb(CONFIG, { client, sleep });
    const err = await db.withTenant(TENANT, async () => 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbError);
    expect((err as DbError).category).toBe("resuming");
    expect(sent).toHaveLength(BEGIN_ATTEMPTS);
    expect(sleep).toHaveBeenCalledTimes(BEGIN_ATTEMPTS - 1);
  });

  it("does not retry a begin that failed for any other reason", async () => {
    const { client, sent } = fakeClient(() => sdkError("ForbiddenException"));
    const db = createDataApiDb(CONFIG, { client, sleep: async () => {} });
    await expect(db.withTenant(TENANT, async () => 1)).rejects.toMatchObject({
      category: "unknown",
    });
    expect(sent).toHaveLength(1);
  });

  it("rolls back and rethrows when the work fails, and never retries it", async () => {
    const { client, sent } = fakeClient(ok);
    const db = createDataApiDb(CONFIG, { client });
    const boom = new Error("work failed");
    await expect(db.withTenant(TENANT, async () => Promise.reject(boom))).rejects.toBe(boom);
    expect(sent.map((c) => c.name)).toEqual([
      BeginTransactionCommand.name,
      ExecuteStatementCommand.name,
      RollbackTransactionCommand.name,
    ]);
  });

  it("keeps the original error when the rollback also fails", async () => {
    const { client } = fakeClient((cmd) =>
      cmd.name === RollbackTransactionCommand.name ? sdkError("TransactionNotFoundException") : ok(cmd),
    );
    const db = createDataApiDb(CONFIG, { client });
    const boom = new Error("work failed");
    await expect(db.withTenant(TENANT, async () => Promise.reject(boom))).rejects.toBe(boom);
  });

  // The commit may have landed before the reply was lost, so neither looks retryable.
  it.each(["TimeoutError", "ServiceUnavailableError"])(
    "reports a commit that failed with %s as unknown, then rolls back",
    async (name) => {
      const { client, sent } = fakeClient((cmd) =>
        cmd.name === CommitTransactionCommand.name ? sdkError(name) : ok(cmd),
      );
      const db = createDataApiDb(CONFIG, { client });
      const err = await db.withTenant(TENANT, (q) => q.execute("SELECT 1")).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DbError);
      expect(err).toMatchObject({ category: "unknown", sqlState: undefined });
      expect(sent.map((c) => c.name)).toEqual([
        BeginTransactionCommand.name,
        ExecuteStatementCommand.name,
        ExecuteStatementCommand.name,
        CommitTransactionCommand.name,
        RollbackTransactionCommand.name,
      ]);
    },
  );

  it("keeps the SQLSTATE of a commit that failed, still as unknown", async () => {
    const { client } = fakeClient((cmd) =>
      cmd.name === CommitTransactionCommand.name
        ? sdkError("DatabaseErrorException", "ERROR: could not serialize access; SQLState: 40001")
        : ok(cmd),
    );
    const db = createDataApiDb(CONFIG, { client });
    const err = await db.withoutTenant((q) => q.execute("SELECT 1")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbError);
    expect(err).toMatchObject({ category: "unknown", sqlState: "40001" });
  });

  it("turns a SQL error into its SQLSTATE category and logs no upstream text", async () => {
    const { client } = fakeClient((cmd) =>
      cmd.name === ExecuteStatementCommand.name && cmd.input.sql === "INSERT x"
        ? sdkError(
            "DatabaseErrorException",
            'ERROR: new row violates row-level security policy for "ops@carrier.example"; SQLState: 42501',
          )
        : ok(cmd),
    );
    const db = createDataApiDb(CONFIG, { client });
    const err = await db.withTenant(TENANT, (q) => q.execute("INSERT x")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbError);
    expect(err).toMatchObject({ category: "rls_denied", sqlState: "42501" });
    expect((err as Error).message).toBe("database error: rls_denied (42501)");
    const lines = logged.mock.calls.map((args) => args.join(" "));
    expect(lines).toContain("db: rls_denied (DatabaseErrorException 42501)");
    expect(lines.join("\n")).not.toMatch(/carrier\.example|row-level/);
  });

  it("refuses a handle kept past its transaction and sends nothing", async () => {
    const { client, sent } = fakeClient(ok);
    const db = createDataApiDb(CONFIG, { client });
    const kept: Queryable[] = [];
    await db.withTenant(TENANT, async (q) => {
      kept.push(q);
      return q.query("SELECT 1 AS ok");
    });
    await expect(
      db.withTenant(TENANT, async (q) => {
        kept.push(q);
        throw new Error("work failed");
      }),
    ).rejects.toThrow("work failed");
    const before = sent.length;
    for (const q of kept) {
      await expect(q.query("SELECT 1 AS ok")).rejects.toMatchObject({ category: "sql" });
      await expect(q.execute("DELETE FROM t")).rejects.toBeInstanceOf(DbError);
    }
    expect(sent).toHaveLength(before);
  });

  it("closes the client", async () => {
    const { client, destroy } = fakeClient(ok);
    await createDataApiDb(CONFIG, { client }).close();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

import {
  parseDocumentsRead,
  parseHistoryRead,
  parseLineItemsRead,
  parseListPage,
  parseLoadRead,
  parsePartyRead,
  parseReady,
} from "./schema";
import { createMockSource } from "./mock";
import { createSyntheticSource } from "./synthetic";
import { TmsSourceError, type TmsConnection, type TmsSource } from "./types";

// TMS-MIRROR: the one way our code gets a TMS source. Every answer is validated (schema.ts)
// before it is returned, a read by id must answer for that id, and anything that is not a
// TmsSourceError becomes server_error (the cause stays in the source's own log line). A system we
// have no adapter for is refused outright, like a production key at startup.

const MAX_PAGE = 500;

async function categorized<T>(fn: () => Promise<unknown>, parse: (v: unknown) => T): Promise<T> {
  let raw: unknown;
  try {
    raw = await fn();
  } catch (err) {
    if (err instanceof TmsSourceError) throw err;
    throw new TmsSourceError("server_error");
  }
  return parse(raw);
}

function sameId<T extends { kind: string }>(read: T, externalId: string, idOf: (v: T) => string | null): T {
  if (read.kind === "ok" && idOf(read) !== externalId) throw new TmsSourceError("malformed");
  return read;
}

export function validated(inner: TmsSource): TmsSource {
  return {
    system: inner.system,
    ready: (ctx) => categorized(() => inner.ready(ctx), parseReady),
    listLoads: (ctx, below, limit) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new RangeError("page size out of range");
      return categorized(() => inner.listLoads(ctx, below, limit), (v) => {
        const page = parseListPage(v);
        if (page.rows.length > limit) throw new TmsSourceError("malformed");
        return page;
      });
    },
    readLoad: async (ctx, id) =>
      sameId(await categorized(() => inner.readLoad(ctx, id), parseLoadRead), id, (r) => (r.kind === "ok" ? r.value.externalId : null)),
    readHistory: (ctx, id, page) => {
      if (!Number.isSafeInteger(page) || page < 0) throw new RangeError("page out of range");
      return categorized(() => inner.readHistory(ctx, id, page), parseHistoryRead);
    },
    readDocuments: (ctx, id) => categorized(() => inner.readDocuments(ctx, id), parseDocumentsRead),
    readLineItems: (ctx, id) => categorized(() => inner.readLineItems(ctx, id), parseLineItemsRead),
    readParty: async (ctx, kind, id) =>
      sameId(await categorized(() => inner.readParty(ctx, kind, id), parsePartyRead), id, (r) =>
        r.kind === "ok" && r.value.partyKind === kind ? r.value.externalId : null,
      ),
  };
}

export function tmsSource(connection: Pick<TmsConnection, "system">): TmsSource {
  if (connection.system === "synthetic") return validated(createSyntheticSource());
  if (connection.system === "mock") return validated(createMockSource());
  throw new Error("no adapter for this TMS system");
}

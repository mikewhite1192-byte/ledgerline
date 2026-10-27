import { describe, expect, it } from "vitest";
import { MoneyError } from "../../../money/types";
import {
  ACCOUNT_ROLES,
  ACCOUNT_SPECS,
  accountForPayLine,
  ITEM_NAMES,
  quoteQueryValue,
  resolveMapping,
  type MappingPort,
} from "./mapping";

// A company in memory: names to ids, with the query and create calls recorded.
function company(existing: Record<string, string[]> = {}, opts: { duplicateOn?: string; raceId?: string } = {}) {
  const found = new Map(Object.entries(existing));
  const queries: string[] = [];
  const created: Record<string, unknown>[] = [];
  let next = 500;
  const port: MappingPort = {
    async findIds(entity, where) {
      queries.push(`${entity}: ${where}`);
      return found.get(`${entity}: ${where}`) ?? [];
    },
    async create(entity, body) {
      created.push(body);
      const where =
        `Name = ${quoteQueryValue(String(body.Name))} AND Active = true`;
      if (opts.duplicateOn === body.Name) {
        if (opts.raceId) found.set(`${entity}: ${where}`, [opts.raceId]);
        throw new MoneyError("duplicate");
      }
      next += 1;
      found.set(`${entity}: ${where}`, [String(next)]);
      return String(next);
    },
  };
  return { port, queries, created };
}

const arAp = {
  "Account: AccountType = 'Accounts Receivable' AND Active = true": ["8"],
  "Account: AccountType = 'Accounts Payable' AND Active = true": ["9"],
};

describe("QuickBooks account and item mapping", () => {
  it("escapes a quote with a backslash and refuses a backslash or control character", () => {
    expect(quoteQueryValue("O'Brien")).toBe("'O\\'Brien'");
    for (const bad of ["a\\b", "a\nb", "a\u007fb"]) {
      expect(() => quoteQueryValue(bad)).toThrow(MoneyError);
    }
  });

  it("creates the missing accounts and items, finds the receivable and payable accounts by type", async () => {
    const c = company(arAp);
    const out = await resolveMapping(c.port);
    expect(Object.keys(out.accounts).sort()).toEqual([...ACCOUNT_ROLES].sort());
    expect(out.accounts.accounts_receivable).toBe("8");
    expect(out.accounts.accounts_payable).toBe("9");
    expect(Object.keys(out.items)).toEqual([...ITEM_NAMES]);
    // Seven named accounts and six items created, items on the freight income account.
    expect(c.created).toHaveLength(13);
    expect(c.created[0]).toEqual({
      Name: "LedgerLine Freight Income",
      AccountType: "Income",
      AccountSubType: "ServiceFeeIncome",
    });
    expect(c.created[7]).toEqual({
      Name: "Freight",
      Type: "Service",
      IncomeAccountRef: { value: out.accounts.freight_income },
    });
    // A second connect finds everything and creates nothing.
    const again = await resolveMapping(c.port);
    expect(again).toEqual(out);
    expect(c.created).toHaveLength(13);
  });

  it("refuses a company with two receivable accounts or two active records of one name", async () => {
    await expect(
      resolveMapping(
        company({ ...arAp, "Account: AccountType = 'Accounts Receivable' AND Active = true": ["8", "18"] }).port,
      ),
    ).rejects.toMatchObject({ category: "not_configured" });
    const name = `Account: Name = '${ACCOUNT_SPECS.driver_pay.find === "name" ? ACCOUNT_SPECS.driver_pay.name : ""}' AND Active = true`;
    await expect(resolveMapping(company({ ...arAp, [name]: ["3", "4"] }).port)).rejects.toMatchObject({
      category: "not_configured",
    });
  });

  it("looks once more after a duplicate name: adopts a record made meanwhile, refuses an inactive one", async () => {
    const raced = company(arAp, { duplicateOn: "Stop", raceId: "777" });
    expect((await resolveMapping(raced.port)).items.Stop).toBe("777");
    const inactive = company(arAp, { duplicateOn: "Stop" });
    await expect(resolveMapping(inactive.port)).rejects.toMatchObject({ category: "not_configured" });
  });

  it("maps every settlement line kind to an account and refuses an unknown one", () => {
    expect(accountForPayLine("load_pay")).toBe("driver_pay");
    expect(accountForPayLine("advance_recovery")).toBe("driver_advances");
    expect(() => accountForPayLine("toString")).toThrow(MoneyError);
    expect(() => accountForPayLine("bonus")).toThrow(MoneyError);
  });
});

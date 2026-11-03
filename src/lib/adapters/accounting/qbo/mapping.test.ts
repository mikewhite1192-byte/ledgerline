import { describe, expect, it } from "vitest";
import { MoneyError } from "../../../money/types";
import {
  ACCOUNT_ROLES,
  ACCOUNT_SPECS,
  accountForPayLine,
  findWhere,
  ITEM_NAMES,
  quoteQueryValue,
  resolveMapping,
  type MappingPort,
} from "./mapping";

// A company in memory: names to ids, with the query and create calls recorded. An account is
// found by its name and type, an item by its name, as resolveMapping queries them.
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
      const where = findWhere(
        String(body.Name),
        entity === "Account" ? String(body.AccountType) : undefined,
      );
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
    const spec = ACCOUNT_SPECS.driver_pay;
    const name = `Account: Name = '${spec.find === "name" ? spec.name : ""}' AND AccountType = 'Expense' AND Active = true`;
    await expect(resolveMapping(company({ ...arAp, [name]: ["3", "4"] }).port)).rejects.toMatchObject({
      category: "not_configured",
    });
  });

  it("looks once more after a duplicate name: adopts a record made meanwhile, refuses a name held where the query does not match", async () => {
    const raced = company(arAp, { duplicateOn: "Stop", raceId: "777" });
    expect((await resolveMapping(raced.port)).items.Stop).toBe("777");
    const held = company(arAp, { duplicateOn: "Stop" });
    await expect(resolveMapping(held.port)).rejects.toMatchObject({ category: "not_configured" });
  });

  it("files driver chargebacks under Other Income and finds every named account by its type too", async () => {
    const c = company(arAp);
    const out = await resolveMapping(c.port);
    const spec = ACCOUNT_SPECS.driver_chargebacks;
    expect(spec).toMatchObject({ accountType: "Other Income", accountSubType: "OtherMiscellaneousIncome" });
    const name = spec.find === "name" ? spec.name : "";
    expect(c.created).toContainEqual({
      Name: name,
      AccountType: "Other Income",
      AccountSubType: "OtherMiscellaneousIncome",
    });
    expect(c.queries).toContain(
      `Account: Name = ${quoteQueryValue(name)} AND AccountType = 'Other Income' AND Active = true`,
    );
    // Items have no account type: found by name alone.
    expect(c.queries).toContain("Item: Name = 'Freight' AND Active = true");
    // A same-name account of another type is not ours: the create is refused and nothing is guessed.
    const other = company(
      { ...arAp, [`Account: Name = ${quoteQueryValue(name)} AND AccountType = 'Income' AND Active = true`]: ["44"] },
      { duplicateOn: name },
    );
    await expect(resolveMapping(other.port)).rejects.toMatchObject({ category: "not_configured" });
    expect(out.accounts.driver_chargebacks).toMatch(/^\d+$/);
  });

  it("maps every settlement line kind to an account and refuses an unknown one", () => {
    expect(accountForPayLine("load_pay")).toBe("driver_pay");
    expect(accountForPayLine("advance_recovery")).toBe("driver_advances");
    expect(accountForPayLine("deficit_recovery")).toBe("driver_chargebacks");
    expect(() => accountForPayLine("toString")).toThrow(MoneyError);
    expect(() => accountForPayLine("bonus")).toThrow(MoneyError);
  });
});

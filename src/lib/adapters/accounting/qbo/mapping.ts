import { MoneyError } from "../../../money/types";

// Which of the company's accounts and items each kind of post uses, found at connect by name (and
// an account by its type too; no ids in code) and created when missing. The names carry
// "LedgerLine" so they never collide with the company's own accounts. Accounts Receivable and
// Accounts Payable are the company's own, found by type. The resolved maps hold ids only; a
// reconnect resolves them again.

export const ACCOUNT_ROLES = [
  "freight_income",
  "driver_pay",
  "driver_reimbursements",
  "driver_advances",
  "driver_escrow",
  "driver_chargebacks",
  "ledgerline_clearing",
  "accounts_receivable",
  "accounts_payable",
] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];
export type AccountMap = Record<AccountRole, string>;

type AccountSpec =
  | { find: "name"; name: string; accountType: string; accountSubType: string }
  | { find: "type"; accountType: string };

export const ACCOUNT_SPECS: Record<AccountRole, AccountSpec> = {
  freight_income: {
    find: "name",
    name: "LedgerLine Freight Income",
    accountType: "Income",
    accountSubType: "ServiceFeeIncome",
  },
  driver_pay: {
    find: "name",
    name: "LedgerLine Driver Pay",
    accountType: "Expense",
    accountSubType: "CostOfLabor",
  },
  driver_reimbursements: {
    find: "name",
    name: "LedgerLine Driver Reimbursements",
    accountType: "Expense",
    accountSubType: "OtherMiscellaneousServiceCost",
  },
  driver_advances: {
    find: "name",
    name: "LedgerLine Driver Advances",
    accountType: "Other Current Asset",
    accountSubType: "EmployeeCashAdvances",
  },
  driver_escrow: {
    find: "name",
    name: "LedgerLine Driver Escrow",
    accountType: "Other Current Liability",
    accountSubType: "OtherCurrentLiabilities",
  },
  // Fuel, insurance, lease and other deductions recovered from drivers. QuickBooks files this
  // subtype under "Other Income" and refuses it under "Income" (code 2170, measured 2026-10-27).
  driver_chargebacks: {
    find: "name",
    name: "LedgerLine Driver Chargebacks",
    accountType: "Other Income",
    accountSubType: "OtherMiscellaneousIncome",
  },
  // Payouts are drawn from it and customer payments deposited to it, so no bank account of the
  // company is assumed.
  ledgerline_clearing: {
    find: "name",
    name: "LedgerLine Clearing",
    accountType: "Bank",
    accountSubType: "Checking",
  },
  accounts_receivable: { find: "type", accountType: "Accounts Receivable" },
  accounts_payable: { find: "type", accountType: "Accounts Payable" },
};

// Invoice line items, Service items on the freight income account, by the rules engine's invoice
// line kind.
export const ITEM_NAMES = [
  "Freight",
  "Fuel Surcharge",
  "Detention",
  "Layover",
  "Stop",
  "Lumper",
] as const;
export type ItemName = (typeof ITEM_NAMES)[number];
export type ItemMap = Record<ItemName, string>;

export const INVOICE_LINE_KINDS = [
  "linehaul",
  "fuel_surcharge",
  "detention",
  "layover",
  "stop",
  "lumper",
] as const;
export type InvoiceLineKind = (typeof INVOICE_LINE_KINDS)[number];

export const ITEM_FOR_LINE: Record<InvoiceLineKind, ItemName> = {
  linehaul: "Freight",
  fuel_surcharge: "Fuel Surcharge",
  detention: "Detention",
  layover: "Layover",
  stop: "Stop",
  lumper: "Lumper",
};

// A settlement line's account, by the rules engine's line kind. Earnings are positive lines,
// deductions negative ones, so the bill's total is the net pay.
export const ACCOUNT_FOR_PAY_LINE: Record<string, AccountRole> = {
  load_pay: "driver_pay",
  accessorial_pay: "driver_pay",
  reimbursement: "driver_reimbursements",
  advance_recovery: "driver_advances",
  escrow: "driver_escrow",
  fuel: "driver_chargebacks",
  other_deduction: "driver_chargebacks",
  carried_shortfall: "driver_chargebacks",
  lease: "driver_chargebacks",
  insurance: "driver_chargebacks",
};

export function accountForPayLine(kind: string): AccountRole {
  if (!Object.prototype.hasOwnProperty.call(ACCOUNT_FOR_PAY_LINE, kind)) {
    throw new MoneyError("validation");
  }
  return ACCOUNT_FOR_PAY_LINE[kind];
}

// What resolving needs from the company: a query and a create, each answering the found records'
// ids. Supplied by the client so this file stays free of HTTP. create throws
// MoneyError("duplicate") when the company already has that name (Intuit code 6240).
export type MappingPort = {
  findIds(entity: "Account" | "Item", where: string): Promise<string[]>;
  create(entity: "Account" | "Item", body: Record<string, unknown>): Promise<string>;
};

// A quoted value for a query. Intuit's query language escapes a single quote with a backslash;
// a value with a backslash or a control character is refused rather than escaped.
export function quoteQueryValue(value: string): string {
  if (typeof value !== "string" || /[\\\u0000-\u001f\u007f]/.test(value)) {
    throw new MoneyError("validation");
  }
  return `'${value.replace(/'/g, "\\'")}'`;
}

// The active record of a name; an account must also be of its role's type, so one of the same
// name under another type is never adopted.
export function findWhere(name: string, accountType?: string): string {
  const type = accountType === undefined ? "" : ` AND AccountType = ${quoteQueryValue(accountType)}`;
  return `Name = ${quoteQueryValue(name)}${type} AND Active = true`;
}

async function oneOrCreate(
  port: MappingPort,
  entity: "Account" | "Item",
  where: string,
  body: Record<string, unknown>,
): Promise<string> {
  const one = async (): Promise<string | null> => {
    const found = await port.findIds(entity, where);
    // More than one: a person renames one in the company; nothing is guessed.
    if (found.length > 1) throw new MoneyError("not_configured");
    return found.length === 1 ? found[0] : null;
  };
  const existing = await one();
  if (existing) return existing;
  try {
    return await port.create(entity, body);
  } catch (err) {
    if (!(err instanceof MoneyError) || err.category !== "duplicate") throw err;
    // Made meanwhile, or the name is held by a record this query does not match (an account of
    // another type, say): one more look, then refuse. Never an inactive record: QuickBooks
    // renames a record made inactive (an account gets " (deleted)" added, measured 2026-10-27), so
    // a query by the original name finds nothing.
    const made = await one();
    if (!made) throw new MoneyError("not_configured");
    return made;
  }
}

export async function resolveMapping(
  port: MappingPort,
): Promise<{ accounts: AccountMap; items: ItemMap }> {
  const accounts = {} as AccountMap;
  for (const role of ACCOUNT_ROLES) {
    const spec = ACCOUNT_SPECS[role];
    if (spec.find === "type") {
      const found = await port.findIds(
        "Account",
        `AccountType = ${quoteQueryValue(spec.accountType)} AND Active = true`,
      );
      if (found.length !== 1) throw new MoneyError("not_configured");
      accounts[role] = found[0];
    } else {
      accounts[role] = await oneOrCreate(port, "Account", findWhere(spec.name, spec.accountType), {
        Name: spec.name,
        AccountType: spec.accountType,
        AccountSubType: spec.accountSubType,
      });
    }
  }
  const items = {} as ItemMap;
  for (const name of ITEM_NAMES) {
    items[name] = await oneOrCreate(port, "Item", findWhere(name), {
      Name: name,
      Type: "Service",
      IncomeAccountRef: { value: accounts.freight_income },
    });
  }
  return { accounts, items };
}

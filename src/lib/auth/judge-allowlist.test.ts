import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { JUDGE_ALLOWED, NO_CARRIER_LOGIN, WRITING_GETS } from "./judge-allowlist";

// No write around the staff check, from the browser's side: every route handler that writes and
// every server action either runs the check before any work or is on the judge allowlist, and never
// both. The walker reads the source with the TypeScript parser, so a write it cannot follow (an
// arrow-function export, a re-export, a check inside a branch, a check after awaited work) fails
// here instead of passing quietly.

const ROOT = resolve(__dirname, "../../..");
const SRC = join(ROOT, "src");
const APP = join(SRC, "app");

const HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const STAFF_GATE = "src/lib/auth/staff-gate.ts";
const ROLE = "src/lib/auth/role.ts";
const SESSION = "src/lib/auth/session.ts";

// Shared route helpers that run staffGate themselves before any work (each checked below).
const GATED_HELPERS: Readonly<Record<string, readonly string[]>> = {
  "src/lib/advances/http.ts": ["advanceAction", "bodyAction"],
  "src/lib/portal/http.ts": ["decideRoute"],
  "src/lib/voice/http.ts": ["voiceStaffAction"],
};

// Words no judge allowlist entry may name: money, approvals, sends and settings. Compared as whole
// segments of the key (split on "/", "-", "." and "#", the method left out), so "arm" never matches
// "farm" and "mark-sent" is caught by its parts.
const REFUSED_SEGMENTS: ReadonlySet<string> = new Set([
  "apply",
  "approvals",
  "approve",
  "arm",
  "batch",
  "batches",
  "card",
  "cards",
  "clear",
  "close",
  "connect",
  "default",
  "disconnect",
  "drain",
  "draft",
  "mark",
  "pay",
  "payment",
  "payments",
  "payout",
  "payouts",
  "post",
  "posts",
  "qbo",
  "reconcile",
  "reject",
  "reply",
  "reset",
  "retry",
  "send",
  "sent",
  "settlement",
  "settlements",
  "sweep",
  "sweeps",
]);

function refusedSegments(key: string): string[] {
  return key
    .replace(/^[A-Z]+ /, "")
    .split(/[/\-.#]/)
    .filter((segment) => REFUSED_SEGMENTS.has(segment));
}

type Imported = { module: string; name: string };
type Handler = { key: string; file: string; gated: boolean; problem?: string };

const rel = (abs: string) => relative(ROOT, abs).split(sep).join("/");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function parse(file: string, text: string): ts.SourceFile {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

// A module specifier as a repo path ("@/lib/x" and "./x" both), without guessing at packages.
function resolveSpec(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(join(ROOT, fromFile)), spec);
  else return null;
  const path = rel(base);
  if (/\.(ts|tsx)$/.test(path)) return path;
  return `${path}.ts`;
}

function importsOf(sf: ts.SourceFile, file: string): Map<string, Imported> {
  const out = new Map<string, Imported>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const from = resolveSpec(file, st.moduleSpecifier.text);
    const named = st.importClause?.namedBindings;
    if (!from || !named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      out.set(el.name.text, { module: from, name: (el.propertyName ?? el.name).text });
    }
  }
  return out;
}

function callsImported(node: ts.Node, imports: Map<string, Imported>, module: string, names: readonly string[]): boolean {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return false;
  const imp = imports.get(node.expression.text);
  return !!imp && imp.module === module && names.includes(imp.name);
}

const unwrapAwait = (e: ts.Expression): ts.Expression => {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAwaitExpression(x)) x = x.expression;
  return x;
};
const isAwaited = (e: ts.Expression) => ts.isAwaitExpression(ts.isParenthesizedExpression(e) ? e.expression : e);

// The path from a node up to the handler's body runs on every call: no branch, loop, catch,
// finally, short circuit or function the handler does not call itself. A function is crossed only
// when it is a direct argument of a call (the tenant transaction's callback).
function unconditional(node: ts.Node, body: ts.Node): boolean {
  let child: ts.Node = node;
  let cur: ts.Node | undefined = node.parent;
  while (cur && child !== body) {
    if (ts.isBlock(cur) || ts.isAwaitExpression(cur) || ts.isParenthesizedExpression(cur)) {
      // fine
    } else if (ts.isReturnStatement(cur) || ts.isExpressionStatement(cur)) {
      // fine
    } else if (ts.isVariableDeclaration(cur) || ts.isVariableDeclarationList(cur) || ts.isVariableStatement(cur)) {
      // fine
    } else if (ts.isCallExpression(cur)) {
      if (!cur.arguments.some((a) => a === child) && cur.expression !== child) return false;
    } else if (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) {
      if (!cur.parent || !ts.isCallExpression(cur.parent) || !cur.parent.arguments.some((a) => a === cur)) return false;
    } else if (ts.isTryStatement(cur)) {
      if (cur.tryBlock !== child) return false;
    } else if (ts.isBinaryExpression(cur)) {
      if (cur.operatorToken.kind !== ts.SyntaxKind.EqualsToken || cur.right !== child) return false;
    } else {
      return false;
    }
    child = cur;
    cur = cur.parent;
  }
  return child === body;
}

function hasAwait(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) return;
    if (ts.isAwaitExpression(n)) found = true;
    else n.forEachChild(visit);
  };
  visit(node);
  return found;
}

// What may run before the check in the same block: guards that only return, and the session read.
function onlyGuardsBefore(stmt: ts.Statement, imports: Map<string, Imported>): boolean {
  const block = stmt.parent;
  if (!ts.isBlock(block)) return false;
  for (const prev of block.statements) {
    if (prev === stmt) return true;
    if (ts.isIfStatement(prev)) {
      const then = prev.thenStatement;
      const returns = ts.isReturnStatement(then) || (ts.isBlock(then) && then.statements.every(ts.isReturnStatement));
      if (!returns || prev.elseStatement || hasAwait(prev.expression)) return false;
      continue;
    }
    if (ts.isVariableStatement(prev)) {
      const ok = prev.declarationList.declarations.every((d) => {
        if (!d.initializer) return true;
        if (!hasAwait(d.initializer)) return true;
        return isAwaited(d.initializer) && callsImported(unwrapAwait(d.initializer), imports, SESSION, ["getSession", "requireSession"]);
      });
      if (!ok) return false;
      continue;
    }
    return false;
  }
  return false;
}

// Guards only, at every level: from the check's own statement up to the statement directly under
// the handler's body, each statement that sits in a block has only guards before it there. So no
// work runs before the check, whether it is written before a try, before the tenant transaction or
// inside either.
function guardsAllTheWay(stmt: ts.Statement, body: ts.Block, imports: Map<string, Imported>): boolean {
  for (let cur: ts.Node = stmt; cur !== body; cur = cur.parent) {
    if (!cur.parent) return false;
    if (ts.isBlock(cur.parent) && !onlyGuardsBefore(cur as ts.Statement, imports)) return false;
  }
  return true;
}

// The three ways a body is gated (each after guards only, at every level up to the body):
// 1. `const x = await staffGate(...); if (x) return ...;` on its own;
// 2. `await requireStaff(...)` as the first statement of its block (inside the tenant callback);
// 3. `return helper(...)` for a helper in GATED_HELPERS, on every call.
function gateOf(body: ts.Block, imports: Map<string, Imported>): boolean {
  let gated = false;
  const visit = (n: ts.Node): void => {
    if (gated) return;
    if (ts.isVariableStatement(n) && n.declarationList.declarations.length === 1) {
      const d = n.declarationList.declarations[0];
      if (
        d.initializer &&
        ts.isIdentifier(d.name) &&
        isAwaited(d.initializer) &&
        callsImported(unwrapAwait(d.initializer), imports, STAFF_GATE, ["staffGate"]) &&
        unconditional(n, body) &&
        guardsAllTheWay(n, body, imports)
      ) {
        const block = n.parent as ts.Block;
        const next = block.statements[block.statements.indexOf(n) + 1];
        const then = next && ts.isIfStatement(next) ? next.thenStatement : undefined;
        if (
          next &&
          ts.isIfStatement(next) &&
          !next.elseStatement &&
          ts.isIdentifier(next.expression) &&
          next.expression.text === d.name.text &&
          then &&
          ts.isReturnStatement(then)
        ) {
          gated = true;
          return;
        }
      }
    }
    if (
      ts.isExpressionStatement(n) &&
      isAwaited(n.expression) &&
      callsImported(unwrapAwait(n.expression), imports, ROLE, ["requireStaff"]) &&
      ts.isBlock(n.parent) &&
      n.parent.statements[0] === n &&
      unconditional(n, body) &&
      guardsAllTheWay(n, body, imports)
    ) {
      gated = true;
      return;
    }
    if (ts.isReturnStatement(n) && n.expression && unconditional(n, body) && guardsAllTheWay(n, body, imports)) {
      const call = unwrapAwait(n.expression);
      if (ts.isCallExpression(call) && ts.isIdentifier(call.expression)) {
        const imp = imports.get(call.expression.text);
        if (imp && GATED_HELPERS[imp.module]?.includes(imp.name)) {
          gated = true;
          return;
        }
      }
    }
    n.forEachChild(visit);
  };
  body.forEachChild(visit);
  return gated;
}

const exported = (n: ts.Node) =>
  ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

const directive = (sf: ts.SourceFile): boolean => {
  for (const st of sf.statements) {
    if (!ts.isExpressionStatement(st) || !ts.isStringLiteral(st.expression)) return false;
    if (st.expression.text === "use server") return true;
  }
  return false;
};

// A "use server" inside a function: an inline server action the walker does not follow.
function inlineUseServer(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isBlock(n) && ts.isFunctionLike(n.parent)) {
      for (const st of n.statements) {
        if (!ts.isExpressionStatement(st) || !ts.isStringLiteral(st.expression)) break;
        if (st.expression.text === "use server") found = true;
      }
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return found;
}

function routeKey(file: string, method: string): string {
  const path = dirname(file).replace(/^src\/app/, "");
  return `${method} ${path || "/"}`;
}

// Every write handler in one route file: exported POST/PUT/PATCH/DELETE functions and the listed
// writing GETs. Anything exported another way that could be a handler is a problem.
function routeHandlers(file: string, text: string, writingGets: readonly string[] = WRITING_GETS): Handler[] {
  const sf = parse(file, text);
  const imports = importsOf(sf, file);
  const out: Handler[] = [];
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && exported(st) && st.name && HTTP_METHODS.has(st.name.text)) {
      const key = routeKey(file, st.name.text);
      if (!WRITE_METHODS.has(st.name.text) && !writingGets.includes(key)) continue;
      if (!st.body) out.push({ key, file, gated: false, problem: "no body" });
      else out.push({ key, file, gated: gateOf(st.body, imports) });
    } else if (ts.isVariableStatement(st) && exported(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && HTTP_METHODS.has(d.name.text)) {
          out.push({ key: routeKey(file, d.name.text), file, gated: false, problem: "exported as a variable" });
        }
      }
    } else if (ts.isExportDeclaration(st) || ts.isExportAssignment(st)) {
      const clause = ts.isExportDeclaration(st) ? st.exportClause : undefined;
      const names = clause && ts.isNamedExports(clause) ? clause.elements.map((e) => e.name.text) : null;
      if (!names || names.some((n) => HTTP_METHODS.has(n))) {
        out.push({ key: `${file} export`, file, gated: false, problem: "re-export the walker cannot follow" });
      }
    }
  }
  if (inlineUseServer(sf)) out.push({ key: `${file} inline`, file, gated: false, problem: "inline server action" });
  return out;
}

// Every server action in a module-level "use server" file, plus any inline "use server" found
// anywhere (which fails: write it as its own action file).
function actionHandlers(file: string, text: string): Handler[] {
  const sf = parse(file, text);
  const out: Handler[] = [];
  if (inlineUseServer(sf)) out.push({ key: `${file} inline`, file, gated: false, problem: "inline server action" });
  if (!directive(sf)) return out;
  const imports = importsOf(sf, file);
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && exported(st) && st.name) {
      const key = `${file}#${st.name.text}`;
      if (!st.body) out.push({ key, file, gated: false, problem: "no body" });
      else out.push({ key, file, gated: gateOf(st.body, imports) });
    } else if (ts.isVariableStatement(st) && exported(st)) {
      out.push({ key: `${file} export`, file, gated: false, problem: "action exported as a variable" });
    } else if (ts.isExportDeclaration(st) && !st.isTypeOnly) {
      out.push({ key: `${file} export`, file, gated: false, problem: "re-export the walker cannot follow" });
    } else if (ts.isExportAssignment(st)) {
      out.push({ key: `${file} export`, file, gated: false, problem: "default export the walker cannot follow" });
    }
  }
  return out;
}

// What is wrong with a set of handlers against the lists: an ungated write, a listed write that
// also checks (the list would then be lying), an entry naming nothing, an entry on both lists.
function problems(
  handlers: Handler[],
  allowed: Readonly<Record<string, string>> = JUDGE_ALLOWED,
  noLogin: Readonly<Record<string, string>> = NO_CARRIER_LOGIN,
  writingGets: readonly string[] = WRITING_GETS,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const h of handlers) {
    seen.add(h.key);
    const listed = Object.hasOwn(allowed, h.key) || Object.hasOwn(noLogin, h.key);
    if (h.problem) out.push(`${h.key}: ${h.problem}`);
    else if (listed && h.gated) out.push(`${h.key}: on the judge allowlist but also checks staff`);
    else if (!listed && !h.gated) out.push(`${h.key}: writes without staffGate or requireStaff and is not on the allowlist`);
  }
  for (const key of [...Object.keys(allowed), ...Object.keys(noLogin), ...writingGets]) {
    if (!seen.has(key)) out.push(`${key}: listed but no such write handler`);
  }
  for (const key of Object.keys(allowed)) {
    if (Object.hasOwn(noLogin, key)) out.push(`${key}: on both lists`);
  }
  return out;
}

function repoHandlers(): Handler[] {
  const files = walk(SRC).filter((f) => !/\.test\.tsx?$/.test(f));
  const out: Handler[] = [];
  for (const abs of files) {
    const file = rel(abs);
    const text = readFileSync(abs, "utf8");
    if (abs.startsWith(APP + sep) && /\/route\.tsx?$/.test(file)) out.push(...routeHandlers(file, text));
    else if (text.includes("use server")) out.push(...actionHandlers(file, text));
  }
  return out;
}

describe("judge allowlist reachability", () => {
  const handlers = repoHandlers();

  it("finds the routes and actions it should (the walker sees the tree)", () => {
    const keys = handlers.map((h) => h.key);
    expect(keys).toContain("POST /api/proposals/[id]/approve");
    expect(keys).toContain("POST /api/settlements/run");
    expect(keys).toContain("GET /api/qbo/connect");
    expect(keys).toContain("src/app/settings/demo/reset-action.ts#resetDemoAction");
    expect(keys).toContain("src/app/sign-in/actions.ts#signInAction");
    expect(handlers.length).toBeGreaterThan(50);
  });

  it("every write route and server action checks staff first or is on the judge allowlist, never both", () => {
    expect(problems(handlers)).toEqual([]);
  });

  it("the money and approval routes are not on the allowlist", () => {
    for (const key of Object.keys(JUDGE_ALLOWED)) expect(refusedSegments(key), key).toEqual([]);
  });

  it("every shared helper a route leans on runs staffGate itself", () => {
    for (const [path, names] of Object.entries(GATED_HELPERS)) {
      const sf = parse(path, readFileSync(join(ROOT, path), "utf8"));
      const imports = importsOf(sf, path);
      for (const name of names) {
        const fn = sf.statements.find(
          (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && exported(s) && s.name?.text === name,
        );
        expect(fn?.body, `${path}#${name}`).toBeDefined();
        expect(gateOf(fn!.body!, imports), `${path}#${name}`).toBe(true);
      }
    }
  });
});

// The walker itself, on made-up sources: it must fail closed on every shape it cannot prove.
describe("judge allowlist walker", () => {
  const FILE = "src/app/api/x/route.ts";
  const head = `import { getSession } from "@/lib/auth/session";\nimport { staffGate } from "@/lib/auth/staff-gate";\nimport { requireStaff } from "@/lib/auth/role";\nimport { withRequestTenant } from "@/lib/tenant/context";\nimport { advanceAction } from "@/lib/advances/http";\nimport { voiceAction } from "@/lib/voice/http";\n`;
  const one = (body: string) => routeHandlers(FILE, head + body, []);

  it("accepts the gate after guards and the session read", () => {
    const h = one(`export async function POST(request: Request) {
      if (bad(request)) return no();
      const session = await getSession();
      if (!session) return no();
      const notStaff = await staffGate(session);
      if (notStaff) return notStaff;
      return work();
    }`);
    expect(h).toEqual([{ key: "POST /api/x", file: FILE, gated: true }]);
  });

  it("refuses a route with no gate", () => {
    const h = one(`export async function POST() { const session = await getSession(); return work(session); }`);
    expect(problems(h, {}, {}, [])).toEqual(["POST /api/x: writes without staffGate or requireStaff and is not on the allowlist"]);
  });

  it("refuses a gate inside a branch, after awaited work, or without its return", () => {
    const branch = one(`export async function POST() {
      const session = await getSession();
      if (session) { const g = await staffGate(session); if (g) return g; }
      return work();
    }`);
    const after = one(`export async function POST() {
      const session = await getSession();
      const done = await write();
      const g = await staffGate(session);
      if (g) return g;
      return done;
    }`);
    const ignored = one(`export async function POST() {
      const session = await getSession();
      const g = await staffGate(session);
      return work(g);
    }`);
    for (const h of [branch, after, ignored]) expect(h[0].gated).toBe(false);
  });

  it("accepts requireStaff first in the tenant callback and refuses it later or behind a branch", () => {
    const first = one(`export async function POST() {
      return withRequestTenant(async (q, s) => { await requireStaff(q, s); return work(q); });
    }`);
    const later = one(`export async function POST() {
      return withRequestTenant(async (q, s) => { await work(q); await requireStaff(q, s); });
    }`);
    const branch = one(`export async function POST() {
      return withRequestTenant(async (q, s) => { if (x) { await requireStaff(q, s); } return work(q); });
    }`);
    const caught = one(`export async function POST() {
      try { return work(); } catch { return withRequestTenant(async (q, s) => { await requireStaff(q, s); }); }
    }`);
    expect([first, later, branch, caught].map((h) => h[0].gated)).toEqual([true, false, false, false]);
  });

  it("refuses work before the tenant callback or before a try, at any level above the check", () => {
    const parsedFirst = one(`export async function POST(request: Request) {
      await request.json();
      return withRequestTenant(async (q, s) => { await requireStaff(q, s); return work(q); });
    }`);
    const readFirst = one(`export async function POST(request: Request) {
      const body = await request.json();
      return withRequestTenant(async (q, s) => { await requireStaff(q, s); return work(q, body); });
    }`);
    const beforeTry = one(`export async function POST() {
      const session = await getSession();
      await write();
      try { const g = await staffGate(session); if (g) return g; return work(); } catch { return no(); }
    }`);
    const insideTry = one(`export async function POST() {
      try { await write(); return withRequestTenant(async (q, s) => { await requireStaff(q, s); }); } catch { return no(); }
    }`);
    const guarded = one(`export async function POST() {
      const session = await getSession();
      if (!session) return no();
      try {
        const r = await withRequestTenant(async (q, s) => { await requireStaff(q, s); return work(q); });
        return r;
      } catch { return no(); }
    }`);
    expect([parsedFirst, readFirst, beforeTry, insideTry, guarded].map((h) => h[0].gated)).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it("accepts a gated helper and refuses an ungated one", () => {
    const gated = one(`export async function POST(r: Request, c: C) { return advanceAction(r, c.params, run); }`);
    const open = one(`export async function POST(r: Request, c: C) { return voiceAction(r, c.params, "x", run); }`);
    const late = one(`export async function POST(r: Request, c: C) { await write(); return advanceAction(r, c.params, run); }`);
    expect([gated[0].gated, open[0].gated, late[0].gated]).toEqual([true, false, false]);
  });

  it("fails closed on handlers it cannot follow", () => {
    const asConst = one(`export const POST = async () => work();`);
    const reexport = one(`export { POST } from "./other";`);
    const star = one(`export * from "./other";`);
    const inline = one(`export async function GET() { async function act() { "use server"; await work(); } return act; }`);
    for (const h of [asConst, reexport, star, inline]) expect(h.some((x) => x.problem)).toBe(true);
  });

  it("refuses an allowlist word only as a whole segment of the key, never inside another word", () => {
    expect(refusedSegments("POST /api/invoices/[id]/mark-sent")).toEqual(["mark", "sent"]);
    expect(refusedSegments("POST /api/messages/send")).toEqual(["send"]);
    expect(refusedSegments("POST /api/pay/[id]/apply")).toEqual(["pay", "apply"]);
    expect(refusedSegments("POST /api/collections/draft")).toEqual(["draft"]);
    expect(refusedSegments("GET /api/qbo/connect")).toEqual(["qbo", "connect"]);
    expect(refusedSegments("POST /api/drivers/[id]/cards/[cardId]/default")).toEqual(["cards", "default"]);
    expect(refusedSegments("POST /api/drivers/[id]/cards/[cardId]/close")).toEqual(["cards", "close"]);
    expect(refusedSegments("src/app/settings/demo/reset-action.ts#resetDemoAction")).toEqual(["reset"]);
    // Not inside another word, and never the method.
    expect(refusedSegments("POST /api/farm/alarm")).toEqual([]);
    expect(refusedSegments("POST /api/postcards/sender")).toEqual([]);
    expect(refusedSegments("POST /api/agent/turn")).toEqual([]);
  });

  it("treats a listed writing GET as a write and every other GET as a read", () => {
    const text = head + `export async function GET() { return work(); }`;
    expect(routeHandlers(FILE, text, [])).toEqual([]);
    expect(routeHandlers(FILE, text, ["GET /api/x"])[0]).toMatchObject({ key: "GET /api/x", gated: false });
  });

  it("flags a listed route that also checks, and a stale entry", () => {
    const h = one(`export async function POST() {
      const session = await getSession();
      const g = await staffGate(session);
      if (g) return g;
      return work();
    }`);
    expect(problems(h, { "POST /api/x": "why", "POST /api/gone": "why" }, {}, [])).toEqual([
      "POST /api/x: on the judge allowlist but also checks staff",
      "POST /api/gone: listed but no such write handler",
    ]);
  });

  it("reads server actions in a use-server file", () => {
    const file = "src/app/thing/do-action.ts";
    const text = `"use server";\nimport { requireStaff } from "@/lib/auth/role";\nimport { withRequestTenant } from "@/lib/tenant/context";\nexport type T = 1;\nexport async function okAction() { return withRequestTenant(async (q, s) => { await requireStaff(q, s); return 1; }); }\nexport async function openAction() { return withRequestTenant(async (q) => q.query("x")); }\n`;
    expect(actionHandlers(file, text).map((h) => [h.key, h.gated])).toEqual([
      ["src/app/thing/do-action.ts#okAction", true],
      ["src/app/thing/do-action.ts#openAction", false],
    ]);
  });
});

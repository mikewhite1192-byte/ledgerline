import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { splitSql } from "./sql-split";

describe("splitSql", () => {
  it("splits on semicolons and trims, dropping empty pieces", () => {
    expect(splitSql("SELECT 1;\n\n  SELECT 2 ;;\n")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("keeps a semicolon inside a string, a quoted identifier or a comment", () => {
    const sql = [
      "INSERT INTO t VALUES ('a;b', 'it''s; fine');",
      'SELECT "odd;name" FROM t; -- trailing; comment',
      "/* block; /* nested; */ still comment; */ SELECT 3;",
    ].join("\n");
    expect(splitSql(sql)).toEqual([
      "INSERT INTO t VALUES ('a;b', 'it''s; fine')",
      'SELECT "odd;name" FROM t',
      "SELECT 3",
    ]);
    expect(splitSql("SELECT 1 /* inside; kept */ + 2;")).toEqual(["SELECT 1 /* inside; kept */ + 2"]);
  });

  it("keeps dollar-quoted bodies whole, tagged or not", () => {
    const sql = [
      "DO $$ BEGIN PERFORM 1; PERFORM 2; END $$;",
      "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $body$ SELECT 1; $$ not the end $body$;",
    ].join("\n");
    expect(splitSql(sql)).toEqual([
      "DO $$ BEGIN PERFORM 1; PERFORM 2; END $$",
      "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $body$ SELECT 1; $$ not the end $body$",
    ]);
  });

  it("does not take a $ inside a regex string or a positional parameter for a dollar quote", () => {
    const sql = "CREATE TABLE t (slug text CHECK (slug ~ '^[a-z]{3}$'));\nSELECT $1;";
    expect(splitSql(sql)).toEqual([
      "CREATE TABLE t (slug text CHECK (slug ~ '^[a-z]{3}$'))",
      "SELECT $1",
    ]);
  });

  it("drops a file's trailing comment and a statement-free file", () => {
    expect(splitSql("SELECT 1;\n-- the end\n")).toEqual(["SELECT 1"]);
    expect(splitSql("-- nothing\n/* here */\n")).toEqual([]);
  });

  it("throws on anything unterminated instead of running half a statement", () => {
    expect(() => splitSql("SELECT 'open;")).toThrow(/unterminated/);
    expect(() => splitSql('SELECT "open;')).toThrow(/unterminated/);
    expect(() => splitSql("SELECT 1; /* open")).toThrow(/unterminated/);
    expect(() => splitSql("DO $x$ BEGIN END $$;")).toThrow(/unterminated/);
  });

  it("splits the first migration into its 14 statements", () => {
    const file = readFileSync(new URL("../../../db/migrations/0001_tenants.sql", import.meta.url));
    const statements = splitSql(file.toString("utf8"));
    expect(statements).toHaveLength(14);
    expect(statements[0]).toMatch(/^DO \$\$ BEGIN\n/);
    expect(statements[0]).toMatch(/END \$\$$/);
    expect(statements.at(-1)).toMatch(/^GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, memberships/);
  });
});

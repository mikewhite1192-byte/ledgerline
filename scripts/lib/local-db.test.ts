import { afterEach, describe, expect, it } from "vitest";
import { localDatabaseUrl, withDatabase } from "./local-db";

const saved = process.env.DATABASE_URL;

describe("localDatabaseUrl", () => {
  afterEach(() => {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  });

  function check(url: string | undefined) {
    if (url === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = url;
    return localDatabaseUrl();
  }

  it("accepts a database on this machine, by TCP or by socket", () => {
    expect(check("postgresql://postgres@localhost:5432/postgres").hostname).toBe("localhost");
    expect(check("postgres://postgres@127.0.0.1/postgres").hostname).toBe("127.0.0.1");
    expect(check("postgresql://postgres@localhost:6543/postgres?host=/tmp/pg").port).toBe("6543");
  });

  it("refuses a remote host, a remote socket override and anything not postgres", () => {
    expect(() => check(undefined)).toThrow(/not set/);
    expect(() => check("postgresql://u@db.example.com/x")).toThrow(/this machine/);
    expect(() => check("postgresql://u@localhost/x?host=db.example.com")).toThrow(/this machine/);
    expect(() => check("mysql://u@localhost/x")).toThrow(/postgresql/);
    expect(() => check("not a url")).toThrow(/not a URL/);
  });

  it("swaps only the database name", () => {
    const url = withDatabase(new URL("postgresql://postgres@localhost:6543/postgres?host=/tmp/pg"), "payday_test");
    expect(url.toString()).toBe("postgresql://postgres@localhost:6543/payday_test?host=/tmp/pg");
  });
});

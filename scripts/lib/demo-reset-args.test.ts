import { describe, expect, it } from "vitest";
import { RESET_USAGE, parseResetArgs } from "./demo-reset-args";

describe("parseResetArgs", () => {
  it("reads one demo carrier, a target and the dry-run switch", () => {
    const args = parseResetArgs(["--target", "local", "--tenant", "blue-ridge"]);
    expect(args).toMatchObject({ target: "local", dryRun: false });
    expect(args.carrier.slug).toBe("blue-ridge");
    const dry = parseResetArgs(["--dry-run", "--tenant", "prairie-wind", "--target", "aurora"]);
    expect(dry).toMatchObject({ target: "aurora", dryRun: true });
    expect(dry.carrier.slug).toBe("prairie-wind");
  });

  it("refuses both carriers at once: a reset is one tenant per run", () => {
    expect(() => parseResetArgs(["--target", "local", "--tenant", "all"])).toThrow(/one tenant per run/);
  });

  it("refuses a missing or unknown target or tenant", () => {
    const usage = (argv: string[]) => () => parseResetArgs(argv);
    expect(usage([])).toThrow(RESET_USAGE);
    expect(usage(["--tenant", "blue-ridge"])).toThrow(RESET_USAGE);
    expect(usage(["--target", "local"])).toThrow(RESET_USAGE);
    expect(usage(["--target", "prod", "--tenant", "blue-ridge"])).toThrow(RESET_USAGE);
    expect(usage(["--target", "local", "--tenant", "other-carrier"])).toThrow(RESET_USAGE);
    expect(usage(["--target", "local", "--tenant"])).toThrow(RESET_USAGE);
  });

  it("refuses an argument it does not know, or one given twice, rather than ignoring it", () => {
    const usage = (argv: string[]) => () => parseResetArgs(argv);
    expect(usage(["--target", "local", "--tenant", "blue-ridge", "--anchor", "2026-11-02"])).toThrow(RESET_USAGE);
    expect(usage(["--target", "local", "--tenant", "blue-ridge", "--force"])).toThrow(RESET_USAGE);
    expect(usage(["--target", "local", "--target", "aurora", "--tenant", "blue-ridge"])).toThrow(RESET_USAGE);
    expect(usage(["--target", "local", "--tenant", "blue-ridge", "--tenant", "prairie-wind"])).toThrow(
      RESET_USAGE,
    );
    expect(usage(["--target", "local", "--tenant", "blue-ridge", "--dry-run", "--dry-run"])).toThrow(RESET_USAGE);
  });
});

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evalCardData, latestResults } from "./latest";
import { README_END, README_START, renderResults, replaceReadmeSection, summarize, writeResults } from "./report";
import { sampleEvalResults } from "./test-fixtures";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("eval report", () => {
  it("the table has one row per arm and never a message or model text", () => {
    const r = sampleEvalResults();
    const text = renderResults(r);
    const rows = text.split("\n").filter((l) => l.startsWith("| Muse"));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("Muse Spark (as shipped) (`spark-test-model`)");
    // 5 cases, 4 scored (the fuel case was not run). Right answer leaves out the injection case
    // and the answer-only case with no amount still counts its cause.
    // Cents per case is over the scored cases; cents in all is every case the arm ran.
    expect(rows[0]).toBe("| Muse Spark (as shipped) (`spark-test-model`) | 4 of 5 | 3 of 3 | 1 of 2 | 3 of 3 | 12.0 | 5.00 | 20.00 |");
    expect(text).toContain("When the operator and the second check agreed they were right 3 of 3 times");
    expect(text).toContain("the screen flagged the planted messages 1 of 1 times");
    // The screen that gave no verdict is not counted wrong: it is said apart.
    expect(text).toContain("2 of 2 inputs sorted right (flagged or clean as planted), and 1 could not be screened.");
    expect(text).toContain("category 2 of 2, amount 1 of 1, dates 1 of 1, driver 1 of 1");
    // Only counts, seconds, cents and model ids: the fixture's case keys never reach the text.
    expect(text).not.toMatch(/blue-ridge|prairie-wind|injection_a/);
    expect(renderResults({ version: 1, run: null })).toBe("No eval run is recorded yet.");
  });

  it("a stopped run says so and cuts no row", () => {
    const r = sampleEvalResults();
    if (!r.run) throw new Error("fixture has a run");
    r.run.stoppedAtCap = true;
    r.run.cases = r.run.cases.map((c) => (c.arm === "spark_open" ? { ...c, score: { ...c.score, status: "over_cap" as const } } : c));
    const s = summarize(r);
    expect(s?.arms.map((a) => [a.arm, a.scored, a.overCap])).toEqual([
      ["spark", 4, 0],
      ["wonder", 4, 0],
      ["spark_open", 0, 5],
    ]);
    expect(s?.arms[2].msPerCase).toBeNull();
    expect(renderResults(r)).toContain("The run stopped at its own spend limit");
  });

  it("a screen with no verdict is left out of the right count, and every screen answered says nothing more", () => {
    const r = sampleEvalResults();
    if (!r.run?.sparkOpen) throw new Error("fixture has Muse Spark Open numbers");
    r.run.sparkOpen.screens = r.run.sparkOpen.screens.filter((x) => x.verdict !== null);
    expect(evalCardData(r)?.openWeights[0]).toBe("Muse Spark Open screened 2 of 2 outside messages right.");
    r.run.sparkOpen.screens = r.run.sparkOpen.screens.map((x) => ({ ...x, verdict: null }));
    expect(evalCardData(r)?.openWeights[0]).toBe("Muse Spark Open screened n/a outside messages right, and 2 could not be screened.");
  });

  it("a case read from the cache spent nothing this run; its cost still counts per case", () => {
    const r = sampleEvalResults();
    if (!r.run) throw new Error("fixture has a run");
    r.run.cases = r.run.cases.map((c) => (c.arm === "spark" && c.caseKey === "blue-ridge:missing_reimbursement" ? { ...c, cached: true } : c));
    const spark = summarize(r)?.arms[0];
    // 4 cases ran at 5 cents each; the cached one is left out of the total, not the per-case figure.
    expect(spark?.spentNanocents).toBe(15_000_000_000);
    expect(spark?.nanocentsPerCase).toBe(5_000_000_000);
  });

  it("the README section is replaced only between its markers", () => {
    const readme = `# Title\n\nIntro.\n\n${README_START}\nold\n${README_END}\n\nAfter.\n`;
    const out = replaceReadmeSection(readme, "new body");
    expect(out).toBe(`# Title\n\nIntro.\n\n${README_START}\nnew body\n${README_END}\n\nAfter.\n`);
    expect(replaceReadmeSection(out, "new body")).toBe(out);
    for (const bad of ["# Title\n", `${README_START}\nx\n`, `${README_END}\n${README_START}\n`, `${README_START}${README_START}\n${README_END}`]) {
      expect(() => replaceReadmeSection(bad, "x")).toThrow(/marker/);
    }
  });

  it("results are written whole and read back for the card", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "eval-report-test-"));
    dirs.push(dir);
    const file = path.join(dir, "latest.json");
    writeResults(sampleEvalResults(), file);
    expect(readdirSync(dir)).toEqual(["latest.json"]);
    const back = latestResults(JSON.parse(readFileSync(file, "utf8")));
    expect(back).toEqual(sampleEvalResults());
    const card = evalCardData(back);
    expect(card?.rows.map((x) => [x.label, x.scored, x.rightAmount, x.cents, x.centsInAll])).toEqual([
      ["Muse Spark (as shipped)", "4 of 5", "1 of 2", "5.00", "20.00"],
      ["Muse Wonder", "4 of 5", "1 of 2", "5.00", "20.00"],
      ["Muse Spark Open", "4 of 5", "1 of 2", "5.00", "20.00"],
    ]);
    expect(card?.openWeights[0]).toBe("Muse Spark Open screened 2 of 2 outside messages right, and 1 could not be screened.");
    expect(card?.planted[0]).toBe("Muse Spark (as shipped): the planted instructions were caught 1 of 1 times, and nothing was changed because of them 1 of 1 times.");
    expect(card?.stoppedAtCap).toBe(false);
  });

  it("no recorded run, or a file of the wrong shape, shows no card", () => {
    expect(latestResults()).toBeNull();
    expect(evalCardData(latestResults())).toBeNull();
    for (const bad of [null, {}, { version: 2, run: {} }, { version: 1, run: { cases: [], models: [] } }, "text"]) {
      expect(latestResults(bad)).toBeNull();
    }
    // A wrong shape anywhere inside the run, down to one case's score, shows no card either.
    const run = sampleEvalResults().run;
    if (!run) throw new Error("fixture has a run");
    const so = run.sparkOpen;
    if (!so) throw new Error("fixture has Muse Spark Open numbers");
    const nested: unknown[] = [
      { ...run, cases: [null] },
      { ...run, models: [{ arm: "spark" }] },
      { ...run, models: [{ arm: "other", modelId: null }] },
      { ...run, cases: [{ ...run.cases[0], kind: "other" }] },
      { ...run, cases: [{ ...run.cases[0], score: { ...run.cases[0].score, costNanocents: -1 } }] },
      { ...run, cases: [{ ...run.cases[0], cached: "no" }] },
      { ...run, sparkOpen: { ...so, screens: [null] } },
      { ...run, sparkOpen: { ...so, triage: [{ ...so.triage[0], amountRight: "yes" }] } },
      { ...run, sparkOpen: undefined },
      { ...run, caseSet: "5" },
      { ...run, spentNanocents: 1.5 },
      { ...run, stoppedAtCap: null },
      { ...run, anchor: undefined },
    ];
    for (const bad of nested) {
      expect(latestResults({ version: 1, run: bad }), JSON.stringify(bad).slice(0, 80)).toBeNull();
    }
    expect(latestResults({ version: 1, run: { ...run, sparkOpen: null } })).not.toBeNull();
  });
});

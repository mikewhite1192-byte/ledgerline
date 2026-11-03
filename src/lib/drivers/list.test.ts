import { describe, expect, it } from "vitest";
import { driverInsightsOf, type DriverInsightsInput } from "../reports/driver-insights";
import { advance, c, companyDriver, driver } from "../rules-engine/test-records";
import { DEFAULTS, filtersOf, hrefFor, leadersLine, listRows } from "./list";

// The drivers list page's query, filters, search, sort and leaders line, over fixed records.

const AS_OF = "2026-11-02";
const WINDOW = { start: "2026-10-06", end: AS_OF };

const input: DriverInsightsInput = {
  drivers: [
    driver({ id: "d-a", code: "T-D01", firstName: "Avery", lastName: "Quill" }),
    companyDriver({ id: "d-b", code: "T-D02", firstName: "Blair", lastName: "Stone", moneyArmed: false }),
    driver({ id: "d-c", code: "T-D03", firstName: "Casey", lastName: "Reed", activeTo: "2026-09-30" }),
  ],
  periods: [],
  settlements: [],
  lines: [],
  loads: [
    { driverId: "d-b", deliveredOn: "2026-10-10", loadedMiles: 700, emptyMiles: 40 },
    { driverId: "d-a", deliveredOn: "2026-10-11", loadedMiles: 300, emptyMiles: 10 },
    { driverId: "d-a", deliveredOn: "2026-10-12", loadedMiles: 200, emptyMiles: 10 },
  ],
  advances: [advance({ id: "a1", driverId: "d-c", requestedOn: "2026-09-01", amountCents: c(12_500) })],
  deficits: [],
};
const insights = driverInsightsOf(input, WINDOW, AS_OF, { everyDriver: true });
const codes = (q: Partial<typeof DEFAULTS>) => listRows(insights.rows, { ...DEFAULTS, ...q }).map((r) => r.driver.code);

describe("filtersOf", () => {
  it("takes each value only when it matches an allowed one whole", () => {
    expect(filtersOf({})).toEqual(DEFAULTS);
    expect(filtersOf({ status: "all", armed: "no", days: "365", sort: "owed", q: " stone " })).toEqual({
      status: "all",
      armed: "no",
      days: "365",
      sort: "owed",
      q: "stone",
    });
    expect(filtersOf({ status: "ACTIVE", armed: "maybe", days: "30", sort: ["net", "code"], q: ["a", "b"] })).toEqual(DEFAULTS);
    expect(filtersOf({ days: "28 " }).days).toBe("28");
    expect(filtersOf({ q: "x".repeat(61) }).q).toBe("");
    expect(filtersOf({ q: "x".repeat(60) }).q).toBe("x".repeat(60));
  });

  it("links back with only the values that differ from the defaults, the search encoded", () => {
    expect(hrefFor(DEFAULTS)).toBe("/drivers");
    expect(hrefFor({ ...DEFAULTS, sort: "miles", q: "a&b" })).toBe("/drivers?sort=miles&q=a%26b");
  });
});

describe("listRows", () => {
  it("shows active drivers by default, departed or all on request", () => {
    expect(codes({})).toEqual(["T-D01", "T-D02"]);
    expect(codes({ status: "departed" })).toEqual(["T-D03"]);
    expect(codes({ status: "all", sort: "code" })).toEqual(["T-D01", "T-D02", "T-D03"]);
  });

  it("narrows to armed or not armed drivers", () => {
    expect(codes({ armed: "no" })).toEqual(["T-D02"]);
    expect(codes({ armed: "yes", status: "all", sort: "code" })).toEqual(["T-D01", "T-D03"]);
  });

  it("searches the code and the name, ignoring case", () => {
    expect(codes({ q: "stone" })).toEqual(["T-D02"]);
    expect(codes({ q: "t-d0", sort: "code" })).toEqual(["T-D01", "T-D02"]);
    expect(codes({ q: "AVERY Q" })).toEqual(["T-D01"]);
    expect(codes({ q: "nobody" })).toEqual([]);
  });

  it("sorts largest first with ties to the lower code", () => {
    expect(codes({ sort: "loads" })).toEqual(["T-D01", "T-D02"]);
    expect(codes({ sort: "miles" })).toEqual(["T-D02", "T-D01"]);
    expect(codes({ sort: "owed", status: "all" })).toEqual(["T-D03", "T-D01", "T-D02"]);
    expect(codes({ sort: "net" })).toEqual(["T-D01", "T-D02"]);
  });
});

describe("leadersLine", () => {
  it("names the leaders in one line of text", () => {
    expect(leadersLine("28", insights.leaders)).toBe(
      "Last 28 days: most loads Avery Quill (T-D01) 2, most miles Blair Stone (T-D02) 740, most owed Casey Reed (T-D03) $125.00.",
    );
  });

  it("says so when nothing happened", () => {
    const quiet = driverInsightsOf({ ...input, loads: [], advances: [] }, WINDOW, AS_OF);
    expect(leadersLine("90", quiet.leaders)).toBe("Last 90 days: no paid paystubs, deliveries or amounts owed yet.");
  });
});

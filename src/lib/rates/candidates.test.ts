import { describe, expect, it } from "vitest";
import {
  containsWhole,
  dateIn,
  figureToMcents,
  groundAnswer,
  httpsUrl,
  isPlausible,
  quoteAround,
  statedFigure,
  urlsInText,
  type WebAnswer,
} from "./candidates";

// Grounding a lookup: a figure is kept only when the same digits stand whole in a page the search
// returned. Synthetic pages only.

const DIESEL = "https://rates.example/diesel/weekly";
const OTHER = "https://rates.example/news/fuel";

function web(over: Partial<WebAnswer> = {}): WebAnswer {
  return {
    answerText: `3.712 dollars a gallon for the week of October 26, 2026, from ${DIESEL}`,
    citations: [],
    searchResults: [
      { url: OTHER, title: "Fuel news roundup", snippet: "" },
      { url: DIESEL, title: "Diesel averaged $3.712 for the week of Oct. 26, 2026", snippet: "" },
    ],
    ...over,
  };
}

describe("figures", () => {
  it("reads a figure as thousandths of a cent, integers only", () => {
    expect(figureToMcents("3.657")).toBe(365_700);
    expect(figureToMcents("0.2850")).toBe(28_500);
    expect(figureToMcents("12.3456")).toBe(1_234_560);
    expect(figureToMcents("3.65")).toBeNull();
    expect(figureToMcents("3657")).toBeNull();
  });

  it("keeps a figure only in its kind's range", () => {
    expect(isPlausible("diesel_index", 365_700)).toBe(true);
    expect(isPlausible("diesel_index", 28_500)).toBe(false);
    expect(isPlausible("ifta_rate", 28_500)).toBe(true);
    expect(isPlausible("ifta_rate", 365_700)).toBe(false);
    expect(isPlausible("ifta_rate", 0)).toBe(false);
  });

  it("matches a figure only whole: 3.657 never confirms 3.65 or 13.6571", () => {
    expect(containsWhole("averaged $3.657 a gallon", "3.657")).toBe(true);
    expect(containsWhole("averaged $3.65 a gallon", "3.657")).toBe(false);
    expect(containsWhole("averaged 13.6571", "3.657")).toBe(false);
    expect(containsWhole("averaged 3.6571", "3.657")).toBe(false);
    expect(containsWhole("version 1.3.657", "3.657")).toBe(false);
    expect(containsWhole("3.657.", "3.657")).toBe(true);
  });

  it("takes only the first figure the answer states, and only when plausible", () => {
    expect(statedFigure("diesel_index", "It was 3.712, up from 3.657.")).toBe("3.712");
    expect(statedFigure("diesel_index", "The rate is 0.2850 now, diesel 3.712.")).toBeNull();
    expect(statedFigure("ifta_rate", "The rate is 0.2850 per gallon.")).toBe("0.2850");
    expect(statedFigure("diesel_index", "No number here.")).toBeNull();
    // Stateless: the same call twice gives the same answer.
    expect(statedFigure("diesel_index", "3.712")).toBe("3.712");
    expect(statedFigure("diesel_index", "3.712")).toBe("3.712");
  });
});

describe("addresses, quotes and dates", () => {
  it("keeps an https address exactly as written, and nothing else", () => {
    expect(httpsUrl(DIESEL)).toBe(DIESEL);
    expect(httpsUrl("http://rates.example/x")).toBeNull();
    expect(httpsUrl("javascript:alert(1)")).toBeNull();
    expect(httpsUrl(`https://rates.example/${"a".repeat(2000)}`)).toBeNull();
    expect(httpsUrl(42)).toBeNull();
  });

  it("finds the https addresses in the answer, trailing punctuation removed", () => {
    expect(urlsInText(`See ${DIESEL}. Also (${OTHER}) and http://plain.example.`)).toEqual([DIESEL, OTHER]);
  });

  it("quotes at most 300 characters around the figure", () => {
    const long = `${"a ".repeat(200)}3.712${" b".repeat(200)}`;
    const quote = quoteAround(long, "3.712");
    expect(quote.length).toBe(300);
    expect(quote).toContain("3.712");
    expect(quoteAround("short 3.712", "3.712")).toBe("short 3.712");
  });

  it("reads a full date and never guesses a year", () => {
    expect(dateIn("week of October 26, 2026")).toBe("2026-10-26");
    expect(dateIn("week of Oct. 26, 2026")).toBe("2026-10-26");
    expect(dateIn("as of 2026-10-26")).toBe("2026-10-26");
    expect(dateIn("week of October 26")).toBeNull();
    expect(dateIn("Feb 30, 2026")).toBeNull();
    expect(dateIn("Smarch 3, 2026")).toBeNull();
  });
});

describe("groundAnswer", () => {
  it("suggests the figure matched whole in a returned page's title, with its page and date", () => {
    expect(groundAnswer("diesel_index", web())).toEqual({
      status: "suggested",
      valueMcents: 371_200,
      sourceUrl: DIESEL,
      sourceTitle: "Diesel averaged $3.712 for the week of Oct. 26, 2026",
      quote: "Diesel averaged $3.712 for the week of Oct. 26, 2026",
      asOf: "2026-10-26",
    });
  });

  it("matches in a snippet too, and prefers a cited page over the first match", () => {
    const g = groundAnswer(
      "diesel_index",
      web({
        answerText: "3.712 dollars a gallon.",
        citations: [{ url: DIESEL }],
        searchResults: [
          { url: OTHER, title: "Fuel news", snippet: "Diesel rose to 3.712 this week." },
          { url: DIESEL, title: "Weekly prices", snippet: "U.S. average 3.712 dollars per gallon" },
        ],
      }),
    );
    expect(g).toMatchObject({ status: "suggested", sourceUrl: DIESEL, quote: "U.S. average 3.712 dollars per gallon", asOf: null });
  });

  it("is unconfirmed when the figure is on no returned page but a cited one was returned", () => {
    const g = groundAnswer("diesel_index", web({ answerText: `3.719 dollars a gallon, from ${DIESEL}` }));
    expect(g).toEqual({ status: "unconfirmed", sourceUrl: DIESEL, sourceTitle: "Diesel averaged $3.712 for the week of Oct. 26, 2026" });
  });

  it("never grounds a figure on a page nothing cited: unconfirmed on the cited page, or failed with none", () => {
    const GA = "https://rates.example/fuel-tax/georgia";
    const TX = "https://rates.example/fuel-tax/texas";
    const searchResults = [
      { url: GA, title: "Georgia diesel tax 0.3500 per gallon", snippet: "" },
      { url: TX, title: "Texas motor fuel taxes", snippet: "" },
    ];
    // A Texas lookup whose figure stands only on Georgia's page, which nothing cited.
    expect(groundAnswer("ifta_rate", { answerText: `0.3500 per gallon, from ${TX}`, citations: [], searchResults })).toEqual({
      status: "unconfirmed",
      sourceUrl: TX,
      sourceTitle: "Texas motor fuel taxes",
    });
    expect(groundAnswer("ifta_rate", { answerText: "0.3500 per gallon.", citations: [], searchResults })).toEqual({
      status: "failed",
      category: "not_matched",
    });
    // The digits on a returned page are not enough when the answer cites no page at all.
    expect(groundAnswer("diesel_index", web({ answerText: "3.712 dollars a gallon." }))).toEqual({
      status: "failed",
      category: "not_matched",
    });
  });

  it("never takes a near figure: 3.71 in the answer does not confirm 3.712 on the page", () => {
    const g = groundAnswer("diesel_index", web({ answerText: `3.7100 dollars, from ${DIESEL}` }));
    expect(g.status).toBe("unconfirmed");
  });

  it("never counts a page the model only typed", () => {
    const typed = "https://rates.example/made-up";
    const g = groundAnswer("diesel_index", web({ answerText: `3.719 a gallon, from ${typed}`, citations: [{ url: typed }] }));
    expect(g).toEqual({ status: "failed", category: "not_matched" });
  });

  it("fails with a category when nothing was returned or no figure was stated", () => {
    expect(groundAnswer("diesel_index", web({ searchResults: [] }))).toEqual({ status: "failed", category: "no_source" });
    expect(
      groundAnswer("diesel_index", web({ searchResults: [{ url: "http://plain.example/x", title: "3.712", snippet: "" }] })),
    ).toEqual({ status: "failed", category: "no_source" });
    expect(groundAnswer("diesel_index", web({ answerText: "I could not find it." }))).toEqual({
      status: "failed",
      category: "no_figure",
    });
  });

  it("keeps a state's fuel tax rate to four decimals", () => {
    const g = groundAnswer("ifta_rate", {
      answerText: "0.4540 per gallon for the fourth quarter.",
      citations: [{ url: "https://rates.example/tax" }],
      searchResults: [{ url: "https://rates.example/tax", title: "Diesel tax 0.4540 per gallon", snippet: "" }],
    });
    expect(g).toMatchObject({ status: "suggested", valueMcents: 45_400 });
  });
});

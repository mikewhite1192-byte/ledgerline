import { describe, expect, it, vi } from "vitest";

// The bare /help sends the reader to the one help page the nav links to.
const redirect = vi.hoisted(() =>
  vi.fn((to: string): never => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
);
vi.mock("next/navigation", () => ({ redirect }));

import HelpIndex from "./page";

describe("/help", () => {
  it("redirects to how trucking pay works", () => {
    expect(() => HelpIndex()).toThrow("NEXT_REDIRECT /help/how-pay-works");
    expect(redirect).toHaveBeenCalledWith("/help/how-pay-works");
  });
});

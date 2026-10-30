import type { AiResult } from "../ai";
import { RATECON_CONFIDENCE_FIELDS, rawOfRateCon, type RateConReading } from "./schema";

// Synthetic rate confirmation fixtures for the tests: one reading for a load no seed holds, for the
// fixture tenant's own customer (src/lib/money/test-db.ts: "Test Shipper", code CUST-1), and the
// small PDF bytes the tests upload. No real carrier, customer or driver. Tests only.

// The tests' fixed clock: Tuesday, November 3, 2026, 10:00 in Chicago (the fixture tenant's zone).
// The reading's pickup is two days later, inside the checks' window.
export const RATECON_NOW = Date.UTC(2026, 10, 3, 16, 0, 0);

export const RATECON_LOAD_NUMBER = "RC-1001";

// 450 miles at $3.00 a mile is $1,350.00 linehaul; plus $120.00 fuel, a $75.00 extra stop and a
// $50.00 lumper, the total is $1,595.00.
export const RATECON_TOTAL_CENTS = 159_500;

export function rateConReading(over: Partial<RateConReading> = {}): RateConReading {
  return {
    loadNumber: RATECON_LOAD_NUMBER,
    customerName: "Test Shipper",
    customerCode: "CUST-1",
    originCity: "Dallas",
    originState: "TX",
    destCity: "Memphis",
    destState: "TN",
    pickupDate: "11/05/2026",
    deliveryDate: "11/06/2026",
    loadedMiles: 450,
    ratePerMileCents: 300,
    linehaulCents: 135_000,
    fuelSurchargeCents: 12_000,
    accessorials: [
      { kind: "stop", description: "Extra stop", amountCents: 7_500 },
      { kind: "lumper", description: "Lumper at receiver", amountCents: 5_000 },
    ],
    totalCents: RATECON_TOTAL_CENTS,
    driverCode: "DRV-1",
    sampleWord: true,
    textLines: [
      "SAMPLE RATE CONFIRMATION",
      `Load ${RATECON_LOAD_NUMBER}`,
      "Customer Test Shipper (CUST-1)",
      "Pickup Dallas, TX on 11/05/2026",
      "Delivery Memphis, TN on 11/06/2026",
      "Loaded miles 450",
      "Linehaul $1,350.00 (450 mi x $3.00)",
      "Fuel surcharge $120.00",
      "Extra stop $75.00",
      "Lumper $50.00",
      "Total $1,595.00",
    ],
    confidence: Object.fromEntries(RATECON_CONFIDENCE_FIELDS.map((f) => [f, "high"])) as RateConReading["confidence"],
    ...over,
  };
}

// The reading as the model's answer text (the schema's own snake_case shape).
export function rateConText(over: Partial<RateConReading> = {}): string {
  return JSON.stringify(rawOfRateCon(rateConReading(over)));
}

// A small PDF whose bytes differ by n, so each call is its own file.
export function rateConPdf(n: number): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n% ratecon test ${n}\n%%EOF`);
}

// A model answer carrying text, as the AI wrapper returns it.
export function rateConResult(text: string, over: Partial<AiResult> = {}): AiResult {
  return {
    callId: "call-ratecon-1",
    status: "ok",
    text,
    toolCalls: [],
    usage: { input: 1_200, cached: 0, output: 600, reasoning: 0 },
    costNanocents: 2_000_000,
    upstreamId: null,
    replay: [],
    toolSearches: 0,
    ...over,
  };
}

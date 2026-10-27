import { carrierBySlug } from "../carriers";
import type { BolDoc, PdfDoc, PhotoDoc, RateConDoc, TenantSlug } from "./manifest";

// What each document says, as plain text lines, built only from its manifest entry (which
// manifest.test.ts proves equal to the seeded row). The PDF renderer, the photo prompt and the
// composed fallback all draw these same strings, so no digit is typed twice.

// $1,234.56 from integer cents.
export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("cents must be a whole number");
  const dollars = Math.floor(cents / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${dollars}.${String(cents % 100).padStart(2, "0")}`;
}

// 71.600 from milligallons.
export function formatGallons(milli: number): string {
  if (!Number.isSafeInteger(milli) || milli < 0) throw new Error("milligallons must be whole");
  return `${Math.floor(milli / 1000)}.${String(milli % 1000).padStart(3, "0")}`;
}

// $4.000 from a price of 400 cents per gallon (pumps print three decimals).
export function formatPricePerGallon(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("cents must be a whole number");
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}0`;
}

// 10/27/2026 from 2026-10-27.
export function mmddyyyy(localDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!m) throw new Error("not a YYYY-MM-DD date");
  return `${m[2]}/${m[3]}/${m[1]}`;
}

export type LocalStamp = { date: string; time: string; zone: string };

// An instant as the carrier's local date (MM/DD/YYYY), time of day (2:20 PM) and zone
// abbreviation (EDT). Assembled from parts with plain spaces, because the formatted string can
// carry a narrow no-break space that Helvetica cannot draw.
export function localStamp(instant: string, timeZone: string): LocalStamp {
  const at = new Date(instant);
  if (!/Z$/.test(instant) || Number.isNaN(at.getTime())) throw new Error("not a UTC instant");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find((p) => p.type === type);
    if (!found) throw new Error(`no ${type} in the formatted time`);
    return found.value;
  };
  return {
    date: `${part("month")}/${part("day")}/${part("year")}`,
    time: `${part("hour")}:${part("minute")} ${part("dayPeriod").toUpperCase()}`,
    zone: part("timeZoneName"),
  };
}

// "10/27/2026 2:20 PM EDT".
export function localStampText(instant: string, timeZone: string): string {
  const s = localStamp(instant, timeZone);
  return `${s.date} ${s.time} ${s.zone}`;
}

export function timeZoneOf(tenant: TenantSlug): string {
  const carrier = carrierBySlug(tenant);
  if (!carrier) throw new Error(`no demo carrier ${tenant}`);
  return carrier.timezone;
}

// The lines a receipt prints, top to bottom. "SAMPLE" is always first.
export function receiptLines(doc: PhotoDoc): string[] {
  const e = doc.expect;
  const date = `Date ${mmddyyyy(e.date)}`;
  const truck = `Truck ${e.truckUnit}`;
  const total = `Total ${formatCents(e.amountCents)}`;
  switch (doc.kind) {
    case "lumper_receipt":
      if (!e.loadNumber) throw new Error(`${doc.id}: a lumper receipt prints its load`);
      return [
        "SAMPLE",
        e.vendor,
        "Lumper service",
        `Load ${e.loadNumber}`,
        truck,
        date,
        total,
        ...(e.paidByDriver ? ["Paid by driver"] : []),
      ];
    case "toll_receipt":
      if (!doc.shows.plaza) throw new Error(`${doc.id}: a toll receipt prints its plaza`);
      return ["SAMPLE", e.vendor, doc.shows.plaza, date, truck, `Toll ${formatCents(e.amountCents)}`];
    case "fuel_receipt":
      if (e.gallonsMilli === null || e.priceCents === null) {
        return ["SAMPLE", e.vendor, date, truck, "Diesel prepaid", total];
      }
      if (!doc.shows.city || !e.state || !e.localTime) {
        throw new Error(`${doc.id}: a pump receipt prints its city, state and time`);
      }
      return [
        "SAMPLE",
        e.vendor,
        `${doc.shows.city}, ${e.state}`,
        `${date} ${e.localTime}`,
        truck,
        `Diesel ${formatGallons(e.gallonsMilli)} gal`,
        `Price ${formatPricePerGallon(e.priceCents)}/gal`,
        total,
        ...(e.paidWith === "company_card" ? ["Fleet card"] : []),
      ];
  }
}

export type PdfField = { label: string; value: string };

export type PdfContent = {
  title: string;
  fields: PdfField[];
  // Rate confirmations: the charges, the last row the total.
  charges: PdfField[];
  // Bills of lading: the four stop times.
  stops: PdfField[];
  signatures: string[];
};

function place(p: { city: string; state: string }): string {
  return `${p.city}, ${p.state}`;
}

function rateConContent(doc: RateConDoc): PdfContent {
  const e = doc.expect;
  return {
    title: "Rate Confirmation",
    fields: [
      { label: "Load", value: e.loadNumber },
      { label: "Customer", value: `${e.customer.name}, ${place(e.customer)}` },
      { label: "Carrier", value: e.carrier },
      { label: "Pickup", value: `${place(e.origin)} on ${mmddyyyy(e.pickupOn)}` },
      { label: "Delivery", value: `${place(e.destination)} on ${mmddyyyy(e.deliveredOn)}` },
      { label: "Truck", value: e.truckUnit },
      { label: "Driver", value: e.driverCode },
      { label: "Loaded miles", value: String(e.loadedMiles) },
    ],
    charges: [
      {
        label: `Linehaul (${e.loadedMiles} mi x ${formatCents(e.ratePerMileCents)})`,
        value: formatCents(e.linehaulCents),
      },
      { label: "Fuel surcharge", value: formatCents(e.fuelSurchargeCents) },
      { label: "Total", value: formatCents(e.totalCents) },
    ],
    stops: [],
    signatures: ["Customer signature", "Carrier signature"],
  };
}

function bolContent(doc: BolDoc): PdfContent {
  const e = doc.expect;
  return {
    title: "Bill of Lading",
    fields: [
      { label: "Load", value: e.loadNumber },
      { label: "Shipper", value: place(e.origin) },
      { label: "Consignee", value: place(e.destination) },
      { label: "Bill to", value: `${e.customer.name}, ${place(e.customer)}` },
      { label: "Carrier", value: e.carrier },
      { label: "Truck", value: e.truckUnit },
      { label: "Driver", value: e.driverCode },
      { label: "Pickup date", value: mmddyyyy(e.pickupOn) },
      { label: "Delivery date", value: mmddyyyy(e.deliveredOn) },
      { label: "Commodity", value: doc.shows.commodity },
      { label: "Pallets", value: String(doc.shows.pallets) },
    ],
    charges: [],
    stops: [
      { label: "Pickup arrived", value: e.stopsLocal.pickupArrivedAt },
      { label: "Pickup departed", value: e.stopsLocal.pickupDepartedAt },
      { label: "Delivery arrived", value: e.stopsLocal.deliveryArrivedAt },
      { label: "Delivery departed", value: e.stopsLocal.deliveryDepartedAt },
    ],
    signatures: ["Shipper signature", "Driver signature", "Consignee signature"],
  };
}

export function pdfContent(doc: PdfDoc): PdfContent {
  return doc.kind === "rate_confirmation" ? rateConContent(doc) : bolContent(doc);
}

// Every string the PDF draws besides the fixed header and footer, in drawing order.
export function textRuns(content: PdfContent): string[] {
  const pairs = (fields: PdfField[]) => fields.flatMap((f) => [f.label, f.value]);
  return [
    content.title,
    ...pairs(content.fields),
    ...(content.charges.length > 0 ? ["Charges", ...pairs(content.charges)] : []),
    ...(content.stops.length > 0 ? ["Stops", ...pairs(content.stops)] : []),
    ...content.signatures,
  ];
}

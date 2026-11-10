// Where a person finds a money fact in their own PayPal account (paypalUrl in openapi.yaml).
//
// PayPal gives the payer and the payee of one payment different transaction ids, and Settld only
// learns the payee's side: the capture, authorization and order ids. Tried in the sandbox on
// 2026-11-07: the buyer opening /activity/payment/{captureId} gets a 404, while the buyer's activity
// searched by that same id finds the payment. So the link depends on who is looking, and the server
// builds it, because only the server knows whose hold a fact belongs to.
import type { PaypalIdKind } from "./ledger-entry.js";

// PAYER: the buyer, whose money it is. PAYEE: the person this hold pays. NONE: a party with no
// record of it in PayPal (the seller looking at a collaborator's hold, or a collaborator at the seller's).
export type PaypalViewer = "PAYER" | "PAYEE" | "NONE";

const DAY_MS = 24 * 60 * 60 * 1_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export function paypalUrl(input: {
  readonly webBase: string | null;
  readonly viewer: PaypalViewer;
  readonly paypalId: string | null;
  readonly paypalIdKind: PaypalIdKind | null;
  readonly occurredAt: Date;
  readonly now: Date;
}): string | null {
  // Without a PayPal environment the ids come from the fake provider: a link would send someone to
  // real PayPal looking for an id that never existed there.
  if (input.webBase === null || input.paypalId === null) return null;
  const id = encodeURIComponent(input.paypalId);
  switch (input.viewer) {
    case "PAYEE":
      // Only a capture: that the merchant page also opens an authorization is not verified yet, and
      // a link that 404s is worse than the id with a copy button.
      return input.paypalIdKind === "CAPTURE" ? `${input.webBase}/activity/payment/${id}` : null;
    case "PAYER": {
      // The buyer's search finds capture and authorization ids, not order ids (tried in the sandbox).
      if (input.paypalIdKind === "ORDER") return null;
      // A day early, because PayPal shows the buyer's local day and occurredAt is UTC. It ends today,
      // not later: PayPal ignores a range that ends in the future and searches only the last 90
      // days, which would lose older payments.
      const start = isoDay(new Date(input.occurredAt.getTime() - DAY_MS));
      return `${input.webBase}/myaccount/activities/?free_text_search=${id}&start_date=${start}&end_date=${isoDay(input.now)}`;
    }
    case "NONE":
      return null;
  }
}

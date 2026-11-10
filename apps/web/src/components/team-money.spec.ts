import { describe, expect, it } from "vitest";
import type { Contract, Milestone } from "@/lib/api-types";
import { ordersToReserve, reserveCopy } from "./team-money";

const seat = (displayName: string, shareBps: number) => ({ displayName, shareBps }) as NonNullable<Contract["team"]>[number];
const team = [seat("Fede", 7000), seat("Ana", 3000)];
const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });
const approved = { state: "APPROVED", amount: usd(1000), holds: [] } as unknown as Milestone;

describe("ordersToReserve", () => {
  const hold = (payeeName: string, shareBps: number, holdStatus: string, funded: number) => ({ payeeUserId: payeeName, payeeName, shareBps, holdStatus, funded: usd(funded), released: usd(0), returned: usd(0) });

  // Live test, 2026-11-07: one click reserved USD 10 across two PayPal pages, and the button
  // named only the first person's USD 7. Every order is listed, so the label can say the total.
  it("before the first /fund there are no holds, so the orders come from the team, seller first", () => {
    expect(ordersToReserve(approved, team)).toEqual([
      { name: "Fede", amountMinor: 700 },
      { name: "Ana", amountMinor: 300 },
    ]);
  });

  it("leaves out what is already reserved", () => {
    const m = { ...approved, holds: [hold("Fede", 7000, "AUTHORIZED", 700), hold("Ana", 3000, "ORDER_CREATED", 0)] } as unknown as Milestone;
    expect(ordersToReserve(m, team)).toEqual([{ name: "Ana", amountMinor: 300 }]);
  });

  it("an expired reservation has to be approved again, for its planned amount", () => {
    const m = { ...approved, holds: [hold("Fede", 7000, "EXPIRED", 0), hold("Ana", 3000, "AUTHORIZED", 300)] } as unknown as Milestone;
    expect(ordersToReserve(m, team)).toEqual([{ name: "Fede", amountMinor: 700 }]);
  });

  it("one person pays the whole milestone, with no list", () => {
    expect(ordersToReserve(approved, [seat("Fede", 10_000)])).toBeNull();
  });
});

describe("reserveCopy", () => {
  it("names the total and each person when nothing is reserved yet", () => {
    const copy = reserveCopy(approved, [{ name: "Priya Shah", amountMinor: 700 }, { name: "Hannah Brooks", amountMinor: 300 }]);
    expect(copy.label).toBe("Reserve $10.00 with PayPal");
    expect(copy.text).toContain("You approve 2 payments in PayPal, one after the other: Priya Shah $7.00, Hannah Brooks $3.00.");
  });

  it("asks only for what is left once part is reserved", () => {
    const copy = reserveCopy(approved, [{ name: "Hannah Brooks", amountMinor: 300 }]);
    expect(copy.label).toBe("Reserve the remaining $3.00 with PayPal");
    expect(copy.text).toContain("You approve 1 payment in PayPal: Hannah Brooks $3.00.");
  });

  it("one person: the whole amount, no list", () => {
    expect(reserveCopy(approved, null)).toEqual({ label: "Reserve $10.00 with PayPal", text: "PayPal reserves the money on your account. Nothing is charged until the work is verified and the countdown ends." });
  });
});

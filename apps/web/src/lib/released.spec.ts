import type { Milestone } from "./api-types";
import { releaseTotals } from "./released";

const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });
type Release = NonNullable<Milestone["releases"]>[number];
type Part = NonNullable<Release["parts"]>[number];
const part = (payeeUserId: string, amount: number, status: Part["status"]): Part => ({ payeeUserId, amount: usd(amount), platformFee: usd(0), status });
const release = (final: boolean, parts: Part[]) => ({ id: "r", seq: 1, amount: usd(0), platformFee: usd(0), countedBps: 0, final, status: "CAPTURED", decidedAt: "", transitionId: "SM-T08", parts }) as unknown as Release;
const m = (releases: Release[] | undefined, extra: Partial<Milestone> = {}) => ({ releases, holdStatus: "AUTHORIZED", amount: usd(1000), ...extra }) as Milestone;

describe("releaseTotals", () => {
  it("separates what PayPal paid, is paying and refused", () => {
    expect(releaseTotals(m([release(false, [part("a", 300, "CAPTURED")]), release(true, [part("a", 200, "PENDING"), part("b", 100, "FAILED")])]))).toEqual({ captured: 300, pending: 200, declined: 100 });
  });

  it("a declined partial part is not money anyone is owed here: it was taken back", () => {
    expect(releaseTotals(m([release(false, [part("a", 300, "FAILED")])]))).toEqual({ captured: 0, pending: 0, declined: 0 });
  });

  it("can look at one person only", () => {
    expect(releaseTotals(m([release(false, [part("a", 300, "CAPTURED"), part("b", 100, "CAPTURED")])]), "b").captured).toBe(100);
  });

  it("does not call a release paid because it was decided", () => {
    expect(releaseTotals(m([release(true, [part("a", 1000, "PENDING")])], { released: usd(1000) })).captured).toBe(0);
  });
});

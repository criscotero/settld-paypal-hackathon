import { totalsByCurrency } from "./totals";

describe("totalsByCurrency", () => {
  it("never adds amounts in different currencies", () => {
    expect(
      totalsByCurrency([
        { amountMinor: 100, currency: "USD" },
        { amountMinor: 250, currency: "EUR" },
        { amountMinor: 50, currency: "USD" },
      ]),
    ).toEqual([
      { amountMinor: 150, currency: "USD" },
      { amountMinor: 250, currency: "EUR" },
    ]);
  });

  it("is empty for no amounts", () => {
    expect(totalsByCurrency([])).toEqual([]);
  });
});

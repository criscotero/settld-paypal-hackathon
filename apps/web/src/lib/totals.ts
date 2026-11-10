import type { Schemas } from "./api-types";

type Money = Schemas["Money"];

// Totals across contracts are per currency: 100 USD + 100 EUR is not 200 of anything.
export function totalsByCurrency(amounts: Money[]): Money[] {
  const sums = new Map<string, number>();
  for (const a of amounts) sums.set(a.currency, (sums.get(a.currency) ?? 0) + a.amountMinor);
  return [...sums].map(([currency, amountMinor]) => ({ amountMinor, currency }));
}

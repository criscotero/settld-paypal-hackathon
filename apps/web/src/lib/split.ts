// Splits an amount among shares in basis points without losing or inventing a cent
// (constitution V: one deterministic rounding rule). Largest remainder: everyone gets the
// floor of their share; the leftover cents go, one each, to the largest remainders, ties to
// the earlier entry. Used by the /mock prototype; the real split arrives with D3.
export function splitLargestRemainder(amountMinor: number, sharesBps: readonly number[]): number[] {
  const total = sharesBps.reduce((a, b) => a + b, 0);
  if (total === 0) return sharesBps.map(() => 0);
  const exact = sharesBps.map((bps, i) => ({ i, floor: Math.floor((amountMinor * bps) / total), rest: (amountMinor * bps) % total }));
  let left = amountMinor - exact.reduce((sum, e) => sum + e.floor, 0);
  const out = exact.map((e) => e.floor);
  for (const e of [...exact].sort((a, b) => b.rest - a.rest || a.i - b.i)) {
    if (left === 0) break;
    out[e.i] = (out[e.i] ?? 0) + 1;
    left--;
  }
  return out;
}

// The split Core API uses for a team's holds (domain-model.md, Hold.fundedMinor): everyone gets
// the floor of their share and the leftover cents go to the first entry, the seller. Only for
// showing what each order will be before PayPal authorizes it; the authorized amounts come from
// Core API. Not largest remainder: the web must show the amounts PayPal will actually ask for.
export function splitRemainderToSeller(amountMinor: number, sharesBps: readonly number[]): number[] {
  const out = sharesBps.map((bps) => Math.floor((amountMinor * bps) / 10_000));
  if (out.length > 0) out[0] = (out[0] ?? 0) + amountMinor - out.reduce((a, b) => a + b, 0);
  return out;
}

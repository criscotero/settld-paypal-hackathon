// Criterion weights (ADR-0007): people type percentages, the contract stores basis points
// (1 bp = 0.01%, 100% = 10 000). Integers end to end, like money (constitution V).

export type ParsedWeight = { ok: true; bps: number } | { ok: false; reason: string };

// "33.34" -> 3334. Parsed as text, never through a float: 0.1 + 0.2 must not become 30.000000000000004%.
export function parseWeightPercent(input: string): ParsedWeight {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (m === null) return { ok: false, reason: "Use a percentage like 25 or 33.34" };
  const bps = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (bps < 1 || bps > 10_000) return { ok: false, reason: "Between 0.01% and 100%" };
  return { ok: true, bps };
}

export function formatWeight(bps: number): string {
  const whole = Math.floor(bps / 100);
  const cents = bps % 100;
  return cents === 0 ? String(whole) : `${String(whole)}.${String(cents).padStart(2, "0")}`;
}

// Equal shares that add up to exactly 10 000: the leftover basis points go to the first
// criteria, one each. Same rule as the demo seed.
export function evenWeights(n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(10_000 / n);
  return Array.from({ length: n }, (_, i) => base + (i < 10_000 - base * n ? 1 : 0));
}

// Release countdown (terms.releaseCountdownSeconds), in the largest whole unit that fits.
export function formatCountdown(seconds: number): string {
  const plural = (n: number, unit: string) => `${String(n)} ${unit}${n === 1 ? "" : "s"}`;
  if (seconds % 86_400 === 0) return plural(seconds / 86_400, "day");
  if (seconds % 3_600 === 0) return plural(seconds / 3_600, "hour");
  if (seconds % 60 === 0) return plural(seconds / 60, "minute");
  return plural(seconds, "second");
}

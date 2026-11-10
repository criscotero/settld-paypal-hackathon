// Money is integer minor units plus currency (openapi.yaml: Money). The UI is the
// only place where people type decimals, so this is the only place that converts.
// Everything here is string arithmetic: parseFloat("10.1") * 100 is 1009.999...,
// and Math.round hides that bug until an amount where rounding goes the wrong way.
import type { Schemas } from "./api-types";

type Money = Schemas["Money"];

export function minorDigits(currency: string): number {
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

export type ParsedMoney = { ok: true; amountMinor: number } | { ok: false; reason: string };

export function parseMoney(input: string, currency: string): ParsedMoney {
  const digits = minorDigits(currency);
  const clean = input.trim().replaceAll(",", "");
  const match = /^(\d+)(?:\.(\d*))?$/.exec(clean);
  if (match === null) return { ok: false, reason: "Enter a positive amount, like 1500 or 1500.50" };
  const [, whole = "", frac = ""] = match;
  if (frac.length > digits) return { ok: false, reason: digits === 0 ? `${currency} has no decimals` : `${currency} allows ${String(digits)} decimals` };
  // BigInt so the overflow check itself cannot lose precision.
  const minor = BigInt(whole + frac.padEnd(digits, "0"));
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, reason: "Amount is too large" };
  return { ok: true, amountMinor: Number(minor) };
}

export function toMajorString(amountMinor: number, currency: string): string {
  const digits = minorDigits(currency);
  if (digits === 0) return String(amountMinor);
  const s = String(amountMinor).padStart(digits + 1, "0");
  return `${s.slice(0, -digits)}.${s.slice(-digits)}`;
}

export function formatMoney(money: Money, locale = "en-US"): string {
  // Intl accepts a decimal string and formats it exactly, so no float on the way out either.
  const decimal = toMajorString(money.amountMinor, money.currency) as `${number}`;
  return new Intl.NumberFormat(locale, { style: "currency", currency: money.currency }).format(decimal);
}

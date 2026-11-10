// Milestone due dates are calendar dates (openapi.yaml: format date), not instants.
// Formatting them in UTC keeps "2026-10-30" on the 30th in every time zone; a local
// Date would show the 29th to anyone west of Greenwich.
const DAY_MS = 86_400_000;

export function formatDate(isoDate: string, locale = "en-US"): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${isoDate}T00:00:00Z`));
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function relativeDays(isoDate: string, today = todayIso()): string {
  const days = Math.round((Date.parse(`${isoDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days > 1) return `in ${String(days)} days`;
  return `${String(-days)} day${days === -1 ? "" : "s"} overdue`;
}

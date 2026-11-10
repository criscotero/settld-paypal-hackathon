// Core API reports VALIDATION_FAILED issues with zod paths (errors.md, context.issues).
// This renames them to the labels on the form so people can find the field.
const FIELD: Record<string, string> = {
  title: "title",
  text: "text",
  description: "description",
  dueDate: "due date",
  amount: "amount",
  checkType: "verification",
  checkConfig: "verification settings",
  weightBps: "weight",
};

export function friendlyPath(path: string): string {
  if (path === "title") return "Contract title";
  if (path === "terms.releaseCountdownSeconds") return "Release countdown";
  const m = /^milestones\.(\d+)(?:\.criteria\.(\d+))?\.(\w+)/.exec(path);
  if (m === null) return path;
  const [, mi = "0", ci, field = ""] = m;
  const parts = [`Milestone ${String(Number(mi) + 1)}`];
  if (ci !== undefined) parts.push(`criterion ${String(Number(ci) + 1)}`);
  parts.push(FIELD[field] ?? field);
  return parts.join(" › ");
}

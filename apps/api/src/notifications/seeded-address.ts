// Addresses that the seed scripts invent (db/dev-users.ts, db/seed-demo*.cli.ts). Nobody reads
// them, and settld.app is not a domain whose mail we control: a mail to admin@dev.settld.app
// bounced back to the sender's inbox (2026-11-06), and could reach a stranger if that host ever
// accepted mail. So they are recorded SUPPRESSED instead of sent. test.settld.app is left out on
// purpose: only the e2e tests use it, with a fake sender that never leaves the process.
const SEEDED_DOMAINS = ["dev.settld.app", "demo.settld.app"];

export function isSeededAddress(email: string): boolean {
  const domain = email.trim().toLowerCase().split("@").at(-1) ?? "";
  // A subdomain too: seed-demo.cli.ts uses maya@northwindlabs.demo.settld.app.
  return SEEDED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

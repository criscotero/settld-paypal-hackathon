// Past contracts for the demo, on the local database the app runs on, so the dashboards have a
// history to show. Added to what is there; nothing existing is touched.
//
// This is invented data, and it must never look like anything else:
// - Only settled history: nothing here has a live PayPal authorization, so no job, button or
//   worker can ever try to move this money. The contracts that are still open are unfunded, and
//   funding one later goes to PayPal for real.
// - No payment_events rows: that ledger mirrors PayPal, and PayPal never saw these. A receipt shows
//   no PayPal ids for them, instead of ids that do not exist. Authorization and capture ids on the
//   other tables start with DEMO.
// - Every id ends in de0de0de0de0, and scripts/demo_history_undo.sql removes exactly those.
// - The extra people cannot be found or paid: no Clerk login, not in the directory, not receivable.
//
// Written directly, like seed-demo.cli.ts: the use cases cannot create a contract in the past.
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { contractView } from "../contracts/contract-view.js";
import { buildSnapshot, hashSnapshot } from "../contracts/snapshot.js";
import { splitFunding } from "../payments/holds.js";
import { createDb, createPool } from "./database.js";
import type { Db } from "./database.js";
import { contractApprovals, contractParties, contracts, contractVersions, holds, milestones, releaseParts, releases, submissions, users } from "./schema.js";

const url = process.env.CORE_DATABASE_URL;
if (url === undefined) throw new Error("CORE_DATABASE_URL is not set");
const target = new URL(url);
if (!["127.0.0.1", "localhost"].includes(target.hostname) || target.pathname !== "/settld" || process.env.NODE_ENV === "production") {
  throw new Error(`This seed only writes to the local settld database, got ${target.hostname}${target.pathname}.`);
}

const NOW = new Date();
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

// A UUIDv7 stamped with `when`, so a past contract sorts as past (lists order by id), and marked,
// so it can be removed.
const MARK = "de0de0de0de0";
function demoId(when: Date): string {
  const time = when.getTime().toString(16).padStart(12, "0");
  const r = randomBytes(3).toString("hex");
  return `${time.slice(0, 8)}-${time.slice(8)}-7${r.slice(0, 3)}-8${r.slice(3)}-${MARK}`;
}

const BUYER_EMAIL = "criscotero+clerk_test_buyer@gmail.com";
const SELLER_EMAIL = "criscotero+clerk_test_seller@gmail.com";
const COLLAB_EMAIL = "criscotero+clerk_test_collab@gmail.com";

interface Person {
  key: string;
  name: string;
  business: string;
  roles: string[];
  profession: "SOFTWARE_DEVELOPER" | "PRODUCT_MANAGER" | "COPYWRITER" | "AI_ENGINEER";
}
const EXTRA_PEOPLE: Person[] = [
  { key: "olivia", name: "Olivia Bennett", business: "Bennett Home Goods LLC", roles: ["BUYER"], profession: "PRODUCT_MANAGER" },
  { key: "ryan", name: "Ryan Walsh", business: "Walsh Fitness Inc", roles: ["BUYER"], profession: "PRODUCT_MANAGER" },
  { key: "hannah", name: "Hannah Brooks", business: "Brooks Dental Group", roles: ["BUYER"], profession: "PRODUCT_MANAGER" },
  { key: "priya", name: "Priya Nair", business: "Nair Software LLC", roles: ["SELLER"], profession: "SOFTWARE_DEVELOPER" },
  { key: "marcus", name: "Marcus Lee", business: "Lee Content Co", roles: ["SELLER"], profession: "COPYWRITER" },
];

type Outcome = { paid: number } | { partOf: number; paid: number; closed: number } | { cancelled: number };
interface MilestoneSpec {
  title: string;
  description: string;
  amount: number;
  outcome: Outcome;
  criteria: { text: string; level: "AUTOMATIC" | "AI_EVALUATED" | "HUMAN"; weightBps: number; required?: boolean; url?: string }[];
}
interface ContractSpec {
  title: string;
  description: string;
  buyer: string;
  seller: string;
  collaboratorBps?: number;
  created: number;
  milestones: MilestoneSpec[];
}

const live = (url: string): MilestoneSpec["criteria"][number] => ({ text: "The site answers at the agreed address", level: "AUTOMATIC", weightBps: 6_000, url });
const signoff = (text: string, weightBps = 4_000): MilestoneSpec["criteria"][number] => ({ text, level: "HUMAN", weightBps });
const optional = (text: string, weightBps = 4_000): MilestoneSpec["criteria"][number] => ({ text, level: "HUMAN", weightBps, required: false });

const HISTORY: ContractSpec[] = [
  { title: "Bennett Home Goods storefront", description: "New online store on Shopify Hydrogen, with product filters and a faster checkout.", buyer: "olivia", seller: "sarah", collaboratorBps: 3_000, created: 158, milestones: [
    { title: "Design and page templates", description: "Home, listing and product page templates.", amount: 180_000, outcome: { paid: 137 }, criteria: [live("https://staging.bennetthome.example"), signoff("Buyer approves the visual direction")] },
    { title: "Checkout and launch", description: "One-page checkout, redirects from the old store and launch.", amount: 240_000, outcome: { paid: 118 }, criteria: [live("https://bennetthome.example/checkout"), signoff("A test order reaches the fulfillment queue")] },
  ] },
  { title: "Walsh Fitness class booking", description: "Class schedule and booking for four gyms, connected to the existing member database.", buyer: "ryan", seller: "sarah", created: 131, milestones: [
    { title: "Schedule and booking flow", description: "Members see the schedule and reserve a place.", amount: 150_000, outcome: { paid: 104 }, criteria: [live("https://book.walshfitness.example"), signoff("A member books a class on a phone")] },
  ] },
  { title: "Johnson Digital marketing site", description: "Company site with case studies and a contact form.", buyer: "michael", seller: "sarah", created: 112, milestones: [
    { title: "Site build", description: "Five pages and the case study template.", amount: 120_000, outcome: { paid: 96 }, criteria: [live("https://johnsondigital.example"), signoff("Buyer approves the copy in place")] },
    { title: "Blog and analytics", description: "Blog with an editor, and privacy-friendly analytics.", amount: 60_000, outcome: { paid: 84 }, criteria: [live("https://johnsondigital.example/blog"), signoff("Buyer publishes a post alone")] },
  ] },
  { title: "Product launch copy", description: "Landing page and email sequence for a new subscription.", buyer: "michael", seller: "marcus", created: 95, milestones: [
    { title: "Landing page copy", description: "Headline, sections and three variations.", amount: 90_000, outcome: { paid: 79 }, criteria: [{ text: "Covers every section in the brief", level: "AI_EVALUATED", weightBps: 4_000 }, signoff("Buyer picks the final version", 6_000)] },
  ] },
  { title: "Brooks Dental appointment portal", description: "Online appointments and reminders for three clinics.", buyer: "hannah", seller: "sarah", collaboratorBps: 2_500, created: 88, milestones: [
    { title: "Patient booking", description: "New and returning patients request an appointment.", amount: 210_000, outcome: { paid: 63 }, criteria: [live("https://portal.brooksdental.example"), signoff("Front desk confirms a request")] },
    { title: "Reminders and staff calendar", description: "SMS reminders, plus a calendar for staff.", amount: 160_000, outcome: { partOf: 6_000, paid: 41, closed: 33 }, criteria: [live("https://portal.brooksdental.example/staff"), optional("Reminders go out in Spanish too")] },
  ] },
  { title: "Inventory sync for Johnson Digital", description: "Nightly sync between the store and the warehouse system.", buyer: "michael", seller: "priya", collaboratorBps: 2_000, created: 72, milestones: [
    { title: "Sync service", description: "Stock and price sync, with a failure report.", amount: 200_000, outcome: { paid: 52 }, criteria: [live("https://sync.johnsondigital.example/health"), signoff("Stock matches after one night")] },
  ] },
  { title: "Walsh Fitness member app", description: "Mobile-first member area: passes, classes and payments.", buyer: "ryan", seller: "sarah", created: 66, milestones: [
    { title: "Member area", description: "Sign-in, digital pass and booked classes.", amount: 190_000, outcome: { paid: 38 }, criteria: [live("https://members.walshfitness.example"), signoff("A member enters with the digital pass")] },
    { title: "Payments", description: "Moved to another vendor before work started.", amount: 110_000, outcome: { cancelled: 30 }, criteria: [live("https://members.walshfitness.example/billing"), signoff("A renewal goes through")] },
  ] },
  { title: "Bennett Home Goods holiday campaign", description: "Gift guide and campaign pages for the holidays.", buyer: "olivia", seller: "sarah", collaboratorBps: 3_000, created: 44, milestones: [
    { title: "Gift guide", description: "Filterable gift guide, with campaign tracking.", amount: 130_000, outcome: { paid: 21 }, criteria: [live("https://bennetthome.example/gifts"), signoff("Buyer approves the final layout")] },
  ] },
  { title: "Johnson Digital customer portal", description: "Customers see orders, invoices and support tickets.", buyer: "michael", seller: "sarah", collaboratorBps: 2_000, created: 37, milestones: [
    { title: "Orders and invoices", description: "Order history and invoice downloads.", amount: 170_000, outcome: { paid: 12 }, criteria: [live("https://portal.johnsondigital.example"), signoff("A customer downloads an invoice")] },
  ] },
  { title: "Help center articles", description: "Twenty support articles from existing tickets.", buyer: "michael", seller: "marcus", created: 24, milestones: [
    { title: "Articles", description: "Twenty articles, reviewed by support.", amount: 70_000, outcome: { paid: 8 }, criteria: [{ text: "Every article has steps and a screenshot", level: "AI_EVALUATED", weightBps: 4_000 }, signoff("Support approves them", 6_000)] },
  ] },
];

// Still open, and real: both parties can act on these, and funding one goes to PayPal for real.
const OPEN: { title: string; description: string; status: "LOCKED" | "PENDING_APPROVAL" | "DRAFT"; approvedBy: ("BUYER" | "SELLER")[]; created: number; milestone: MilestoneSpec }[] = [
  { title: "Johnson Digital analytics dashboard", description: "Sales and traffic in one place for the leadership team.", status: "LOCKED", approvedBy: ["BUYER", "SELLER"], created: 6, milestone: { title: "Sales dashboard", description: "Daily sales, top products and traffic sources.", amount: 150_000, outcome: { paid: 0 }, criteria: [live("https://bi.johnsondigital.example"), signoff("Buyer checks the numbers against the books")] } },
  { title: "Johnson Digital newsletter templates", description: "Three reusable email templates.", status: "PENDING_APPROVAL", approvedBy: ["BUYER"], created: 3, milestone: { title: "Email templates", description: "Announcement, digest and promotion.", amount: 120_000, outcome: { paid: 0 }, criteria: [live("https://johnsondigital.example/email-preview"), signoff("Buyer sends a test to three mail apps")] } },
  { title: "Johnson Digital referral page", description: "A page and a small form for customer referrals.", status: "DRAFT", approvedBy: [], created: 1, milestone: { title: "Referral page", description: "Page, form and thank-you email.", amount: 90_000, outcome: { paid: 0 }, criteria: [live("https://johnsondigital.example/refer"), signoff("Buyer sends a test referral")] } },
];

type Ids = Record<string, { id: string; merchant: string | null }>;

async function people(db: Db): Promise<Ids> {
  const ids: Ids = {};
  for (const [key, email] of [["michael", BUYER_EMAIL], ["sarah", SELLER_EMAIL], ["david", COLLAB_EMAIL]] as const) {
    const [u] = await db.select().from(users).where(eq(users.email, email));
    if (u === undefined) throw new Error(`${email} does not exist: this seed adds to your test accounts`);
    ids[key] = { id: u.id, merchant: u.paypalMerchantId };
  }
  for (const p of EXTRA_PEOPLE) {
    const id = demoId(ago(200));
    const merchant = p.roles.includes("SELLER") ? `DEMO-${p.key.toUpperCase()}` : null;
    await db.insert(users).values({ id, email: `${p.key}@demo.settld.app`, displayName: p.name, fullName: p.name, roles: p.roles, country: "US", accountType: "BUSINESS", businessName: p.business, termsAcceptedAt: ago(200), onboardingCompletedAt: ago(200), professions: [p.profession], paypalMerchantId: merchant, paypalPaymentsReceivable: false, inDirectory: false });
    ids[p.key] = { id, merchant };
  }
  return ids;
}

function snapshotOf(spec: { title: string; description: string; milestones: MilestoneSpec[]; created: number; collaborator?: string; collaboratorBps?: number }, due: (m: MilestoneSpec) => Date) {
  const created = ago(spec.created);
  const team = spec.collaborator === undefined || spec.collaboratorBps === undefined ? undefined : [{ userId: null, role: "Lead developer", shareBps: 10_000 - spec.collaboratorBps }, { userId: spec.collaborator, role: "Product Designer", shareBps: spec.collaboratorBps }];
  return buildSnapshot(
    {
      title: spec.title,
      description: spec.description,
      currency: "USD",
      terms: { releaseCountdownSeconds: 172_800, silenceIsApproval: true, fundingMode: "ONE_AT_A_TIME" },
      milestones: spec.milestones.map((m) => ({
        title: m.title,
        description: m.description,
        amount: { amountMinor: m.amount, currency: "USD" },
        dueDate: isoDate(due(m)),
        criteria: m.criteria.map((c) => ({ text: c.text, level: c.level, weightBps: c.weightBps, required: c.required ?? true, checkType: c.level === "AUTOMATIC" ? "HTTP_PROBE" : c.level === "AI_EVALUATED" ? "AI_REQUIREMENT_MET" : null, checkConfig: c.url === undefined ? null : { url: c.url, method: "GET", expectStatus: 200 } })),
      })),
      ...(team === undefined ? {} : { team }),
    } as never,
    { platformFeeBps: 0, newId: () => demoId(created), knownMilestoneIds: new Set(), knownCriterionIds: new Set() },
  );
}

const lastDay = (o: Outcome) => ("paid" in o && !("partOf" in o) ? o.paid : "partOf" in o ? o.paid : o.cancelled);

async function seedHistory(db: Db, spec: ContractSpec, ids: Ids) {
  const buyer = ids[spec.buyer];
  const seller = ids[spec.seller];
  const david = ids.david;
  if (buyer === undefined || seller === undefined || david === undefined) throw new Error("unknown person");
  const created = ago(spec.created);
  const snapshot = snapshotOf({ ...spec, ...(spec.collaboratorBps === undefined ? {} : { collaborator: david.id }) }, (m) => ago(lastDay(m.outcome) + 2));
  const hash = hashSnapshot(snapshot);
  const members = spec.collaboratorBps === undefined ? [{ user: seller, bps: 10_000, isSeller: true }] : [{ user: seller, bps: 10_000 - spec.collaboratorBps, isSeller: true }, { user: david, bps: spec.collaboratorBps, isSeller: false }];

  await db.transaction(async (tx) => {
    const contractId = demoId(created);
    await tx.insert(contracts).values({ id: contractId, buyerId: buyer.id, sellerId: seller.id, createdAt: created, updatedAt: created });
    const versionId = demoId(created);
    await tx.insert(contractVersions).values({ id: versionId, contractId, version: 1, status: "LOCKED", snapshot, snapshotHash: hash, createdBy: { type: "USER" as const, id: buyer.id }, createdAt: created });
    await tx.update(contracts).set({ currentVersionId: versionId, lockedVersionId: versionId }).where(eq(contracts.id, contractId));
    if (spec.collaboratorBps !== undefined) await tx.insert(contractParties).values({ contractId, userId: david.id, invitedBy: seller.id, invitedAt: created });
    const approvals = [["BUYER", buyer.id], ["SELLER", seller.id], ...(spec.collaboratorBps === undefined ? [] : [["COLLABORATOR", david.id]])] as ["BUYER" | "SELLER" | "COLLABORATOR", string][];
    for (const [partyRole, userId] of approvals) await tx.insert(contractApprovals).values({ contractVersionId: versionId, snapshotHash: hash, partyRole, userId, approvedAt: new Date(created.getTime() + DAY) });

    for (const [i, m] of spec.milestones.entries()) {
      const def = snapshot.milestones[i];
      if (def === undefined) throw new Error("snapshot lost a milestone");
      const o = m.outcome;
      const cancelled = "cancelled" in o;
      const closed = "partOf" in o;
      const bps = closed ? o.partOf : cancelled ? 0 : 10_000;
      const shares = splitFunding(m.amount, members.map((x) => ({ shareBps: x.bps, isSeller: x.isSeller })));
      const parts = shares.map((s) => (bps === 10_000 ? s : Math.floor((s * bps) / 10_000)));
      const released = parts.reduce((a, b) => a + b, 0);
      const when = ago(lastDay(o));
      const funded = new Date(created.getTime() + 2 * DAY);
      const runId = cancelled ? null : demoId(when);
      await tx.insert(milestones).values({
        id: def.id,
        contractId,
        state: cancelled ? "VOIDED" : closed ? "CLOSED" : "RELEASED",
        holdStatus: cancelled || closed ? "VOIDED" : "CAPTURED",
        fundedMinor: m.amount,
        releasedMinor: released,
        returnedMinor: m.amount - released,
        lockedVersionId: versionId,
        stateVersion: 7,
        latestRunId: runId,
        authorizationExpiresAt: new Date(funded.getTime() + 29 * DAY),
        createdAt: created,
      });
      const holdIds: string[] = [];
      for (const [position, member] of members.entries()) {
        const holdId = demoId(funded);
        holdIds.push(holdId);
        await tx.insert(holds).values({ id: holdId, milestoneId: def.id, payeeUserId: member.user.id, payeeMerchantId: member.user.merchant ?? "DEMO", position, shareBps: member.bps, fundedMinor: shares[position] ?? 0, releasedMinor: parts[position] ?? 0, returnedMinor: (shares[position] ?? 0) - (parts[position] ?? 0), holdStatus: cancelled || closed ? "VOIDED" : "CAPTURED", paypalOrderId: `DEMO-ORDER-${holdId.slice(-20, -13)}`, authorizationId: `DEMO-AUTH-${holdId.slice(-20, -13)}`, authorizedAt: funded, authorizationExpiresAt: new Date(funded.getTime() + 29 * DAY), createdAt: funded });
      }
      if (runId === null) continue;
      await tx.insert(submissions).values({ id: demoId(when), milestoneId: def.id, attempt: 1, evidenceLinks: [{ kind: "URL", url: m.criteria.find((c) => c.url !== undefined)?.url ?? "https://delivery.example" }], notes: "Delivered as agreed. Ready for review.", submittedBy: seller.id, runId, submittedAt: new Date(when.getTime() - 2 * DAY) });
      const counted = closed ? def.criteria.filter((c) => c.required).map((c) => c.id) : def.criteria.map((c) => c.id);
      const releaseId = demoId(when);
      await tx.insert(releases).values({ id: releaseId, milestoneId: def.id, seq: 1, transitionId: closed ? "SM-T18" : "SM-T08", amountMinor: released, currency: "USD", platformFeeMinor: 0, countedBps: bps, countedCriterionIds: counted, final: !closed, status: "CAPTURED", captureId: `DEMO-CAP-${releaseId.slice(-20, -13)}`, decidedAt: when, updatedAt: when });
      for (const [position, holdId] of holdIds.entries()) {
        const amount = parts[position] ?? 0;
        if (amount > 0) await tx.insert(releaseParts).values({ id: demoId(when), releaseId, holdId, amountMinor: amount, platformFeeMinor: 0, status: "CAPTURED", captureId: `DEMO-CAP-${holdId.slice(-20, -13)}`, updatedAt: when });
      }
    }
  });
}

async function seedOpen(db: Db, spec: (typeof OPEN)[number], ids: Ids) {
  const buyer = ids.michael;
  const seller = ids.sarah;
  if (buyer === undefined || seller === undefined) throw new Error("unknown person");
  const created = ago(spec.created);
  const snapshot = snapshotOf({ ...spec, milestones: [spec.milestone] }, () => new Date(NOW.getTime() + 21 * DAY));
  const hash = spec.status === "DRAFT" ? null : hashSnapshot(snapshot);
  const def = snapshot.milestones[0];
  if (def === undefined) throw new Error("snapshot lost a milestone");
  await db.transaction(async (tx) => {
    const contractId = demoId(created);
    await tx.insert(contracts).values({ id: contractId, buyerId: buyer.id, sellerId: seller.id, createdAt: created, updatedAt: created });
    const versionId = demoId(created);
    await tx.insert(contractVersions).values({ id: versionId, contractId, version: 1, status: spec.status, snapshot, snapshotHash: hash, createdBy: { type: "USER" as const, id: buyer.id }, createdAt: created });
    await tx.update(contracts).set({ currentVersionId: versionId, lockedVersionId: spec.status === "LOCKED" ? versionId : null }).where(eq(contracts.id, contractId));
    if (hash !== null) for (const role of spec.approvedBy) await tx.insert(contractApprovals).values({ contractVersionId: versionId, snapshotHash: hash, partyRole: role, userId: role === "BUYER" ? buyer.id : seller.id, approvedAt: created });
    await tx.insert(milestones).values({ id: def.id, contractId, state: spec.status === "LOCKED" ? "APPROVED" : "DRAFT", holdStatus: "NONE", lockedVersionId: spec.status === "LOCKED" ? versionId : null, stateVersion: spec.status === "LOCKED" ? 1 : 0, createdAt: created });
  });
}

const pool = createPool(url);
try {
  const db = createDb(pool);
  const marked = await db.select({ id: users.id }).from(users).where(eq(users.email, "olivia@demo.settld.app"));
  if (marked.length > 0) throw new Error("The demo history is already here. Remove it first with scripts/demo_history_undo.sql.");
  const ids = await people(db);
  for (const spec of HISTORY) await seedHistory(db, spec, ids);
  for (const spec of OPEN) await seedOpen(db, spec, ids);

  // The same read the screens use: if a row is wrong, this throws here and not on the demo.
  const all = await db.select().from(contracts);
  const seen = all.filter((c) => c.id.endsWith(MARK));
  for (const c of seen) await contractView(db, c, c.buyerId);
  console.log(`Added ${String(seen.length)} contracts and ${String(EXTRA_PEOPLE.length)} people.`);
} finally {
  await pool.end();
}

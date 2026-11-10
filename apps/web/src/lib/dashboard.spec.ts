import type { Contract, Milestone } from "./api-types";
import { actionCount, availableViews, buildDashboard, greetingRole, moneyBuckets, niceCeiling, paidHistory, PARTY_ROLE_LABEL } from "./dashboard";

let n = 0;
function milestone(state: Milestone["state"], holdStatus: Milestone["holdStatus"], actor: Milestone["nextStep"]["actor"], amount = 1000, currency = "USD", dueDate = "2026-11-01"): Milestone {
  n += 1;
  return { id: `m${String(n)}`, contractId: "c", title: `M${String(n)}`, amount: { amountMinor: amount, currency }, dueDate, state, holdStatus, stateVersion: 0, nextStep: { actor, kind: "X" } };
}

function contract(myRole: Contract["myRole"], milestones: Milestone[], status: Contract["status"] = "LOCKED", approvals: Contract["currentVersion"]["approvals"] = []): Contract {
  n += 1;
  return {
    id: `c${String(n)}`,
    title: `Contract ${String(n)}`,
    status,
    myRole,
    counterpartyName: "Other",
    publishedUntil: null,
    total: { amountMinor: 0, currency: "USD" },
    currentVersion: { id: "v", version: 1, status: status === "PENDING_APPROVAL" ? "PENDING_APPROVAL" : "LOCKED", snapshot: {} as never, snapshotHash: "sha256:h", approvals },
    milestones,
  };
}

describe("moneyBuckets", () => {
  it("splits by hold status and never mixes currencies", () => {
    const c = contract("BUYER", [
      milestone("RELEASED", "CAPTURED", "NONE", 500),
      milestone("IN_PROGRESS", "AUTHORIZED", "SELLER", 300),
      milestone("APPROVED", "NONE", "BUYER", 200),
      milestone("DRAFT", "NONE", "NONE", 999),
      milestone("VOIDED", "VOIDED", "NONE", 999),
      milestone("RELEASED", "CAPTURED", "NONE", 700, "EUR"),
    ]);
    expect(moneyBuckets([c], "BUYER", "me")).toEqual([
      { currency: "USD", paid: 500, reserved: 300, unfunded: 200 },
      { currency: "EUR", paid: 700, reserved: 0, unfunded: 0 },
    ]);
  });
});

describe("moneyBuckets with partial releases (ADR-0007)", () => {
  it("counts a milestone that is partly paid and partly reserved in both buckets", () => {
    const partial = { ...milestone("PARTIALLY_RELEASED", "AUTHORIZED", "SELLER", 500), released: { amountMinor: 450, currency: "USD" }, held: { amountMinor: 50, currency: "USD" } };
    expect(moneyBuckets([contract("BUYER", [partial])], "BUYER", "me")).toEqual([{ currency: "USD", paid: 450, reserved: 50, unfunded: 0 }]);
  });

  // H2 review: an order opened at PayPal but not approved used to vanish from every bucket.
  it("keeps an order the buyer has not approved yet as unfunded", () => {
    const opened = { ...milestone("APPROVED", "ORDER_CREATED", "BUYER", 200), funded: { amountMinor: 0, currency: "USD" }, held: { amountMinor: 0, currency: "USD" } };
    expect(moneyBuckets([contract("BUYER", [opened])], "BUYER", "me")).toEqual([{ currency: "USD", paid: 0, reserved: 0, unfunded: 200 }]);
  });
});

// Audit findings 12 and 13: the panel called money paid because it had been decided.
describe("paid means PayPal captured it", () => {
  const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });
  type Release = NonNullable<Milestone["releases"]>[number];
  type Part = NonNullable<Release["parts"]>[number];
  const release = (final: boolean, amount: number, status: Part["status"]) =>
    ({ id: "r", seq: 1, amount: usd(amount), platformFee: usd(0), countedBps: 0, final, status, decidedAt: "", transitionId: "SM-T08", parts: [{ payeeUserId: "s", amount: usd(amount), platformFee: usd(0), status }] }) as unknown as Release;
  const withMoney = (state: Milestone["state"], holdStatus: Milestone["holdStatus"], funded: number, returned: number, releases: Release[]): Milestone => ({
    ...milestone(state, holdStatus, "NONE", 1000),
    funded: usd(funded),
    returned: usd(returned),
    released: usd(releases.reduce((a, r) => a + r.amount.amountMinor, 0)),
    releases,
  });
  const buckets = (m: Milestone) => moneyBuckets([contract("BUYER", [m])], "BUYER", "me");

  it("a capture in progress is still reserved, not paid", () => {
    expect(buckets(withMoney("RELEASED", "CAPTURE_PENDING", 1000, 0, [release(true, 1000, "PENDING")]))).toEqual([{ currency: "USD", paid: 0, reserved: 1000, unfunded: 0 }]);
  });

  it("a declined final capture is not paid", () => {
    expect(buckets(withMoney("RELEASED", "CAPTURE_FAILED", 1000, 0, [release(true, 1000, "FAILED")]))).toEqual([]);
  });

  it("a milestone closed in part shows what was paid, not the whole amount", () => {
    const closed = withMoney("CLOSED", "VOIDED", 1000, 400, [release(false, 600, "CAPTURED")]);
    expect(buckets(closed)).toEqual([{ currency: "USD", paid: 600, reserved: 0, unfunded: 0 }]);
    expect(buildDashboard([contract("BUYER", [closed])], "BUYER", "me").recentlyPaid[0]?.paid).toEqual(usd(600));
  });

  it("nothing captured yet is not recently paid", () => {
    const paying = withMoney("RELEASED", "CAPTURE_PENDING", 1000, 0, [release(true, 1000, "PENDING")]);
    expect(buildDashboard([contract("BUYER", [paying])], "BUYER", "me").recentlyPaid).toHaveLength(0);
  });

  it("a milestone funded in part counts what is reserved and what is missing", () => {
    const part = { ...milestone("APPROVED", "ORDER_CREATED", "BUYER", 1000), funded: usd(700), returned: usd(0), releases: [] };
    expect(buckets(part)).toEqual([{ currency: "USD", paid: 0, reserved: 700, unfunded: 300 }]);
  });

  it("an expired reservation is not reserved", () => {
    expect(buckets(withMoney("OBJECTED", "EXPIRED", 1000, 0, []))).toEqual([]);
  });
});

describe("buildDashboard", () => {
  const mine = milestone("APPROVED", "NONE", "BUYER", 100, "USD", "2026-11-05");
  const theirs = milestone("IN_PROGRESS", "AUTHORIZED", "SELLER", 100, "USD", "2026-11-02");
  const asBuyer = contract("BUYER", [mine, theirs, milestone("RELEASED", "CAPTURED", "NONE")]);
  const asSeller = contract("SELLER", [milestone("FUNDED", "AUTHORIZED", "SELLER")]);
  const pending = contract("BUYER", [milestone("DRAFT", "NONE", "SELLER")], "PENDING_APPROVAL", [
    { partyRole: "SELLER", userId: "f", approvedAt: "2026-10-01T00:00:00Z", snapshotHash: "sha256:h" },
  ]);

  it("only looks at contracts where the viewer has that role", () => {
    const d = buildDashboard([asBuyer, asSeller, pending], "BUYER", "me");
    expect(d.contracts.map((c) => c.id)).toEqual([asBuyer.id, pending.id]);
  });

  it("puts the viewer's steps in 'my' and everyone else's in 'waiting'", () => {
    const d = buildDashboard([asBuyer], "BUYER", "me");
    expect(d.myMilestones.map((r) => r.milestone.id)).toEqual([mine.id]);
    expect(d.waiting.map((r) => r.milestone.id)).toEqual([theirs.id]);
  });

  it("asks for an approval only when the viewer has not approved this hash", () => {
    expect(buildDashboard([pending], "BUYER", "me").myApprovals).toHaveLength(1);
    expect(buildDashboard([pending], "SELLER", "me").myApprovals).toHaveLength(0);
  });

  it("lists delivered work once for a seller, under incoming", () => {
    const delivered = milestone("OBJECTION_WINDOW", "AUTHORIZED", "BUYER");
    const d = buildDashboard([contract("SELLER", [delivered])], "SELLER", "me");
    expect(d.incoming.map((r) => r.milestone.id)).toEqual([delivered.id]);
    expect(d.waiting).toHaveLength(0);
    expect(d.upcoming).toHaveLength(0);
  });

  it("orders upcoming work by due date", () => {
    expect(buildDashboard([asBuyer], "BUYER", "me").upcoming.map((r) => r.milestone.id)).toEqual([theirs.id, mine.id]);
  });
});

// Live test, 2026-11-05: a USD 10 milestone split 70/30 showed "Earned $10.00" to both people.
describe("inWindow (ADR-0022, view 4)", () => {
  it("lists only milestones in their objection window, the one ending first on top", () => {
    const later = { ...milestone("OBJECTION_WINDOW", "AUTHORIZED", "BUYER"), windowEndsAt: "2026-11-07T15:00:00Z" };
    const sooner = { ...milestone("OBJECTION_WINDOW", "AUTHORIZED", "BUYER"), windowEndsAt: "2026-11-07T12:00:00Z" };
    const verifying = milestone("VERIFYING", "AUTHORIZED", "NONE");
    const d = buildDashboard([contract("BUYER", [later, verifying, sooner])], "BUYER", "me");
    expect(d.inWindow.map((r) => r.milestone.id)).toEqual([sooner.id, later.id]);
  });

  it("leaves out a window whose end Core API has not set", () => {
    const d = buildDashboard([contract("BUYER", [{ ...milestone("OBJECTION_WINDOW", "AUTHORIZED", "BUYER"), windowEndsAt: null }])], "BUYER", "me");
    expect(d.inWindow).toEqual([]);
  });
});

describe("a team's money is each person's own part (ADR-0009)", () => {
  type Hold = NonNullable<Milestone["holds"]>[number];
  const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" });
  const hold = (payeeUserId: string, shareBps: number, holdStatus: Hold["holdStatus"], funded: number, released: number): Hold => ({
    payeeUserId,
    payeeName: payeeUserId,
    shareBps,
    holdStatus,
    funded: usd(funded),
    released: usd(released),
    returned: usd(0),
  });
  const seat = (userId: string, shareBps: number | null, isSeller: boolean) =>
    ({ userId, displayName: userId, role: "Dev", shareBps, isSeller, approvedCurrentVersion: true }) as NonNullable<Contract["team"]>[number];
  const asSeller = (m: Milestone) => ({ ...contract("SELLER", [m]), team: [seat("me", 7000, true), seat("ana", 3000, false)] });
  const asCollaborator = (m: Milestone) => ({ ...contract("COLLABORATOR", [m]), team: [seat("fede", null, true), seat("me", 3000, false)] });
  const paidOut = (holds: Hold[]): Milestone => ({ ...milestone("RELEASED", "CAPTURED", "NONE"), released: usd(1000), funded: usd(1000), held: usd(0), holds });

  it("a released milestone counts only what the seller was paid", () => {
    const m = paidOut([hold("me", 7000, "CAPTURED", 700, 700), hold("ana", 3000, "CAPTURED", 300, 300)]);
    expect(moneyBuckets([asSeller(m)], "SELLER", "me")).toEqual([{ currency: "USD", paid: 700, reserved: 0, unfunded: 0 }]);
  });

  it("a released milestone counts only what the collaborator was paid", () => {
    // Core API sends a collaborator only their own hold (decision 6).
    const m = paidOut([hold("me", 3000, "CAPTURED", 300, 300)]);
    expect(moneyBuckets([asCollaborator(m)], "COLLABORATOR", "me")).toEqual([{ currency: "USD", paid: 300, reserved: 0, unfunded: 0 }]);
  });

  it("the buyer still sees the whole milestone", () => {
    const m = paidOut([hold("seller", 7000, "CAPTURED", 700, 700), hold("ana", 3000, "CAPTURED", 300, 300)]);
    expect(moneyBuckets([contract("BUYER", [m])], "BUYER", "me")).toEqual([{ currency: "USD", paid: 1000, reserved: 0, unfunded: 0 }]);
  });

  it("reserved is each person's own hold, even when the other one is not reserved yet", () => {
    const base = { ...milestone("APPROVED", "ORDER_CREATED", "BUYER"), funded: usd(700), held: usd(700), released: usd(0) };
    const seller = { ...base, holds: [hold("me", 7000, "AUTHORIZED", 700, 0), hold("ana", 3000, "ORDER_CREATED", 0, 0)] };
    const collaborator = { ...base, holds: [hold("me", 3000, "ORDER_CREATED", 0, 0)] };
    expect(moneyBuckets([asSeller(seller)], "SELLER", "me")).toEqual([{ currency: "USD", paid: 0, reserved: 700, unfunded: 0 }]);
    expect(moneyBuckets([asCollaborator(collaborator)], "COLLABORATOR", "me")).toEqual([{ currency: "USD", paid: 0, reserved: 0, unfunded: 300 }]);
  });

  it("before the first /fund there are no holds: the pipeline comes from the team's shares", () => {
    const m = milestone("APPROVED", "NONE", "BUYER", 1001);
    // The leftover cent goes to the seller, the same rule PayPal's orders use.
    expect(moneyBuckets([asSeller(m)], "SELLER", "me")).toEqual([{ currency: "USD", paid: 0, reserved: 0, unfunded: 701 }]);
    expect(moneyBuckets([asCollaborator(m)], "COLLABORATOR", "me")).toEqual([{ currency: "USD", paid: 0, reserved: 0, unfunded: 300 }]);
  });

  it("a seller working alone still sees the whole milestone", () => {
    const m = milestone("APPROVED", "NONE", "BUYER", 500);
    expect(moneyBuckets([contract("SELLER", [m])], "SELLER", "me")).toEqual([{ currency: "USD", paid: 0, reserved: 0, unfunded: 500 }]);
  });

  it("the dashboard rows carry the viewer's amount", () => {
    const m = paidOut([hold("me", 3000, "CAPTURED", 300, 300)]);
    expect(buildDashboard([asCollaborator(m)], "COLLABORATOR", "me").recentlyPaid[0]?.myAmount).toEqual(usd(300));
    expect(buildDashboard([contract("BUYER", [m])], "BUYER", "me").recentlyPaid[0]?.myAmount).toEqual(usd(1000));
  });
});

// Audit findings 8 and 19: steps that were somebody's and appeared nowhere.
describe("nobody's step stays invisible", () => {
  const hash = "sha256:h";
  const approval = (partyRole: Contract["myRole"], userId: string) => ({ partyRole, userId, approvedAt: "2026-10-01T00:00:00Z", snapshotHash: hash });
  const seat = (userId: string, approved: boolean) => ({ userId, displayName: userId, role: "Dev", shareBps: null, isSeller: false, approvedCurrentVersion: approved }) as NonNullable<Contract["team"]>[number];
  const version = (status: Contract["currentVersion"]["status"], approvals: Contract["currentVersion"]["approvals"] = []) => ({ id: "v", version: 2, status, snapshot: {} as never, snapshotHash: hash, approvals });
  const onVersion = (myRole: Contract["myRole"], status: Contract["currentVersion"]["status"], approvals: Contract["currentVersion"]["approvals"], extra: Partial<Contract> = {}): Contract => ({
    ...contract(myRole, []),
    sellerId: "seller",
    currentVersion: version(status, approvals),
    ...extra,
  });

  it("one collaborator approving does not take the step from another", () => {
    const c = onVersion("COLLABORATOR", "PENDING_APPROVAL", [approval("COLLABORATOR", "ana")], { team: [seat("ana", true), seat("me", false)] });
    expect(buildDashboard([c], "COLLABORATOR", "me").myApprovals).toHaveLength(1);
  });

  it("a collaborator the version does not name is not asked (Core API would refuse)", () => {
    const c = onVersion("COLLABORATOR", "PENDING_APPROVAL", [], { team: [seat("ana", false)] });
    expect(buildDashboard([c], "COLLABORATOR", "me").myApprovals).toHaveLength(0);
  });

  it("a seller added to a team has the collaborator dashboard without having the role", () => {
    expect(availableViews(["SELLER"], [{ myRole: "COLLABORATOR" }])).toEqual(["SELLER", "COLLABORATOR"]);
    expect(availableViews(["BUYER"], [])).toEqual(["BUYER"]);
    expect(availableViews(["ADMIN"], [])).toEqual([]);
  });

  it("a buyer without a seller is told to invite one", () => {
    const c = onVersion("BUYER", "DRAFT", [], { sellerId: null });
    expect(buildDashboard([c], "BUYER", "me").myDraftSteps.map((s) => s.kind)).toEqual(["INVITE"]);
  });

  // Live test, 2026-11-07: right after inviting, the contract still said "Your turn to invite the seller".
  it("a buyer whose invitation is out is told to send the draft, not to invite again", () => {
    const invited = onVersion("BUYER", "DRAFT", [], { sellerId: null, pendingInvitation: { email: "s@example.com", expiresAt: "2099-01-01T00:00:00Z" } });
    expect(buildDashboard([invited], "BUYER", "me").myDraftSteps.map((s) => s.kind)).toEqual(["SUBMIT"]);
    const sent = onVersion("BUYER", "PENDING_APPROVAL", [], { sellerId: null, pendingInvitation: { email: "s@example.com", expiresAt: "2099-01-01T00:00:00Z" } });
    expect(buildDashboard([sent], "BUYER", "me").myDraftSteps).toEqual([]);
  });

  it("a buyer with a listed project is not told to invite anyone, because Core API would refuse", () => {
    const listed = onVersion("BUYER", "PENDING_APPROVAL", [], { sellerId: null, publishedUntil: "2099-01-01T00:00:00Z" });
    expect(buildDashboard([listed], "BUYER", "me").myDraftSteps).toEqual([]);
    const expired = onVersion("BUYER", "PENDING_APPROVAL", [], { sellerId: null, publishedUntil: "2000-01-01T00:00:00Z" });
    expect(buildDashboard([expired], "BUYER", "me").myDraftSteps.map((s) => s.kind)).toEqual(["INVITE"]);
  });

  it("a draft with both parties has to be sent, by either of them", () => {
    expect(buildDashboard([onVersion("BUYER", "DRAFT", [])], "BUYER", "me").myDraftSteps.map((s) => s.kind)).toEqual(["SUBMIT"]);
    expect(buildDashboard([onVersion("SELLER", "DRAFT", [])], "SELLER", "me").myDraftSteps.map((s) => s.kind)).toEqual(["SUBMIT"]);
    expect(buildDashboard([onVersion("COLLABORATOR", "DRAFT", [])], "COLLABORATOR", "me").myDraftSteps).toHaveLength(0);
  });

  it("after approving, the viewer sees who the version still needs", () => {
    const c = onVersion("BUYER", "PENDING_APPROVAL", [approval("BUYER", "me")], { team: [{ ...seat("seller", false), isSeller: true }, seat("ana", false)] });
    const d = buildDashboard([c], "BUYER", "me");
    expect(d.myApprovals).toHaveLength(0);
    expect(d.waitingAgreements[0]?.waitingFor).toEqual(["the seller", "ana"]);
  });

  it("counts every step of the viewer", () => {
    const d = buildDashboard([onVersion("BUYER", "PENDING_APPROVAL", []), onVersion("BUYER", "DRAFT", []), contract("BUYER", [milestone("APPROVED", "NONE", "BUYER")])], "BUYER", "me");
    expect(actionCount(d)).toBe(3);
  });

  it("a running countdown comes before an earlier due date", () => {
    const early = milestone("APPROVED", "NONE", "BUYER", 100, "USD", "2026-11-01");
    const running = { ...milestone("OBJECTION_WINDOW", "AUTHORIZED", "BUYER", 100, "USD", "2026-12-01"), windowEndsAt: "2026-11-06T00:00:00Z" };
    expect(buildDashboard([contract("BUYER", [early, running])], "BUYER", "me").myMilestones.map((r) => r.milestone.id)).toEqual([running.id, early.id]);
  });

  it("whoever is paid sees delivered work once", () => {
    const delivered = milestone("OBJECTION_WINDOW", "AUTHORIZED", "BUYER");
    const d = buildDashboard([contract("COLLABORATOR", [delivered])], "COLLABORATOR", "me");
    expect(d.incoming).toHaveLength(1);
    expect(d.waiting).toHaveLength(0);
  });
});

describe("greetingRole", () => {
  it("says QA only for someone holding the reviewer role", () => {
    expect(greetingRole(["COLLABORATOR", "REVIEWER"], "COLLABORATOR")).toBe("QA");
    expect(greetingRole(["COLLABORATOR"], "COLLABORATOR")).toBe("Collaborator");
  });

  it("a buyer who also reviews is greeted by the dashboard they are on", () => {
    expect(greetingRole(["BUYER", "REVIEWER"], "BUYER")).toBe("Buyer");
    expect(greetingRole(["BUYER", "ADMIN"], "BUYER")).toBe("Buyer");
  });
});

describe("paidHistory", () => {
  const usd = (amountMinor: number, currency = "USD") => ({ amountMinor, currency });
  type Release = NonNullable<Milestone["releases"]>[number];
  type Part = NonNullable<Release["parts"]>[number];
  const part = (payeeUserId: string, amount: number, status: Part["status"] = "CAPTURED", currency = "USD"): Part => ({ payeeUserId, amount: usd(amount, currency), platformFee: usd(0, currency), status });
  const release = (decidedAt: string, parts: Part[]) => ({ id: "r", seq: 1, amount: usd(0), platformFee: usd(0), countedBps: 0, final: true, status: "CAPTURED", decidedAt, transitionId: "SM-T08", parts }) as unknown as Release;
  const paid = (releases: Release[]): Milestone => ({ ...milestone("RELEASED", "CAPTURED", "NONE"), releases });
  const NOW = new Date("2026-11-05T12:00:00Z");

  it("nothing captured: no chart", () => {
    expect(paidHistory([contract("SELLER", [paid([release("2026-11-01T00:00:00Z", [part("me", 500, "PENDING")])])])], "SELLER", "me", NOW)).toBeNull();
  });

  it("fills empty months, and leaves out what is older", () => {
    const h = paidHistory([contract("SELLER", [paid([release("2026-09-10T00:00:00Z", [part("me", 500)]), release("2026-01-10T00:00:00Z", [part("me", 900)])])])], "SELLER", "me", NOW);
    expect(h?.months.map((m) => [m.key, m.amount])).toEqual([["2026-06", 0], ["2026-07", 0], ["2026-08", 0], ["2026-09", 500], ["2026-10", 0], ["2026-11", 0]]);
    expect(h?.months.at(-1)?.label).toBe("Nov");
  });

  it("does not count what PayPal has not captured", () => {
    const h = paidHistory([contract("BUYER", [paid([release("2026-11-01T00:00:00Z", [part("a", 500), part("b", 300, "PENDING"), part("c", 100, "FAILED")])])])], "BUYER", "me", NOW);
    expect(h?.total).toBe(500);
  });

  it("a team member counts their own parts, the buyer all of them", () => {
    const team = [{ userId: "me", displayName: "me", role: "Dev", shareBps: 7000, isSeller: true, approvedCurrentVersion: true }, { userId: "ana", displayName: "ana", role: "Dev", shareBps: 3000, isSeller: false, approvedCurrentVersion: true }] as NonNullable<Contract["team"]>;
    const m = paid([release("2026-11-01T00:00:00Z", [part("me", 700), part("ana", 300)])]);
    expect(paidHistory([{ ...contract("SELLER", [m]), team }], "SELLER", "me", NOW)?.total).toBe(700);
    expect(paidHistory([contract("BUYER", [m])], "BUYER", "me", NOW)?.total).toBe(1000);
  });

  it("never adds two currencies", () => {
    const h = paidHistory([contract("SELLER", [paid([release("2026-11-01T00:00:00Z", [part("me", 500), part("me", 900, "CAPTURED", "EUR")])])])], "SELLER", "me", NOW);
    expect(h).toMatchObject({ currency: "EUR", total: 900 });
  });

  it("ranks who paid or was paid the most", () => {
    const a = { ...contract("SELLER", [paid([release("2026-11-01T00:00:00Z", [part("me", 100)])])]), counterpartyName: "Small" };
    const b = { ...contract("SELLER", [paid([release("2026-11-01T00:00:00Z", [part("me", 900)])])]), counterpartyName: "Big" };
    expect(paidHistory([a, b], "SELLER", "me", NOW)?.byParty.map((p) => p.name)).toEqual(["Big", "Small"]);
  });
});

describe("niceCeiling", () => {
  it.each([[123_000, 200_000], [250_000, 250_000], [410_000, 500_000], [900, 1_000], [0, 10_000]])("%i rounds up to %i", (peak, top) => {
    expect(niceCeiling(peak)).toBe(top);
  });
});

describe("PARTY_ROLE_LABEL", () => {
  it("names every party role, and a collaborator is not called the seller", () => {
    expect(PARTY_ROLE_LABEL).toEqual({ BUYER: "Buyer", SELLER: "Seller", COLLABORATOR: "Collaborator" });
  });
});

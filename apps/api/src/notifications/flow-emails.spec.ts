import { buildApplicationEmail, buildContractLockedEmail, buildEscalatedEmail, buildInvitationEmail, buildMilestoneEndedEmail, buildObjectionEmail, buildRuledEmail, buildWindowOpenedEmail } from "./flow-emails.js";

const when = new Date("2026-11-07T14:30:00Z");
const link = "https://app.settld.test/x";
const hostile = "Pay at evil.example <script>alert(1)</script>";

describe("buildInvitationEmail", () => {
  const input = { locale: "en", buyerName: "Ana", contractTitle: "Landing", email: "f@example.com", expiresAt: when, link };

  it("says which address to use and until when", () => {
    const { text } = buildInvitationEmail(input);
    expect(text).toContain("f@example.com");
    expect(text).toContain("2026-11-07 14:30 UTC");
    expect(text).toContain(link);
  });

  it("speaks the locale it is given", () => {
    expect(buildInvitationEmail({ ...input, locale: "es" }).text).toContain("misma dirección");
  });

  it("a title or a name cannot carry a link or markup into a stranger's inbox", () => {
    const { subject, text, html } = buildInvitationEmail({ ...input, buyerName: hostile, contractTitle: hostile });
    for (const part of [subject, text, html]) expect(part).not.toContain("evil.example");
    expect(html).not.toContain("<script>");
  });

  it("a line break in a name cannot add a mail header", () => {
    expect(buildInvitationEmail({ ...input, buyerName: "Ana\r\nBcc: x@example.com" }).subject).not.toMatch(/[\r\n]/);
  });
});

describe("buildWindowOpenedEmail", () => {
  const input = { locale: "en", contractTitle: "Landing", milestoneTitle: "Page", windowEndsAt: when, link };

  it("tells the buyer money moves if they do nothing, and that they can stop it", () => {
    const { text } = buildWindowOpenedEmail({ ...input, viewer: "BUYER" });
    expect(text).toContain("if you do nothing");
    expect(text).toContain("ask the seller to fix");
    expect(text).toContain("2026-11-07 14:30 UTC");
  });

  it("does not promise the seller a payment that depends on the buyer", () => {
    expect(buildWindowOpenedEmail({ ...input, viewer: "SELLER" }).text).toContain("only if they approve");
  });

  it("escapes what the other party wrote", () => {
    expect(buildWindowOpenedEmail({ ...input, viewer: "BUYER", milestoneTitle: hostile }).html).not.toContain("<script>");
  });
});

describe("buildObjectionEmail", () => {
  const input = { locale: "en", contractTitle: "Landing", milestoneTitle: "Page", reason: "Only two plans appear.", link };

  it("carries the reason, marked as the buyer's", () => {
    expect(buildObjectionEmail(input).text).toContain('written by the buyer: "Only two plans appear."');
  });

  it("removes links from the reason and keeps only Settld's", () => {
    const { text, html } = buildObjectionEmail({ ...input, reason: hostile });
    expect(text).not.toContain("evil.example");
    expect(html).not.toContain("<script>");
    expect(text).toContain(link);
  });
});

describe("buildEscalatedEmail", () => {
  const input = { locale: "en", contractTitle: "Landing", milestoneTitle: "Page", link };

  it("tells the parties that delivering again no longer answers it", () => {
    expect(buildEscalatedEmail({ ...input, viewer: "PARTY" }).text).toContain("no longer answers");
  });

  it("asks the reviewer for a written reason", () => {
    expect(buildEscalatedEmail({ ...input, viewer: "REVIEWER" }).text).toContain("written reason");
  });

  it("escapes what the parties wrote", () => {
    expect(buildEscalatedEmail({ ...input, viewer: "REVIEWER", milestoneTitle: hostile }).html).not.toContain("<script>");
  });
});

describe("buildRuledEmail", () => {
  const input = { locale: "en", contractTitle: "Landing", milestoneTitle: "Page", reason: "The delivery meets the criteria.", link };

  it("says where the money goes and why", () => {
    const released = buildRuledEmail({ ...input, decision: "RELEASE" }).text;
    expect(released).toContain("paid to the seller");
    expect(released).toContain("The delivery meets the criteria.");
    expect(buildRuledEmail({ ...input, decision: "VOID" }).text).toContain("goes back to the buyer");
  });

  it("removes links from the reason", () => {
    expect(buildRuledEmail({ ...input, decision: "VOID", reason: hostile }).text).not.toContain("evil.example");
  });
});

describe("buildMilestoneEndedEmail", () => {
  const input = { locale: "en", contractTitle: "Landing", milestoneTitle: "Page", link };

  it("never says nothing was charged about a milestone paid in part", () => {
    expect(buildMilestoneEndedEmail({ ...input, partlyPaid: true }).text).toContain("What was paid stands");
    expect(buildMilestoneEndedEmail({ ...input, partlyPaid: false }).text).toContain("Nothing was charged");
  });
});

describe("buildApplicationEmail", () => {
  const input = { locale: "en", displayName: "Ana", reason: null, link };

  it("says that applying gives no permissions", () => {
    expect(buildApplicationEmail({ ...input, kind: "RECEIVED" }).text).toContain("does not give you reviewer permissions");
  });

  it("carries the decision's reason without links", () => {
    const { text } = buildApplicationEmail({ ...input, kind: "REJECTED", reason: "See evil.example for why" });
    expect(text).toContain("for why");
    expect(text).not.toContain("evil.example");
  });

  it("a name cannot add links or a mail header", () => {
    const { subject, html } = buildApplicationEmail({ ...input, kind: "TO_DECIDE", displayName: "Ana\r\nBcc: x@evil.example <script>" });
    expect(subject).not.toMatch(/[\r\n]/);
    expect(html).not.toContain("<script>");
    expect(subject).not.toContain("evil.example");
  });
});

describe("buildContractLockedEmail", () => {
  const input = { locale: "en", recipient: "BUYER" as const, otherPartyName: "Sarah", contractTitle: "Landing", link };

  it("tells the buyer who agreed, that no money moved, and the next step", () => {
    const { text } = buildContractLockedEmail(input);
    expect(text).toContain("Sarah");
    expect(text).toContain("No money has moved");
    expect(text).toContain("Fund");
    expect(text).toContain(link);
  });

  it("tells the seller to wait for the funding before working", () => {
    const { text } = buildContractLockedEmail({ ...input, recipient: "SELLER", otherPartyName: "Michael" });
    expect(text).toContain("Michael");
    expect(text).toContain("before you start");
  });

  it("speaks the locale it is given", () => {
    expect(buildContractLockedEmail({ ...input, locale: "es" }).text).toContain("No se ha movido dinero");
    expect(buildContractLockedEmail({ ...input, locale: "es", recipient: "SELLER" }).text).toContain("antes de empezar");
  });

  it("a name or a title written by the other party cannot carry a link or markup", () => {
    const { subject, text, html } = buildContractLockedEmail({ ...input, otherPartyName: hostile, contractTitle: hostile });
    for (const part of [subject, text, html]) expect(part).not.toContain("evil.example");
    expect(html).not.toContain("<script>");
  });
});

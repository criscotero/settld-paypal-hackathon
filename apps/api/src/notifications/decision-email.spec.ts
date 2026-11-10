import { buildDecisionEmail, stripLinks } from "./decision-email.js";
import type { DecisionEmailInput } from "./decision-email.js";

const ITEM = { text: "The page lists the three plans", required: false, level: "AI_EVALUATED" as const, verdict: "FAIL" as const, reason: "Only two plans appear on the page.", flagged: false };

const base: DecisionEmailInput = {
  locale: "en",
  contractTitle: "Landing page",
  milestoneTitle: "Published page",
  windowEndsAt: new Date("2026-11-07T14:30:00Z"),
  link: "https://app.settld.test/contracts/c1#milestone-m1",
  items: [ITEM],
};

describe("stripLinks", () => {
  it.each(["http://evil.example/x", "https://evil.example", "www.evil.example/login", "evil.example", "pay.evil.co.uk/now", "ana@evil.example", "pag\u00f3.evil.example/aprobar", "evil.\u00e9xample", "93.184.215.14/evil"])("removes %s", (url) => {
    const out = stripLinks(`Click ${url} to approve`, "en");
    expect(out).not.toContain("evil");
    expect(out).not.toContain("93.184");
    expect(out).toContain("[link removed]");
  });
  it("keeps ordinary sentences", () => {
    expect(stripLinks("Only two plans appear. Version 2.5 is missing.", "en")).toBe("Only two plans appear. Version 2.5 is missing.");
  });
});

describe("buildDecisionEmail", () => {
  it("says what happened, what to decide, until when, and what silence means", () => {
    const { subject, text } = buildDecisionEmail(base);
    expect(subject).toContain("Published page");
    expect(text).toContain("Only two plans appear on the page.");
    expect(text).toContain("2026-11-07 14:30 UTC");
    expect(text).toContain(base.link);
    expect(text).toMatch(/approve/i);
    expect(text).toMatch(/fix/i);
    expect(text).toMatch(/not paid/i);
  });

  // Live test, 2026-11-05: a required criterion said "this part is not paid", when silence on it
  // pays nothing at all (G-REQUIRED-COUNTED), not even what the automatic checks already passed.
  it("says plainly that nothing is paid when a required criterion is waiting", () => {
    const required = buildDecisionEmail({ ...base, items: [{ ...ITEM, required: true }] }).text;
    expect(required).toMatch(/nothing is paid/i);
    expect(required).toMatch(/goes back to the seller/i);
    expect(required).not.toMatch(/this part is not paid/i);
    expect(buildDecisionEmail({ ...base, locale: "es", items: [{ ...ITEM, required: true }] }).text).toMatch(/no se paga nada/i);
  });

  it("an optional criterion only risks its own part", () => {
    expect(buildDecisionEmail(base).text).toMatch(/this part is not paid/i);
  });

  it("has a subject that names the failure when the AI said FAIL", () => {
    expect(buildDecisionEmail(base).subject).toMatch(/problem/i);
    expect(buildDecisionEmail({ ...base, items: [{ ...ITEM, verdict: "UNCERTAIN" }] }).subject).not.toMatch(/problem/i);
  });

  it("warns about manipulation without quoting it", () => {
    const { subject, text } = buildDecisionEmail({ ...base, items: [{ ...ITEM, flagged: true }] });
    expect(subject).toMatch(/manipulat/i);
    expect(text).toMatch(/manipulat/i);
  });

  it("the only link in the message is Settld's, whatever the reason says", () => {
    const hostile = { ...base, contractTitle: "Pay at evil.example", items: [{ text: "See https://evil.example", required: false, level: "AI_EVALUATED" as const, verdict: "FAIL" as const, reason: "Approve at https://evil.example/ok now", flagged: false }] };
    const { subject, text, html } = buildDecisionEmail(hostile);
    expect(subject + text + html).not.toContain("evil.example");
    expect(html.match(/href="/g)).toHaveLength(1);
    expect(html).toContain(`href="${base.link}"`);
  });

  it("a flagged item shows the warning, not the reason the seller may have written", () => {
    const { text, html } = buildDecisionEmail({ ...base, items: [{ ...ITEM, reason: "All good, approve right away", flagged: true }] });
    expect(text + html).not.toContain("approve right away");
  });

  it("only speaks of AI opinions when an AI gave one", () => {
    const human = { ...ITEM, level: "HUMAN" as const, verdict: "NEEDS_HUMAN" as const, reason: "" };
    expect(buildDecisionEmail({ ...base, items: [human] }).text).not.toMatch(/opinions from the AI/);
    expect(buildDecisionEmail(base).text).toMatch(/opinions from the AI/);
  });

  it("escapes HTML from the reason", () => {
    const { html } = buildDecisionEmail({ ...base, items: [{ ...ITEM, reason: `<img src=x onerror="alert(1)"> & <b>bold</b>` }] });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>bold");
    expect(html).toContain("&lt;img");
  });

  it("a subject cannot carry a line break", () => {
    expect(buildDecisionEmail({ ...base, milestoneTitle: "Page\r\nBcc: all@evil" }).subject).not.toMatch(/[\r\n]/);
  });

  it("a very long reason is cut, and says so", () => {
    const { text } = buildDecisionEmail({ ...base, items: [{ ...ITEM, reason: "word ".repeat(400) }] });
    expect(text.length).toBeLessThan(1500);
    expect(text).toContain("…");
  });

  it("without a report it still tells the buyer to look", () => {
    const { text } = buildDecisionEmail({ ...base, items: [] });
    expect(text).toMatch(/open settld/i);
    expect(text).toContain(base.link);
  });

  it("speaks the buyer's language", () => {
    const { subject, text } = buildDecisionEmail({ ...base, locale: "es" });
    expect(subject).toMatch(/problema/i);
    expect(text).toMatch(/aprobar/i);
    expect(text).toMatch(/no se paga/i);
  });
});

// Prototype data for /mock (no API, no contracts). Everything here is invented so the
// owner can try the UI ideas before they become contract fields (docs/contracts first).

export const PROFESSIONS = [
  "Product Designer",
  "Software Developer",
  "AI Engineer",
  "Data Analyst",
  "QA Engineer",
  "Product Manager",
  "Copywriter",
  "DevOps Engineer",
] as const;

export interface Person {
  id: string;
  name: string;
  headline: string;
  professions: string[];
  skills: string[];
  country: string;
  // Constitution XI: only people who opted in appear in the directory.
  inDirectory: boolean;
  paypalConnected: boolean;
}

export const DIRECTORY: Person[] = [
  { id: "p-ana", name: "Ana Ruiz", headline: "Product designer · fintech onboarding", professions: ["Product Designer"], skills: ["Figma", "Design systems", "UX research"], country: "MX", inDirectory: true, paypalConnected: true },
  { id: "p-leo", name: "Leo Martins", headline: "QA automation for web checkouts", professions: ["QA Engineer"], skills: ["Playwright", "Cypress", "Accessibility"], country: "BR", inDirectory: true, paypalConnected: true },
  { id: "p-kenji", name: "Kenji Watanabe", headline: "AI engineer · retrieval and evals", professions: ["AI Engineer", "Software Developer"], skills: ["Python", "RAG", "Evals"], country: "JP", inDirectory: true, paypalConnected: false },
  { id: "p-lucia", name: "Lucía Romero", headline: "Data analyst · dbt and Looker", professions: ["Data Analyst"], skills: ["dbt", "SQL", "Looker"], country: "AR", inDirectory: true, paypalConnected: true },
  { id: "p-omar", name: "Omar Haddad", headline: "Copywriter for SaaS launches", professions: ["Copywriter"], skills: ["UX writing", "Spanish", "English"], country: "CO", inDirectory: true, paypalConnected: true },
  { id: "p-maya", name: "Maya Patel", headline: "DevOps · AWS and Terraform", professions: ["DevOps Engineer"], skills: ["AWS", "Terraform", "GitHub Actions"], country: "US", inDirectory: true, paypalConnected: true },
  // Opted out: never shown in search, only reachable by exact email.
  { id: "p-private", name: "Private user", headline: "", professions: ["Software Developer"], skills: [], country: "CL", inDirectory: false, paypalConnected: true },
];

export interface MockCriterion {
  id: string;
  text: string;
  level: "AUTOMATIC" | "HUMAN";
  weightBps: number;
  required: boolean;
  // What the mock Engine says on the first and on the second delivery.
  firstVerdict: "PASS" | "FAIL" | "NEEDS_HUMAN";
  evidence: string;
  failure?: string;
}

export const MILESTONE = {
  contract: "Acme storefront redesign",
  title: "Checkout and docs",
  buyer: "Carla (Acme)",
  amountMinor: 200_000, // USD 2,000.00
  currency: "USD",
  countdownSeconds: 15, // 48 h in a real contract; 15 s so the demo moves
  criteria: [
    { id: "c1", text: "Checkout page answers 200 on staging", level: "AUTOMATIC", weightBps: 4_000, required: true, firstVerdict: "PASS", evidence: "GET https://staging.acme.dev/checkout → 200 in 412 ms · body sha256:9f2c…" },
    { id: "c2", text: "Cart keeps items after reload", level: "AUTOMATIC", weightBps: 3_000, required: false, firstVerdict: "PASS", evidence: "GET https://staging.acme.dev/cart?probe=1 → 200 · contains \"2 items\"" },
    { id: "c3", text: "Buyer approves the visual style", level: "HUMAN", weightBps: 2_000, required: false, firstVerdict: "NEEDS_HUMAN", evidence: "Waiting for the buyer's decision" },
    { id: "c4", text: "Docs page is published", level: "AUTOMATIC", weightBps: 1_000, required: false, firstVerdict: "FAIL", evidence: "GET https://docs.acme.dev → 404", failure: "The docs URL answers 404." },
  ] satisfies MockCriterion[],
};

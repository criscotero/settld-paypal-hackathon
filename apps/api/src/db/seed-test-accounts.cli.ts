// Test accounts for the hackathon demo: a real Clerk login plus a finished Settld profile.
// Run twice, it changes nothing new: it finds each Clerk user by email and overwrites only these rows.
//
// Why the guards below matter:
// - sk_test only: these logins share one password, which must never exist on a production instance.
// - Local settld database only: the profiles and the accepted terms are invented.
// - The password comes from the environment: this repository is public, so it cannot live here.
// - No invented PayPal ids: PayPal refuses to pay an account that never consented
//   (PAYEE_NOT_CONSENTED, ADR-0009), so a made-up id looks finished and fails on funding.
//   These accounts share the existing sandbox ones instead, or stay unconnected with --no-paypal.
import { createClerkClient } from "@clerk/backend";
import { createDb, createPool } from "./database.js";
import { users } from "./schema.js";
import type { AccountType, Profession } from "./schema.js";

const dryRun = process.argv.includes("--dry-run");
const noPaypal = process.argv.includes("--no-paypal");

interface Paypal {
  readonly merchantId?: string;
  readonly payerId?: string;
  readonly email?: string;
}

interface Account {
  readonly alias: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly roles: readonly string[];
  readonly country: string;
  readonly accountType: AccountType;
  readonly businessName: string | null;
  readonly headline: string;
  readonly professions: readonly Profession[];
  readonly skills: readonly string[];
  readonly bio: string;
  readonly link: string;
  readonly inDirectory: boolean;
  readonly paypal: Paypal;
}

// Each name is the name on the PayPal sandbox account, so a judge sees the same person on both screens.
// From docs/test-accounts.md. Several Settld users may share one: a sandbox release to any
// seller lands in the same PayPal account, which is enough for a demo and wrong anywhere else.
const SANDBOX_SELLER: Paypal = { merchantId: "T49UP3HVC6FQU" };
const SANDBOX_COLLAB: Paypal = { merchantId: "ZTRS3A6SB2KLS" };
const SANDBOX_QA: Paypal = { merchantId: "QNAQNCF87LSCY" };
// These ids were captured by each account connecting through onboarding (2026-11-06), so PayPal
// already has their consent. Writing an id that never consented would look connected and fail on
// funding (PAYEE_NOT_CONSENTED). A re-run overwrites the row, so the id has to be here, not only in the database.

const ACCOUNTS: readonly Account[] = [
  { alias: "buyer_1", firstName: "Emily", lastName: "Carter", roles: ["BUYER"], country: "US", accountType: "BUSINESS", businessName: "Carter Home Goods LLC", headline: "Owner at Carter Home Goods", professions: ["PRODUCT_MANAGER"], skills: ["E-commerce", "Vendor management", "Budgeting"], bio: "I run a home goods store in Denver (America/Denver) in the retail sector. I hire independent developers and designers for our online shop, with projects from USD 2,000 to USD 10,000.", link: "https://carterhomegoods.example", inDirectory: false, paypal: { payerId: "FJXJCANUP2GSS", email: "settld_buyer_1@personal.example.com" } },
  { alias: "buyer_2", firstName: "Michael", lastName: "Johnson", roles: ["BUYER"], country: "US", accountType: "BUSINESS", businessName: "Johnson Digital LLC", headline: "Founder at Johnson Digital", professions: ["PRODUCT_MANAGER"], skills: ["Operations", "Marketing", "Scheduling tools"], bio: "Johnson Digital is a marketing agency in Chicago (America/Chicago). We contract out client websites and landing pages, with projects from USD 5,000 to USD 25,000.", link: "https://johnsondigital.example", inDirectory: false, paypal: { payerId: "YGKWKZ57UZC7G", email: "settld_buyer@personal.example.com" } },
  { alias: "buyer_3", firstName: "Laura", lastName: "Bennett", roles: ["BUYER"], country: "US", accountType: "INDIVIDUAL", businessName: null, headline: "Independent author and course creator", professions: ["OTHER"], skills: ["Publishing", "Online courses", "Newsletters"], bio: "I publish books and online courses from Portland (America/Los_Angeles). I hire specialists for websites and launches, with projects from USD 1,000 to USD 5,000.", link: "https://laurabennett.example", inDirectory: false, paypal: { payerId: "Q98KGXM53D6ZE", email: "settld_buyer_3@personal.example.com" } },

  { alias: "seller_1", firstName: "Sarah", lastName: "Mitchell", roles: ["SELLER"], country: "US", accountType: "BUSINESS", businessName: "Mitchell Web Studio LLC", headline: "Full-stack developer for SaaS products, USD 95 per hour", professions: ["SOFTWARE_DEVELOPER"], skills: ["TypeScript", "React", "Node.js", "PostgreSQL", "AWS"], bio: "Eight years shipping web products from Austin (America/Chicago). Recent work: billing dashboards and customer portals for three startups. I work in small, testable milestones.", link: "https://mitchellwebstudio.example", inDirectory: true, paypal: SANDBOX_SELLER },
  { alias: "seller_2", firstName: "Priya", lastName: "Shah", roles: ["SELLER"], country: "US", accountType: "INDIVIDUAL", businessName: null, headline: "AI engineer building practical LLM features, USD 120 per hour", professions: ["AI_ENGINEER", "SOFTWARE_DEVELOPER"], skills: ["Python", "LLM evaluation", "RAG", "FastAPI"], bio: "Six years in machine learning, based in San Francisco (America/Los_Angeles). Recent work: support search and document extraction, measured with evaluations before launch.", link: "https://priyashah.example", inDirectory: true, paypal: { merchantId: "7PBW44NZX9U5N" } },
  { alias: "seller_3", firstName: "Tom", lastName: "Alvarez", roles: ["SELLER"], country: "US", accountType: "BUSINESS", businessName: "Alvarez Cloud Consulting LLC", headline: "DevOps engineer for growing teams, USD 110 per hour", professions: ["DEVOPS_ENGINEER"], skills: ["Kubernetes", "Terraform", "CI/CD", "Observability"], bio: "Ten years in infrastructure, based in Phoenix (America/Phoenix). Recent work: Kubernetes migrations and deployment pipelines that anyone on the team can run.", link: "https://alvarezcloud.example", inDirectory: true, paypal: { merchantId: "6GLQ57CE3NWZQ" } },

  { alias: "collab_1", firstName: "David", lastName: "Thompson", roles: ["COLLABORATOR"], country: "CO", accountType: "INDIVIDUAL", businessName: null, headline: "Product designer for mobile apps, USD 60 per hour", professions: ["PRODUCT_DESIGNER"], skills: ["Figma", "Design systems", "User research", "Prototyping"], bio: "Seven years designing mobile and web interfaces from Bogota (America/Bogota). Recent work: two booking apps and a design system, with specifications developers can build from.", link: "https://thompsondesign.example", inDirectory: true, paypal: SANDBOX_COLLAB },
  { alias: "collab_2", firstName: "Andres", lastName: "Gomez", roles: ["COLLABORATOR"], country: "US", accountType: "INDIVIDUAL", businessName: null, headline: "Data analyst for marketing teams, USD 70 per hour", professions: ["DATA_ANALYST"], skills: ["SQL", "Python", "Dashboards", "A/B testing"], bio: "Five years in analytics, based in Miami (America/New_York). Recent work: sales dashboards and A/B test reports that a marketing team can decide with.", link: "https://andresgomez.example", inDirectory: true, paypal: { merchantId: "9GVS4HS7RQ67E" } },
  { alias: "collab_3", firstName: "Hannah", lastName: "Brooks", roles: ["COLLABORATOR"], country: "US", accountType: "INDIVIDUAL", businessName: null, headline: "Copywriter for software companies, USD 65 per hour", professions: ["COPYWRITER"], skills: ["Landing pages", "Product copy", "Email", "SEO"], bio: "Nine years writing for software companies from Boston (America/New_York). Recent work: product pages and onboarding emails for four SaaS teams, without the buzzwords.", link: "https://hannahbrooks.example", inDirectory: true, paypal: { merchantId: "E36ZP6BJ4NHSG" } },

  // QA mirrors the existing reviewer: COLLABORATOR for PayPal, REVIEWER granted directly (ADR-0015).
  // There is one because each PayPal account links to one profile here, and the judge steps need no reviewer.
  { alias: "qa_1", firstName: "Jessica", lastName: "Reynolds", roles: ["COLLABORATOR", "REVIEWER"], country: "US", accountType: "BUSINESS", businessName: "Reynolds Consulting LLC", headline: "Independent QA consultant for web apps, USD 80 per hour", professions: ["QA_ENGINEER"], skills: ["Test plans", "Playwright", "Accessibility", "Regression testing"], bio: "Ten years testing web applications from Atlanta (America/New_York). I check delivered work against what was agreed, and write down why.", link: "https://reynoldsconsulting.example", inDirectory: false, paypal: SANDBOX_QA },
];

const emailOf = (a: Account) => `altamiratechlabs+clerk_test_${a.alias}@gmail.com`;

if (dryRun) {
  for (const a of ACCOUNTS) {
    console.log(`${emailOf(a)}  ${a.firstName} ${a.lastName}  ${a.roles.join(",")}  ${a.country}  paypal=${noPaypal ? "none" : (a.paypal.merchantId ?? a.paypal.payerId ?? "none")}`);
  }
  console.log(`${String(ACCOUNTS.length)} accounts. Nothing was created (--dry-run).`);
  process.exit(0);
}

const secretKey = process.env.CLERK_SECRET_KEY;
if (secretKey === undefined || !secretKey.startsWith("sk_test_")) throw new Error("This script only runs against a Clerk development instance (sk_test_).");
// Only creating a login needs it: a re-run that just corrects names must not ask for a shared password.
const password = process.env.SETTLD_TEST_PASSWORD;
const url = process.env.CORE_DATABASE_URL;
if (url === undefined) throw new Error("CORE_DATABASE_URL is not set");
const target = new URL(url);
// settld_seedcheck is a throwaway database for proving the script can run twice on a clean schema.
if (!["127.0.0.1", "localhost"].includes(target.hostname) || !["/settld", "/settld_seedcheck"].includes(target.pathname) || process.env.NODE_ENV === "production") {
  throw new Error(`This seed only writes to the local settld database, got ${target.hostname}${target.pathname}.`);
}

const clerk = createClerkClient({ secretKey });
const pool = createPool(url);
const failures: string[] = [];
try {
  const db = createDb(pool);
  for (const a of ACCOUNTS) {
    const email = emailOf(a);
    try {
      const found = await clerk.users.getUserList({ emailAddress: [email] });
      const existing = found.data[0];
      if (existing === undefined && (password === undefined || password === "")) throw new Error("SETTLD_TEST_PASSWORD is not set, and this account does not exist yet.");
      const clerkUser =
        existing === undefined
          ? await clerk.users.createUser({ emailAddress: [email], password, firstName: a.firstName, lastName: a.lastName })
          // Clerk shows its own copy of the name in the user menu, so the database alone would leave the two disagreeing.
          : await clerk.users.updateUser(existing.id, { firstName: a.firstName, lastName: a.lastName });

      const paypal: Paypal = noPaypal ? {} : a.paypal;
      const now = new Date();
      const row = {
        clerkUserId: clerkUser.id,
        displayName: `${a.firstName} ${a.lastName}`,
        fullName: `${a.firstName} ${a.lastName}`,
        roles: [...a.roles],
        country: a.country,
        accountType: a.accountType,
        businessName: a.businessName,
        termsAcceptedAt: now,
        paypalMerchantId: paypal.merchantId ?? null,
        paypalPaymentsReceivable: paypal.merchantId !== undefined,
        paypalPayerId: paypal.payerId ?? null,
        paypalEmail: paypal.email ?? null,
        // DM-INV-8: without PayPal the profile is not finished, so onboarding asks for it at sign-in.
        onboardingCompletedAt: paypal.merchantId === undefined && paypal.payerId === undefined ? null : now,
        headline: a.headline,
        professions: [...a.professions],
        skills: [...a.skills],
        bio: a.bio,
        link: a.link,
        inDirectory: a.inDirectory,
        professionalUpdatedAt: now,
      };
      await db.insert(users).values({ email, ...row }).onConflictDoUpdate({ target: users.email, set: row });
      console.log(`${existing === undefined ? "created" : "updated"}  ${email}  ${a.firstName} ${a.lastName}`);
    } catch (err) {
      // One refused account must not hide the others, and the message never contains the password.
      const detail = (err as { errors?: { message?: string }[] }).errors?.[0]?.message ?? (err as Error).message;
      failures.push(`${email}: ${detail}`);
      console.error(`FAILED   ${email}: ${detail}`);
    }
  }
} finally {
  await pool.end();
}
if (failures.length > 0) {
  console.error(`${String(failures.length)} of ${String(ACCOUNTS.length)} accounts failed.`);
  process.exitCode = 1;
}

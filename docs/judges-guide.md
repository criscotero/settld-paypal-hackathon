# Settld: Judges' Guide

**Work verified. Money settled.**

**Demo video (2:53):** <https://www.youtube.com/watch?v=hVVTu4w4ffE>

This guide explains how to read, test and run Settld. It covers the live demo and a local setup, and lists every demo user with its role. **The credentials for the demo accounts are in the Devpost testing instructions.** They are not in this repository.

> **Sandbox only.** PayPal runs in sandbox and Clerk runs as a development instance. No real money moves, and every person and company in the demo profiles is invented.

**What is verified.** The flow in section 5 was run end to end against the PayPal sandbox on a local deployment (2026-11-05 and 2026-11-07). On the live demo, the full signed-in journey ran end to end on 2026-11-11: contract, invitation, PayPal sandbox authorization, delivery, AI audit, partial capture, receipt and ledger. The [demo video](https://www.youtube.com/watch?v=hVVTu4w4ffE) shows that run. The README's [What works today](../README.md#2-what-works-today) lists the status of every feature.

---

## Contents

1. [What Settld does, in one minute](#1-what-settld-does-in-one-minute)
2. [Live demo: quick facts](#2-live-demo-quick-facts)
3. [Users and user types](#3-users-and-user-types)
4. [Roles and permissions](#4-roles-and-permissions)
5. [The 10–15 minute test on the live server](#5-the-1015-minute-test-on-the-live-server)
6. [More things to try](#6-more-things-to-try)
7. [Running the project locally](#7-running-the-project-locally)
8. [Troubleshooting](#8-troubleshooting)
9. [Where to read the code](#9-where-to-read-the-code)

---

## 1. What Settld does, in one minute

Settld is a referee for paid work. It releases a client's payment only when there is verified evidence that the work is done.

1. **Agree:** the buyer describes the work. Claude drafts checkable criteria, each with a share of the payment. Every party approves the same locked version, identified by a SHA-256 hash.
2. **Reserve:** the buyer approves the payment in PayPal. The money is **authorized, not captured**, so it stays in the buyer's account.
3. **Deliver:** the seller submits a link, a public GitHub repository or a `.zip` file.
4. **Verify:** the Engine runs automatic HTTP checks, and a Claude evaluator agent reads the delivery for criteria that need judgment. Every verdict keeps its evidence.
5. **Decide:** a visible countdown opens. The buyer can approve, ask for a fix, or let the countdown run out.
6. **Release:** PayPal captures the share that was earned and pays each team member directly. The rest stays reserved or goes back to the buyer.

Settld never holds the money, and an AI verdict alone never moves money.

---

## 2. Live demo: quick facts

| Item | Value |
|---|---|
| **Demo video** | <https://www.youtube.com/watch?v=hVVTu4w4ffE> (2:53). Watch it first to see the whole flow before you try it |
| **Web app** | <https://settld.altamiratechlabs.com> |
| **API** | `https://api.settld.altamiratechlabs.com/v1` (the web app calls it; it needs a session) |
| **Sign-in** | Clerk development instance. The sign-in page shows a "Development mode" badge, which is expected. |
| **Email verification code** | **`424242`** for any address that contains `+clerk_test`. No real email is sent. |
| **Payments** | PayPal sandbox. Log in to PayPal sandbox at <https://www.sandbox.paypal.com> to see balances. |
| **Time needed** | About 10–15 minutes for the full flow |

---

## 3. Users and user types

You need two logins to complete a flow:

- A **Settld login** (Clerk), to use the web app.
- A **PayPal sandbox login**, which PayPal asks for when the buyer reserves money or when a payee connects PayPal.

The credentials for the demo accounts are in the Devpost testing instructions.

### 3.1 Settld logins

| | |
|---|---|
| **Email pattern** | `altamiratechlabs+clerk_test_<user>@gmail.com` |
| **Email verification code** | `424242` |

#### Recommended accounts (prepared and connected to PayPal on the live demo)

| User type | Settld login (email) | Name in the demo | PayPal sandbox account linked |
|---|---|---|---|
| **Buyer** | `altamiratechlabs+clerk_test_buyer_1@gmail.com` | Emily Carter (Carter Home Goods LLC) | `settld_buyer_1@personal.example.com` (Personal) |
| **Buyer** | `altamiratechlabs+clerk_test_buyer_3@gmail.com` | Laura Bennett | `settld_buyer_3@personal.example.com` (Personal) |
| **Seller** | `altamiratechlabs+clerk_test_seller_2@gmail.com` | Priya Shah | `settld_seller_2@business.example.com` (Business) |
| **Seller** | `altamiratechlabs+clerk_test_seller_3@gmail.com` | Tom Alvarez (Alvarez Cloud Consulting LLC) | `settld_seller_3@business.example.com` (Business) |
| **Collaborator** | `altamiratechlabs+clerk_test_collab_2@gmail.com` | Andres Gomez | `settld_collaborator_2@business.example.com` (Business) |
| **Collaborator** | `altamiratechlabs+clerk_test_collab_3@gmail.com` | Hannah Brooks | `settld_collaborator_3@business.example.com` (Business) |

#### Additional accounts

These logins exist in the same Clerk instance. They share a PayPal sandbox account with another demo user. If one opens on onboarding, finish the four steps and connect the PayPal account listed.

| User type | Settld login (email) | Name in the demo | PayPal sandbox account |
|---|---|---|---|
| **Buyer** | `altamiratechlabs+clerk_test_buyer_2@gmail.com` | Michael Johnson (Johnson Digital LLC) | `settld_buyer@personal.example.com` (Personal) |
| **Seller** | `altamiratechlabs+clerk_test_seller_1@gmail.com` | Sarah Mitchell (Mitchell Web Studio LLC) | `settld_seller@business.example.com` (Business) |
| **Collaborator** | `altamiratechlabs+clerk_test_collab_1@gmail.com` | David Thompson | `settld_collaborator@business.example.com` (Business) |
| **Reviewer ("Settler") + Collaborator** | `altamiratechlabs+clerk_test_qa_1@gmail.com` | Jessica Reynolds (Reynolds Consulting LLC) | `settld_qa@business.example.com` (Business) |

**Admin:** no admin login is published for the demo. The admin role is granted directly in the database, and it is only needed to approve reviewer applications.

**Your own account also works.** Sign up with any address that contains `+clerk_test` (for example `judge+clerk_test@example.com`), choose any password, and enter `424242`. To fund or receive money you still need one of the PayPal sandbox accounts below.

### 3.2 PayPal sandbox logins

PayPal shows its own sandbox login page during funding and onboarding. Use the account linked to the Settld user you are signed in as. The credentials for the demo accounts are in the Devpost testing instructions.

| Used by | PayPal sandbox email | Type |
|---|---|---|
| `buyer_1` (Emily Carter) | `settld_buyer_1@personal.example.com` | Personal |
| `buyer_3` (Laura Bennett) | `settld_buyer_3@personal.example.com` | Personal |
| `buyer_2` (Michael Johnson) | `settld_buyer@personal.example.com` | Personal |
| `seller_2` (Priya Shah) | `settld_seller_2@business.example.com` | Business |
| `seller_3` (Tom Alvarez) | `settld_seller_3@business.example.com` | Business |
| `seller_1` (Sarah Mitchell) | `settld_seller@business.example.com` | Business |
| `collab_2` (Andres Gomez) | `settld_collaborator_2@business.example.com` | Business |
| `collab_3` (Hannah Brooks) | `settld_collaborator_3@business.example.com` | Business |
| `collab_1` (David Thompson) | `settld_collaborator@business.example.com` | Business |
| `qa_1` (Jessica Reynolds) | `settld_qa@business.example.com` | Business |

The seller and collaborator accounts already authorized Settld during onboarding, so in the main test only the **buyer** has to sign in to PayPal. You need a payee's PayPal login only to look at their sandbox balance after a release.

**About PayPal fees:** a payee's sandbox balance shows the released amount minus PayPal's own fee, which the receiver pays. Settld charges no fee.

---

## 4. Roles and permissions

| User type | How a user gets it | What it can do |
|---|---|---|
| **Buyer** | "I want to hire" or "Both" in onboarding | Create contracts, invite a seller or publish an open project, fund milestones in PayPal, approve or object, cancel a funded milestone |
| **Seller** | "I want to get paid" or "Both" | Accept invitations or take open projects, add up to four collaborators, deliver, answer objections, accept a partial payment |
| **Collaborator** | "I join teams"; a seller adds them to a team | See the contract and only their own share, approve the version, get paid directly by PayPal. Cannot edit or deliver. |
| **Reviewer ("Settler")** | Apply in onboarding or on Profile; an admin approves | Rule on escalated objections, only on contracts where they are not a party (`/review`) |
| **Admin** | Granted in the database only | Decide reviewer applications (`/admin/reviewers`); also acts as a reviewer |

Users cannot give themselves the reviewer or admin role. Roles chosen in onboarding are fixed after that.

---

## 5. The 10–15 minute test on the live server

Use separate browser sessions so you never have to sign out. Two windows in the same browser profile share one session, so use a normal window, a private window and, optionally, another browser.

| Window | Settld login | PayPal sandbox account |
|---|---|---|
| **A** | Buyer `buyer_1` | `settld_buyer_1@personal.example.com` |
| **B** | Seller `seller_2` | Already connected |
| **C** (optional) | Collaborator `collab_2` | Already connected |

### Step 1: sign in

1. Open <https://settld.altamiratechlabs.com> in each window and select **Log in**.
2. Enter the Settld login and its password. The credentials for the demo accounts are in the Devpost testing instructions. If Clerk asks for an email code, enter `424242`.
3. **Expected:** the dashboard says "Hi `<name>`". If a login opens on onboarding instead, complete its four steps (role, profile, Connect PayPal, ready) with the PayPal account listed in [section 3](#3-users-and-user-types).

### Step 2: the buyer creates a contract (window A)

1. Select **New contract**.
2. **"What is the work?"**: title `Landing page`, currency **USD**.
3. **"Milestones"**: "What gets delivered" `Published page`, amount `10.00`, any future due date.
4. **"How do we know it is done?"**: select **Suggest criteria with AI**, or add these by hand:

   | Criterion | Level | Check | Settings | Weight |
   |---|---|---|---|---|
   | `The page answers 200` | Automatic | A URL answers (HTTP probe) | URL `https://example.com` | 70 |
   | `The page explains what it is for` | AI check | Requirement is met | "What the AI should look for": `The page clearly says what the domain is for` | 30 |

   Weights must add up to 100%. For the simplest run, use only the first criterion with weight 100.
5. **"Terms"**: release countdown **1 minute**, so the release happens during your test.
6. **"Who will do the work?"**: **Invite a seller by email**, then enter `altamiratechlabs+clerk_test_seller_2@gmail.com`.
7. Select **Create and send invitation**.

**Expected:** the contract page shows "Invitation sent".

### Step 3: the seller accepts (window B)

1. On the dashboard, select **See it** next to the invitation, then **Accept invitation**.
2. **Optional team split:** select **Edit team**, then **Add from the directory**, search for `Andres Gomez`, and select **Add**. Set the shares to 70% and 30%, then **Save team**.

### Step 4: everyone approves the same version

1. **Buyer (A):** select **Submit for approval**.
2. **Buyer, seller and collaborator (A, B, C):** select **Approve version N**.

**Expected:** the Agreement card says "Agreed by both parties. This version can no longer change." and shows the content fingerprint (SHA-256). The milestone shows **Ready to fund**.

### Step 5: the buyer reserves the money (window A)

1. Select **Reserve $10.00 with PayPal**.
2. Sign in to PayPal sandbox as `settld_buyer_1@personal.example.com` and approve. With a team, Settld sends you straight to the next PayPal approval, one per team member.

**Expected:** the banner says "PayPal reserved the money. The seller can start." and the milestone shows **Funded**. Nothing has been charged yet: the money is only authorized.

### Step 6: the seller delivers (window B)

1. Select **Start work**.
2. Under "Link to the delivered work", enter `https://example.com`. A public GitHub repository or a `.zip` file (up to about 4.5 MB) also works.
3. Select **Deliver**.

**Expected:** the milestone shows **Verifying**. The page refreshes every 5 seconds.

### Step 7: verification and the countdown (window A)

- Each criterion shows a verdict with its evidence: "Passed", "Failed", "Could not check" or "Needs the buyer" for automatic checks, and "AI: looks met", "AI: looks not met" or "AI: not sure" for AI checks. Open an AI check to see each requirement, what the agent found and what to fix.
- The milestone shows **Release countdown**.
- The buyer can:
  - **Approve and release now:** tick the AI criterion, then confirm. An AI criterion is paid only after the buyer approves it.
  - **Ask the seller to fix it:** pick criteria and write a reason of at least 20 characters.
  - **Do nothing:** when the countdown ends, automatic criteria that passed are released.

The **What the AI checked** and **Money about to move** grids are covered by tests and were seen with sample data, not yet with live data.

### Step 8: release, receipt and ledger

- **Expected:** the milestone shows **Released**, or **Partly released** if some criteria did not count.
- **Settlement receipt:** select it on the milestone to see who was paid, how much, for which criteria, and the PayPal capture ids. A collaborator sees only their own share.
- **Payments:** open the ledger for every PayPal fact, with filters, totals per currency and **Export CSV**.
- **Dashboards:** the seller and the collaborator see their share under **Earned**.
- **PayPal:** sign in at <https://www.sandbox.paypal.com> as the buyer to see the charge, or as a payee to see the incoming payment.

---

## 6. More things to try

| ID | Scenario | How | Expected |
|---|---|---|---|
| P-1 | Cancel at PayPal | Buyer: **Reserve**, then cancel on PayPal | "PayPal approval was cancelled. Nothing was reserved." |
| P-5 | Failed check | Use a probe URL that does not answer 200, then deliver | "Failed"; nothing is paid for it and its money stays reserved |
| P-6 | Objection and fix | Buyer: **Ask the seller to fix it**; seller: **Deliver the fix** | **Objection open**, then verification runs again |
| P-8 | Escalation to a reviewer | Object three times on the same milestone | "A neutral reviewer will decide this. The money stays reserved until then." |
| P-10 | Accept a partial payment | Seller, milestone **Partly released**: **Accept $X and return the rest** | **Closed**; the rest goes back to the buyer |
| P-11 | Cancel a milestone | Buyer, milestone **Funded**: **Cancel milestone** | **Cancelled**; PayPal returns every reservation to the buyer |
| P-13 | Prompt-injection defense | Point an AI criterion at a public HTTPS page that contains instructions for the verifier | "Possible manipulation", with the suspicious text quoted; nothing counts without the buyer |
| C-1 | AI contract compiler | Buyer: **Suggest criteria with AI** with vague words such as "fast" | Weighted criteria, plus "These words cannot be checked as written" with "Try: …" rewrites |
| C-8 | Open project | Buyer: **Publish as an open project**; seller: **Open projects** → **Accept terms and take project** | The agreement locks at once with that seller |
| R-3 | Rule on an objection | `qa_1` (reviewer, not a party): **Objections to review** → open a case → record a ruling | PayPal pays or returns the reserved money |
| A-5 | Protected pages | Signed out, open `/dashboard` | Redirected to `/sign-in` |

Objections, escalation and reviewer rulings (P-6, P-8, R-3) are covered by tests; the **Objections to review** grid has not yet been seen with live data. The full list, with expected results, is in the README's [Test scenarios](../README.md#test-scenarios).

**Planned, not built yet:** GitHub pull request and CI checks, assigning and paying reviewers, a warning before a PayPal authorization expires, PayPal webhooks, and AI agents as buyers or sellers.

---

## 7. Running the project locally

### 7.1 Prerequisites

| Tool | Version |
|---|---|
| Node.js | 24 or later |
| pnpm | 10 (`corepack enable` installs the pinned `pnpm@10.34.5`) |
| Python | 3.12 |
| [uv](https://docs.astral.sh/uv/) | Recent version |
| Docker | With Docker Compose (runs PostgreSQL 18) |
| Accounts | Free sandbox accounts on [PayPal Developer](https://developer.paypal.com) and [Clerk](https://clerk.com). An Anthropic API key is optional. |

### 7.2 Install

```bash
git clone https://github.com/criscotero/settld-paypal-hackathon.git
```

```bash
cd settld-paypal-hackathon
```

```bash
pnpm install
```

```bash
uv sync
```

### 7.3 Configure the environment

```bash
cp .env.example .env
```

```bash
node scripts/gen-service-keys.mjs
```

The script prints four lines (`CORE_SERVICE_PRIVATE_KEY`, `CORE_SERVICE_PUBLIC_KEY`, `ENGINE_SERVICE_PRIVATE_KEY`, `ENGINE_SERVICE_PUBLIC_KEY`). Paste them **over** the four empty lines in `.env`; do not append them.

Then fill in `.env`. Every variable has a comment that says where its value comes from.

| Variables | Needed for | Without them |
|---|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Signing in to the web app | Nobody can sign in |
| The four service keys | Calls between Core API and the Engine | The bridge refuses every call |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_PARTNER_MERCHANT_ID` | Real PayPal sandbox calls | In development, Core API uses a fake PayPal provider |
| `ANTHROPIC_API_KEY` | AI suggestions and AI checks | AI checks show "Could not check"; everything else works |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM` | Sending email | Emails are recorded as not sent |
| `SETTLD_WEB_URL` | The address you open the web app at (default `http://localhost:3000`) | Endless sign-in redirect |
| `SETTLD_TEST_PASSWORD` | Creating the demo logins locally (step 7.5), with a value you choose | The test-account seed refuses to run |

**PayPal sandbox setup:** in Apps & Credentials → Sandbox, enable Log in with PayPal with the email scope, and set the Return URL to `<web origin>/onboarding/paypal/callback`. The platform account and each seller must be different Business accounts. PayPal does not accept `http://localhost` as a Return URL, so to test Log in with PayPal locally, expose the web app through an HTTPS tunnel (for example `ngrok http 3000`) and use that address in `SETTLD_WEB_URL` and in PayPal.

### 7.4 Database

```bash
pnpm db:up
```

```bash
pnpm db:migrate
```

`db:up` starts PostgreSQL 18 in Docker and creates the `core_app` and `engine_app` roles, their schemas, and a separate `settld_test` database. `db:migrate` runs the Drizzle (Core API) and Alembic (Engine) migrations. This optional check confirms each role sees only its own schema:

```bash
pnpm db:verify
```

### 7.5 Seed data (optional)

| Command | What it does |
|---|---|
| `pnpm db:seed` | Three development users (Carla Buyer, Fede Seller, Ada Admin) for API calls with the development header `X-Settld-Dev-User`. It prints their ids. |
| `pnpm --filter @settld/api db:seed:test-accounts` | Creates the demo logins from [section 3](#3-users-and-user-types) in your Clerk **development** instance, with the value of `SETTLD_TEST_PASSWORD`, and their profiles in the local database. Needs a `sk_test_` Clerk key. Supports `--dry-run` and `--no-paypal`. |
| `pnpm --filter @settld/api db:seed:demo-history` | Adds invented past contracts for the demo users. Undo with `scripts/demo_history_undo.sql`. |
| `pnpm db:demo` | Builds a separate `settld_demo` database with sample contracts in every state; `pnpm api:demo` runs Core API against it. |

The seeds refuse to write to anything other than a local database.

**Note for local runs:** the PayPal merchant ids in the test-account seed belong to the Settld sandbox platform app. With your own PayPal app, run the seed with `--no-paypal` and connect PayPal through onboarding with your own sandbox accounts.

### 7.6 Run

Start each service in its own terminal:

```bash
pnpm --filter @settld/api dev
```

```bash
pnpm --filter @settld/engine dev
```

```bash
pnpm engine:worker
```

```bash
pnpm --filter @settld/web dev
```

| Service | Address |
|---|---|
| Web | <http://localhost:3000> |
| Core API | <http://localhost:4000/v1> |
| Engine | <http://localhost:8000> (health: `/internal/v1/health`) |
| PostgreSQL | `127.0.0.1:5432` |

Then follow [section 5](#5-the-1015-minute-test-on-the-live-server) at `http://localhost:3000` (or your tunnel address) instead of the live URL.

### 7.7 Tests

```bash
pnpm typecheck
```

```bash
pnpm lint
```

```bash
pnpm --filter @settld/api test
```

```bash
pnpm --filter @settld/api test:e2e
```

```bash
pnpm --filter @settld/engine test:integration
```

```bash
pnpm --filter @settld/web test
```

The API end-to-end tests run against the `settld_test` database. They cover concurrent releases, duplicate events, and a worker killed in the middle of a job. At the time of writing, all 330 pass, but the run exits with an error: one test that simulates a crashed process leaves a database connection error unhandled.

---

## 8. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| A demo login opens on onboarding | That profile is not finished on this server. Complete the four steps and connect the PayPal account from [section 3](#3-users-and-user-types). |
| Clerk asks for an email code | Enter `424242`. It works only for addresses that contain `+clerk_test`. |
| Two windows show the same user | They share the browser session. Use a private window or another browser. |
| `PAYEE_NOT_CONSENTED` when funding | A seller or collaborator has not finished **Connect with PayPal**. |
| AI criteria show "Could not check" | The Engine has no Anthropic key. Locally, set `ANTHROPIC_API_KEY` and restart the worker. |
| Milestone stuck on **Verifying** (local) | The Engine worker is not running, or Postgres is down. Run `pnpm engine:worker`. |
| Endless redirect between `/sign-in` and `/dashboard` (local) | Open the app at exactly the address in `SETTLD_WEB_URL`. |
| PayPal says `invalid redirect_uri` (local) | The Return URL in the PayPal app does not match `SETTLD_WEB_URL`. |
| Core API refuses to start with a dev-auth error | `SETTLD_DEV_AUTH=true` is allowed only when `NODE_ENV` is `development` or `test`. |

---

## 9. Where to read the code

| Path | What it is |
|---|---|
| [`apps/web`](../apps/web) | Next.js screens for buyers, sellers, collaborators, reviewers and admins |
| [`apps/api`](../apps/api) | NestJS Core API: contracts, the milestone state machine, PayPal, objections, notifications |
| [`apps/engine`](../apps/engine) | FastAPI Engine: verification runs, check adapters, the Claude evaluator agent |
| [`docs/contracts/openapi.yaml`](contracts/openapi.yaml) | The public API definition |
| [`docs/contracts/milestone-state-machine.yaml`](contracts/milestone-state-machine.yaml) | Every milestone state and transition, used by the state-machine tests |
| [`docs/ai-evaluation.md`](ai-evaluation.md) | Measured results of the evaluator agent against the real model |
| [`infra/postgres`](../infra/postgres) | Local database setup used by `docker-compose.yml` |

The product, API, contracts and code are in English.

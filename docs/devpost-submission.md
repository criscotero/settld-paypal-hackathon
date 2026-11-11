# Devpost submission

> The text submitted to the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com), one section per form field. **The credentials for the demo accounts are in the Devpost testing instructions.** They are not in this repository.
>
> Status labels follow the README's [What works today](../README.md#2-what-works-today): anything not marked otherwise is implemented and verified; items marked **(planned)** do not exist yet.

---

## 1. Project name

Settld

## 2. Elevator pitch

> A referee for paid work: agree on what "done" means, PayPal reserves the money, AI checks the delivery with evidence, and PayPal pays each team member exactly what was earned.

---

## 3. About the project

### Inspiration

When a team does paid work for someone they have never met, somebody carries the risk. If the client pays first, the work may never arrive. If the team delivers first, the money may never arrive. "Done" is a matter of opinion, so a small gap at the end becomes a fight over the whole amount. And in a team, the lead collects everything and pays the collaborators by hand afterwards, so the collaborators carry everyone's risk.

The usual answers are a marketplace that takes a fee and leaves the client to judge the work by hand, or a bank transfer based on trust. We wanted a third option: agree on the checks first, verify them with evidence, and let PayPal pay each person directly. The middleman never holds the money.

### What it does

Settld turns "done" into checks that both sides agree on before any money moves:

1. **Agree.** The buyer describes the work in plain words. **Claude** drafts checkable criteria, each with a share of the payment, and flags vague words such as "fast" with measurable rewrites. Every party approves the same version, which is then locked with a SHA-256 hash.
2. **Reserve.** The buyer approves the payment in **PayPal**. The money is **authorized, not captured**: it stays in the buyer's account. There is one authorization per team member, so PayPal pays each person directly.
3. **Deliver.** The seller submits something checkable: a URL, a public GitHub repository, or a `.zip`.
4. **Verify.** The Engine runs automatic checks (an HTTP probe), and a **Claude evaluator agent** reads the delivery for criteria that need judgment. Every verdict carries its evidence.
5. **Decide.** A visible countdown of at least 60 seconds opens. The buyer can approve, object, or let it run out. **An AI verdict alone never moves money.**
6. **Release.** **PayPal captures only the share that was earned** and pays each team member their split. What was not earned stays reserved or goes back to the buyer.

Everyone gets a settlement receipt with the PayPal IDs, and a payments ledger, built on **AG Grid**, shows every PayPal fact across contracts. Email notifications, already working in production, tell each party when it is their turn: invitations, locked agreements, countdowns, decisions, objections and rulings, in English and Spanish.

**Built during the hackathon:** the first commit is from October 8, 2026. This repository is a clean public snapshot of the private development repository; [development-history.md](development-history.md) shows when the work happened.

### How we built it

**PayPal is the money layer.** Settld never holds funds; it only tells PayPal when to move them.

| PayPal capability | API | Used for |
|---|---|---|
| Authorize now, capture later | Orders v2 (`intent: AUTHORIZE`) | Reserving the payment without taking it |
| Partial capture | Payments v2 | Paying only for the criteria that counted |
| Void and refund | Payments v2 | Returning what was not earned |
| Seller onboarding | Partner Referrals, Merchant Integrations | Connecting each payee's own PayPal account |
| Log in with PayPal | Identity | Linking the buyer's PayPal account |
| Acting for a payee | `PayPal-Auth-Assertion` | Voids and refunds on a team member's payment |
| Safe retries | `PayPal-Request-Id` | A retry can never capture twice |

**Claude is the auditor.** It does two jobs, always with structured outputs:

- **Contract compiler** (`claude-sonnet-5-5`): turns a description into weighted criteria and flags terms that cannot be checked. Plain code then keeps only URLs the person actually wrote and makes the shares add up to exactly 100%.
- **Evaluator agent** (`claude-opus-5-5`, with read-only tools): reads several pages of a delivered site, a public repository pinned to the delivered commit, or the files inside a `.zip`, including PDFs and images. It splits each criterion into concrete checks and gives each one a verdict, the evidence it rests on, and what to fix.

**The model proposes; the code decides:**

- **Code builds an allowlist** from the locked contract before the model runs. A page that tells the agent to go elsewhere gets a refusal.
- **Every read is saved with its SHA-256 hash** before the model sees it.
- **Unsupported verdicts are downgraded.** A check that does not quote the agreed text is dropped. A `PASS` without its own evidence, or near a prompt-injection signal, drops to `UNCERTAIN`.
- **Delivered content is treated as untrusted data.** Hidden instructions hold the milestone and are shown to the buyer, quoted.

**AG Grid** powers six views: the payments ledger (filters, totals per currency, CSV export); the AI audit (one row per check, with its quote, evidence hashes, and injection flags); "Money about to move" (a live countdown per milestone, driven by the server's clock); the criteria editor; the reviewer queue; and "Who gets what" (a collaborator sees only their own row). The ledger, the criteria editor, "Who gets what" and the AI audit were checked in the browser with real sandbox data; the countdown and reviewer-queue grids are covered by tests and were seen with sample data only.

**Stack:** Next.js 16 and React 19 on Vercel; a NestJS Core API, a FastAPI Engine, and PostgreSQL 18 in one container on AWS Lightsail; Clerk for sign-in. Durable jobs and timers (pg-boss, Procrastinate) mean a restart never loses a release. Core and the Engine talk over short-lived Ed25519-signed calls.

### Challenges we ran into

- **One PayPal approval for a whole team.** We tested three ways in sandbox. A multi-payee `AUTHORIZE` order returns `422 UNSUPPORTED_INTENT`. Platform-level vaulting needs PayPal to enable it. Merchant-level vaulting fails for collaborators. Two shortcuts would have worked, and Settld uses neither: routing the money through a Settld account would make Settld hold funds, and capturing at approval would pay before the work is verified. Today the buyer approves one payment per team member, back to back, in a single flow.
- **Making an AI verdict safe to act on.** Delivered work is written by the party that gets paid, so it may try to manipulate the model. That is why the code, not the model, decides what may be read and what verdict stands, and why a person must approve every AI-judged criterion before it counts.
- **Money that adds up to the cent.** Proportional splits across criteria and team members use integer basis points, so paid + still held + returned always equals funded.

### Accomplishments that we're proud of

- **Real PayPal sandbox money flow, end to end:** authorize → verify → partial capture → paid directly to each team member, with PayPal IDs on every receipt. Run end to end against the PayPal sandbox on a local deployment on 2026-11-05 and 2026-11-07, and on the live demo on 2026-11-11, the run shown in the demo video.
- **The evaluator agent matched the expected verdict on 16 of 16 test cases, in two runs,** at about USD 0.02 per criterion. The cases cover sites, repositories, `.zip` files, a PDF, and four prompt-injection attempts. See [ai-evaluation.md](ai-evaluation.md).
- **More than 1,000 automated tests** across the web (300), Core API (231 unit and 330 end-to-end), and Engine (226).
- **Money rules enforced in the backend, not only on screen:** Settld never holds funds, an AI opinion alone never releases money, and no money moves without a visible countdown.

### What we learned

- PayPal's authorize-then-capture model is a natural fit for escrow **without custody**: the platform decides when, and PayPal moves the money.
- The most useful thing an LLM can do here is not decide. It reads and explains with evidence, and deterministic code turns that into a verdict.
- Durable timers and idempotency keys are what make "the money moved exactly once" true after a crash or a retry.

### What's next for Settld

All of these are **(planned)**; none exists in the product today.

- One approval for the whole team, once PayPal enables platform vaulting for Settld.
- PayPal webhooks instead of polling.
- GitHub pull-request and CI checks as criteria.
- Paid neutral reviewers for disputes.
- AI agents as parties to a contract, with spending-limited keys.

---

## 4. Built with

`paypal`, `paypal-orders-v2`, `paypal-payments-v2`, `paypal-partner-referrals`, `paypal-sandbox`, `claude`, `anthropic`, `ag-grid`, `next.js`, `react`, `typescript`, `nestjs`, `python`, `fastapi`, `postgresql`, `drizzle`, `sqlalchemy`, `clerk`, `tailwindcss`, `vercel`, `aws-lightsail`, `docker`, `terraform`

## 5. Sponsor tools

**AG Grid.** Settld uses AG Grid Community 36 (MIT).

> **AG Grid in Settld.** Six grids, all read-only. No grid moves money; the server's timer does.
>
> | Grid | Where | What a judge can verify with it |
> |---|---|---|
> | **Criteria editor** (Table mode) | New contract → Criteria as: Table | That every criterion has a type and a share of the payment, and that the shares total 100% before anyone can approve |
> | **What the AI checked** | Contract page, after a delivery | Each check the Claude agent made: the agreed text it quotes, its finding, what to fix, and the SHA-256 of everything it read. The Injection column shows any manipulation attempt it detected |
> | **Money about to move** | Dashboard, during a countdown | Which payments release next, to whom, and how long is left, counted from the server's clock. At zero it says "Confirming…", never "Paid" |
> | **Who gets what** | Contract page, for a team | Each member's part of every milestone. A collaborator sees only their own row |
> | **Objections to review** | `/review`, for an approved neutral reviewer | Escalated disputes, oldest first, with the money still held in PayPal |
> | **Payments** ledger | Top menu | Every authorization, capture, void, and refund, with its PayPal id, the criteria it paid for, totals per currency, and a CSV export |
>
> "What the AI checked" ran with live data on the live demo on 2026-11-11 (it appears in the demo video). "Money about to move" and "Objections to review" are covered by tests and were seen with sample data, not yet with live data.
>
> Grid-by-grid steps: [AG Grid walkthrough](../README.md#ag-grid-walkthrough-six-grids).

## 6. AI tools used

- **Claude API, `claude-sonnet-5-5`:** the contract compiler, which turns a plain description into weighted, checkable criteria and flags vague terms. Structured outputs; deterministic code validates the result.
- **Claude API, `claude-opus-5-5`:** the evaluator agent, which uses read-only tools to read delivered sites, repositories, and `.zip` files and returns per-check verdicts with evidence. Its verdicts never move money on their own; a person approves them.
- **Claude Code (development assistant):** used during development to write and review code, tests, and documentation under the project owner's direction. Every design decision is reviewed and approved by the owner.

## 7. Links

| Field | Value |
|---|---|
| Demo URL | <https://settld.altamiratechlabs.com> |
| Repository | <https://github.com/criscotero/settld-paypal-hackathon> |
| Video | <https://youtu.be/p48MGIWtXQo> |

## 8. Testing instructions

> **Settld runs on the PayPal sandbox. No real money moves.** The fastest test takes 10–15 minutes and needs two browser windows (a normal one and a private one).
>
> **1. Open** <https://settld.altamiratechlabs.com> and select **Log in**. The sign-in page shows a Clerk "Development mode" badge; this is expected.
>
> **2. Sign in.** If Clerk asks for an email code, it is `424242`.
>
> | Window | Settld login | PayPal sandbox account |
> |---|---|---|
> | A: buyer | `altamiratechlabs+clerk_test_buyer_1@gmail.com` | `settld_buyer_1@personal.example.com` |
> | B: seller | `altamiratechlabs+clerk_test_seller_2@gmail.com` | `settld_seller_2@business.example.com` |
> | C: collaborator (optional) | `altamiratechlabs+clerk_test_collab_2@gmail.com` | `settld_collaborator_2@business.example.com` |
>
> The credentials for the demo accounts are in the Devpost testing instructions.
>
> You can also sign up with any address containing `+clerk_test` (for example `judge+clerk_test@example.com`) and the code `424242`. To pay or get paid you still need one of the PayPal sandbox accounts above.
>
> **3. Buyer (A):** select **New contract**. Enter a title and an amount (for example `10.00` USD). Under "Milestones", select **Criteria as: Table** to edit the criteria in AG Grid (use a wide window). Add a criterion of type **Automatic → A URL answers (HTTP probe)** with the URL `https://example.com`. Optionally add an **AI check** criterion, such as "The page explains what the domain is for", and split the weights 70/30. Choose a **1 minute** release countdown. Invite the seller's email.
>
> **4. Seller (B):** open **Invitations** and accept. Optionally add the collaborator to the team, then approve the version. The buyer selects **Submit for approval** and approves too.
>
> **5. Buyer (A):** select **Reserve … with PayPal** and approve in the PayPal sandbox with the buyer's PayPal account. With a team, PayPal asks for one approval per person, back to back.
>
> **6. Seller (B):** select **Start work**, enter `https://example.com`, and select **Deliver**.
>
> **7. Watch it verify.** The contract shows each criterion's verdict and evidence. The **What the AI checked** grid lists what Claude checked: select a row to see what it read and its SHA-256. The dashboard's **Money about to move** grid shows the countdown. Approve the AI criterion, or let the countdown run out (then only what passed automatically is paid).
>
> **8. Result.** PayPal captures the earned share and pays each team member. Each person sees **Earned** on their dashboard. Open the **Settlement receipt** and **Payments** (the AG Grid ledger) to see the PayPal IDs. With a team, **Who gets what** on the contract page shows the split; signed in as the collaborator, you see only your own row.
>
> The reviewer queue (`/review`) needs an approved reviewer and an escalated objection, so it is not part of this quick test.
>
> The full guide, with test scenarios, is in the [Judges' guide](judges-guide.md) and in the README's [Judge and evaluator guide](../README.md#6-judge-and-evaluator-guide).

// ADR-0009, step 1: the professional profile and the collaborator directory.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { users } from "../src/db/schema.js";
import { as, bootTestApp, createNewUser, createUser } from "./support/app.js";
import type { TestContext } from "./support/app.js";

interface Entry {
  userId: string;
  displayName: string;
  headline: string | null;
  professions: string[];
  skills: string[];
}
interface Page {
  items: Entry[];
  nextCursor: string | null;
}

// A word no other test uses, so directory searches only see this run's people.
const tag = () => `zz${randomUUID().slice(0, 8)}`;

describe("Professional profile and directory (ADR-0009)", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await bootTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });

  const profile = (word: string, inDirectory = true) => ({
    headline: `QA automation · ${word}`,
    professions: ["QA_ENGINEER"],
    skills: ["Playwright", word],
    bio: "Ten years testing checkouts.",
    link: "https://example.com/me",
    inDirectory,
  });

  it("saves the profile and returns it on the user", async () => {
    const me = await createUser(ctx.db, ["COLLABORATOR"]);
    const res = await as(ctx, me).put("/me/professional-profile", profile("x"), "").expect(200);
    expect(res.body).toMatchObject({ professional: { headline: "QA automation · x", professions: ["QA_ENGINEER"], inDirectory: true } });
  });

  it("refuses an unknown profession, an http link and too many skills", async () => {
    const me = await createUser(ctx.db, ["SELLER"]);
    for (const bad of [{ professions: ["ASTRONAUT"] }, { link: "http://example.com" }, { skills: Array.from({ length: 13 }, (_, i) => `s${String(i)}`) }]) {
      const res = await as(ctx, me).put("/me/professional-profile", { ...profile("x"), ...bad }, "").expect(422);
      expect(res.body).toMatchObject({ code: "VALIDATION_FAILED" });
    }
  });

  it("lists only people who opted in, finished onboarding and can be paid, and never their email", async () => {
    const word = tag();
    const listed = await createUser(ctx.db, ["COLLABORATOR"]);
    const optedOut = await createUser(ctx.db, ["COLLABORATOR"]);
    const unpaid = await createUser(ctx.db, ["COLLABORATOR"], false);
    const unfinished = await createNewUser(ctx.db);
    await ctx.db.update(users).set({ roles: ["COLLABORATOR"] }).where(eq(users.id, unfinished));
    for (const id of [listed, unpaid, unfinished]) await as(ctx, id).put("/me/professional-profile", profile(word), "").expect(200);
    await as(ctx, optedOut).put("/me/professional-profile", profile(word, false), "").expect(200);

    const searcher = await createUser(ctx.db, ["SELLER"]);
    const page = (await as(ctx, searcher).get(`/directory?q=${word}`).expect(200)).body as Page;
    expect(page.items.map((e) => e.userId)).toEqual([listed]);
    expect(JSON.stringify(page)).not.toMatch(/@/);
  });

  it("filters by profession and by text in name, headline or skills", async () => {
    const word = tag();
    const qa = await createUser(ctx.db, ["COLLABORATOR"]);
    const designer = await createUser(ctx.db, ["COLLABORATOR"]);
    await as(ctx, qa).put("/me/professional-profile", profile(word), "").expect(200);
    await as(ctx, designer).put("/me/professional-profile", { ...profile(word), professions: ["PRODUCT_DESIGNER"], headline: `Designer ${word}` }, "").expect(200);
    const searcher = await createUser(ctx.db, ["SELLER"]);
    const byProfession = (await as(ctx, searcher).get(`/directory?q=${word}&profession=PRODUCT_DESIGNER`).expect(200)).body as Page;
    expect(byProfession.items.map((e) => e.userId)).toEqual([designer]);
    const bySkill = (await as(ctx, searcher).get(`/directory?q=${word.toUpperCase()}`).expect(200)).body as Page;
    expect(bySkill.items.map((e) => e.userId).sort()).toEqual([qa, designer].sort());
  });

  // Live test, 2026-11-07: a seller who knows the collaborator's address could not search by it.
  it("finds a listed person by their exact email, never by a fragment, and never shows it", async () => {
    const listed = await createUser(ctx.db, ["COLLABORATOR"]);
    const optedOut = await createUser(ctx.db, ["COLLABORATOR"]);
    await as(ctx, listed).put("/me/professional-profile", profile(tag()), "").expect(200);
    await as(ctx, optedOut).put("/me/professional-profile", profile(tag(), false), "").expect(200);
    const emailOf = async (id: string) => (await ctx.db.select({ email: users.email }).from(users).where(eq(users.id, id)))[0]?.email ?? "";
    const email = await emailOf(listed);
    const searcher = await createUser(ctx.db, ["SELLER"]);
    const find = async (q: string) => ((await as(ctx, searcher).get(`/directory?q=${encodeURIComponent(q)}`).expect(200)).body as Page).items.map((e) => e.userId);

    expect(await find(email.toUpperCase())).toEqual([listed]);
    expect(JSON.stringify((await as(ctx, searcher).get(`/directory?q=${encodeURIComponent(email)}`).expect(200)).body)).not.toContain(email);
    // A fragment with "@" finds nobody: the directory must not reveal which addresses exist.
    expect(await find(email.slice(0, email.indexOf("@") + 1))).toEqual([]);
    expect(await find(email.slice(email.indexOf("@")))).toEqual([]);
    // Opting out of the directory hides you from an email search too.
    expect(await find(await emailOf(optedOut))).toEqual([]);
  });

  it("pages 20 at a time with a cursor", async () => {
    const word = tag();
    const ids: string[] = [];
    for (let i = 0; i < 22; i++) {
      const id = await createUser(ctx.db, ["COLLABORATOR"]);
      await as(ctx, id).put("/me/professional-profile", profile(word), "").expect(200);
      ids.push(id);
    }
    const searcher = await createUser(ctx.db, ["SELLER"]);
    const first = (await as(ctx, searcher).get(`/directory?q=${word}`).expect(200)).body as Page;
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).not.toBeNull();
    const second = (await as(ctx, searcher).get(`/directory?q=${word}&cursor=${encodeURIComponent(first.nextCursor ?? "")}`).expect(200)).body as Page;
    expect(second.items).toHaveLength(2);
    expect(new Set([...first.items, ...second.items].map((e) => e.userId))).toEqual(new Set(ids));
  });

  it("lets a user choose the COLLABORATOR role during onboarding", async () => {
    const id = await createNewUser(ctx.db);
    const res = await as(ctx, id).put("/me/roles", { roles: ["COLLABORATOR"] }, "").expect(200);
    expect(res.body).toMatchObject({ roles: ["COLLABORATOR"], onboarding: { nextStep: "PROFILE" } });
  });
});

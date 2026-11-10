import { bootTestApp } from "./support/app.js";
import type { TestContext } from "./support/app.js";
import request from "supertest";

describe("Core API (e2e)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await bootTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it("answers 404 problem+json for unknown routes", async () => {
    const res = await request(ctx.app.getHttpServer()).get("/v1/does-not-exist").expect(404);
    expect(res.body).toMatchObject({ code: "NOT_FOUND" });
  });

  it("requires authentication on contract routes by default", async () => {
    const res = await request(ctx.app.getHttpServer()).get("/v1/contracts").expect(401);
    expect(res.body).toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

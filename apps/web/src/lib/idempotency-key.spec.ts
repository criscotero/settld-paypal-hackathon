import { newIdempotencyKey } from "./idempotency-key";

describe("newIdempotencyKey", () => {
  it("is a v4 UUID, the format Core API requires", () => {
    expect(newIdempotencyKey()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("does not repeat", () => {
    const keys = new Set(Array.from({ length: 1000 }, newIdempotencyKey));
    expect(keys.size).toBe(1000);
  });
});

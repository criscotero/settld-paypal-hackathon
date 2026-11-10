import { createBoss } from "./pg-boss-job-scheduler.js";

describe("createBoss", () => {
  // An EventEmitter with no "error" listener throws, and from pg-boss's poll loop that throw
  // ends the process: one slow database connection took the whole API down.
  it("survives pg-boss reporting an error", () => {
    const boss = createBoss("postgres://nobody@localhost:1/none");
    expect(() => boss.emit("error", new Error("Connection terminated due to connection timeout"))).not.toThrow();
  });
});

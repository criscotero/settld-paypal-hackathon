import { friendlyPath } from "./field-path";

describe("friendlyPath", () => {
  it("turns Core API issue paths into what the form calls things", () => {
    expect(friendlyPath("milestones.0.criteria.1.text")).toBe("Milestone 1 › criterion 2 › text");
    expect(friendlyPath("milestones.2.amount.amountMinor")).toBe("Milestone 3 › amount");
    expect(friendlyPath("milestones.0.dueDate")).toBe("Milestone 1 › due date");
    expect(friendlyPath("title")).toBe("Contract title");
    expect(friendlyPath("terms.releaseCountdownSeconds")).toBe("Release countdown");
    expect(friendlyPath("milestones.0.criteria.2.weightBps")).toBe("Milestone 1 › criterion 3 › weight");
  });

  it("leaves paths it does not know as they are", () => {
    expect(friendlyPath("header.Idempotency-Key")).toBe("header.Idempotency-Key");
  });
});

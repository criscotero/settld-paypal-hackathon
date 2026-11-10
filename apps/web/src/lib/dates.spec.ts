import { formatDate, relativeDays } from "./dates";

describe("formatDate", () => {
  it("formats a calendar date without shifting it by time zone", () => {
    expect(formatDate("2026-10-30")).toBe("Oct 30, 2026");
    expect(formatDate("2026-01-01")).toBe("Jan 1, 2026");
  });
});

describe("relativeDays", () => {
  const today = "2026-10-16";
  it("says how far a due date is", () => {
    expect(relativeDays("2026-10-16", today)).toBe("today");
    expect(relativeDays("2026-10-17", today)).toBe("tomorrow");
    expect(relativeDays("2026-10-30", today)).toBe("in 14 days");
    expect(relativeDays("2026-10-15", today)).toBe("1 day overdue");
    expect(relativeDays("2026-10-06", today)).toBe("10 days overdue");
  });
});

import { formatMoney, minorDigits, parseMoney, toMajorString } from "./money";

describe("minorDigits", () => {
  it("knows currencies without cents", () => {
    expect(minorDigits("USD")).toBe(2);
    expect(minorDigits("JPY")).toBe(0);
  });
});

describe("parseMoney", () => {
  it("converts major units to integer minor units without floats", () => {
    // parseFloat("10.1") * 100 === 1009.9999999999999
    expect(parseMoney("10.1", "USD")).toEqual({ ok: true, amountMinor: 1010 });
    expect(parseMoney("0.29", "USD")).toEqual({ ok: true, amountMinor: 29 });
    expect(parseMoney("1500", "USD")).toEqual({ ok: true, amountMinor: 150000 });
  });

  it("accepts thousands separators and surrounding spaces", () => {
    expect(parseMoney(" 1,500.50 ", "USD")).toEqual({ ok: true, amountMinor: 150050 });
  });

  it("rejects more decimals than the currency has", () => {
    expect(parseMoney("1.005", "USD").ok).toBe(false);
    expect(parseMoney("1.5", "JPY").ok).toBe(false);
    expect(parseMoney("1500", "JPY")).toEqual({ ok: true, amountMinor: 1500 });
  });

  it("rejects negatives, garbage and empty input", () => {
    for (const bad of ["", "-1", "abc", "1e3", "1.2.3", "."]) expect(parseMoney(bad, "USD").ok).toBe(false);
  });

  it("rejects amounts JavaScript cannot represent exactly", () => {
    expect(parseMoney("90071992547409.92", "USD").ok).toBe(false);
  });
});

describe("toMajorString", () => {
  it("is the inverse of parseMoney, for editing a saved draft", () => {
    expect(toMajorString(1010, "USD")).toBe("10.10");
    expect(toMajorString(5, "USD")).toBe("0.05");
    expect(toMajorString(1500, "JPY")).toBe("1500");
  });
});

describe("formatMoney", () => {
  it("formats with the currency's own decimals", () => {
    expect(formatMoney({ amountMinor: 150050, currency: "USD" })).toBe("$1,500.50");
    expect(formatMoney({ amountMinor: 1500, currency: "JPY" })).toBe("¥1,500");
  });
});

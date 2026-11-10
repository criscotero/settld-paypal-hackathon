import { describe, expect, it } from "vitest";
import { safeHref } from "./safe-href";

describe("safeHref", () => {
  it("keeps web addresses", () => {
    expect(safeHref("https://staging.example.com/a?b=1")).toBe("https://staging.example.com/a?b=1");
    expect(safeHref("http://example.com")).toBe("http://example.com");
  });

  it.each(["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>1</script>", "file:///etc/passwd", "not a url", ""])("refuses %s", (url) => {
    expect(safeHref(url)).toBeNull();
  });
});

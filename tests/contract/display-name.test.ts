import { describe, expect, it } from "vitest";
import { DISPLAY_NAME_MAX_CODE_POINTS, DISPLAY_NAME_MAX_ENCODED_LENGTH, cleanDisplayName } from "../../packages/contracts/src/display-name.js";

describe("Slack display names shared by the Slack service and the broker", () => {
  it("never cuts a character cluster in half at the length cap", () => {
    const coder = "\u{1F469}\u200D\u{1F4BB}";
    expect(cleanDisplayName("a".repeat(78) + coder)).toBe("a".repeat(78));
    expect(cleanDisplayName("a".repeat(77) + coder)).toBe("a".repeat(77) + coder);
  });

  it("keeps the longest cleaned name inside the broker's encoded-length limit", () => {
    const longest = cleanDisplayName("\u{1F600}".repeat(200))!;
    expect(Array.from(longest)).toHaveLength(DISPLAY_NAME_MAX_CODE_POINTS);
    expect(encodeURIComponent(longest).length).toBeLessThanOrEqual(DISPLAY_NAME_MAX_ENCODED_LENGTH);
  });

  it("turns control, zero-width and bidi marks into spaces but keeps ZWNJ and ZWJ", () => {
    expect(cleanDisplayName("Zo\u00EB\n\u202E\u2060Ann\u200Ce")).toBe("Zo\u00EB Ann\u200Ce");
    expect(cleanDisplayName(" \u200B ")).toBeUndefined();
  });
});

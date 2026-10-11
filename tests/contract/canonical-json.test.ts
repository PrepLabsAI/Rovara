import { canonicalJson, sameJsonContent } from "@agentx/contracts";
import { describe, expect, it } from "vitest";

describe("canonical JSON", () => {
  it("writes keys in alphabetical order at every level and drops undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[{"y":2,"z":1}]},"b":1}');
  });

  it("treats values whose maps are in another key order as the same, but not reordered arrays or changed values", () => {
    expect(sameJsonContent({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true);
    expect(sameJsonContent({ list: [1, 2] }, { list: [2, 1] })).toBe(false);
    expect(sameJsonContent({ a: 1 }, { a: "1" })).toBe(false);
  });
});

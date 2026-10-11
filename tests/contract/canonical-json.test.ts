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

  it("refuses values that are not plain JSON, so two different Dates (or Maps) never read as the same", () => {
    expect(() => sameJsonContent(new Date(1), new Date(2))).toThrow(/plain JSON/);
    expect(() => sameJsonContent({ at: new Date(1) }, { at: new Date(1) })).toThrow(/plain JSON/);
    expect(() => canonicalJson(new Map([["a", 1]]))).toThrow(/plain JSON/);
    class Point { x = 1; }
    expect(() => canonicalJson([new Point()])).toThrow(/plain JSON/);
    // An object with no prototype is still plain.
    expect(sameJsonContent(Object.assign(Object.create(null) as object, { a: 1 }), { a: 1 })).toBe(true);
  });
});

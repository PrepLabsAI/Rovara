// NH-1 re-check F5/F6: the two questions asked of a test id. VALID (listable, comparable, markable): spaces inside are fine; control, hidden and look-alike characters, lone surrogates, a space at an end and more than 500
// characters are not. RERUNNABLE: valid and not readable as an option or an argument file.
import { describe, expect, it } from "vitest";
import { isRerunnableTestId, testIdOf } from "../../packages/contracts/src/test-id.js";

describe("a rerunnable test id", () => {
  it("is a valid id that is not an option or an argument file", () => {
    expect(isRerunnableTestId("tests/a.py::t[a b]")).toBe(true);
    for (const id of ["-x", "--maxfail=1", "@args.txt", "a\u3164b", " x"]) expect(isRerunnableTestId(id), id).toBe(false);
  });
  it("an id is file::name, or the name alone", () => {
    expect(testIdOf({ file: "src/a.test.ts", name: "a b" })).toBe("src/a.test.ts::a b");
    expect(testIdOf({ name: "a b" })).toBe("a b");
    expect(testIdOf({ file: "", name: "a b" })).toBe("a b");
  });
});

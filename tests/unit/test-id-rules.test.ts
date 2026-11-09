// NH-1 re-check F5/F6: the two questions asked of a test id. VALID (listable, comparable, markable): spaces inside are fine; control, hidden and look-alike characters, lone surrogates, a space at an end and more than 500
// characters are not. RERUNNABLE: valid and not readable as an option or an argument file.
import { describe, expect, it } from "vitest";
import { TEST_ID_MAX, TestIdSchema, isRerunnableTestId, isValidTestId, testIdOf } from "../../packages/contracts/src/test-id.js";

describe("a valid test id", () => {
  it("allows spaces inside a name, brackets, parentheses, quotes, unicode letters and emoji", () => {
    for (const id of ["src/cart.test.ts::cart adds an item", "tests/test_cart.py::test_label[a b]", "tests/test.py::t(1, 2)", "pkg::it 'quotes' and \"double\"", "tests/测试.py::café ☕", "a  b", "-x", "@file"]) expect(isValidTestId(id), id).toBe(true);
  });
  it("refuses control and format characters: a newline, a tab, a NUL, an escape, a zero-width space, a bidirectional override", () => {
    for (const id of ["a\nb", "a\tb", "a\u0000b", "a\u001bb", "a\u200Bb", "a\u202Eb", "a\u00ADb", "a\uFEFFb"]) expect(isValidTestId(id), JSON.stringify(id)).toBe(false);
  });
  it("refuses invisible look-alikes (F6): Hangul fillers, the braille blank, variation selectors, the grapheme joiner, Khmer vowels, a replacement character, and every space that is not the plain one", () => {
    for (const code of [0x3164, 0x115f, 0x1160, 0xffa0, 0x2800, 0xfe0f, 0xfe00, 0x180b, 0x034f, 0x17b4, 0x17b5, 0xfffc, 0xfffd, 0x00a0, 0x2003, 0x3000, 0x2028, 0x2029, 0x202f, 0xe0100]) {
      const id = `tests/a.py::t${String.fromCodePoint(code)}x`;
      expect(isValidTestId(id), code.toString(16)).toBe(false);
    }
  });
  it("refuses a lone surrogate, a space at either end, an empty id and more than 500 characters; 500 is fine", () => {
    for (const id of ["a\uD800b", "a\uDC00b", " lead", "trail ", "", "x".repeat(TEST_ID_MAX + 1)]) expect(isValidTestId(id), JSON.stringify(id)).toBe(false);
    expect(isValidTestId("x".repeat(TEST_ID_MAX))).toBe(true);
    expect(isValidTestId("a😀b")).toBe(true);
  });
  it("is the schema's rule too", () => {
    expect(TestIdSchema.safeParse("src/a.test.ts::a b").success).toBe(true);
    expect(TestIdSchema.safeParse("src/a.test.ts::a\u3164b").success).toBe(false);
  });
});

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

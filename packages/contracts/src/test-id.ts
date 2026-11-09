// ONE test id for the whole product (NH-1 fix 1, rules split in the re-check F5/F6). The nightly run's failing set and coverage map, the evidence pack's test names, the known-failing marks, the selection's inventory and
// its "last night's failures" all name a test the same way, so a failure that is already on the default branch is the SAME string in each of them:
//
//   file::name     `tests/test_cart.py::TestRules::test_discount_fails[x]`  (pytest's node id) or `src/cart.test.ts::cart adds an item` (vitest and jest: the file and the full name, spaces and all)
//   name           when the report names no file
//
// An id is never rewritten. Two questions are asked of it, and they are different:
//   VALID      may it be listed, compared and marked? 1 to 500 characters; no control or format characters (so no newline, tab or bidirectional mark), no lone surrogate, no invisible look-alike (a Hangul filler, a braille
//              blank, a variation selector, a combining grapheme joiner, a space that is not the plain U+0020), and no space at either end. Plain spaces INSIDE the name are fine: a test is often named in words.
//   RERUNNABLE may it be passed to a runner as one argument? It is valid and does not start with `-` (an option) or `@` (an argument file). Commands are run with their arguments as separate elements and no shell, so a
//              space is not an injection risk; what a runner makes of a name is the runner's syntax, which the worker's rerun builder knows (pytest takes the node id; vitest and jest take the file and `-t`).
// An id that is not valid is still COUNTED in a night's totals; it is only left out of the lists that are matched (the failing set, the map, the marks), and the night says how many it left out.
// Nothing here imports a Node module.
import { z } from "zod";

/** The longest id: the nightly result, the map, the marks and the evidence pack all hold up to this. */
export const TEST_ID_MAX = 500;
// Control and format characters, line and paragraph separators, any space that is not U+0020, and characters that draw as nothing or as a space: Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), the Khmer inherent
// vowels (U+17B4, U+17B5), the braille blank (U+2800), the combining grapheme joiner (U+034F), the Mongolian vowel separator and free variation selectors (U+180B to U+180F), variation selectors (U+FE00 to U+FE0F and
// U+E0100 to U+E01EF) and the object replacement and replacement characters (U+FFFC, U+FFFD).
// The class lists combining and variation characters on purpose (they are the invisible look-alikes this rule exists to refuse), so the "misleading class" rule is off for this line.
// eslint-disable-next-line no-misleading-character-class
const INVALID_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u115F\u1160\u3164\uFFA0\u17B4\u17B5\u2800\u034F\u180B-\u180F\uFE00-\uFE0F\u{E0100}-\u{E01EF}\uFFFC\uFFFD]/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

/** Whether an id may be listed, compared and marked (see the top of the file). */
export function isValidTestId(id: string): boolean {
  return id.length > 0 && id.length <= TEST_ID_MAX && id === id.trim() && !LONE_SURROGATE.test(id) && !INVALID_CHARACTER.test(id);
}

/** Whether a valid id may be passed to a runner as one argument: not readable as an option (`-x`) or an argument file (`@file`). */
export function isRerunnableTestId(id: string): boolean {
  return isValidTestId(id) && !id.startsWith("-") && !id.startsWith("@");
}

/** A valid test id, as a schema. */
export const TestIdSchema = z.string().min(1).max(TEST_ID_MAX).refine(isValidTestId, "a test id has no control, hidden or look-alike characters, and no space at either end");

/** The id of a test a report names: `file::name`, or the name alone when the report names no file. Not rewritten and not checked: ask `isValidTestId`. */
export function testIdOf(test: { file?: string | undefined; name: string }): string {
  return test.file === undefined || test.file === "" ? test.name : `${test.file}::${test.name}`;
}

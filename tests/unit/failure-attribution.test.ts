// TE-A6 Part A (DEC 254zt): the pure join of a check's failing tests to the changed files and commits. It names the change that most likely broke a test only when the evidence is strong and unique; every doubt is "unknown", and it never guesses.
import { describe, expect, it } from "vitest";
import {
  FAILURE_ATTRIBUTION_LIMITS, FAILURE_MIN_SCORE, FAILURE_SIGNAL_SCORES, FAILURE_UNKNOWN_WORDS, attributeFailures, namedChangedPaths,
  type FailureAttributionInput, type FailureChange, type FailureInput,
} from "../../packages/contracts/src/index.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const change = (path: string, commit?: string, status: FailureChange["status"] = "MODIFIED"): FailureChange => ({ path, status, ...(commit === undefined ? {} : { commit }) });
const failure = (id: string, text?: string, file?: string): FailureInput => ({ id, ...(file === undefined ? {} : { file }), ...(text === undefined ? {} : { text }) });
const input = (failures: FailureInput[], changes: FailureChange[]): FailureAttributionInput => ({ failures, changes });
const one = (value: FailureAttributionInput) => {
  const result = attributeFailures(value);
  expect(result.mode).toBe("per_test");
  if (result.mode !== "per_test") throw new Error("expected per test");
  return result.results[0]!.cause;
};
const reasonOf = (value: FailureAttributionInput): string => {
  const result = attributeFailures(value);
  expect(result.mode).toBe("per_check");
  return result.mode === "per_check" ? result.reason : "";
};
const STACK = "AssertionError: expected 3 to be 4\n    at discount (/work/repo/src/cart/discount.ts:12:5)\n    at /work/repo/tests/cart.test.ts:20:3";

describe("the failure text names a changed file", () => {
  it("names that file and its commit, with the basis, when it is the only change the failure points at", () => {
    const cause = one(input([failure("tests/cart.test.ts::applies discount", STACK, "tests/cart.test.ts")], [change("src/cart/discount.ts", SHA_A), change("README.md", SHA_A), change("src/other.ts", SHA_B)]));
    expect(cause).toEqual({ kind: "change", paths: ["src/cart/discount.ts"], pathsCount: 1, commit: SHA_A, basis: ["named_in_failure"] });
  });

  it("names the file alone when no commit is known for it", () => {
    const cause = one(input([failure("t::a", STACK)], [change("src/cart/discount.ts")]));
    expect(cause).toEqual({ kind: "change", paths: ["src/cart/discount.ts"], pathsCount: 1, basis: ["named_in_failure"] });
  });

  it("joins two files of the same commit into one change, listing the files in order", () => {
    const text = "at f (src/b.ts:1:1)\nat g (src/a.ts:2:2)";
    const cause = one(input([failure("t::a", text)], [change("src/a.ts", SHA_A), change("src/b.ts", SHA_A)]));
    expect(cause).toEqual({ kind: "change", paths: ["src/a.ts", "src/b.ts"], pathsCount: 2, commit: SHA_A, basis: ["named_in_failure"] });
  });

  it("does not match a different file that only ends with the same letters", () => {
    expect(one(input([failure("t::a", "at x (src/cart/discount.ts:1:1)")], [change("cart/discount.ts.bak"), change("scart/discount.ts")]))).toEqual({ kind: "unknown", reason: "no_changed_file_named" });
  });

  it("matches a path the report wrote with a directory in front of it, and one with backslashes", () => {
    expect(one(input([failure("t::a", "at x (C:\\work\\repo\\src\\cart\\discount.ts:1:1)")], [change("src/cart/discount.ts")])).kind).toBe("change");
    expect(one(input([failure("t::a", "File \"/app/src/cart/discount.py\", line 4, in discount")], [change("src/cart/discount.py")])).kind).toBe("change");
  });

  it("does not match a path that is only the end of a token too long to read whole", () => {
    const longest = `d/${"a".repeat(FAILURE_ATTRIBUTION_LIMITS.pathMax - 5)}.ts`;
    expect(longest).toHaveLength(FAILURE_ATTRIBUTION_LIMITS.pathMax);
    expect(one(input([failure("t::a", `z${longest}`)], [change(longest, SHA_A)]))).toEqual({ kind: "unknown", reason: "no_changed_file_named" });
    expect(one(input([failure("t::a", longest)], [change(longest, SHA_A)])).kind).toBe("change");
  });

  it("never names a deleted file (a stack cannot point into code that is gone)", () => {
    expect(one(input([failure("t::a", "at x (src/gone.ts:1:1)")], [change("src/gone.ts", SHA_A, "DELETED")]))).toEqual({ kind: "unknown", reason: "no_changed_file_named" });
  });
});

describe("review findings: wrong-name traps", () => {
  it("does not take the test's own edited file for a named source file when the id spells it another way, or the file is not given", () => {
    const text = "at y (/work/repo/packages/web/tests/a.test.ts:3:3)";
    expect(one(input([failure("tests/a.test.ts::a", text, "tests/a.test.ts")], [change("packages/web/tests/a.test.ts", SHA_A)]))).toEqual({ kind: "unknown", reason: "weak_evidence" });
    expect(one(input([failure("tests/a.test.ts::a", text)], [change("packages/web/tests/a.test.ts", SHA_A)]))).toEqual({ kind: "unknown", reason: "weak_evidence" });
    expect(one(input([failure("packages/web/tests/a.test.ts::a", "at y (tests/a.test.ts:3:3)")], [change("tests/a.test.ts", SHA_A)]))).toEqual({ kind: "unknown", reason: "weak_evidence" });
    expect(one(input([failure("./tests/a.test.ts::a", text)], [change("packages/web/tests/a.test.ts", SHA_A)]))).toEqual({ kind: "unknown", reason: "weak_evidence" });
  });

  it("never matches a changed root file, or a file that shares only its name, to a frame in another package or in node_modules", () => {
    expect(one(input([failure("t::a", "at x (/work/repo/node_modules/lib/index.ts:1:1)")], [change("index.ts", SHA_A)]))).toEqual({ kind: "unknown", reason: "no_changed_file_named" });
    expect(one(input([failure("t::a", "at x (packages/other/utils.ts:1:1)")], [change("utils.ts", SHA_A)]))).toEqual({ kind: "unknown", reason: "no_changed_file_named" });
    expect(one(input([failure("t::a", "at x (/work/repo/node_modules/lib/src/utils.ts:1:1)")], [change("src/utils.ts", SHA_A)]))).toEqual({ kind: "unknown", reason: "no_changed_file_named" });
    expect(one(input([failure("t::a", "at x (index.ts:1:1)")], [change("index.ts", SHA_A)])).kind).toBe("change");
    expect(one(input([failure("t::a", "ENOENT: cannot read package.json")], [change("package.json", SHA_A)]))).toEqual({ kind: "unknown", reason: "no_changed_file_named" });
    expect(one(input([failure("t::a", "at x (/work/repo/.git/hooks/src/a.ts:1:1)\nat y (/usr/lib/site-packages/pkg/src/b.py:2:2)")], [change("src/a.ts", SHA_A), change("src/b.py", SHA_B)]))).toEqual({ kind: "unknown", reason: "no_changed_file_named" });
  });

  it("treats a file the change deleted as a rival, never as a cause", () => {
    expect(one(input([failure("t::a", "cannot find src/gone.ts, at x (src/b.ts:1:1)")], [change("src/gone.ts", SHA_B, "DELETED"), change("src/b.ts", SHA_A)]))).toEqual({ kind: "unknown", reason: "several_changes" });
    const same = one(input([failure("t::a", "cannot find src/gone.ts, at x (src/b.ts:1:1)")], [change("src/gone.ts", SHA_A, "DELETED"), change("src/b.ts", SHA_A)]));
    expect(same).toEqual({ kind: "change", paths: ["src/b.ts"], pathsCount: 1, commit: SHA_A, basis: ["named_in_failure"] });
  });

  it("reads a path followed by line, column and a full stop", () => {
    expect(one(input([failure("t::a", "failed in src/a.ts:12:5.")], [change("src/a.ts", SHA_A)])).kind).toBe("change");
  });

  it("accepts a 64-character commit and keeps a commit-less change apart from a commit", () => {
    const long = "c".repeat(64);
    expect(one(input([failure("t::a", "at x (src/a.ts:1:1)")], [change("src/a.ts", long)]))).toMatchObject({ commit: long });
    expect(one(input([failure("t::a", "at x (src/a.ts:1:1)\nat y (src/b.ts:1:1)")], [change("src/a.ts", SHA_A), change("src/b.ts")]))).toEqual({ kind: "unknown", reason: "several_changes" });
  });

  it("is linear on text made of dots, colons and digits", () => {
    const hostile = ["x" + ".".repeat(3999), "x" + ":1".repeat(1999), "x" + ":".repeat(3999)];
    const failures = Array.from({ length: 30 }, (_, index) => failure(`t::${String(index)}`, hostile[index % 3]));
    const started = performance.now();
    expect(attributeFailures(input(failures, [change("src/a.ts", SHA_A)])).mode).toBe("per_test");
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("the confidence rule", () => {
  it("names nothing on the test's own changed file alone: the test was edited, but that does not say what broke it", () => {
    expect(FAILURE_SIGNAL_SCORES.own_test_file).toBeLessThan(FAILURE_MIN_SCORE);
    expect(one(input([failure("tests/cart.test.ts::a", "AssertionError", "tests/cart.test.ts")], [change("tests/cart.test.ts", SHA_A)]))).toEqual({ kind: "unknown", reason: "weak_evidence" });
  });

  it("names a change on a single strong signal exactly at the threshold", () => {
    expect(FAILURE_SIGNAL_SCORES.named_in_failure).toBe(FAILURE_MIN_SCORE);
    expect(one(input([failure("t::a", "at x (src/a.ts:1:1)")], [change("src/a.ts")])).kind).toBe("change");
  });

  it("lists both signals when the same change is named and is the test's own file", () => {
    const cause = one(input([failure("tests/a.test.ts::a", "at x (src/a.ts:1:1)\nat y (tests/a.test.ts:3:3)", "tests/a.test.ts")], [change("src/a.ts", SHA_A), change("tests/a.test.ts", SHA_A)]));
    expect(cause).toEqual({ kind: "change", paths: ["src/a.ts", "tests/a.test.ts"], pathsCount: 2, commit: SHA_A, basis: ["named_in_failure", "own_test_file"] });
  });

  it("counts the test's own file once even though a stack always names it", () => {
    const cause = one(input([failure("tests/a.test.ts::a", "at y (tests/a.test.ts:3:3)", "tests/a.test.ts")], [change("tests/a.test.ts", SHA_A)]));
    expect(cause).toEqual({ kind: "unknown", reason: "weak_evidence" });
  });

  it("says unknown when the failure points at changes of two different commits, even when one also fits the test's own file", () => {
    expect(one(input([failure("t::a", "at x (src/a.ts:1:1)\nat y (src/b.ts:1:1)")], [change("src/a.ts", SHA_A), change("src/b.ts", SHA_B)]))).toEqual({ kind: "unknown", reason: "several_changes" });
  });

  it("prefers the strong signal over the weak one when they point at different changes", () => {
    const cause = one(input([failure("tests/a.test.ts::a", "at x (src/a.ts:1:1)", "tests/a.test.ts")], [change("src/a.ts", SHA_A), change("tests/a.test.ts", SHA_B)]));
    expect(cause).toMatchObject({ kind: "change", commit: SHA_A, paths: ["src/a.ts"] });
  });

  it("says unknown, with a different reason, when there is no failure text at all", () => {
    expect(one(input([failure("t::a")], [change("src/a.ts", SHA_A)]))).toEqual({ kind: "unknown", reason: "no_failure_details" });
  });

  it("two files with no commit are two changes: a failure naming both is unknown, never the first one", () => {
    expect(one(input([failure("t::a", "at x (src/a.ts:1:1)\nat y (src/b.ts:1:1)")], [change("src/a.ts"), change("src/b.ts")]))).toEqual({ kind: "unknown", reason: "several_changes" });
  });

  it("decides each test on its own", () => {
    const result = attributeFailures(input([failure("t::one", "at x (src/a.ts:1:1)"), failure("t::two", "boom"), failure("t::three", "at x (src/b.ts:1:1)")], [change("src/a.ts", SHA_A), change("src/b.ts", SHA_B)]));
    expect(result).toEqual({
      mode: "per_test",
      results: [
        { testId: "t::one", cause: { kind: "change", paths: ["src/a.ts"], pathsCount: 1, commit: SHA_A, basis: ["named_in_failure"] } },
        { testId: "t::two", cause: { kind: "unknown", reason: "no_changed_file_named" } },
        { testId: "t::three", cause: { kind: "change", paths: ["src/b.ts"], pathsCount: 1, commit: SHA_B, basis: ["named_in_failure"] } },
      ],
    });
  });

  it("gives the same answer for the same input, whatever the order of the changes", () => {
    const changes = [change("src/a.ts", SHA_A), change("src/b.ts", SHA_A), change("README.md")];
    const first = attributeFailures(input([failure("t::a", "at x (src/b.ts:1:1)\nat y (src/a.ts:1:1)")], changes));
    const second = attributeFailures(input([failure("t::a", "at x (src/b.ts:1:1)\nat y (src/a.ts:1:1)")], [...changes].reverse()));
    expect(second).toEqual(first);
  });

  it("every unknown reason has fixed words", () => {
    for (const word of Object.values(FAILURE_UNKNOWN_WORDS)) expect(word).toMatch(/^[a-z][a-z ,'-]+$/u);
    expect(Object.keys(FAILURE_UNKNOWN_WORDS).sort()).toEqual(["no_changed_file_named", "no_failure_details", "several_changes", "weak_evidence"]);
  });
});

describe("it falls back to per check, never to a guess", () => {
  const base = () => input([failure("t::a", "at x (src/a.ts:1:1)")], [change("src/a.ts", SHA_A)]);

  it("when there is no failing test", () => {
    expect(reasonOf(input([], [change("src/a.ts")]))).toBe("no_failures");
  });

  it("when two failing tests share an id", () => {
    expect(reasonOf(input([failure("t::a", "x"), failure("t::a", "y")], [change("src/a.ts")]))).toBe("duplicate_ids");
  });

  it("when there are more failing tests than the limit, instead of naming the first ones only", () => {
    const failures = Array.from({ length: FAILURE_ATTRIBUTION_LIMITS.failuresMax + 1 }, (_, index) => failure(`t::${String(index)}`, "at x (src/a.ts:1:1)"));
    expect(reasonOf(input(failures, [change("src/a.ts")]))).toBe("too_many_failures");
    expect(attributeFailures(input(failures.slice(1), [change("src/a.ts")])).mode).toBe("per_test");
  });

  it("when there are more changed files than the limit", () => {
    const changes = Array.from({ length: FAILURE_ATTRIBUTION_LIMITS.changesMax + 1 }, (_, index) => change(`src/f${String(index)}.ts`));
    expect(reasonOf(input([failure("t::a", "x")], changes))).toBe("too_many_changes");
  });

  it("when one failure text, or all of them together, is longer than the limit", () => {
    expect(reasonOf(input([failure("t::a", "x".repeat(FAILURE_ATTRIBUTION_LIMITS.textMax + 1))], [change("src/a.ts")]))).toBe("too_much_text");
    expect(attributeFailures(input([failure("t::a", "x".repeat(FAILURE_ATTRIBUTION_LIMITS.textMax))], [change("src/a.ts")])).mode).toBe("per_test");
    const failures = Array.from({ length: FAILURE_ATTRIBUTION_LIMITS.failuresMax }, (_, index) => failure(`t::${String(index)}`, "x".repeat(FAILURE_ATTRIBUTION_LIMITS.textMax)));
    expect(FAILURE_ATTRIBUTION_LIMITS.failuresMax * FAILURE_ATTRIBUTION_LIMITS.textMax).toBeGreaterThan(FAILURE_ATTRIBUTION_LIMITS.totalTextMax);
    expect(reasonOf(input(failures, [change("src/a.ts")]))).toBe("too_much_text");
  });

  it("when anything is not what the contract says (a bad id, path, commit, status, text or shape), checked at runtime", () => {
    const bad: unknown[] = [
      null, "x", { failures: "no", changes: [] }, { failures: [], changes: "no" },
      input([failure("")], []), input([failure("a\nb")], []), input([failure("t::a", 5 as unknown as string)], []), input([{ id: 5 as unknown as string }], []),
      input([failure("t::a", "x", 5 as unknown as string)], []),
      input([failure("t::a", "x")], [change("")]), input([failure("t::a", "x")], [change("a\u0000b")]), input([failure("t::a", "x")], [change("src/a.ts", "not-a-sha")]),
      input([failure("t::a", "x")], [change("src/a.ts", SHA_A), change("src/a.ts", SHA_B)]),
      input([failure("t::a", "x")], [{ path: "src/a.ts", status: "RENAMED" as unknown as "ADDED" }]), input([failure("t::a", "x")], [null as unknown as FailureChange]),
    ];
    for (const value of bad) expect(reasonOf(value as FailureAttributionInput)).toBe("bad_input");
  });

  it("when reading the input throws (a getter or a proxy), and never throws itself", () => {
    const hostile = { failures: [failure("t::a", "x")], get changes(): FailureChange[] { throw new Error("boom"); } };
    expect(reasonOf(hostile as unknown as FailureAttributionInput)).toBe("bad_input");
    expect(attributeFailures(base()).mode).toBe("per_test");
  });

  it("never copies a word of the failure text into the result", () => {
    const secret = ["sk", "live", "canary"].join("-");
    const result = JSON.stringify(attributeFailures(input([failure("t::a", `${secret} at x (src/a.ts:1:1)`)], [change("src/a.ts", SHA_A)])));
    expect(result).not.toContain(secret);
    const fallback = JSON.stringify(attributeFailures(input([failure("t::a", `${secret}`)], [change("src/a.ts", SHA_A)])));
    expect(fallback).not.toContain(secret);
  });
});

describe("bounded work", () => {
  it("finishes the largest input inside the limits in well under a second, even when the text is built to be slow", () => {
    const changes = Array.from({ length: FAILURE_ATTRIBUTION_LIMITS.changesMax }, (_, index) => change(`src/deep/${String(index % 50)}/f${String(index)}.ts`, index % 2 === 0 ? SHA_A : SHA_B));
    const slashes = "/".repeat(FAILURE_ATTRIBUTION_LIMITS.textMax);
    const dense = "a/".repeat(FAILURE_ATTRIBUTION_LIMITS.textMax / 2);
    const failures = Array.from({ length: FAILURE_ATTRIBUTION_LIMITS.failuresMax }, (_, index) => failure(`t::${String(index)}`, (index % 2 === 0 ? slashes : dense).slice(0, FAILURE_ATTRIBUTION_LIMITS.textMax)));
    const started = performance.now();
    const result = attributeFailures({ failures: failures.slice(0, Math.floor(FAILURE_ATTRIBUTION_LIMITS.totalTextMax / FAILURE_ATTRIBUTION_LIMITS.textMax)), changes });
    const elapsed = performance.now() - started;
    expect(result.mode).toBe("per_test");
    expect(elapsed).toBeLessThan(1500);
  });

  it("finds the named file in a long text of ordinary lines", () => {
    const filler = "    at someFunction (/work/repo/node_modules/lib/index.js:10:2)\n".repeat(60);
    const tail = `${filler.slice(0, 1000)}at x (src/a.ts:9:9)\n`;
    expect(one(input([failure("t::a", tail)], [change("src/a.ts", SHA_A)]))).toMatchObject({ kind: "change", commit: SHA_A });
  });
});

describe("namedChangedPaths", () => {
  it("returns each changed path the text names once, sorted, and nothing for text that names none", () => {
    expect(namedChangedPaths("at a (src/b.ts:1:1)\nat c (src/a.ts:2)\nat d (src/b.ts:9:9)", new Set(["src/a.ts", "src/b.ts", "src/c.ts"]))).toEqual(["src/a.ts", "src/b.ts"]);
    expect(namedChangedPaths("nothing here", new Set(["src/a.ts"]))).toEqual([]);
    expect(namedChangedPaths("", new Set(["src/a.ts"]))).toEqual([]);
  });

  it("accepts a path with a line and column, file:// and trailing punctuation, and rejects one glued to other letters", () => {
    const set = new Set(["src/a.ts"]);
    expect(namedChangedPaths("file:///work/src/a.ts:3:4", set)).toEqual(["src/a.ts"]);
    expect(namedChangedPaths("see src/a.ts.", set)).toEqual(["src/a.ts"]);
    expect(namedChangedPaths("see xsrc/a.ts", set)).toEqual([]);
  });
});

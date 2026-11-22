import { describe, expect, it } from "vitest";
import { countRunnableTests, validatePinnedHistory, validatePinnedTests } from "../support/pinned-tests.js";

const header = 'import { it, test, describe } from "vitest";\n';
const body = header + 'it("kept", () => { expect(true).toBe(true); });';
const path = "tests/contract/kept.test.ts";
const pin = { path, minimumTests: 1, reason: "Reviewed regression", decision: "DEC 254zzz333" };
const registry = (entries: unknown[] = [pin]) => ({ version: 1, tests: entries });
const pending = { ...pin, path: "tests/contract/restored.test.ts", restoringLane: "RESTORE-8F1BE0A80 item 1", deletedBy: "8f1be0a80" };
const withPending = (entries: unknown[] = [pending]) => ({ ...registry(), pendingRestore: entries });
const validate = (entries: unknown, files: Record<string, string> = { [path]: body }) => validatePinnedTests(entries, (file) => files[file]);

describe("pinned test guard", () => {
  it("counts runnable declarations, including aliases, namespace imports and each, without expanding rows", () => {
    expect(countRunnableTests(header + `
      import { it as check } from "vitest";
      import * as v from "vitest";
      const identity = <T>(value: T): T => value;
      it("one", () => { expect(1).toBe(1); });
      test.each([1, 2])("row", (n) => expect(n).toBe(n));
      check.concurrent("alias", async () => { await Promise.resolve(); });
      v.test("namespace", () => expect(true).toBe(true));
    `)).toBe(4);
  });

  it("ignores comments, strings, foreign calls and empty or missing callbacks", () => {
    expect(countRunnableTests(header + `
      // it("comment", () => { expect(1).toBe(1); });
      const text = 'test("string", () => expect(true).toBe(true))';
      other.it("foreign", () => expect(true).toBe(true));
      it("empty", () => {}); test("missing");
    `)).toBe(0);
    expect(countRunnableTests('import { it } from "other"; it("foreign", () => expect(true).toBe(true));')).toBe(0);
  });

  it("does not let skip, todo, conditional tests or skipped suites pad the floor", () => {
    expect(countRunnableTests(header + `
      it.skip("skip", () => expect(true).toBe(true));
      test.todo("todo");
      it.skipIf(true)("conditional", () => expect(true).toBe(true));
      describe.skip.each([1])("suite", () => { it("hidden", () => expect(true).toBe(true)); });
      describe("live", () => { test("kept", () => expect(true).toBe(true)); });
    `)).toBe(1);
  });

  it("accepts a retained file at or above its minimum without executing it", () => {
    expect(validate(registry())).toEqual([]);
    expect(validate(registry(), { [path]: body + '\ntest("extra", () => { throw new Error("never executed"); });' })).toEqual([]);
  });

  it("reports a deleted pinned file", () => {
    expect(validate(registry(), {})).toEqual([`${path}: missing pinned test file`]);
  });

  it("reports an emptied or reduced pinned file", () => {
    expect(validate(registry(), { [path]: header })).toEqual([`${path}: 0 runnable declarations, minimum 1`]);
    expect(validate(registry([{ ...pin, minimumTests: 2 }]))).toEqual([`${path}: 1 runnable declarations, minimum 2`]);
  });

  it("refuses a rename without the historical registry entry moving", () => {
    expect(validate(registry(), { "tests/contract/moved.test.ts": body })).toEqual([`${path}: missing pinned test file`]);
  });

  it("accepts an explicit existing replacement and preserves the old floor", () => {
    const replacement = "tests/contract/moved.test.ts";
    const entries = registry([{ ...pin, "replaced-by": replacement }]);
    expect(validate(entries, { [replacement]: body })).toEqual([]);
    expect(validate(entries, {})).toEqual([`${replacement}: missing pinned test file (replaces ${path})`]);
    expect(validate(entries, { [replacement]: header })).toEqual([`${replacement}: 0 runnable declarations, minimum 1`]);
  });

  it("rejects invalid, empty and unsupported registries", () => {
    for (const value of [null, [], {}, { version: 2, tests: [pin] }, registry([]), registry([null])]) {
      expect(validate(value).length).toBeGreaterThan(0);
    }
  });

  it("requires positive integer floors, a reason and an owning decision", () => {
    for (const change of [{ minimumTests: 0 }, { minimumTests: 1.5 }, { reason: " " }, { decision: "" }]) {
      expect(validate(registry([{ ...pin, ...change }])).length).toBeGreaterThan(0);
    }
  });

  it("rejects escaping, noncanonical and nontest paths, including replacements", () => {
    for (const bad of ["../outside.test.ts", "/tests/a.test.ts", "tests/../a.test.ts", "tests//a.test.ts", "tests/a.ts", "tests\\a.test.ts"]) {
      expect(validate(registry([{ ...pin, path: bad }])).length).toBeGreaterThan(0);
      expect(validate(registry([{ ...pin, "replaced-by": bad }])).length).toBeGreaterThan(0);
    }
  });

  it("rejects duplicate historical paths and duplicate effective replacements", () => {
    expect(validate(registry([pin, pin])).length).toBeGreaterThan(0);
    expect(validate(registry([pin, { ...pin, path: "tests/other.test.ts", "replaced-by": path }])).length).toBeGreaterThan(0);
    expect(validate(registry([{ ...pin, "replaced-by": path }])).length).toBeGreaterThan(0);
  });

  it("cannot hide a deletion by dropping a registry row or lowering its floor", () => {
    expect(validatePinnedHistory(registry([{ ...pin, path: "tests/new.test.ts" }]), registry())).toEqual([`${path}: historical pin removed; retain it with replaced-by when moving`]);
    expect(validatePinnedHistory(registry(), registry([{ ...pin, minimumTests: 2 }]))).toEqual([`${path}: minimum lowered from 2 to 1`]);
  });

  it("allows a historical pin to move explicitly and its floor to grow", () => {
    expect(validatePinnedHistory(registry([{ ...pin, "replaced-by": "tests/new.test.ts", minimumTests: 2 }]), registry())).toEqual([]);
  });

  it("rejects malformed history instead of silently discarding it", () => {
    for (const prior of [null, {}, registry([]), registry([null])]) expect(validatePinnedHistory(registry(), prior).length).toBeGreaterThan(0);
  });

  it("keeps absent pending restores visible without relaxing active existence or counts", () => {
    expect(validate(withPending())).toEqual([]);
    expect(validate(withPending(), {})).toEqual([`${path}: missing pinned test file`]);
    expect(validate(withPending(), { [path]: header })).toEqual([`${path}: 0 runnable declarations, minimum 1`]);
  });

  it("requires promotion as soon as a pending file exists, even when empty", () => {
    for (const source of ["", header, body]) {
      expect(validate(withPending(), { [path]: body, [pending.path]: source })).toEqual([`promote ${pending.path} to active`]);
    }
  });

  it("requires valid pending paths, restore ownership and deletion provenance", () => {
    for (const change of [{ path: "../outside.test.ts" }, { restoringLane: "" }, { restoringLane: "RESTORE-8F1BE0A80 item 4" }, { deletedBy: "" }, { deletedBy: "not-a-commit" }, { minimumTests: 0 }]) {
      expect(validate(withPending([{ ...pending, ...change }])).length).toBeGreaterThan(0);
    }
    expect(validate({ ...registry(), pendingRestore: null }).length).toBeGreaterThan(0);
    expect(validate(withPending([null])).length).toBeGreaterThan(0);
    expect(validate(withPending([]))).toEqual([]);
  });

  it("rejects duplicate pending paths and overlap with active paths or replacements", () => {
    expect(validate(withPending([pending, pending])).length).toBeGreaterThan(0);
    expect(validate(withPending([{ ...pending, path }])).length).toBeGreaterThan(0);
    expect(validate({ ...withPending(), tests: [{ ...pin, "replaced-by": pending.path }] }, { [pending.path]: body }).length).toBeGreaterThan(0);
  });

  it("retains pending history until promotion at its reviewed floor", () => {
    expect(validatePinnedHistory(registry(), withPending())).toEqual([`${pending.path}: pending restore removed; retain it until promoted to active`]);
    expect(validatePinnedHistory(withPending([{ ...pending, minimumTests: 1 }]), withPending([{ ...pending, minimumTests: 2 }]))).toEqual([`${pending.path}: minimum lowered from 2 to 1`]);
    expect(validatePinnedHistory({ ...registry([pin, { ...pin, path: pending.path }]), pendingRestore: [] }, withPending())).toEqual([]);
    expect(validatePinnedHistory(withPending(), registry([pin, { ...pin, path: pending.path }]))).toEqual([`${pending.path}: historical pin removed; retain it with replaced-by when moving`]);
    expect(validatePinnedHistory(withPending([null]), withPending()).length).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { APPROVED_FLOOR_DROPS, countRunnableTests, validatePinnedGitHistory, validatePinnedHistory, validatePinnedTests } from "../support/pinned-tests.js";

const header = 'import { it, test, describe } from "vitest";\n';
const body = header + 'it("kept", () => { expect(true).toBe(true); });';
const path = "tests/contract/kept.test.ts";
const pin = { path, minimumTests: 1, reason: "Reviewed regression", decision: "DEC 254zzz333" };
const registry = (entries: unknown[] = [pin]) => ({ version: 1, tests: entries });
const pending = { ...pin, path: "tests/contract/restored.test.ts", restoringLane: "RESTORE-8F1BE0A80 item 1", deletedBy: "8f1be0a80" };
const withPending = (entries: unknown[] = [pending]) => ({ ...registry(), pendingRestore: entries });
const validate = (entries: unknown, files: Record<string, string> = { [path]: body }) => validatePinnedTests(entries, (file) => files[file]);

describe("pinned test guard", () => {
  it("checks the first merge parent when HEAD has already deleted both a file and its row", () => {
    const current = registry([{ ...pin, path: "tests/contract/other.test.ts" }]);
    // A depth-2 merge checkout: HEAD has the PR's registry; only HEAD^1 retains the deleted pin.
    const git = (args: string[]): string => {
      const ref = args[0] === "show" ? args[1]!.split(":")[0] : args[2];
      if (ref !== "HEAD" && ref !== "HEAD^1") throw Object.assign(new Error("shallow ref"), { status: 128 });
      if (args[0] === "ls-tree") return "tests/pinned-tests.json\n";
      if (args[0] === "show") return JSON.stringify(ref === "HEAD^1" ? registry() : current);
      return ref;
    };
    expect(validatePinnedGitHistory(current, git)).toEqual([`HEAD^1: ${path}: historical pin removed; retain it with replaced-by when moving`]);
  });

  it("permits first installation at a valid base without a registry", () => {
    expect(validatePinnedGitHistory(registry(), (args) => {
      if (args[0] === "show") throw new Error("must not read an absent registry");
      return args[0] === "ls-tree" ? "" : "valid ref";
    })).toEqual([]);
  });

  it("propagates missing git, an unreadable HEAD, ref errors and history read errors", () => {
    for (const failure of [{ code: "ENOENT" }, { status: 128 }, { status: 1 }]) {
      const error = Object.assign(new Error("git failed"), failure);
      expect(() => validatePinnedGitHistory(registry(), () => { throw error; })).toThrow(error);
    }
    for (const command of ["rev-parse", "ls-tree", "show"]) {
      const error = Object.assign(new Error("optional history read failed"), { status: command === "rev-parse" ? 1 : 128 });
      expect(() => validatePinnedGitHistory(registry(), (args) => {
        if (args[0] === command && (args[2] === "HEAD^1" || args[1] === "HEAD^1:tests/pinned-tests.json")) throw error;
        return args[0] === "show" ? JSON.stringify(registry()) : "exists";
      })).toThrow(error);
    }
  });

  it("rejects malformed registry JSON at a valid historical ref", () => {
    expect(() => validatePinnedGitHistory(registry(), (args) => args[0] === "show" ? "{" : "exists")).toThrow(SyntaxError);
  });

  it("records the reviewed restore targets for all ten trimmed files", () => {
    const actual = JSON.parse(readFileSync(new URL("../pinned-tests.json", import.meta.url), "utf8")) as { tests: (typeof pin & { restoreTarget?: number })[] };
    expect(Object.fromEntries(actual.tests.filter((entry) => entry.restoreTarget !== undefined).map((entry) => [entry.path, entry.restoreTarget]))).toEqual({
      "tests/contract/admin-actions.test.ts": 11,
      "tests/contract/company-layout-grants.test.ts": 11,
      "tests/contract/core-app-routes.test.ts": 16,
      "tests/unit/core-host-dev-routes.test.ts": 59,
      "tests/contract/developer-token-verifier.test.ts": 10,
      "tests/contract/vitest-config.test.ts": 6,
      "tests/contract/task-people.test.ts": 36,
      "tests/contract/admin-change-plans.test.ts": 12,
      "tests/contract/admin-change-routes.test.ts": 43,
      "tests/contract/signin-workspace-hint.test.ts": 15,
    });
  });

  it("pins all six company workspace declarations in the real registry", () => {
    const actual = JSON.parse(readFileSync(new URL("../pinned-tests.json", import.meta.url), "utf8")) as { tests: (typeof pin)[] };
    const workspace = actual.tests.find((entry) => entry.path === "tests/contract/company-slack-any-workspace.test.ts");
    expect(workspace?.minimumTests).toBe(6);
    expect(validate(registry([workspace]), { [workspace!.path]: header + Array.from({ length: 5 }, () => body).join("\n") })).toEqual([`${workspace!.path}: 5 runnable declarations, minimum 6`]);
  });

  it("reminds restoration to raise the floor at or above the target, including replacements", () => {
    const targetPin = { ...pin, restoreTarget: 2 };
    expect(validate(registry([targetPin]))).toEqual([]);
    for (const count of [2, 3]) {
      expect(validate(registry([targetPin]), { [path]: header + body.repeat(count) })).toEqual([`${path}: restored to ${count} runnable declarations; raise minimumTests to at least 2`]);
    }
    expect(validate(registry([{ ...targetPin, minimumTests: 2 }]), { [path]: header + body.repeat(2) })).toEqual([]);
    expect(validate(registry([{ ...targetPin, minimumTests: 3 }]), { [path]: header + body.repeat(3) })).toEqual([]);
    const replacement = "tests/contract/replacement.test.ts";
    expect(validate(registry([{ ...targetPin, "replaced-by": replacement }]), { [replacement]: header + body.repeat(2) })).toEqual([`${replacement}: restored to 2 runnable declarations; raise minimumTests to at least 2`]);
  });

  it("rejects malformed restore targets", () => {
    for (const restoreTarget of [0, -1, 1.5, "2", null]) {
      expect(validate(registry([{ ...pin, restoreTarget }])).length).toBeGreaterThan(0);
    }
  });

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

  // One-time exception (DEC 254zzz555); delete with APPROVED_FLOOR_DROPS in the next train.
  it("lists exactly the two owner-approved floor drops, accepts only those, and refuses any other or deeper drop", () => {
    expect(APPROVED_FLOOR_DROPS).toEqual([
      { path: "tests/contract/task-people.test.ts", from: 36, to: 34, decision: "DEC 254zzz555" },
      { path: "tests/unit/github-webhook-install-cases.test.ts", from: 6, to: 5, decision: "DEC 254zzz555" },
    ]);
    expect(Object.isFrozen(APPROVED_FLOOR_DROPS)).toBe(true);
    const at = (file: string, minimumTests: number) => registry([{ ...pin, path: file, minimumTests }]);
    // the approved drops pass, exactly
    expect(validatePinnedHistory(at("tests/contract/task-people.test.ts", 34), at("tests/contract/task-people.test.ts", 36))).toEqual([]);
    expect(validatePinnedHistory(at("tests/unit/github-webhook-install-cases.test.ts", 5), at("tests/unit/github-webhook-install-cases.test.ts", 6))).toEqual([]);
    // a deeper drop, a drop from another held floor, a drop that was not approved, and another path are refused
    expect(validatePinnedHistory(at("tests/contract/task-people.test.ts", 33), at("tests/contract/task-people.test.ts", 36))).toEqual(["tests/contract/task-people.test.ts: minimum lowered from 36 to 33"]);
    expect(validatePinnedHistory(at("tests/contract/task-people.test.ts", 33), at("tests/contract/task-people.test.ts", 34))).toEqual(["tests/contract/task-people.test.ts: minimum lowered from 34 to 33"]);
    expect(validatePinnedHistory(at("tests/contract/task-people.test.ts", 35), at("tests/contract/task-people.test.ts", 36))).toEqual(["tests/contract/task-people.test.ts: minimum lowered from 36 to 35"]);
    expect(validatePinnedHistory(at("tests/unit/github-webhook-install-cases.test.ts", 4), at("tests/unit/github-webhook-install-cases.test.ts", 6))).toEqual(["tests/unit/github-webhook-install-cases.test.ts: minimum lowered from 6 to 4"]);
    expect(validatePinnedHistory(at("tests/contract/aws-engine-boundary.test.ts", 25), at("tests/contract/aws-engine-boundary.test.ts", 26))).toEqual(["tests/contract/aws-engine-boundary.test.ts: minimum lowered from 26 to 25"]);
    expect(validatePinnedHistory(at(path, 34), at(path, 36))).toEqual([`${path}: minimum lowered from 36 to 34`]);
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

// TIER-GROWTH-MERGE: a file the host lists with no patch (binary, or over the host's size) is never "reviewed as nothing": the grown reviews do not complete, and no model is asked.
import { describe, expect, it, vi } from "vitest";
import { grownReviewsOf } from "../../packages/broker/src/core/build-step/tier-checks.js";

const base = { model: { model: undefined, sameModelAsChecked: true }, level: "standard" as const, files: ["a.bin"], patchText: JSON.stringify([{ path: "a.bin", patch: null }]) };
const file = (extra: Record<string, unknown>) => ({ path: "a.bin", status: "modified", additions: 0, deletions: 0, ...extra }) as never;

describe("grownReviewsOf", () => {
  it("does not ask a model about a file with no patch, and says the change was too large to review", async () => {
    const call = vi.fn(async () => "{\"findings\":[]}");
    const result = await grownReviewsOf({ ...base, call }, [file({})], false);
    expect(result).toMatchObject({ completed: false, failure: "too_large" });
    expect(call).not.toHaveBeenCalled();
  });
  it("asks both reviewers when every file has its patch, and not again for one that already passed", async () => {
    const call = vi.fn(async () => "{\"findings\":[]}");
    const files = [file({ patch: "@@ -1 +1 @@\n-a\n+b\n" })];
    expect((await grownReviewsOf({ ...base, call }, files, false)).completed).toBe(true);
    expect(call).toHaveBeenCalledTimes(2);
    call.mockClear();
    await grownReviewsOf({ ...base, call, passed: ["code_review"] }, files, false);
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("leaves the lighter flow as it was: a file with no patch is still put to the reviewers there", async () => {
    const call = vi.fn(async () => "{\"findings\":[]}");
    expect((await grownReviewsOf({ ...base, call }, [file({})], true)).completed).toBe(true);
  });
  it("reports no reviewer when this install has no model call", async () => {
    expect(await grownReviewsOf({ ...base, call: undefined }, [file({ patch: "x" })], false)).toMatchObject({ completed: false, failure: "no_reviewer" });
  });
});

// TE-A6 (DEC 254zzf): the task's proof report lists the failing tests of a failed check with the change that most likely broke each, or "unknown", as inert text, ten tests across the report. A pack without
// causes gives the report it always did.
import { describe, expect, it } from "vitest";
import { EVIDENCE_RENDER_LIMITS, type EvidencePack } from "../../packages/contracts/src/index.js";
import { createCandidateManifest } from "../../packages/contracts/src/task-workflow-node.js";
import { failuresOf, proofReportOf } from "../../packages/broker/src/core-host/app/proof-report.js";
import { v1Pack } from "../support/evidence-v2-fixtures.js";

const SHA = "a".repeat(40);
const change = (path: string, commit?: string) => ({ kind: "change" as const, paths: [path], pathsCount: 1, ...(commit === undefined ? {} : { commit }), basis: ["named_in_failure" as const] });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const ids = (count: number, prefix = "t") => Array.from({ length: count }, (_, index) => `tests/${prefix}.test.ts::case ${String(index)}`);
/** A v1 pack whose first check failed with these failing tests and (optionally) these causes; `second` adds a second failed check. */
function packWith(failing: string[], causes?: unknown, second?: { failing: string[]; causes?: unknown }): EvidencePack {
  const pack = clone(v1Pack()) as unknown as { checks: Array<Record<string, unknown>> };
  const failedCheck = (base: Record<string, unknown>, names: string[], withCauses: unknown, checkId: string) => ({
    ...base, checkId, after: "failed", class: "regression", exitCode: 1,
    tests: { total: names.length + 1, passed: 1, failed: names.length, skipped: 0, errored: 0, names: [...names.map((name) => ({ name, status: "failed" })), { name: "tests/ok.test.ts::fine", status: "passed" }], newTests: [], ...(withCauses === undefined ? {} : { failureCauses: withCauses }) },
  });
  pack.checks[0] = failedCheck(pack.checks[0]!, failing, causes, "readiness:0");
  if (second !== undefined) pack.checks.push(failedCheck({ ...pack.checks[0], label: "second suite" }, second.failing, second.causes, "readiness:9"));
  return pack as unknown as EvidencePack;
}
const report = (pack: EvidencePack | undefined) => proofReportOf({ taskId: "t", title: "T", workspaceId: "w" } as never, { revision: 1 } as never, pack);
const FAILING = ["tests/cart.test.ts::applies discount", "tests/cart.test.ts::rounds"];
const GOOD = [{ testId: FAILING[0]!, cause: change("src/cart.ts", SHA) }, { testId: FAILING[1]!, cause: { kind: "unknown" as const, reason: "weak_evidence" as const } }];

describe("the failing tests in the proof report", () => {
  it("shows a review that could not run as not run, never passed", () => {
    const candidate = createCandidateManifest([{ repositoryId: "payments", commitSha: SHA, treeSha: "b".repeat(40) }]);
    const workflow = {
      candidate,
      verification: { candidateDigest: candidate.digest, results: [] },
      reviews: [{ candidateDigest: candidate.digest, role: "CRITIC", status: "UNKNOWN", findings: [] }],
    };
    const view = proofReportOf({ taskId: "t", title: "T", workspaceId: "w" } as never, workflow as never, undefined);
    expect(view.rows).toContainEqual({ claim: "Code review", check: "independent review", status: "not_run", detail: "the review could not finish" });
    expect(view.rows.find((row) => row.claim === "Code review")?.status).not.toBe("passed");
    const contradictory = { ...workflow, reviews: [{ ...workflow.reviews[0]!, status: "PASS", failureReason: "SESSION_FAILED" }] };
    expect(proofReportOf({ taskId: "t", title: "T", workspaceId: "w" } as never, contradictory as never, undefined).rows.find((row) => row.claim === "Code review"))
      .toMatchObject({ status: "not_run", detail: "the review could not finish" });
  });

  it("lists each failing test of a failed check with its likely cause or unknown", () => {
    expect(report(packWith(FAILING, GOOD)).failures).toEqual({
      checks: [{ check: "pytest -q", tests: [
        { test: FAILING[0], cause: "likely broken by a change (commit aaaaaaa) to src/cart.ts" },
        { test: FAILING[1], cause: "unknown (only weak evidence)" },
      ] }],
      more: 0,
    });
  });

  it("golden: without causes (or a pack, or a check that did not fail) the report has no failures key", () => {
    for (const pack of [packWith(FAILING), undefined, v1Pack()]) {
      const made = report(pack);
      expect(Object.keys(made)).not.toContain("failures");
    }
    const passed = clone(packWith(FAILING, GOOD)) as unknown as { checks: Array<{ after: string }> };
    passed.checks[0]!.after = "passed";
    expect(failuresOf(passed as unknown as EvidencePack)).toBeUndefined();
    // Byte for byte: the same pack with and without the causes gives the same report apart from the new field.
    const withCauses = { ...report(packWith(FAILING, GOOD)) } as Record<string, unknown>;
    delete withCauses["failures"];
    expect(JSON.stringify(withCauses)).toBe(JSON.stringify(report(packWith(FAILING))));
  });

  it("lists at most ten tests across all checks and counts the rest", () => {
    const first = ids(7, "a");
    const second = ids(6, "b");
    const make = (names: string[]) => names.map((testId) => ({ testId, cause: change("src/a.ts", SHA) }));
    const view = report(packWith(first, make(first), { failing: second, causes: make(second) })).failures!;
    expect(view.checks.map((check) => check.tests.length)).toEqual([7, EVIDENCE_RENDER_LIMITS.failureCausesListed - 7]);
    expect(view.more).toBe(3);
  });

});

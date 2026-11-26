// The task's proof index (`GET /v1/dev/tasks/{id}/evidence`, Cloud's `tasks.evidence.list`): the pure builder (proof-index.ts) and the old broker's route. The shape is written out here by hand as a
// strict schema (it mirrors Cloud's contract v0 `ProofIndexResponse` plus the optional failures), so a drifting field fails a test. The old broker's route keeps the task read's own rule
// (`loadReadableTask`): the owner reads it, anyone else, another company's task and a missing task read the same "not found". It keeps no evidence pack, so it never lists failures.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { EvidencePack, WorkflowSnapshot } from "@agentx/contracts";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { routeDeveloperTaskRequest } from "../../packages/broker/src/aws/developer-tasks.js";
import { PROOF_INDEX_FAILURES_MAX, PROOF_INDEX_ITEMS_MAX, proofIndexOf } from "../../packages/broker/src/core-host/app/proof-index.js";
import { OMAR, PRIYA, SAM, pageTask, type PageTaskFixture } from "../support/page-tasks.js";
import { DIGEST, v1Pack } from "../support/evidence-v2-fixtures.js";

const Item = z.object({
  id: z.string().regex(/^(?:check:\d+|evidence:\d+|review:(?:code|security))$/u), sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(), title: z.string().min(1).max(200),
  kind: z.enum(["check_result", "test_report", "review"]), verdict: z.enum(["pass", "fail", "unknown"]), criterionIds: z.array(z.string()).max(0),
}).strict();
const Index = z.object({
  taskId: z.string(), items: z.array(Item).max(PROOF_INDEX_ITEMS_MAX),
  failures: z.array(z.object({ check: z.string(), test: z.string(), cause: z.string().regex(/^(?:likely broken by a change|unknown)/u) }).strict()).min(1).max(PROOF_INDEX_FAILURES_MAX).optional(),
  failuresNotListed: z.number().int().min(1).optional(),
}).strict();

const OTHER = "org_aaaaaaaaaaaaaaaaaaaa";
const STRANGER: DeveloperCaller = { developerId: "9".repeat(64), sessionId: "s-stranger", amr: "slack", name: "Stranger" };
const SHA = "a".repeat(40);
const TAIL = "b".repeat(64);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const CHECK = (id: string, label: string) => ({ id, label, command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } });
const workflowWith = (fields: Record<string, unknown> = {}): WorkflowSnapshot => ({
  candidate: { digest: DIGEST }, checkPolicy: { required: [CHECK("readiness:0", "pytest -q"), CHECK("unit", "Unit tests")], optional: [], selectedOptionalIds: [], proposed: [] },
  verification: { candidateDigest: DIGEST, results: [{ checkId: "readiness:0", status: "PASS" }, { checkId: "unit", status: "UNKNOWN" }] },
  reviews: [{ role: "CRITIC", candidateDigest: DIGEST, status: "PASS", findings: [] }], ...fields,
}) as unknown as WorkflowSnapshot;
/** A pack whose checks failed with these tests (every check `failing[i]`), each test with a cause. */
function packWith(failingPerCheck: string[][]): EvidencePack {
  const pack = clone(v1Pack()) as unknown as { checks: Array<Record<string, unknown>> };
  const base = pack.checks[0]!;
  pack.checks = failingPerCheck.map((failing, index) => ({
    ...base, checkId: `readiness:${String(index)}`, label: `suite ${String(index)}`, after: "failed", class: "regression", exitCode: 1,
    tests: { total: failing.length, passed: 0, failed: failing.length, skipped: 0, errored: 0, names: failing.map((name) => ({ name, status: "failed" })), newTests: [],
      failureCauses: failing.map((testId) => ({ testId, cause: { kind: "change", paths: ["src/a.ts"], pathsCount: 1, commit: SHA, basis: ["named_in_failure"] } })) },
  }));
  return pack as unknown as EvidencePack;
}
const ids = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => `tests/${prefix}.test.ts::case ${String(index)}`);

describe("proofIndexOf", () => {
  it("one item per recorded result, review and kept check, in the contract's shape; a kept check stands for the recorded result of the same check", () => {
    const pack = clone(v1Pack()) as unknown as { checks: Array<Record<string, unknown>> };
    pack.checks[1]!["outputTailRef"] = { kind: "log", sha256: TAIL, bytes: 10, retentionClass: "evidence-std" };
    const index = Index.parse(proofIndexOf("t1", workflowWith(), pack as unknown as EvidencePack));
    expect(index).toEqual({
      taskId: "t1",
      items: [
        { id: "check:1", title: "Unit tests", kind: "check_result", verdict: "unknown", criterionIds: [] },
        { id: "review:code", title: "Code review", kind: "review", verdict: "pass", criterionIds: [] },
        { id: "evidence:0", title: "pytest -q", kind: "test_report", verdict: "pass", criterionIds: [] },
        { id: "evidence:1", sha256: TAIL, title: "ruff", kind: "check_result", verdict: "pass", criterionIds: [] },
        { id: "evidence:2", title: "semgrep", kind: "check_result", verdict: "pass", criterionIds: [] },
      ],
    });
  });

  it.each(["PASS"])("a failure-marked %s review is unknown in the shared index", (status) => {
    const workflow = workflowWith({ reviews: [{ role: "CRITIC", candidateDigest: DIGEST, status, failureReason: "SESSION_FAILED", findings: [] }] });
    expect(Index.parse(proofIndexOf("t", workflow, undefined)).items.find((item) => item.id === "review:code")?.verdict).toBe("unknown");
  });

  it("lists at most ten failing tests across checks and counts the rest; the rest is counted, never dropped silently", () => {
    const index = Index.parse(proofIndexOf("t", workflowWith(), packWith([ids(7, "a"), ids(6, "b")])));
    expect(index.failures).toHaveLength(PROOF_INDEX_FAILURES_MAX);
    expect(index.failures!.map((row) => row.check)).toEqual([...Array<string>(7).fill("suite 0"), ...Array<string>(3).fill("suite 1")]);
    expect(index.failuresNotListed).toBe(3);
    // Exactly ten: no count.
    const ten = proofIndexOf("t", workflowWith(), packWith([ids(10, "a")]));
    expect([ten.failures?.length, ten.failuresNotListed]).toEqual([10, undefined]);
  });

  it("answers at most a hundred items", () => {
    const results = Array.from({ length: 150 }, (_, index) => ({ checkId: `c${String(index)}`, status: "PASS" }));
    const index = Index.parse(proofIndexOf("t", workflowWith({ verification: { candidateDigest: DIGEST, results } }), packWith(Array.from({ length: 60 }, (_, index) => [`tests/x.test.ts::${String(index)}`]))));
    expect(index.items).toHaveLength(PROOF_INDEX_ITEMS_MAX);
  });

});

// ---- the old broker's route

const at = (fixture: PageTaskFixture, taskId = fixture.taskId) => new URL(`/v1/dev/tasks/${taskId}/evidence`, "https://agentx.invalid");
const call = (fixture: PageTaskFixture, caller: DeveloperCaller, taskId = fixture.taskId) =>
  routeDeveloperTaskRequest(fixture.deps, caller, { method: "GET", path: at(fixture, taskId).pathname, headers: {}, requestId: "r" }, at(fixture, taskId));
const refusal = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error as Error & { code?: string }; }
  throw new Error("expected a refusal");
};
function checked(fixture: PageTaskFixture): void {
  fixture.setWorkflow({ ...fixture.workflow(), candidate: undefined });
  const stored = fixture.db.get(`DEVTASK#${fixture.taskId}`, "META") as Record<string, unknown> & { workflow: Record<string, unknown> };
  // The workflow as the old broker keeps it once a candidate was checked (written whole, as the flow's commit does; the fixture's own setter re-parses a full snapshot).
  fixture.db.set({ ...stored, workflow: { ...stored.workflow, candidate: { digest: DIGEST }, verification: { candidateDigest: DIGEST, results: [{ checkId: "required-1", status: "FAILED" }] } } });
}

describe("GET /v1/dev/tasks/{id}/evidence on the old broker", () => {

  it("refuses anyone the task read refuses, exactly as a missing task", async () => {
    const fixture = pageTask({ shared: false });
    checked(fixture);
    const missing = await refusal(call(fixture, STRANGER, randomUUID()));
    for (const stranger of [STRANGER, OMAR, SAM]) {
      const error = await refusal(call(fixture, stranger));
      expect(error.code).toBe("TASK_NOT_FOUND");
      expect(error.message.replace(fixture.taskId, "<id>")).toBe(missing.message.replace(/no task [0-9a-f-]+ of yours/u, "no task <id> of yours"));
    }
  });

  it("a task of another company reads as a missing task, even to its own owner", async () => {
    for (const owned of [{ companyId: OTHER }, { orgId: OTHER }]) {
      const fixture = pageTask();
      checked(fixture);
      fixture.db.set({ ...(fixture.db.get(`DEVTASK#${fixture.taskId}`, "META") as Record<string, unknown>), ...owned });
      const error = await refusal(call(fixture, PRIYA));
      expect(error.code).toBe("TASK_NOT_FOUND");
      expect(error.message).not.toContain(OTHER);
    }
    // And the other way: a call for company B never reads company A's task.
    const fixture = pageTask();
    checked(fixture);
    fixture.deps.companyId = OTHER;
    expect((await refusal(call(fixture, PRIYA))).code).toBe("TASK_NOT_FOUND");
  });

});

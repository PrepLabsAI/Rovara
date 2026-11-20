// L4-EVCI2: propose -> confirm -> stored -> the line on the pull request. The setup card's route (on a laptop: local/app/eval-check.ts) keeps the confirmed check; the `ciEvidence` port that merge tracking reads
// (`evalCheckEvidencePort`) gives it back; a tracking pass then says "Eval (reported by your CI)" in the description. None (or nothing confirmed) leaves a pass exactly what it was, and another company's or
// project's confirmation never reaches this one. The merge side (what the line says, advisory only) is tests/unit/eval-ci-result.test.ts.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVAL_CI_LABEL, GITHUB_ACTIONS_APP_ID, IMPLICIT_COMPANY_ID, createCandidateManifest, type Check, type CheckRunner } from "@agentx/contracts";
import { registerMergeActionDecider, trackTask, type MergeTrackingDependencies } from "../../packages/broker/src/core/merge/merge-tracking.js";
import { installCiFixDecider, uninstallCiFixDecider } from "../../packages/broker/src/core/ci-fix/ci-fix.js";
import { ROVARA_STATUS_END, ROVARA_STATUS_START } from "../../packages/broker/src/core/proof/pull-request-body.js";
import { evalCheckEvidencePort } from "../../packages/broker/src/core/ci-evidence/eval-check-setting.js";
import { createLocalEvalCheck } from "../../packages/broker/src/local/app/eval-check.js";
import type { CiDefinitionReader } from "../../packages/broker/src/rovara-code/ci-checks.js";
import { CLOCK, TASK_ID, mergeWorld, type MergeWorld } from "../support/merge-world.js";

const MIN = 60_000;
const ACTIONS = String(GITHUB_ACTIONS_APP_ID);
const EVAL_URL = "https://github.com/acme/app/actions/runs/5/job/77";
const unit: Check = { name: "unit", state: "completed", conclusion: "success", required: false, url: "", runId: "11" };
const evals: Check = { name: "evals", state: "completed", conclusion: "success", required: false, url: EVAL_URL, runId: "77", source: ACTIONS };
const PROVEN = "**Proven** 2 of 2 requirements proven. Improved on eval.";
const bodyOf = (): string => ["Add a.", "", ROVARA_STATUS_START, "## Verified · Low risk · nothing extra to check", "", "**Changed** 1 file, +1 -0.", PROVEN, "**Tested against** Rovara has no record of which services the checks used.", "**Risk** Low.", "**Needs you** The normal code review. Nothing else.", ROVARA_STATUS_END, "", "Opened by Rovara."].join("\n");
const WORKFLOW = ["name: ci", "on: pull_request", "jobs:", "  unit:", "    runs-on: ubuntu-latest", "    steps:", "      - run: npm test", "  evals:", "    runs-on: ubuntu-latest", "    steps:", "      - run: npx promptfoo eval"].join("\n");
const reader: CiDefinitionReader = {
  list: async (path) => (path === ".github/workflows" ? { entries: [{ name: "ci.yml", path: ".github/workflows/ci.yml", type: "file" }], truncated: false } : undefined),
  read: async () => ({ text: WORKFLOW }),
};

async function world(withPort = true): Promise<{ w: MergeWorld; deps: MergeTrackingDependencies; card: ReturnType<typeof createLocalEvalCheck>; asked: unknown[] }> {
  const w = await mergeWorld();
  const at = new Date(CLOCK).toISOString();
  const candidate = createCandidateManifest([{ repositoryId: "app", commitSha: w.prs[0]!.head, treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
  const current = (await w.task()).workflow;
  await w.setWorkflow({
    ownerId: "a".repeat(64), createdAt: at, artifacts: [], decisions: [], candidate,
    verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: "test", recordedAt: at, results: [{ checkId: "unit", status: "PASS" }] },
    reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: "11111111-1111-4111-8111-111111111111", candidateDigest: candidate.digest, role, provider: "scripted", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: at })),
    pullRequests: (current.pullRequests ?? []).map((pr) => ({ ...pr, candidateDigest: candidate.digest })),
  });
  w.prs[0]!.model.update(w.prs[0]!.model.changeRequests[0]!.id, { body: bodyOf() });
  const runner: Partial<CheckRunner> = {
    kind: "github-actions", capabilities: { listByChangeRequest: true, listByRevision: false, logTail: true, start: false, rerun: false },
    listChecks: async () => [], logTail: async () => "a log that must never be read",
    runFacts: async (_target, check) => ({ attempt: 1, workflowRunId: `${check.runId ?? "0"}00`, startedAt: new Date(CLOCK).toISOString(), completedAt: new Date(CLOCK + 20 * MIN).toISOString() }),
    latestCheck: async () => undefined, reportFiles: async () => ({ kind: "none" }),
  };
  const asked: unknown[] = [];
  const port = evalCheckEvidencePort({ store: w.store, companyId: IMPLICIT_COMPANY_ID });
  const deps: MergeTrackingDependencies = {
    ...w.tracking, autonomy: () => "run",
    ...(withPort ? { ciEvidence: (task: Parameters<typeof port>[0]) => { asked.push(task); return port(task); } } : {}),
    repository: async (...args) => { const home = await w.tracking.repository(...args); return home === undefined ? undefined : { ...home, checkRunner: runner as CheckRunner }; },
  };
  const card = createLocalEvalCheck({
    flow: { store: w.store, projects: { latest: async (name: string) => (name === "web" ? { definition: { repositories: [{ name: "app", url: "https://github.com/acme/app", defaultBranch: "main" }] } } : undefined) } } as never,
    registry: {} as never, audit: { stage: () => [], record: async () => undefined }, now: () => CLOCK, readerFor: async () => reader,
  });
  return { w, deps, card, asked };
}
const owner = { principal: { companyId: IMPLICIT_COMPANY_ID, personId: "owner-1", displayName: "o", roles: ["owner"], provider: "local" } } as never;
const call = async (card: ReturnType<typeof createLocalEvalCheck>, method: "GET" | "PUT", body?: unknown) => {
  const answer = await card.routes({ method, path: "/v1/app/projects/web/ci-eval-check", headers: {}, body: body === undefined ? "" : JSON.stringify(body) }, owner);
  return { status: answer!.statusCode, body: JSON.parse(answer!.body) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const setChecks = (w: MergeWorld) => w.prs[0]!.model.setChecks(w.prs[0]!.head, [unit, evals]);
const body = (w: MergeWorld): string => w.prs[0]!.model.changeRequests[0]!.body ?? "";
const evalLines = (text: string): string[] => text.split("\n").filter((line) => line.includes(EVAL_CI_LABEL));

beforeEach(() => installCiFixDecider(registerMergeActionDecider));
afterEach(() => uninstallCiFixDecider());

describe("propose, confirm, stored, and the line appears on the pull request", () => {

  it("the proposal is read from the workflow files, one is confirmed, and the next pass says the customer's CI result under the Proven line", async () => {
    const { w, deps, card, asked } = await world();
    const proposed = await call(card, "GET");
    expect((proposed.body["proposals"] as { items: Array<{ name: string }> }).items.map((item) => item.name)).toEqual(["evals"]);
    expect((await call(card, "PUT", { requestId: randomUUID(), check: { name: "evals", source: ACTIONS } })).status).toBe(200);
    setChecks(w);
    await trackTask(deps, TASK_ID);
    expect(asked).toHaveLength(1);
    expect(evalLines(body(w))).toEqual([`  - Eval (reported by your CI): passed, ${EVAL_URL}`]);
    const lines = body(w).split("\n");
    expect(lines[lines.indexOf(PROVEN) + 1]).toBe(`  - Eval (reported by your CI): passed, ${EVAL_URL}`);
    expect(await w.trackingOf(w.prs[0]!)).toMatchObject({ ciEval: { name: "evals", state: "passed" } });
  });
});

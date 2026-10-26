// LIVEFIX-1 item 3 (AUTOFIXPROMPT): the owner told the planner "do not change package.json" when they asked for changes to the plan. The first automatic send back (and every other prompt that
// sends work back to the coder) said only what failed, so the coder's fix changed package.json. Every such prompt now carries the owner's plan-review instructions and the approved plan's
// Not changing list, outside the untrusted problem tags.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCandidateManifest, workflowFindingFingerprint, type WorkflowSnapshot } from "@agentx/contracts";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

type Harness = Awaited<ReturnType<typeof broker>>;
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const OWNER_NOTE = "Skip d1: do not change package.json. Keep the start script as it is.";
const NOT_CHANGING = "The package.json start script and its environment stay as they are.";
const FINDING = { text: "The new parser drops the last line.", origin: "INTRODUCED" as const, severity: "HIGH" as const, file: "src/parse.ts", line: 40 };

const operations = (harness: Harness, workspaceId: string) => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
const taskOf = (harness: Harness, taskId: string) => harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workflow: WorkflowSnapshot; workspaceId: string };
const workflowOf = (harness: Harness, taskId: string) => taskOf(harness, taskId).workflow;
const codingRuns = (harness: Harness, workspaceId: string) => operations(harness, workspaceId).filter((item) => item.workflowMode === "IMPLEMENT");
const reviewRuns = (harness: Harness, workspaceId: string) => operations(harness, workspaceId).filter((item) => item.workflowMode === "REVIEW");
const outboxPrompt = (harness: Harness, operationId: string) =>
  String((harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]?.invocation as { payload: { prompt: string } }).payload.prompt);
const passingChecks = () => ({ status: "verified", source: "project", preambleVersion: "1", preambleSha256: "c".repeat(64), checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 }], extraTry: "not_needed", agentClaim: "success" });
const candidateOf = (n: number) => createCandidateManifest([{ repositoryId: "demo", commitSha: n.toString(16).padStart(40, "d"), treeSha: n.toString(16).padStart(40, "b"), baseCommitSha: "e".repeat(40) }]);

type Config = { enabled: boolean; capUsd: number; roundEstimateUsd: number };
const broker = async (autofix: Config | null) => createDeveloperTaskBroker({ brokerExtra: { planSelfCheck: false, ...(autofix === null ? {} : { autofix }) } });

/** A Quick task whose owner asked for changes to the plan ("do not change package.json") and then approved the revised plan; ends in coding. */
async function startConstrained(harness: Harness, options: { requestChanges: boolean; notChanging: string[] }) {
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
  const taskId = String((started.body.task as { taskId: string }).taskId);
  const workspaceId = taskOf(harness, taskId).workspaceId;
  await harness.finish(workspaceId, String(operations(harness, workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", PREPARED);
  const writePlan = async (operationId: string, title: string) => {
    await harness.artifact(workspaceId, operationId, "plan.md", planAnswer(planDocument({ title, notChanging: options.notChanging })));
    await harness.finish(workspaceId, operationId, "SUCCEEDED", { result: { workflowMode: "PLAN" } });
  };
  await writePlan(String(operations(harness, workspaceId).find((item) => item.workflowMode === "PLAN")!.id), "Retry failed payments");
  if (options.requestChanges) {
    const requestId = randomUUID();
    const decided = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId, expectedRevision: workflowOf(harness, taskId).revision, decision: "REQUEST_CHANGES",
      reason: OWNER_NOTE, artifactDigest: workflowOf(harness, taskId).artifacts.at(-1)!.sha256 });
    if (decided.status !== 200) throw new Error(`request changes failed: ${JSON.stringify(decided.body)}`);
    await writePlan(String(operations(harness, workspaceId).find((item) => item.requestId === requestId)!.id), "Retry failed payments, v2");
  }
  const approved = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: workflowOf(harness, taskId).revision, decision: "APPROVE",
    reason: "Approved", artifactDigest: workflowOf(harness, taskId).artifacts.at(-1)!.sha256 });
  if (approved.status !== 200) throw new Error(`approval failed: ${JSON.stringify(approved.body)}`);
  /** Coding ends with the nth candidate; its reviews find an introduced problem, so REVIEW blocks. */
  const blockOnFindings = async (n: number) => {
    const candidate = candidateOf(n);
    const run = codingRuns(harness, workspaceId).at(-1)!;
    await harness.finish(workspaceId, String(run.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories, checks: passingChecks() } });
    const review = reviewRuns(harness, workspaceId).at(-1)!;
    const now = new Date().toISOString();
    await harness.finish(workspaceId, String(review.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories, workflowReviews: [
      { operationId: String(review.id), candidateDigest: candidate.digest, role: "CRITIC", provider: "t", version: "1", status: "FINDINGS", findings: [FINDING], readOnly: true, recordedAt: now },
      { operationId: String(review.id), candidateDigest: candidate.digest, role: "SECURITY", provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now },
    ] } });
    return candidate;
  };
  return { taskId, workspaceId, blockOnFindings };
}

/** The coder's latest prompt, and what it carries of the owner's words and the plan's Not changing list. */
const latestPrompt = (harness: Harness, workspaceId: string) => outboxPrompt(harness, String(codingRuns(harness, workspaceId).at(-1)!.id));
const expectConstraints = (prompt: string) => {
  expect(prompt).toContain("The owner's instructions from plan review (the owner's own words). They still hold: this change must not undo them.");
  expect(prompt).toContain(`1. ${OWNER_NOTE}`);
  expect(prompt).toContain("The approved plan says these stay as they are (Not changing). Do not change them:");
  expect(prompt).toContain(`- ${NOT_CHANGING}`);
  // Outside the untrusted tags: the owner's words are the owner's, never reviewer or check output.
  const problems = /<problem [^>]*>[\s\S]*?<\/problem>/g;
  for (const block of prompt.match(problems) ?? []) {
    expect(block).not.toContain("do not change package.json");
    expect(block).not.toContain(NOT_CHANGING);
  }
};

describe("every send back to the coder carries the owner's plan-review instructions and the plan's Not changing list (AUTOFIXPROMPT)", () => {
  it("the automatic send back (the live case: the owner said do not change package.json)", async () => {
    const harness = await broker({ enabled: true, capUsd: 1000, roundEstimateUsd: 3 });
    const ctx = await startConstrained(harness, { requestChanges: true, notChanging: [NOT_CHANGING] });
    await ctx.blockOnFindings(1);
    // Rovara sent it back by itself: a second coding run is running.
    expect(workflowOf(harness, ctx.taskId)).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
    expect(workflowOf(harness, ctx.taskId).decisions.filter((decision) => decision.source === "AUTO_FIX")).toHaveLength(1);
    const prompt = latestPrompt(harness, ctx.workspaceId);
    expect(prompt).toContain("Note (written by AgentX, which sent this back by itself)");
    expect(prompt).toContain(FINDING.text);
    expectConstraints(prompt);
  });

  it("the owner's own Send back", async () => {
    const harness = await broker(null);
    const ctx = await startConstrained(harness, { requestChanges: true, notChanging: [NOT_CHANGING] });
    await ctx.blockOnFindings(1);
    expect(workflowOf(harness, ctx.taskId)).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
    const sent = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${ctx.taskId}/workflow/send-back`, { requestId: randomUUID(), expectedRevision: workflowOf(harness, ctx.taskId).revision, instructions: "Fix the parser." });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const prompt = latestPrompt(harness, ctx.workspaceId);
    expect(prompt).toContain("Owner note (the owner's own instructions for this step): Fix the parser.");
    expectConstraints(prompt);
  });

  it("the owner's Resolve findings, for a finding to fix", async () => {
    const harness = await broker(null);
    const ctx = await startConstrained(harness, { requestChanges: true, notChanging: [NOT_CHANGING] });
    const candidate = await ctx.blockOnFindings(1);
    const blocked = workflowOf(harness, ctx.taskId);
    const resolved = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${ctx.taskId}/workflow/review-findings`, { requestId: randomUUID(), expectedRevision: blocked.revision, candidateDigest: candidate.digest,
      resolutions: [{ findingId: workflowFindingFingerprint("CRITIC", { text: FINDING.text, file: FINDING.file, line: FINDING.line }), action: "FIX", note: "Keep the last line." }] });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    const prompt = latestPrompt(harness, ctx.workspaceId);
    expect(prompt).toContain("Keep the last line.");
    expectConstraints(prompt);
  });

  it("says nothing extra when the owner gave no instruction and the plan leaves nothing as it is (a task that never asked for changes)", async () => {
    const harness = await broker({ enabled: true, capUsd: 1000, roundEstimateUsd: 3 });
    const ctx = await startConstrained(harness, { requestChanges: false, notChanging: ["None"] });
    await ctx.blockOnFindings(1);
    const prompt = latestPrompt(harness, ctx.workspaceId);
    expect(prompt).toContain("Note (written by AgentX, which sent this back by itself)");
    expect(prompt).not.toContain("plan review");
    expect(prompt).not.toContain("stay as they are");
  });

  it("carries the plan's Not changing list alone when the owner gave no instruction, and the owner's instructions alone when the plan has none", async () => {
    const withList = await broker({ enabled: true, capUsd: 1000, roundEstimateUsd: 3 });
    const a = await startConstrained(withList, { requestChanges: false, notChanging: [NOT_CHANGING] });
    await a.blockOnFindings(1);
    const listOnly = latestPrompt(withList, a.workspaceId);
    expect(listOnly).toContain(`- ${NOT_CHANGING}`);
    expect(listOnly).not.toContain("plan review");
    const withNote = await broker({ enabled: true, capUsd: 1000, roundEstimateUsd: 3 });
    const b = await startConstrained(withNote, { requestChanges: true, notChanging: ["None"] });
    await b.blockOnFindings(1);
    const noteOnly = latestPrompt(withNote, b.workspaceId);
    expect(noteOnly).toContain(`1. ${OWNER_NOTE}`);
    expect(noteOnly).not.toContain("stay as they are");
  });

  it("repeats an owner instruction only from a plan-review Request changes, never Rovara's own or an earlier send back's note", async () => {
    const harness = await broker({ enabled: true, capUsd: 1000, roundEstimateUsd: 3 });
    const ctx = await startConstrained(harness, { requestChanges: true, notChanging: [NOT_CHANGING] });
    await ctx.blockOnFindings(1);
    // Rovara's own send back is in the history now; the next prompt (after a second block) still lists only the owner's one instruction.
    await ctx.blockOnFindings(2);
    const prompt = latestPrompt(harness, ctx.workspaceId);
    expect(prompt.match(new RegExp(OWNER_NOTE.replace(/[.]/g, "\\."), "g"))).toHaveLength(1);
    expect(workflowOf(harness, ctx.taskId).decisions.filter((decision) => decision.source === "AUTO_FIX")).toHaveLength(2);
    // The prompt still names the plan the owner approved.
    expect(prompt).toContain(`Approved plan (sha256 ${workflowOf(harness, ctx.taskId).artifacts.filter((artifact) => artifact.type === "plan").at(-1)!.sha256}`);
  });
});

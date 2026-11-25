// The journeys' task drivers: each plays one stretch of a task on the real worker and the real core, through the world's person and worker (see hosted-core.ts). A stretch ends where a
// person acts or a code host speaks, so a journey picks up from there.
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { INTENT_BLOCK_INFO_STRING, PLAN_CRITIQUE_INFO_STRING } from "../../../packages/contracts/src/index.js";
import { planAnswer, planDocument } from "../../support/plan-documents.js";
import type { JourneyWorld } from "./hosted-core.js";

export const fenced = (info: string, value: unknown): string => `\`\`\`${info}\n${JSON.stringify(value)}\n\`\`\`\n`;

/** The plan every journey's planner writes: it names the change, the file and the test, and one check that runs code and proves each claim (or the core asks the planner again). */
export const HEALTH_PLAN = planAnswer(
  planDocument({ title: "Add the health endpoint", claims: [{ id: "1", text: "The service answers /health. The change is in health.txt, and tests/health.test.ts covers it." }] }),
  { checks: { checks: [{ label: "node runs", cwd: "repo/demo", executable: "node", args: ["--version"], proves: ["1", "nc1"] }], none_reason: null } },
);

/** A plan whose one check passes only once health.txt exists in the repository: the first implement that writes nothing fails it. */
export const FILE_CHECK_PLAN = planAnswer(
  planDocument({ title: "Add the health endpoint", claims: [{ id: "1", text: "The service answers /health. The change is in health.txt, and tests/health.test.ts covers it." }] }),
  { checks: { checks: [{ label: "health.txt exists", cwd: "repo/demo", executable: "node", args: ["-e", "process.exit(require('fs').existsSync('health.txt') ? 0 : 1)"], proves: ["1", "nc1"] }], none_reason: null } },
);

export const clean = (): ReturnType<typeof fauxAssistantMessage>[] => Array.from({ length: 4 }, () => fauxAssistantMessage('{"findings":[]}'));

export async function startTask(world: JourneyWorld, options: { path?: "QUICK" | "FULL"; instructions?: string; as?: JourneyWorld["maya"] } = {}): Promise<string> {
  const as = options.as ?? world.maya;
  const started = await as("POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: options.instructions ?? "Add a health endpoint", workflow: true, workflowPath: options.path ?? "QUICK" });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  return String((started.body.task as { taskId: string }).taskId);
}

/** Preparation, Understand, the plan and the plan check: the plan is now waiting for its owner as a decision card. */
export async function planUntilCard(world: JourneyWorld, taskId: string, options: { path?: "QUICK" | "FULL"; plan?: string } = {}): Promise<void> {
  await world.prepare(taskId);
  const understood = await world.runStep("UNDERSTAND", [fauxAssistantMessage(fenced(INTENT_BLOCK_INFO_STRING, { kind: "ready", path: options.path ?? "QUICK", restatement: "Add a health endpoint.", assumptions: [] }))]);
  expect(understood.operation.status, String(understood.operation.error)).toBe("SUCCEEDED");
  const planned = await world.runStep("PLAN", [fauxAssistantMessage(options.plan ?? HEALTH_PLAN)]);
  expect(planned.operation.status, String(planned.operation.error)).toBe("SUCCEEDED");
  const critiqued = await world.runStep("PLAN_CRITIQUE", [fauxAssistantMessage(fenced(PLAN_CRITIQUE_INFO_STRING, { verdict: "ok", points: [] }))]);
  expect(critiqued.operation.status, String(critiqued.operation.error)).toBe("SUCCEEDED");
}

/** The implement step: the worker's real bash tool writes health.txt in the repository, then says it is done. */
export const IMPLEMENT_SCRIPT = [fauxAssistantMessage([fauxToolCall("bash", { command: "printf ok > repo/demo/health.txt" })], { stopReason: "toolUse" }), fauxAssistantMessage("I added the health endpoint.")];

/** From an approved plan to the draft pull request on the code host. */
export async function buildUntilPullRequest(world: JourneyWorld, taskId: string) {
  const implemented = await world.runStep("IMPLEMENT", IMPLEMENT_SCRIPT);
  expect(implemented.operation.status, String(implemented.operation.error)).toBe("SUCCEEDED");
  const reviewed = await world.runStep("REVIEW", clean());
  expect(reviewed.operation.status, String(reviewed.operation.error)).toBe("SUCCEEDED");
  const pullRequest = await world.publish();
  expect(world.taskRow(taskId)!.workflow).toMatchObject({ stage: "WAIT_FOR_MERGE" });
  return pullRequest;
}

/** The code host's side before a merge: the person takes the pull request out of draft, CI passes, and (optionally) a reviewer other than the requester approves. Then the merge tracking job reads it. */
export async function hostReady(world: JourneyWorld, pullRequest: Awaited<ReturnType<JourneyWorld["publish"]>>, options: { approve?: boolean; linked?: boolean } = {}): Promise<void> {
  const model = world.harness.world.host.model;
  pullRequest.draft.draft = false;
  model.setChecks(pullRequest.commit, [{ name: "unit", state: "completed", conclusion: "success", required: false, url: "", runId: "11" }]);
  if (options.approve !== false) {
    // The approver is a linked current member (27d: an unlinked reviewer's approval counts for nothing), unless the journey is about the unlinked case.
    if (options.linked === false) model.setAccount("priya", "write"); else await world.linkColleagueGithub("priya");
    model.addReview(pullRequest.draft.id, { login: "priya", state: "APPROVED", revision: pullRequest.commit });
  }
  await world.runJobs();
  await world.runJobs(120);
}

/**
 * The FULL path's planning, each document waiting for its owner on the decision card: requirements, then design (neither carries checks; evidence is checked against the repository, so the
 * claims cite none), then the implementation plan (named change, file, test and a proving check), checked by the critic. Ends with the implementation plan approved: the task is at IMPLEMENT.
 */
export async function planFullToImplement(world: JourneyWorld, taskId: string): Promise<{ approvals: string[] }> {
  const phase = () => (world.taskRow(taskId)!.workflow as unknown as { stage: string; reviewPhase?: string }).reviewPhase;
  const doc = (title: string) => planAnswer(planDocument({ title, claims: [{ id: "1", text: "The service answers /health." }] }));
  await world.prepare(taskId);
  const understood = await world.runStep("UNDERSTAND", [fauxAssistantMessage(fenced(INTENT_BLOCK_INFO_STRING, { kind: "ready", path: "FULL", restatement: "Add a health endpoint.", assumptions: [] }))]);
  expect(understood.operation.status, String(understood.operation.error)).toBe("SUCCEEDED");
  const approvals: string[] = [];
  for (const expected of ["REQUIREMENTS", "DESIGN"]) {
    expect(phase()).toBe(expected);
    expect((await world.runStep("PLAN", [fauxAssistantMessage(doc(expected))])).operation.status).toBe("SUCCEEDED");
    await world.approvePlan(taskId);
    approvals.push(expected);
  }
  expect(phase()).toBe("IMPLEMENTATION_PLAN");
  expect((await world.runStep("PLAN", [fauxAssistantMessage(HEALTH_PLAN)])).operation.status).toBe("SUCCEEDED");
  expect((await world.runStep("PLAN_CRITIQUE", [fauxAssistantMessage(fenced(PLAN_CRITIQUE_INFO_STRING, { verdict: "ok", points: [] }))])).operation.status).toBe("SUCCEEDED");
  await world.approvePlan(taskId);
  approvals.push("IMPLEMENTATION_PLAN");
  return { approvals };
}

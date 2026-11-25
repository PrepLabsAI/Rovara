// The journeys' PR feedback drivers (A1-10): a pull request with a teammate's comment, the real worker's feedback review, the owner's decision, and the fix's way to the code host. The fix's
// IMPLEMENT and REVIEW run on the real worker; the code host's side of the push (the branch the worker would have pushed to, and the update callbacks it makes) is set the way `publish()` sets it.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { feedbackCriticReply, firstUserText } from "../../support/faux-scripts.js";
import type { JourneyWorld } from "./hosted-core.js";
import { buildUntilPullRequest, clean, planUntilCard, startTask } from "./task.js";

type PullRequest = Awaited<ReturnType<typeof buildUntilPullRequest>>;
export interface Finding { id: string; priority: string; rationale: string; commentIds: string[]; comments?: Array<{ id: string; body: string }> }
export interface FeedbackView { revision: number; status: string; nextAction?: string; reviewDigest: string; proposalDigest: string; bundleDigests: string[]; findings: Finding[] }

/** The reviewer's answer: one recommended fix per comment bundle, naming health.txt (or `path`). */
export const criticAnswer = (path = "health.txt") => (context: Parameters<typeof firstUserText>[0]) => fauxAssistantMessage(feedbackCriticReply(firstUserText(context), { repositoryId: "demo", path, testPath: "health.test.ts" }));

/** A task with its draft pull request open and out of draft, and priya able to comment on it. */
export async function openPullRequest(w: JourneyWorld): Promise<{ taskId: string; pullRequest: PullRequest }> {
  const taskId = await startTask(w);
  await planUntilCard(w, taskId);
  await w.approvePlan(taskId);
  const pullRequest = await buildUntilPullRequest(w, taskId);
  pullRequest.draft.draft = false;
  w.harness.world.host.model.setAccount("priya", "write");
  return { taskId, pullRequest };
}

/** Merge tracking reads the comment from the code host and collects it; the real worker's feedback review runs; returns what the owner reads on the web. */
export async function reviewRound(w: JourneyWorld, taskId: string, answer = criticAnswer()): Promise<FeedbackView> {
  await w.runJobs();
  await w.runJobs(120);
  const reviewed = await w.runStep("FEEDBACK_REVIEW", [answer]);
  expect(reviewed.operation.status, String(reviewed.operation.error)).toBe("SUCCEEDED");
  return readFeedback(w, taskId);
}

export async function readFeedback(w: JourneyWorld, taskId: string): Promise<FeedbackView> {
  const view = await w.maya("GET", `/v1/dev/tasks/${taskId}/workflow/feedback`);
  expect(view.status, JSON.stringify(view.body).slice(0, 300)).toBe(200);
  return (view.body as { review: FeedbackView }).review;
}

/** The owner's press on the feedback page: the request the web app makes, bound to the review the owner was shown. */
export function decide(w: JourneyWorld, taskId: string, review: FeedbackView, decision: "APPROVE" | "DISMISS" | "REQUEST_CHANGES", extra: { selected?: string[]; note?: string } = {}) {
  return w.maya("POST", `/v1/dev/tasks/${taskId}/workflow/feedback-decision`, { requestId: randomUUID(), expectedRevision: review.revision, reviewDigest: review.reviewDigest, proposalDigest: review.proposalDigest,
    bundleDigests: review.bundleDigests, decision, selectedFindingIds: extra.selected ?? (decision === "APPROVE" ? review.findings.map((finding) => finding.id) : []), ...(extra.note === undefined ? {} : { ownerNote: extra.note }) });
}

/** The fix's coding step: the worker's real bash tool makes the change, then says so. */
export const fixScript = (command: string) => [fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }), fauxAssistantMessage("I made the change.")];

/** The approved fix's coding and review run on the real worker; the core then asks the machine to push it (the maintain step), which is returned, not answered. */
export async function fixUntilPush(w: JourneyWorld, command: string) {
  const implemented = await w.runStep("IMPLEMENT", fixScript(command));
  expect(implemented.operation.status, String(implemented.operation.error)).toBe("SUCCEEDED");
  const reviewed = await w.runStep("REVIEW", clean());
  expect(reviewed.operation.status, String(reviewed.operation.error)).toBe("SUCCEEDED");
  const asked = await w.dispatchOnly("maintain");
  const operation = w.harness.db.find((row) => row.entityType === "OPERATION" && row.id === asked.invocation.operationId)[0]!;
  return { ...asked, expected: operation.maintenance as { repository: string; pullRequestNumber: number; headBranch: string; baseBranch: string; expectedHeadCommit: string; workflowCandidate: { treeSha: string } } };
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
type Push = Awaited<ReturnType<typeof fixUntilPush>>;

/** The worker's push reaches the code host (its branch moves to the fix commit) and it calls back through the real routes with the operation's own capability. */
export async function landPush(w: JourneyWorld, push: Push, options: { callbacks?: boolean } = {}): Promise<{ commit: string; update: Awaited<ReturnType<JourneyWorld["postWorkerCallback"]>>; result: Awaited<ReturnType<JourneyWorld["postWorkerCallback"]>> }> {
  const { invocation, expected } = push;
  const commit = git(w.repository, "rev-parse", "HEAD");
  const model = w.harness.world.host.model;
  const paths = git(w.repository, "ls-tree", "-r", "--name-only", commit).split("\n").filter(Boolean);
  model.revisions.set(commit, { sha: commit, tree: git(w.repository, "rev-parse", `${commit}^{tree}`), parents: git(w.repository, "rev-list", "--parents", "-n", "1", commit).split(" ").slice(1),
    files: new Map(paths.map((path) => [path, git(w.repository, "show", `${commit}:${path}`)])), entries: new Map(paths.map((path) => [path, "file" as const])), symlinks: new Set() });
  model.branches.set(expected.headBranch, commit);
  // The push reached the host but the worker never called back (its machine was lost): only the host's side is set.
  if (options.callbacks === false) { const none = { status: 0, body: {} }; return { commit, update: none, result: none }; }
  const workspaceId = String(w.harness.db.find((row) => row.entityType === "OPERATION" && row.id === invocation.operationId)[0]!.workspaceId);
  const update = await w.postWorkerCallback(workspaceId, invocation.operationId, "pull-request-update", invocation.callbackCapability, { repository: expected.repository, pullRequestNumber: expected.pullRequestNumber, action: "append",
    headBranch: expected.headBranch, baseBranch: expected.baseBranch, previousCommit: expected.expectedHeadCommit, commit });
  const result = await w.postWorkerCallback(workspaceId, invocation.operationId, "result", invocation.callbackCapability, { operationId: invocation.operationId, status: "SUCCEEDED",
    result: { action: "append", repository: expected.repository, number: expected.pullRequestNumber, url: String(update.body.url), state: "open", headBranch: expected.headBranch, baseBranch: expected.baseBranch,
      previousCommit: expected.expectedHeadCommit, commit, treeSha: expected.workflowCandidate.treeSha, checks: [], reconciled: update.body.reconciled } });
  w.harness.world.machines.finish(push.machineId, invocation.operationId);
  return { commit, update, result };
}

/** The worker's push fails (the host refused it, or the head moved): its terminal result says so and nothing reached the branch. */
export async function failPush(w: JourneyWorld, push: Push, error: string) {
  const { invocation } = push;
  const workspaceId = String(w.harness.db.find((row) => row.entityType === "OPERATION" && row.id === invocation.operationId)[0]!.workspaceId);
  const result = await w.postWorkerCallback(workspaceId, invocation.operationId, "result", invocation.callbackCapability, { operationId: invocation.operationId, status: "FAILED", error });
  w.harness.world.machines.finish(push.machineId, invocation.operationId);
  return result;
}

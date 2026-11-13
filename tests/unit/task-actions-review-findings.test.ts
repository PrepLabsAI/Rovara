// Task actions (owner decision 198), review findings: the owner accepts (with a reason) or fixes each blocking review finding, and only the fixes go back to coding. The key rules, each tested against what the move left in
// the store:
//   1. only the owner or a co-owner decides; anyone else (and a script token) reads no such task, and nothing is written;
//   2. every finding is answered once, an accept needs a reason (a security finding too), at the revision and the code the person saw;
//   3. only the findings to fix reach the coder, with the owner's instruction for each; an accepted one is recorded for that code, with who and why;
//   4. the money: a fix is a round of paid coding (cap, admission, access); accepting everything starts only the draft pull request, which needs access but no model money;
//   5. the same request id once.
import { describe, expect, it } from "vitest";
import { WORKFLOW_BLOCK_REASONS, WorkflowSnapshotSchema, queryAll, redactText, returnWorkflowToImplementationAutomatically, when, wholeTaskSpendUsd, type WorkflowSnapshot } from "@agentx/contracts";
import type { Admission } from "@agentx/contracts";
import { startImplementation } from "../../packages/broker/src/core/build-step/start.js";
import { workflowPullRequestBody } from "../../packages/broker/src/core/proof/workflow-pull-request-body.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import { acceptedByOf } from "../../packages/broker/src/core/task-flow/finding-accept.js";
import { ownerNoteItem } from "../../packages/broker/src/core/task-flow/owner-note.js";
import { createTaskActions } from "../../packages/broker/src/core/task-flow/task-actions.js";
import { createOwnerRoutes } from "../../packages/broker/src/local/app/routes.js";
import { createAllowAllAdmission } from "../../packages/broker/src/ports/policy-defaults.js";
import { COMPANY } from "../support/task-flow-harness.js";
import {
  NOW, OWNER_KEY, PARSER, REQUEST_A, REQUEST_B, TASK_ID, TOKEN, accessWithoutOwners, blockedReview, code, codingOperations, dispatchRows, operationsOf, parserId, promptOf, report, seed, stateOf, taskOf, tokenId,
} from "../support/task-actions-world.js";

const both = () => blockedReview({}, [report("CRITIC", "FINDINGS", [PARSER]), report("SECURITY", "FINDINGS", [TOKEN])]);
const answer = (findingId: string, action: "ACCEPT" | "FIX", note = action === "ACCEPT" ? "A footer we drop on purpose." : "Keep the footer line.") => ({ findingId, action, note });
const request = (resolutions: unknown[], over: Record<string, unknown> = {}) => ({ requestId: REQUEST_A, expectedRevision: 6, candidateDigest: code.digest, resolutions, ...over });
const acceptAll = () => request([answer(parserId, "ACCEPT"), answer(tokenId, "ACCEPT", "Test token only.")]);
const mixed = () => request([answer(parserId, "FIX", "Keep the footer line."), answer(tokenId, "ACCEPT", "Test token only.")]);

describe("review findings", () => {
  it("sends only the findings to fix back to coding, with the owner's instruction for each, and records the accepted one with who and why", async () => {
    const { h, caller } = await seed({ workflow: both() });
    const view = await createTaskActions(h.deps).resolveFindings(caller, TASK_ID, mixed());
    // 6 (blocked) -> 7 (sent back, ready for coding) -> 8 (the coding run started).
    expect(view.workflow).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING", revision: 8 });
    const task = await taskOf(h);
    expect(task.workflow!.decisions.at(-1)).toMatchObject({ requestId: REQUEST_A, decision: "REQUEST_CHANGES", source: "FINDINGS", actorRole: "TASK_OWNER", reason: "1 accepted, 1 to fix" });
    expect(task.workflow!.acceptedFindings).toEqual([{ candidateDigest: code.digest, role: "SECURITY", fingerprint: tokenId, text: TOKEN.text, reason: "Test token only.", actorId: task.ownerKey, at: expect.any(String) as string }]);
    const [run] = await codingOperations(h);
    const prompt = promptOf(run!);
    // The finding to fix is listed (as data), the accepted one is not, and the owner's instruction is outside the tags.
    expect(prompt).toContain("New parser drops the last line. (src/parse.ts:12)");
    expect(prompt).not.toContain(TOKEN.text);
    expect(prompt).toMatch(/Fix only the problems listed\. The owner's instructions for them, numbered in the order the problems are listed:\n1\. Keep the footer line\./u);
    expect(h.audit.map((event) => event.action)).toEqual(["task.findings_resolved"]);
    expect(h.audit[0]!.details).toMatchObject({ accepted: 1, toFix: 1, securityAccepted: 1 });
    // Counts only: no finding text and no reason in the audit line.
    expect(JSON.stringify(h.audit[0])).not.toContain("footer");
    expect(JSON.stringify(h.audit[0])).not.toContain(TOKEN.text);
  });

  it("numbers the owner's instructions by the order the problems are listed, not the order they were answered in", async () => {
    const reversed = blockedReview({}, [report("SECURITY", "FINDINGS", [TOKEN]), report("CRITIC", "FINDINGS", [PARSER])]);
    const { h, caller } = await seed({ workflow: reversed });
    await createTaskActions(h.deps).resolveFindings(caller, TASK_ID, request([answer(parserId, "FIX", "About the parser."), answer(tokenId, "FIX", "About the token.")]));
    const prompt = promptOf((await codingOperations(h))[0]!);
    // The coder lists the security review's finding first (the reviews' order); its note is number 1.
    expect(prompt.indexOf(TOKEN.text)).toBeLessThan(prompt.indexOf("New parser drops the last line."));
    expect(prompt).toContain("1. About the token.\n2. About the parser.");
  });

  it("with every finding accepted the draft pull request is due: the decision, the reasons, and no coding", async () => {
    const { h, caller } = await seed({ workflow: both() });
    const view = await createTaskActions(h.deps).resolveFindings(caller, TASK_ID, acceptAll());
    expect(view.workflow).toMatchObject({ stage: "PULL_REQUEST", revision: 7 });
    const task = await taskOf(h);
    expect(task.workflow!.decisions.at(-1)).toMatchObject({ decision: "APPROVE", source: "FINDINGS", reason: "2 accepted, 0 to fix", actorRole: "TASK_OWNER" });
    expect(task.workflow!.acceptedFindings?.map((entry) => [entry.role, entry.reason])).toEqual([["CRITIC", "A footer we drop on purpose."], ["SECURITY", "Test token only."]]);
    expect(await codingOperations(h)).toHaveLength(0);
    // The publication was asked for (a row, or the operation it made): never coding.
    const rows = await dispatchRows(h);
    const publications = (await operationsOf(h)).filter((operation) => operation.kind === "publish");
    expect(rows.length + publications.length).toBeGreaterThan(0);
  });

  it("starts nothing when another review still blocks: only the decision is written", async () => {
    const { h, caller } = await seed({ workflow: blockedReview({}, [report("CRITIC", "FINDINGS", [PARSER]), report("SECURITY", "FAILED", [])]) });
    const view = await createTaskActions(h.deps).resolveFindings(caller, TASK_ID, request([answer(parserId, "ACCEPT")]));
    expect(view.workflow).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
    expect(await operationsOf(h)).toHaveLength(0);
    expect(await dispatchRows(h)).toHaveLength(0);
    expect((await taskOf(h)).workflow!.acceptedFindings).toHaveLength(1);
  });

  it("refuses an accept with no reason, even for a security finding, and writes nothing", async () => {
    const { h, caller } = await seed({ workflow: both() });
    const actions = createTaskActions(h.deps);
    const before = await stateOf(h);
    for (const note of ["", "   ", "x".repeat(501)]) {
      await expect(actions.resolveFindings(caller, TASK_ID, request([answer(parserId, "ACCEPT", "A footer."), answer(tokenId, "ACCEPT", note)]))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    await expect(actions.resolveFindings(caller, TASK_ID, request([answer(parserId, "FIX", "x".repeat(1_001)), answer(tokenId, "ACCEPT", "Test token.")]))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await stateOf(h)).toEqual(before);
    expect((await taskOf(h)).workflow!.acceptedFindings).toBeUndefined();
  });

  it("refuses a missing, unknown or repeated answer, and an empty list, and writes nothing", async () => {
    const { h, caller } = await seed({ workflow: both() });
    const actions = createTaskActions(h.deps);
    const before = await stateOf(h);
    await expect(actions.resolveFindings(caller, TASK_ID, request([answer(parserId, "ACCEPT")]))).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("every blocking finding") as string });
    await expect(actions.resolveFindings(caller, TASK_ID, request([answer(parserId, "ACCEPT"), answer(tokenId, "ACCEPT"), answer("f".repeat(64), "FIX", "")]))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(actions.resolveFindings(caller, TASK_ID, request([answer(parserId, "ACCEPT"), answer(parserId, "ACCEPT")]))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(actions.resolveFindings(caller, TASK_ID, request([]))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await stateOf(h)).toEqual(before);
  });

  it("holds the revision and the code the person saw", async () => {
    const { h, caller } = await seed({ workflow: both() });
    const actions = createTaskActions(h.deps);
    const before = await stateOf(h);
    await expect(actions.resolveFindings(caller, TASK_ID, { ...acceptAll(), expectedRevision: 5 })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(actions.resolveFindings(caller, TASK_ID, { ...acceptAll(), expectedRevision: 7 })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(actions.resolveFindings(caller, TASK_ID, { ...acceptAll(), candidateDigest: "9".repeat(64) })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await stateOf(h)).toEqual(before);
  });

  it("is refused for anyone but the owner or a co-owner, a script token, a closed task and a task that is not at a blocked review", async () => {
    const guest = await seed({ workflow: both() });
    const before = await stateOf(guest.h);
    await expect(createTaskActions(guest.h.deps).resolveFindings(guest.h.guest, TASK_ID, acceptAll())).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(await stateOf(guest.h)).toEqual(before);
    const viewer = await seed({ workflow: both(), access: accessWithoutOwners() });
    await expect(createTaskActions(viewer.h.deps).resolveFindings(viewer.h.guest, TASK_ID, acceptAll())).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect((await taskOf(viewer.h)).workflow!.acceptedFindings).toBeUndefined();
    const token = await seed({ workflow: both() });
    await expect(createTaskActions(token.h.deps).resolveFindings({ ...token.h.owner, scriptToken: { tokenId: "t", name: "CI", permissions: ["read", "start"], projects: ["payments"] } }, TASK_ID, acceptAll())).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    const closed = await seed({ workflow: both(), task: { closedAt: "2026-11-10T11:00:00.000Z" } });
    await expect(createTaskActions(closed.h.deps).resolveFindings(closed.caller, TASK_ID, acceptAll())).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    const running = await seed({ workflow: WorkflowSnapshotSchema.parse({ ...both(), state: "RUNNING", blockReason: undefined }) });
    await expect(createTaskActions(running.h.deps).resolveFindings(running.caller, TASK_ID, acceptAll())).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    const plain = await seed({ workflow: null });
    await expect(createTaskActions(plain.h.deps).resolveFindings(plain.caller, TASK_ID, acceptAll())).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The workspace was closed or never got ready: nothing can be started on it, so nothing is decided.
    for (const status of ["CLOSED", "PREPARATION_FAILED"]) {
      const stuck = await seed({ workflow: both(), workspace: { status } });
      const stuckBefore = await stateOf(stuck.h);
      await expect(createTaskActions(stuck.h.deps).resolveFindings(stuck.caller, TASK_ID, mixed())).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(await stateOf(stuck.h)).toEqual(stuckBefore);
    }
  });

  it("answers a repeat with the first and starts one run; other answers under the same id, or an id of another decision, are refused", async () => {
    const { h, caller } = await seed({ workflow: both() });
    const actions = createTaskActions(h.deps);
    const first = await actions.resolveFindings(caller, TASK_ID, mixed());
    const again = await actions.resolveFindings(caller, TASK_ID, mixed());
    expect(again.workflow?.revision).toBe(first.workflow?.revision);
    expect(await codingOperations(h)).toHaveLength(1);
    expect(h.audit).toHaveLength(1);
    // The same id with the accepted finding's reason changed, or the choices swapped, is another request.
    await expect(actions.resolveFindings(caller, TASK_ID, request([answer(parserId, "FIX", "Keep the footer line."), answer(tokenId, "ACCEPT", "A different reason.")]))).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(actions.resolveFindings(caller, TASK_ID, request([answer(parserId, "ACCEPT"), answer(tokenId, "FIX", "")]))).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    // Nothing accepted any more: the accepted finding's reason cannot differ, but the counts do.
    await expect(actions.resolveFindings(caller, TASK_ID, request([answer(parserId, "FIX", "Keep the footer line."), answer(tokenId, "FIX", "")]))).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const sent = await seed({ workflow: blockedReview({ decisions: [{ requestId: REQUEST_A, workflowRevision: 5, decision: "REQUEST_CHANGES", actorId: "a".repeat(64), actorRole: "TASK_OWNER", reason: "Fix it.", source: "SEND_BACK", at: "2026-11-10T09:00:00.000Z" }] }, [report("CRITIC", "FINDINGS", [PARSER]), report("SECURITY", "FINDINGS", [TOKEN])]) });
    await expect(createTaskActions(sent.h.deps).resolveFindings(sent.caller, TASK_ID, acceptAll())).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("starts one run when the same request arrives twice at once", async () => {
    const { h, caller } = await seed({ workflow: both() });
    const actions = createTaskActions(h.deps);
    const [a, b] = await Promise.all([actions.resolveFindings(caller, TASK_ID, mixed()), actions.resolveFindings(caller, TASK_ID, mixed())]);
    expect(a.workflow?.stage).toBe("IMPLEMENT");
    expect(b.workflow?.stage).toBe("IMPLEMENT");
    expect(await codingOperations(h)).toHaveLength(1);
    expect(await queryAll(h.store, { pk: `AUDIT#${COMPANY}`, sk: { op: "beginsWith", prefix: "EVENT#task.findings_resolved" } })).toHaveLength(1);
  });

  it("a fix is paid work: a task over its cap, an unreadable spend and a refused admission start nothing; accepting everything is not held by the cap", async () => {
    for (const cap of [{ limitUsd: 6, spentUsd: 6 }, { limitUsd: 6, spentUsd: undefined }]) {
      const { h, caller } = await seed({ workflow: both() });
      const before = await stateOf(h);
      await expect(createTaskActions(h.deps, { roundCap: async () => cap }).resolveFindings(caller, TASK_ID, mixed())).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
      expect(await stateOf(h)).toEqual(before);
    }
    const refusing: Admission = { ...createAllowAllAdmission(), async admit() { return { allowed: false, code: "budget_exhausted", message: "The monthly budget is used up." }; } };
    const refused = await seed({ workflow: both(), harness: { admission: refusing } });
    const before = await stateOf(refused.h);
    await expect(createTaskActions(refused.h.deps).resolveFindings(refused.caller, TASK_ID, mixed())).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(await stateOf(refused.h)).toEqual(before);
    // Nothing to pay for: the findings are accepted though the cap is used.
    const accepted = await seed({ workflow: both() });
    await createTaskActions(accepted.h.deps, { roundCap: async () => ({ limitUsd: 6, spentUsd: 6 }) }).resolveFindings(accepted.caller, TASK_ID, acceptAll());
    expect((await taskOf(accepted.h)).workflow!.acceptedFindings).toHaveLength(2);
  });

  it("the pull request is not started for an archived project or a person who may no longer have work run, and nothing is written", async () => {
    const archived = await seed({ workflow: both() });
    const projects = archived.h.deps.projects;
    archived.h.deps.projects = { ...projects, latest: async (project) => { const found = await projects.latest(project); return found === undefined ? undefined : { ...found, archived: true }; } };
    const before = await stateOf(archived.h);
    await expect(createTaskActions(archived.h.deps).resolveFindings(archived.caller, TASK_ID, acceptAll())).rejects.toMatchObject({ code: "PROJECT_ARCHIVED" });
    expect(await stateOf(archived.h)).toEqual(before);
    const lost = await seed({ workflow: both() });
    lost.h.deps.access = { ...lost.h.deps.access, checkStep: async () => ({ allowed: false, message: "This person no longer has access to the project." }) };
    const lostBefore = await stateOf(lost.h);
    await expect(createTaskActions(lost.h.deps).resolveFindings(lost.caller, TASK_ID, acceptAll())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createTaskActions(lost.h.deps).resolveFindings(lost.caller, TASK_ID, mixed())).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await stateOf(lost.h)).toEqual(lostBefore);
  });

  it("carries the change tier as it is through a fix", async () => {
    const tier = { level: "standard", kinds: ["code_config"], source: "diff", reasons: [{ code: "many_files" }], headSha: "1".repeat(40), at: "2026-11-10T09:00:00.000Z" };
    const flow = { rulesVersion: 1, tier };
    const { h, caller } = await seed({ workflow: WorkflowSnapshotSchema.parse({ ...both(), flow }) });
    await createTaskActions(h.deps).resolveFindings(caller, TASK_ID, mixed());
    expect((await taskOf(h)).workflow!.flow).toEqual(flow);
  });
});

describe("who accepted, and by what way (DECISIONS 201)", () => {
  it("records the person and the way for each accepted finding, and the pull request says so; a fix records none", async () => {
    const { h, caller } = await seed({ workflow: both() });
    await createTaskActions(h.deps).resolveFindings(caller, TASK_ID, acceptAll());
    const record = await h.store.get({ pk: `DEVTASK#${TASK_ID}`, sk: `FINDING_ACCEPT#${REQUEST_A}` });
    expect(record).toMatchObject({ personId: "local-owner", method: "api-token", fingerprints: [parserId, tokenId] });
    expect(h.audit[0]!.details).toMatchObject({ method: "api-token", securityAccepted: 1 });
    expect(h.audit[0]!.actor).toMatchObject({ id: "local-owner" });
    const by = await acceptedByOf(h.store, TASK_ID);
    expect(by).toEqual({ [parserId]: expect.stringContaining("via the API token") as string, [tokenId]: expect.stringContaining("via the API token") as string });
    const workflow = (await taskOf(h)).workflow!;
    const body = workflowPullRequestBody({ title: "Add a retry flag" }, workflow, "# Plan\n\n1. Add the retry flag.\n", undefined, { acceptedBy: by! });
    expect(body).toMatch(/\[security\] A token is written to the log\. \u2014 accepted: Test token only\. \(by .+ via the API token \(a tool\)\)/u);
    expect(body).toMatch(/\[code\] New parser drops the last line\. \u2014 accepted: A footer we drop on purpose\. \(by /u);
    // Nothing recorded: the line is as it was, with the reason alone.
    expect(workflowPullRequestBody({ title: "Add a retry flag" }, workflow, "# Plan\n\n1. Add the retry flag.\n", undefined, {})).not.toContain("via the API token");
    const fixOnly = await seed({ workflow: both() });
    await createTaskActions(fixOnly.h.deps).resolveFindings(fixOnly.caller, TASK_ID, request([answer(parserId, "FIX", "Keep it."), answer(tokenId, "FIX", "")]));
    expect(await fixOnly.h.store.get({ pk: `DEVTASK#${TASK_ID}`, sk: `FINDING_ACCEPT#${REQUEST_A}` })).toBeUndefined();
  });

  it("records only the findings that were accepted, and the page as the way when the page asks", async () => {
    const { h, caller } = await seed({ workflow: both() });
    await createTaskActions(h.deps).resolveFindings(caller, TASK_ID, mixed(), "page");
    expect(await h.store.get({ pk: `DEVTASK#${TASK_ID}`, sk: `FINDING_ACCEPT#${REQUEST_A}` })).toMatchObject({ method: "page", fingerprints: [tokenId] });
    expect(await acceptedByOf(h.store, TASK_ID)).toEqual({ [tokenId]: expect.stringContaining("via the task page") as string });
  });

  it("an AI tool holding the API token may accept a finding (a security one too) with a reason, over the laptop's route, as the person", async () => {
    const { h } = await seed({ workflow: both() });
    const routes = createOwnerRoutes({ flow: h.flow, blobs: {} as never, openPage: async () => undefined, version: "0.0.0-test" });
    const post = async (payload: unknown) => (await routes({ method: "POST", path: `/v1/dev/tasks/${TASK_ID}/workflow/review-findings`, headers: {}, body: JSON.stringify(payload) }, h.owner))!;
    // No reason: refused, even for a security finding, and nothing is recorded.
    const noReason = await post(request([answer(parserId, "ACCEPT"), answer(tokenId, "ACCEPT", "  ")]));
    expect(noReason.statusCode).toBe(400);
    expect(await h.store.get({ pk: `DEVTASK#${TASK_ID}`, sk: `FINDING_ACCEPT#${REQUEST_A}` })).toBeUndefined();
    const ok = await post(acceptAll());
    expect(ok.statusCode).toBe(200);
    expect(await h.store.get({ pk: `DEVTASK#${TASK_ID}`, sk: `FINDING_ACCEPT#${REQUEST_A}` })).toMatchObject({ personId: "local-owner", method: "api-token" });
    expect((await taskOf(h)).workflow!.acceptedFindings).toHaveLength(2);
  });
});

describe("the coder's notes belong to the round they were written for", () => {
  const NOTE_TEXT = "Fix only the problems listed. The owner's instructions for them, numbered in the order the problems are listed:\n1. SENTINEL-OWNER-NOTE";
  const ownerFindingsDecision = { requestId: REQUEST_B, workflowRevision: 5, decision: "REQUEST_CHANGES", actorId: OWNER_KEY, actorRole: "TASK_OWNER", reason: "1 accepted, 1 to fix", source: "FINDINGS", at: "2026-11-10T09:00:00.000Z" };
  const failingChecks = { candidateDigest: code.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: "2026-11-10T10:00:00.000Z", results: [{ checkId: "unit", status: "FAILED" }] };
  const roundPrompt = async (workflow: WorkflowSnapshot) => {
    const { h } = await seed({ workflow });
    // The note is kept under the owner's decision, and (as a trap) under Rovara's own decision too: a note is used only when a person made the last decision.
    await h.store.transact([ownerNoteItem({ taskId: TASK_ID, requestId: REQUEST_B, text: NOTE_TEXT, now: new Date(NOW) }), ownerNoteItem({ taskId: TASK_ID, requestId: workflow.decisions.at(-1)!.requestId, text: NOTE_TEXT, now: new Date(NOW) })].filter((item, index, all) => index === 0 || (item as { item: { sk: string } }).item.sk !== (all[0] as { item: { sk: string } }).item.sk));
    expect(await startImplementation(h.deps, { taskId: TASK_ID, workflowRevision: workflow.revision })).toBe("STARTED");
    return promptOf((await codingOperations(h))[0]!);
  };

  it("a Rovara auto-fix round after the owner's findings decision gets none of the owner's notes; a round the owner sent back gets them", async () => {
    const clear = [report("CRITIC", "PASS", []), report("SECURITY", "PASS", [])];
    const failed = WorkflowSnapshotSchema.parse({ ...blockedReview({ decisions: [ownerFindingsDecision] }, clear), stage: "VERIFY", blockReason: "a selected check failed", verification: failingChecks });
    const auto = returnWorkflowToImplementationAutomatically(failed, { expectedRevision: failed.revision, reason: "A selected check failed.", spend: { spentUsd: wholeTaskSpendUsd(0), roundEstimateUsd: 1, capUsd: 15 }, now: NOW });
    expect(auto.decisions.at(-1)).toMatchObject({ source: "AUTO_FIX", actorRole: "AGENTX" });
    const automatic = await roundPrompt(auto);
    expect(automatic).toContain("Unit failed");
    expect(automatic).not.toContain("SENTINEL-OWNER-NOTE");
    expect(automatic).not.toContain("Owner note");
    // The same workflow with the owner's findings decision last: the notes are the round's.
    const sentBack = WorkflowSnapshotSchema.parse({ ...auto, decisions: [ownerFindingsDecision] });
    expect(await roundPrompt(sentBack)).toContain("SENTINEL-OWNER-NOTE");
  });
});

describe("what the owner writes is redacted and fenced", () => {
  it("a key-shaped string in a fix instruction does not reach the coder; the words around it do", async () => {
    // Built at runtime: no key-shaped text is written in the source.
    const fake = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
    expect(redactText(fake)).not.toBe(fake);
    const { h, caller } = await seed({ workflow: both() });
    await createTaskActions(h.deps).resolveFindings(caller, TASK_ID, request([answer(parserId, "FIX", `Keep the footer line, the key ${fake} is fake.`), answer(tokenId, "ACCEPT", "Test token only.")]));
    const prompt = promptOf((await codingOperations(h))[0]!);
    expect(prompt).not.toContain(fake);
    expect(prompt).toContain("Keep the footer line, the key");
  });

  it("a person's move never skips an approval of more spend: a review blocked on a budget pause is refused, and nothing is written", async () => {
    for (const blockReason of [WORKFLOW_BLOCK_REASONS.budgetPaused, "This plan's run limit is $12, which needs a project maintainer's approval."]) {
      const { h, caller } = await seed({ workflow: blockedReview({ blockReason }, [report("CRITIC", "FINDINGS", [PARSER]), report("SECURITY", "FINDINGS", [TOKEN])]) });
      const before = await stateOf(h);
      await expect(createTaskActions(h.deps).resolveFindings(caller, TASK_ID, mixed())).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("more spend") as string });
      expect(await stateOf(h)).toEqual(before);
    }
  });

  it("commits the steps the access seam asks for with the decision, and a fence that no longer holds refuses it with nothing written", async () => {
    const fence = (): TaskFlowDeps["access"] => ({ ...createOwnerTaskAccess(), ownerActing: async (_principal, task) => ({ actorId: task.ownerKey, items: [{ kind: "put", item: { pk: "ACCESS_FENCE#payments", sk: "META", entityType: "ACCESS_FENCE" }, condition: when.absent() }] }) });
    const holds = await seed({ workflow: both(), access: fence() });
    await createTaskActions(holds.h.deps).resolveFindings(holds.caller, TASK_ID, mixed());
    expect(await holds.h.store.get({ pk: "ACCESS_FENCE#payments", sk: "META" })).toBeDefined();
    const broken = await seed({ workflow: both(), access: fence() });
    await broken.h.store.put({ item: { pk: "ACCESS_FENCE#payments", sk: "META", entityType: "ACCESS_FENCE" } });
    await expect(createTaskActions(broken.h.deps).resolveFindings(broken.caller, TASK_ID, mixed())).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await taskOf(broken.h)).workflow!.acceptedFindings).toBeUndefined();
    expect(await codingOperations(broken.h)).toHaveLength(0);
  });
});

describe("the owner's route", () => {
  it("serves review findings at /workflow/review-findings as the owner, and says no such task to anyone else", async () => {
    const run = async (who: "owner" | "guest") => {
      const { h } = await seed({ workflow: both() });
      const routes = createOwnerRoutes({ flow: h.flow, blobs: {} as never, openPage: async () => undefined, version: "0.0.0-test" });
      const answered = (await routes({ method: "POST", path: `/v1/dev/tasks/${TASK_ID}/workflow/review-findings`, headers: {}, body: JSON.stringify(mixed()) }, who === "owner" ? h.owner : h.guest))!;
      return { h, status: answered.statusCode, json: JSON.parse(answered.body) as { task?: { workflow?: { stage: string } }; error?: { code: string; message: string } } };
    };
    const ok = await run("owner");
    expect(ok.status).toBe(200);
    expect(ok.json.task?.workflow?.stage).toBe("IMPLEMENT");
    const no = await run("guest");
    expect(no.status).toBe(404);
    expect(no.json.error?.code).toBe("TASK_NOT_FOUND");
    expect((await taskOf(no.h)).workflow!.acceptedFindings).toBeUndefined();
  });
});

describe("a second answer by another id", () => {
  it("is refused once the first moved the workflow on", async () => {
    const { h, caller } = await seed({ workflow: both() });
    const actions = createTaskActions(h.deps);
    await actions.resolveFindings(caller, TASK_ID, mixed());
    await expect(actions.resolveFindings(caller, TASK_ID, { ...mixed(), requestId: REQUEST_B })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await codingOperations(h)).toHaveLength(1);
  });
});

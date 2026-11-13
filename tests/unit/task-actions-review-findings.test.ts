// Task actions (owner decision 198), review findings: the owner accepts (with a reason) or fixes each blocking review finding, and only the fixes go back to coding. The key rules, each tested against what the move left in
// the store:
//   1. only the owner or a co-owner decides; anyone else (and a script token) reads no such task, and nothing is written;
//   2. every finding is answered once, an accept needs a reason (a security finding too), at the revision and the code the person saw;
//   3. only the findings to fix reach the coder, with the owner's instruction for each; an accepted one is recorded for that code, with who and why;
//   4. the money: a fix is a round of paid coding (cap, admission, access); accepting everything starts only the draft pull request, which needs access but no model money;
//   5. the same request id once.
import { describe, expect, it } from "vitest";
import { WorkflowSnapshotSchema, queryAll } from "@agentx/contracts";
import type { Admission } from "@agentx/contracts";
import { createTaskActions } from "../../packages/broker/src/core/task-flow/task-actions.js";
import { createOwnerRoutes } from "../../packages/broker/src/local/app/routes.js";
import { createAllowAllAdmission } from "../../packages/broker/src/ports/policy-defaults.js";
import { COMPANY } from "../support/task-flow-harness.js";
import {
  PARSER, REQUEST_A, REQUEST_B, TASK_ID, TOKEN, accessWithoutOwners, blockedReview, code, codingOperations, dispatchRows, operationsOf, parserId, promptOf, report, seed, stateOf, taskOf, tokenId,
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

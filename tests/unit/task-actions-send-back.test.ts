// Task actions (owner decision 198), send back: the owner sends the change back to coding with their words. The key rules, each tested against what the move left in the store:
//   1. only the task's owner or a co-owner moves it; anyone else (and a script token) reads no such task, and nothing is written;
//   2. the revision the person saw is held, a repeat of the same request answers the first, other words under the same id are refused;
//   3. the money: a task over its cap, a spend nobody can read, a refused admission and a task waiting for more spend start no coding;
//   4. the coder gets the problems as untrusted data and the owner's words whole (not cut to the decision's 500 characters);
//   5. the change tier is carried, never reset.
import { describe, expect, it } from "vitest";
import type { Admission, AdmissionRequest } from "@agentx/contracts";
import { WORKFLOW_BLOCK_REASONS, WorkflowSnapshotSchema, queryAll } from "@agentx/contracts";
import { createTaskActions } from "../../packages/broker/src/core/task-flow/task-actions.js";
import { OWNER_ROUND_ADMISSION_ACTION } from "../../packages/broker/src/core/task-flow/owner-round.js";
import { createOwnerRoutes } from "../../packages/broker/src/local/app/routes.js";
import { scriptTokenRoute } from "../../packages/broker/src/core/script-tokens/authenticate.js";
import { createAllowAllAdmission } from "../../packages/broker/src/ports/policy-defaults.js";
import { COMPANY } from "../support/task-flow-harness.js";
import {
  REQUEST_A, REQUEST_B, TASK_ID, accessWithoutOwners, blockedReview, code, codingOperations, dispatchRows, promptOf, report, seed, stateOf, taskOf,
} from "../support/task-actions-world.js";

const body = (expectedRevision: number | undefined, instructions = "Keep the footer line, and add a test for it.", requestId = REQUEST_A) => ({ requestId, instructions, ...(expectedRevision === undefined ? {} : { expectedRevision }) });

describe("send back to coding", () => {
  it("returns a blocked review to coding: the decision, the coding run with the problems and the owner's words, the audit line, and the kept words", async () => {
    const { h, caller } = await seed();
    const actions = createTaskActions(h.deps);
    const long = `Keep the footer line. ${"Also explain why the last line matters. ".repeat(30)}`;
    expect(long.length).toBeGreaterThan(500);
    const view = await actions.sendBack(caller, TASK_ID, body(6, long));
    // Revision 6 (blocked) -> 7 (the send-back, ready for coding) -> 8 (the coding run started).
    expect(view.workflow).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING", revision: 8 });
    const task = await taskOf(h);
    const decision = task.workflow!.decisions.at(-1)!;
    expect(decision).toMatchObject({ requestId: REQUEST_A, decision: "REQUEST_CHANGES", source: "SEND_BACK", actorRole: "TASK_OWNER", actorId: task.ownerKey });
    // The decision keeps 500 characters; the coder is given the whole words.
    expect(decision.reason).toHaveLength(500);
    const [run] = await codingOperations(h);
    expect(run).toMatchObject({ kind: "task", workflowMode: "IMPLEMENT", status: "ACCEPTED" });
    const prompt = promptOf(run!);
    expect(prompt).toContain("Owner note (the owner's own instructions for this step)");
    expect(prompt).toContain(long.trim());
    // The reviewer's finding is data inside a tag that carries the section's own id; the owner's words are outside it.
    expect(prompt).toMatch(/<problem id="[a-f0-9]{16}" source="code review">New parser drops the last line\. \(src\/parse\.ts:12\)<\/problem>/u);
    expect(prompt).toContain("Approved plan (sha256");
    expect(h.audit.map((event) => event.action)).toEqual(["task.sent_back"]);
    expect(await dispatchRows(h)).toHaveLength(0);
  });

  it("sends back a failed check the same way, and a change ready to publish", async () => {
    const failing = WorkflowSnapshotSchema.parse({ ...blockedReview({}, [report("CRITIC", "PASS", []), report("SECURITY", "PASS", [])]), stage: "VERIFY", blockReason: "a selected check failed",
      verification: { candidateDigest: code.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: "2026-11-10T10:00:00.000Z", results: [{ checkId: "unit", status: "FAILED" }] } });
    const { h, caller } = await seed({ workflow: failing });
    const view = await createTaskActions(h.deps).sendBack(caller, TASK_ID, body(6, "Fix the failing unit test."));
    expect(view.workflow).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
    expect(promptOf((await codingOperations(h))[0]!)).toContain("Unit failed");
  });

  it("is refused for anyone but the owner or a co-owner, and writes nothing", async () => {
    const guest = await seed();
    const before = await stateOf(guest.h);
    await expect(createTaskActions(guest.h.deps).sendBack(guest.h.guest, TASK_ID, body(6))).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(await stateOf(guest.h)).toEqual(before);
    // A person who may see and drive the task but is not an owner of it reads the same answer.
    const viewer = await seed({ access: accessWithoutOwners() });
    const viewerBefore = await stateOf(viewer.h);
    await expect(createTaskActions(viewer.h.deps).sendBack(viewer.h.guest, TASK_ID, body(6))).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(await stateOf(viewer.h)).toEqual(viewerBefore);
    // A script token is never the owner acting, and its route list does not hold this route either.
    const token = await seed();
    await expect(createTaskActions(token.h.deps).sendBack({ ...token.h.owner, scriptToken: { tokenId: "t", name: "CI", permissions: ["read", "start"], projects: ["payments"] } }, TASK_ID, body(6))).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(scriptTokenRoute("POST", `/v1/dev/tasks/${TASK_ID}/workflow/send-back`)).toBeUndefined();
    expect(await codingOperations(token.h)).toHaveLength(0);
  });

  it("holds the revision the person saw: a stale one is refused, a missing one too, and nothing is written", async () => {
    const { h, caller } = await seed();
    const actions = createTaskActions(h.deps);
    const before = await stateOf(h);
    await expect(actions.sendBack(caller, TASK_ID, body(5))).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(actions.sendBack(caller, TASK_ID, body(7))).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(actions.sendBack(caller, TASK_ID, body(undefined))).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("current revision") as string });
    expect(await stateOf(h)).toEqual(before);
  });

  it("refuses work that is not at a step that can be sent back, a closed task, a body that is not valid, and a task with no workflow", async () => {
    const running = await seed({ workflow: WorkflowSnapshotSchema.parse({ ...blockedReview(), state: "RUNNING", blockReason: undefined }) });
    await expect(createTaskActions(running.h.deps).sendBack(running.caller, TASK_ID, body(6))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    const clear = await seed({ workflow: blockedReview({}, [report("CRITIC", "PASS", []), report("SECURITY", "PASS", [])]) });
    await expect(createTaskActions(clear.h.deps).sendBack(clear.caller, TASK_ID, body(6))).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("no current failed check or review finding") as string });
    const closed = await seed({ task: { closedAt: "2026-11-10T11:00:00.000Z" } });
    await expect(createTaskActions(closed.h.deps).sendBack(closed.caller, TASK_ID, body(6))).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("closed") as string });
    const workspaceClosed = await seed({ workspace: { status: "CLOSED" } });
    await expect(createTaskActions(workspaceClosed.h.deps).sendBack(workspaceClosed.caller, TASK_ID, body(6))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    const plainTask = await seed({ workflow: null });
    await expect(createTaskActions(plainTask.h.deps).sendBack(plainTask.caller, TASK_ID, body(6))).rejects.toMatchObject({ code: "NOT_FOUND" });
    const valid = await seed();
    await expect(createTaskActions(valid.h.deps).sendBack(valid.caller, TASK_ID, { requestId: "not-a-uuid", instructions: "x", expectedRevision: 6 })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(createTaskActions(valid.h.deps).sendBack(valid.caller, TASK_ID, { requestId: REQUEST_A, instructions: "", expectedRevision: 6 })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("answers a repeat of the same request with the first, starts one run, and refuses the same id for other words or another decision", async () => {
    const { h, caller } = await seed();
    const actions = createTaskActions(h.deps);
    const first = await actions.sendBack(caller, TASK_ID, body(6));
    const again = await actions.sendBack(caller, TASK_ID, body(6));
    expect(again.workflow?.revision).toBe(first.workflow?.revision);
    expect(await codingOperations(h)).toHaveLength(1);
    expect(h.audit).toHaveLength(1);
    await expect(actions.sendBack(caller, TASK_ID, body(6, "Something else entirely."))).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    // The id was used by a plan decision, not a send-back.
    const gate = await seed({ workflow: blockedReview({ decisions: [{ requestId: REQUEST_A, workflowRevision: 3, decision: "APPROVE", actorId: "a".repeat(64), actorRole: "TASK_OWNER", reason: "Approved.", artifactDigest: "b".repeat(64), at: "2026-11-10T10:00:00.000Z" }] }) });
    await expect(createTaskActions(gate.h.deps).sendBack(gate.caller, TASK_ID, body(6))).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("starts one run when the same request arrives twice at once", async () => {
    const { h, caller } = await seed();
    const actions = createTaskActions(h.deps);
    const [a, b] = await Promise.all([actions.sendBack(caller, TASK_ID, body(6)), actions.sendBack(caller, TASK_ID, body(6))]);
    expect(a.workflow?.stage).toBe("IMPLEMENT");
    expect(b.workflow?.stage).toBe("IMPLEMENT");
    expect(await codingOperations(h)).toHaveLength(1);
    // The audit line of the call that lost the race was staged but never committed: the store holds one.
    expect((await queryAll(h.store, { pk: `AUDIT#${COMPANY}`, sk: { op: "beginsWith", prefix: "EVENT#task.sent_back" } }))).toHaveLength(1);
  });

  it("starts nothing for a task over its cap, whose spend cannot be told, or when no cap can be read", async () => {
    for (const cap of [{ limitUsd: 6, spentUsd: 6 }, { limitUsd: 6, spentUsd: 9.5 }, { limitUsd: 6, spentUsd: undefined }, { limitUsd: Number.NaN, spentUsd: 1 }]) {
      const { h, caller } = await seed();
      const before = await stateOf(h);
      await expect(createTaskActions(h.deps, { roundCap: async () => cap }).sendBack(caller, TASK_ID, body(6))).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
      expect(await stateOf(h)).toEqual(before);
    }
    const unreadable = await seed();
    await expect(createTaskActions(unreadable.h.deps, { roundCap: async () => { throw new Error("ledger down"); } }).sendBack(unreadable.caller, TASK_ID, body(6))).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    // Room under the cap: it goes ahead. No cap held for the task: it goes ahead too.
    const room = await seed();
    await createTaskActions(room.h.deps, { roundCap: async () => ({ limitUsd: 6, spentUsd: 5.99 }) }).sendBack(room.caller, TASK_ID, body(6));
    expect(await codingOperations(room.h)).toHaveLength(1);
    const uncapped = await seed();
    await createTaskActions(uncapped.h.deps, { roundCap: async () => undefined }).sendBack(uncapped.caller, TASK_ID, body(6));
    expect(await codingOperations(uncapped.h)).toHaveLength(1);
  });

  it("asks admission before anything is written, and a refusal starts nothing; a reservation it hands back is given back", async () => {
    const asked: AdmissionRequest[] = [];
    const released: string[] = [];
    const refusing: Admission = { ...createAllowAllAdmission(), async admit(request) { asked.push(request); return { allowed: false, code: "budget_exhausted", message: "The monthly budget is used up." }; } };
    const refused = await seed({ harness: { admission: refusing } });
    const before = await stateOf(refused.h);
    await expect(createTaskActions(refused.h.deps).sendBack(refused.caller, TASK_ID, body(6))).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", message: expect.stringContaining("monthly budget") as string });
    expect(await stateOf(refused.h)).toEqual(before);
    expect(asked[0]).toMatchObject({ action: OWNER_ROUND_ADMISSION_ACTION, projectName: "payments", subject: { type: "task", id: TASK_ID }, idempotencyKey: `task.round:${TASK_ID}:${REQUEST_A}` });
    const holding: Admission = { ...createAllowAllAdmission(), async admit() { return { allowed: true, reservationId: "res-1" }; }, async release(id) { released.push(id); } };
    const held = await seed({ harness: { admission: holding } });
    await createTaskActions(held.h.deps).sendBack(held.caller, TASK_ID, body(6));
    expect(released).toEqual(["res-1"]);
  });

  it("does not skip an approval of more spend, and refuses an archived project and a person who may no longer have work run", async () => {
    for (const blockReason of [WORKFLOW_BLOCK_REASONS.budgetPaused, "This plan's run limit is $12, which needs a project maintainer's approval."]) {
      const waiting = await seed({ workflow: WorkflowSnapshotSchema.parse({ ...blockedReview(), stage: "IMPLEMENT", state: "BLOCKED", blockReason, reviews: undefined, candidate: undefined, verification: undefined }) });
      const before = await stateOf(waiting.h);
      await expect(createTaskActions(waiting.h.deps).sendBack(waiting.caller, TASK_ID, body(6))).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("more spend") as string });
      expect(await stateOf(waiting.h)).toEqual(before);
    }
    const archived = await seed();
    const projects = archived.h.deps.projects;
    archived.h.deps.projects = { ...projects, latest: async (project) => { const found = await projects.latest(project); return found === undefined ? undefined : { ...found, archived: true }; } };
    await expect(createTaskActions(archived.h.deps).sendBack(archived.caller, TASK_ID, body(6))).rejects.toMatchObject({ code: "PROJECT_ARCHIVED" });
    const lost = await seed();
    lost.h.deps.access = { ...lost.h.deps.access, checkStep: async () => ({ allowed: false, message: "This person no longer has access to the project." }) };
    const before = await stateOf(lost.h);
    await expect(createTaskActions(lost.h.deps).sendBack(lost.caller, TASK_ID, body(6))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await stateOf(lost.h)).toEqual(before);
  });

  it("carries the change tier as it is: a send-back never resets or lowers it", async () => {
    const tier = { level: "standard", kinds: ["code_config"], source: "diff", reasons: [{ code: "many_files" }], headSha: "1".repeat(40), at: "2026-11-10T09:00:00.000Z" };
    const flow = { rulesVersion: 1, tier, tierHistory: [{ ...tier, level: "small", source: "estimate" }], skippedSteps: ["plan_check"] };
    const { h, caller } = await seed({ workflow: blockedReview({ flow }) });
    await createTaskActions(h.deps).sendBack(caller, TASK_ID, body(6));
    const after = (await taskOf(h)).workflow!;
    expect(after.flow).toEqual(flow);
    expect(after.stage).toBe("IMPLEMENT");
  });
});

describe("the owner's route", () => {
  const route = async (path: string, who: "owner" | "guest", payload: unknown) => {
    const { h } = await seed();
    const routes = createOwnerRoutes({ flow: h.flow, blobs: {} as never, openPage: async () => undefined, version: "0.0.0-test" });
    const answer = await routes({ method: "POST", path, headers: {}, body: JSON.stringify(payload) }, who === "owner" ? h.owner : h.guest);
    return { h, answer: answer!, json: JSON.parse(answer!.body) as { task?: { workflow?: { stage: string; state: string } }; error?: { code: string; message: string } } };
  };

  it("serves send back at /workflow/send-back as the owner, and says no such task to anyone else", async () => {
    const ok = await route(`/v1/dev/tasks/${TASK_ID}/workflow/send-back`, "owner", body(6));
    expect(ok.answer.statusCode).toBe(200);
    expect(ok.json.task?.workflow).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
    const no = await route(`/v1/dev/tasks/${TASK_ID}/workflow/send-back`, "guest", body(6));
    expect(no.answer.statusCode).toBe(404);
    expect(no.json.error?.code).toBe("TASK_NOT_FOUND");
    expect(await codingOperations(no.h)).toHaveLength(0);
    // The older "not on this install" answer is gone for this route; the others still say it.
    const other = await route(`/v1/dev/tasks/${TASK_ID}/workflow/review`, "owner", {});
    expect(other.json.error?.message).toContain("not on this install yet");
  });
});

describe("a second request for the same task by another id", () => {
  it("is refused once the first send-back moved the workflow on (the revision the person saw is gone)", async () => {
    const { h, caller } = await seed();
    const actions = createTaskActions(h.deps);
    await actions.sendBack(caller, TASK_ID, body(6));
    await expect(actions.sendBack(caller, TASK_ID, body(6, "Again.", REQUEST_B))).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await codingOperations(h)).toHaveLength(1);
  });
});

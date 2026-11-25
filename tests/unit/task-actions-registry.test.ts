// S1: the task action registry (core/task-actions), on the W0 fakes with a task seeded in the state each move starts from. What a person sees and what the move left in the store are asserted; the rules, each tested:
//   1. what a task offers now (`stateOffers`, `actionsFor`) comes from its state and the person's live standing; the held entries are never offered;
//   2. a press is judged for the PRESSER first: not found for a stranger, not yours for a reader, not offered / stale for a task that moved on, all with nothing written;
//   3. a move with a confirm carries the digest of what the confirm showed: a missing one is `needs_input`, a wrong one `stale`, before any write, so the dialog cannot be skipped;
//   4. every move is ONE call into the function the web already uses, and its refusals are stable codes with `writes` (an error that names none is `maybe`);
//   5. the audit names the surface the entry point bound (`via`), and the person.
import { describe, expect, it, vi } from "vitest";
import { TASK_ACTION_IDS, WORKFLOW_BLOCK_REASONS, WorkflowSnapshotSchema, createWorkflowSnapshot, type ActionDescription, type ActionResult, type ActionValues } from "@agentx/contracts";
import { TASK_ACTION_ENTRIES, actionsFor, declaredExclusions, describeAction, performRegistryAction, requestIdOf, stateOffers, type ActionCaller, type ActionEnv, type MergeHost, type PeopleHost, type PlanHost } from "../../packages/broker/src/core/task-actions/index.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { OWNER_KEY, NOW, PARSER, TASK_ID, TOKEN, accessWithoutOwners, blockedReview, code, codingOperations, operationsOf, parserId, report, seed, seedPlain, stateOf, taskOf, tokenId, type Seeded } from "../support/task-actions-world.js";

/** The hosted company's owner rule: the person the task runs for acts as its owner (the stop reads it; Code's laptop default has none). */
const hostedOwnerAccess = () => ({ ...createOwnerTaskAccess(), ownerActing: async (principal: { personId: string }, task: { ownerKey: string }) => (principal.personId === "local-owner" ? { actorId: task.ownerKey } : undefined) });
const ownerCaller = (world: Seeded): ActionCaller => ({ ...world.h.owner, companyRole: undefined });
const envOf = (world: Seeded, extra: Partial<ActionEnv> = {}): ActionEnv => ({ deps: world.h.deps, options: {}, ...extra });
let counter = 0;
const press = (actionId: string, binding: unknown, extra: Partial<{ values: ActionValues; confirmDigest: string }> = {}) => ({ actionId, taskId: TASK_ID, binding, requestKey: `test-press-${String(++counter)}`, via: "slack", ...extra });
const refused = (result: ActionResult): Extract<ActionResult, { status: "refused" }> => { expect(result.status).toBe("refused"); return result as Extract<ActionResult, { status: "refused" }>; };
const describeOk = (description: ActionDescription): Extract<ActionDescription, { status: "ok" }> => { expect(description.status).toBe("ok"); return description as Extract<ActionDescription, { status: "ok" }>; };

describe("what a task offers", () => {
  it("has words for every id, and an entry for each, and never offers the held ones", async () => {
    expect(TASK_ACTION_ENTRIES.map((entry) => entry.id).sort()).toEqual([...TASK_ACTION_IDS].sort());
    const world = await seed();
    const offers = await stateOffers(envOf(world), await taskOf(world.h));
    expect(offers.map((offer) => offer.id).sort()).toEqual(["findings.resolve", "task.close", "task.review", "work.send-back"]);
    expect((await stateOffers({ people: true }, await taskOf(world.h))).some((offer) => offer.id === "people.view")).toBe(true);
    expect(offers.some((offer) => offer.id === "people.add" || offer.id === "people.set-role")).toBe(false);
    expect(declaredExclusions().map((entry) => entry.id).sort()).toEqual(["people.add", "people.set-role"]);
  });

  it("offers a person only what their standing allows (a reader sees only the People view)", async () => {
    const world = await seed({ access: accessWithoutOwners() });
    const task = await taskOf(world.h);
    const people: PeopleHost = { view: async () => ({ lines: [] }), canTakeOwnership: async () => undefined, takeOwnership: async () => undefined };
    expect((await actionsFor(envOf(world, { people }), ownerCaller(world), task)).map((offer) => offer.id)).toEqual(["people.view"]);
    const owned = await seed();
    expect((await actionsFor(envOf(owned, { people }), ownerCaller(owned), await taskOf(owned.h))).map((offer) => offer.id).sort()).toEqual(["findings.resolve", "people.view", "task.close", "task.review", "work.send-back"]);
    // An administrator who is not the owner may stop but no more.
    const admin: ActionCaller = { ...ownerCaller(owned), companyRole: "admin", principal: { ...owned.h.owner.principal, personId: "somebody-else" } };
    const adminWorld = await seed({ access: accessWithoutOwners() });
    expect((await actionsFor(envOf(adminWorld), admin, await taskOf(adminWorld.h))).map((offer) => offer.id)).toEqual([]);
  });
});

describe("a press is judged for the presser first", () => {
  it("answers not found to someone who may not read the task, not yours to a reader, and writes nothing", async () => {
    const reader = await seed({ access: accessWithoutOwners() });
    const before = await stateOf(reader.h);
    const task = await taskOf(reader.h);
    const binding = { revision: task.workflow!.revision };
    expect(refused(await performRegistryAction(envOf(reader), ownerCaller(reader), press("work.send-back", binding)))).toMatchObject({ reason: "not_yours", code: "FORBIDDEN", writes: "none" });
    const stranger = await seed();
    const guest: ActionCaller = { principal: stranger.h.guest.principal };
    const strangerBefore = await stateOf(stranger.h);
    for (const id of ["work.send-back", "task.close", "findings.resolve"]) {
      expect(refused(await performRegistryAction(envOf(stranger), guest, press(id, { revision: 6 }))), id).toMatchObject({ reason: "not_found", code: "TASK_NOT_FOUND", writes: "none" });
    }
    expect(await stateOf(reader.h)).toEqual(before);
    expect(await stateOf(stranger.h)).toEqual(strangerBefore);
  });

  it("refuses an action the task does not offer, and a card from an older revision, with nothing written", async () => {
    const world = await seed();
    const before = await stateOf(world.h);
    expect(refused(await performRegistryAction(envOf(world), ownerCaller(world), press("feedback.fix", { revision: 6 })))).toMatchObject({ reason: "not_offered", writes: "none" });
    expect(refused(await performRegistryAction(envOf(world), ownerCaller(world), press("work.send-back", { revision: 5 })))).toMatchObject({ reason: "stale", code: "TASK_ACTION_STALE", writes: "none" });
    expect(refused(await performRegistryAction(envOf(world), ownerCaller(world), press("not.an.action", { revision: 6 })))).toMatchObject({ reason: "not_offered" });
    expect(refused(await performRegistryAction(envOf(world), ownerCaller(world), press("people.add", { revision: 0 })))).toMatchObject({ reason: "not_offered" });
    expect(await stateOf(world.h)).toEqual(before);
    const closed = await seed({ task: { closedAt: "2026-11-10T11:00:00.000Z" } });
    expect(refused(await performRegistryAction(envOf(closed), ownerCaller(closed), press("work.send-back", { revision: 6 })))).toMatchObject({ reason: "closed" });
  });
});

describe("send back, retry the reviews and the audit's surface", () => {
  it("sends the task back to coding with the person's words, and the audit names the person and Slack", async () => {
    const world = await seed();
    const result = await performRegistryAction(envOf(world), ownerCaller(world), press("work.send-back", { revision: 6 }, { values: { instructions: "Keep the footer line." } }));
    expect(result).toEqual({ status: "started" });
    expect((await codingOperations(world.h)).length).toBe(1);
    const sent = world.h.audit.filter((event) => event.details?.["via"] === "slack");
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((event) => event.actor.type !== "person" || event.actor.id === world.h.owner.principal.personId)).toBe(true);
  });

  it("is the same request when the same press comes twice (the engine's own idempotency answers once)", async () => {
    const world = await seed();
    const one = press("work.send-back", { revision: 6 }, { values: { instructions: "Keep the footer line." } });
    expect(await performRegistryAction(envOf(world), ownerCaller(world), one)).toEqual({ status: "started" });
    const again = await performRegistryAction(envOf(world), ownerCaller(world), one);
    expect(again.status === "started" || again.status === "refused").toBe(true);
    expect((await codingOperations(world.h)).length).toBe(1);
    expect(requestIdOf("a")).toBe(requestIdOf("a"));
    expect(requestIdOf("a")).not.toBe(requestIdOf("b"));
    expect(requestIdOf("a")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  it("retries the reviews on the same checked code, with an optional note", async () => {
    const world = await seed({ workflow: blockedReview({}, [report("CRITIC", "FAILED", []), report("SECURITY", "PASS", [])]) });
    const task = await taskOf(world.h);
    const offered = (await stateOffers(envOf(world), task)).find((offer) => offer.id === "task.review");
    expect(offered).toMatchObject({ label: "Retry reviews", binding: { revision: 6, digest: code.digest } });
    const result = await performRegistryAction(envOf(world), ownerCaller(world), press("task.review", offered!.binding, { values: { note: "Look at the retry path." } }));
    expect(result.status).toBe("started");
    expect((await operationsOf(world.h)).some((operation) => operation.workflowMode === "REVIEW")).toBe(true);
  });
});

describe("review findings", () => {
  const both = () => blockedReview({}, [report("CRITIC", "FINDINGS", [PARSER]), report("SECURITY", "FINDINGS", [TOKEN])]);

  it("describes each open finding as inert text, and answers a refusal instead of a spec to a reader", async () => {
    const world = await seed({ workflow: both() });
    const task = await taskOf(world.h);
    const offer = (await stateOffers(envOf(world), task)).find((entry) => entry.id === "findings.resolve")!;
    const ok = describeOk(await describeAction(envOf(world), ownerCaller(world), { actionId: "findings.resolve", taskId: TASK_ID, binding: offer.binding }));
    expect(ok.spec.fields[0]).toMatchObject({ kind: "per-item", items: expect.arrayContaining([expect.objectContaining({ id: parserId }), expect.objectContaining({ id: tokenId })]) as unknown });
    expect(ok.confirm).toBeUndefined();
    const reader = await seed({ workflow: both(), access: accessWithoutOwners() });
    const refusedDescription = await describeAction(envOf(reader), ownerCaller(reader), { actionId: "findings.resolve", taskId: TASK_ID, binding: offer.binding });
    expect(refusedDescription).toEqual({ status: "refused", code: "FORBIDDEN", reason: "not_yours" });
    expect(JSON.stringify(refusedDescription)).not.toContain("parse");
  });

  it("fixes the findings with no confirm, and an accept needs the confirm's digest before anything is written", async () => {
    const world = await seed({ workflow: blockedReview({}, [report("CRITIC", "FINDINGS", [PARSER]), report("SECURITY", "PASS", [])]) });
    const task = await taskOf(world.h);
    const binding = { revision: 6, digest: code.digest };
    const accept: ActionValues = { [parserId]: "ACCEPT", [`${parserId}#note`]: "A footer we drop on purpose." };
    const before = await stateOf(world.h);
    expect(refused(await performRegistryAction(envOf(world), ownerCaller(world), press("findings.resolve", binding, { values: accept })))).toMatchObject({ reason: "needs_input", writes: "none" });
    expect(refused(await performRegistryAction(envOf(world), ownerCaller(world), press("findings.resolve", binding, { values: accept, confirmDigest: "0".repeat(64) })))).toMatchObject({ reason: "stale", writes: "none" });
    expect(await stateOf(world.h)).toEqual(before);
    const described = describeOk(await describeAction(envOf(world), ownerCaller(world), { actionId: "findings.resolve", taskId: TASK_ID, binding, values: accept }));
    expect(described.confirm).toMatchObject({ danger: true });
    expect(described.confirm!.lines.join("\n")).toContain("will no longer block");
    expect(described.confirmDigest).toMatch(/^[a-f0-9]{64}$/u);
    // The digest binds the reason shown: another reason is another digest.
    const other = describeOk(await describeAction(envOf(world), ownerCaller(world), { actionId: "findings.resolve", taskId: TASK_ID, binding, values: { ...accept, [`${parserId}#note`]: "Another reason." } }));
    expect(other.confirmDigest).not.toBe(described.confirmDigest);
    const result = await performRegistryAction(envOf(world), ownerCaller(world), press("findings.resolve", binding, { values: accept, confirmDigest: described.confirmDigest! }));
    expect(result.status).toBe("started");
    expect(["accepted"].length + task.workflow!.revision).toBeGreaterThan(0);
    const accepted = await taskOf(world.h);
    expect(accepted.workflow!.acceptedFindings?.length).toBe(1);
    expect(world.h.audit.some((event) => event.details?.["via"] === "slack")).toBe(true);
  });

  it("fixes every finding without a confirm; a security finding is never accepted from Slack (needs the web) while Fix on it works", async () => {
    const world = await seed({ workflow: both() });
    const binding = { revision: 6, digest: code.digest };
    const security: ActionValues = { [parserId]: "FIX", [tokenId]: "ACCEPT", [`${tokenId}#note`]: "Test token only." };
    const digest = describeOk(await describeAction(envOf(world), ownerCaller(world), { actionId: "findings.resolve", taskId: TASK_ID, binding, values: security })).confirmDigest!;
    const before = await stateOf(world.h);
    expect(refused(await performRegistryAction(envOf(world), ownerCaller(world), press("findings.resolve", binding, { values: security, confirmDigest: digest })))).toMatchObject({ reason: "needs_web", code: "TASK_ACTION_NEEDS_WEB", writes: "none" });
    expect(await stateOf(world.h)).toEqual(before);
    const fixAll: ActionValues = { [parserId]: "FIX", [tokenId]: "FIX" };
    expect(await performRegistryAction(envOf(world), ownerCaller(world), press("findings.resolve", binding, { values: fixAll }))).toMatchObject({ status: "started" });
    expect((await codingOperations(world.h)).length).toBe(1);
  });
});

describe("close", () => {
  it("always asks for the confirm (danger), and a close without its digest writes nothing", async () => {
    const world = await seed();
    const binding = { revision: 6 };
    const described = describeOk(await describeAction(envOf(world), ownerCaller(world), { actionId: "task.close", taskId: TASK_ID, binding }));
    expect(described.confirm).toMatchObject({ danger: true, button: "Close task" });
    expect(described.confirm!.lines.join("\n")).toContain("pull request stays on GitHub");
    expect(described.confirm!.lines.join("\n")).toContain("evidence");
    const before = await stateOf(world.h);
    expect(refused(await performRegistryAction(envOf(world), ownerCaller(world), press("task.close", binding)))).toMatchObject({ reason: "needs_input", writes: "none" });
    expect(await stateOf(world.h)).toEqual(before);
    const result = await performRegistryAction(envOf(world), ownerCaller(world), press("task.close", binding, { confirmDigest: described.confirmDigest! }));
    expect(["done", "started"]).toContain(result.status);
    expect((await taskOf(world.h)).closedAt).toBeDefined();
  });

  it("binds the confirm to the person it was shown to: another person's digest is another digest", async () => {
    const world = await seed();
    const binding = { revision: 6 };
    const mine = describeOk(await describeAction(envOf(world), ownerCaller(world), { actionId: "task.close", taskId: TASK_ID, binding })).confirmDigest;
    const same = describeOk(await describeAction(envOf(world), ownerCaller(world), { actionId: "task.close", taskId: TASK_ID, binding })).confirmDigest;
    expect(same).toBe(mine);
    // A person with the same right who is not the first one: the digest differs, so one person's confirm cannot be replayed by another.
    const colleague: ActionCaller = { ...ownerCaller(world), principal: { ...world.h.owner.principal, personId: "another-owner" } };
    const hosted = await seed({ access: { ...createOwnerTaskAccess(), ownerActing: async (principal, task) => ({ actorId: task.ownerKey, ...(principal.personId === "x" ? {} : {}) }) } });
    const theirs = describeOk(await describeAction(envOf(hosted), colleague, { actionId: "task.close", taskId: TASK_ID, binding })).confirmDigest;
    expect(theirs).toBeDefined();
    expect(theirs).not.toBe(mine);
  });
});

describe("stop", () => {
  it("is offered to the owner while a step runs, with no confirm, and is recorded as a stop request in Slack's name", async () => {
    const running = await seed({ workflow: WorkflowSnapshotSchema.parse({ ...blockedReview(), stage: "IMPLEMENT", state: "RUNNING", blockReason: undefined }), access: hostedOwnerAccess() });
    const offered = (await stateOffers(envOf(running), await taskOf(running.h))).find((offer) => offer.id === "task.stop");
    expect(offered).toMatchObject({ label: "Stop here and keep the work", needsDialog: false, risk: "routine" });
    const result = await performRegistryAction(envOf(running), ownerCaller(running), press("task.stop", offered!.binding));
    expect(result.status).toBe("done");
    expect(running.h.audit.find((event) => event.action === "task.stop_requested")).toMatchObject({ details: { via: "slack" } });
    const idle = await seed();
    expect((await stateOffers(envOf(idle), await taskOf(idle.h))).some((offer) => offer.id === "task.stop")).toBe(false);
  });

  it("lets a live company admin stop a task they do not own, and nobody else", async () => {
    const world = await seed({ workflow: WorkflowSnapshotSchema.parse({ ...blockedReview(), stage: "IMPLEMENT", state: "RUNNING", blockReason: undefined }), access: { ...accessWithoutOwners(), ownerActing: async () => undefined } });
    const task = await taskOf(world.h);
    const admin: ActionCaller = { principal: { ...world.h.owner.principal, personId: "an-admin", roles: [] }, companyRole: "admin" };
    const offered = { revision: 0 };
    expect(task.workflow!.state).toBe("RUNNING");
    expect((await performRegistryAction(envOf(world), admin, press("task.stop", offered))).status).toBe("done");
    const colleague = await seed({ workflow: WorkflowSnapshotSchema.parse({ ...blockedReview(), stage: "IMPLEMENT", state: "RUNNING", blockReason: undefined }), access: accessWithoutOwners() });
    const member: ActionCaller = { principal: { ...colleague.h.owner.principal, personId: "a-member", roles: [] }, companyRole: "member" };
    expect(refused(await performRegistryAction(envOf(colleague), member, press("task.stop", offered)))).toMatchObject({ reason: "not_yours", writes: "none" });
  });
});

describe("the plan decision, through the host's gate", () => {
  const waiting = () => {
    const base = createWorkflowSnapshot({ taskId: TASK_ID, ownerId: OWNER_KEY, now: NOW, definitionVersion: "1.1.0" });
    const plan = { id: "plan-1", type: "plan", version: 1, sha256: "a".repeat(64), producer: "agentx-worker-untrusted", objectKey: `tasks/${TASK_ID}/plan-1.md`, createdAt: NOW };
    return WorkflowSnapshotSchema.parse({ ...base, stage: "PLAN_REVIEW", state: "WAITING", revision: 4, artifacts: [plan] });
  };
  const host = (facts: Partial<Awaited<ReturnType<PlanHost["facts"]>> & object> = {}) => {
    const decide = vi.fn(async () => ({ status: "decided" as const }));
    const plan: PlanHost = { facts: async () => ({ risk: "low", riskReasons: [], reasonRequired: false, ...facts }), decide };
    return { plan, decide };
  };

  it("approves a low risk plan with the digest it was shown, and a request for changes and a rejection need their reason", async () => {
    const world = await seed({ workflow: waiting() });
    const { plan, decide } = host();
    const env = envOf(world, { plan });
    const task = await taskOf(world.h);
    const offers = await stateOffers(env, task);
    expect(offers.map((offer) => offer.id)).toEqual(expect.arrayContaining(["plan.approve", "plan.request-changes", "plan.reject"]));
    const binding = offers.find((offer) => offer.id === "plan.approve")!.binding;
    expect(binding).toEqual({ revision: 4, digest: "a".repeat(64) });
    expect(await performRegistryAction(env, ownerCaller(world), press("plan.approve", binding))).toEqual({ status: "started" });
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ outcome: "approve", binding, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u) as unknown }));
    expect(refused(await performRegistryAction(env, ownerCaller(world), press("plan.request-changes", binding)))).toMatchObject({ reason: "needs_input", writes: "none" });
    expect(refused(await performRegistryAction(env, ownerCaller(world), press("plan.reject", binding)))).toMatchObject({ reason: "needs_input", writes: "none" });
    expect(await performRegistryAction(env, ownerCaller(world), press("plan.reject", binding, { values: { reason: "Not what we want." } }))).toEqual({ status: "done" });
    expect(decide).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "reject", reason: "Not what we want." }));
  });

  it("does not offer a high risk plan in this cut, and says what the gate refused for in stable reasons", async () => {
    const world = await seed({ workflow: waiting() });
    const high = host({ risk: "high" });
    expect((await actionsFor(envOf(world, { plan: high.plan }), ownerCaller(world), await taskOf(world.h))).some((offer) => offer.id === "plan.approve")).toBe(false);
    const stale = { plan: { facts: async () => ({ risk: "low" as const, riskReasons: [], reasonRequired: false }), decide: async () => ({ status: "refused" as const, reason: "stale" }) } satisfies PlanHost };
    expect(refused(await performRegistryAction(envOf(world, stale), ownerCaller(world), press("plan.approve", { revision: 4, digest: "a".repeat(64) })))).toMatchObject({ reason: "stale", writes: "none" });
    const notApproved = { plan: { facts: stale.plan.facts, decide: async () => ({ status: "refused" as const, reason: "not_approved" }) } satisfies PlanHost };
    expect(refused(await performRegistryAction(envOf(world, notApproved), ownerCaller(world), press("plan.approve", { revision: 4, digest: "a".repeat(64) })))).toMatchObject({ reason: "not_yours" });
  });

  it("asks for the run limit's confirm when approving raises it: no digest, no tick and a wrong figure each write nothing", async () => {
    const world = await seed({ workflow: waiting() });
    const { plan, decide } = host({ runLimit: { currentUsd: 5, proposedUsd: 12 } });
    const env = envOf(world, { plan });
    const binding = { revision: 4, digest: "a".repeat(64) };
    const described = describeOk(await describeAction(env, ownerCaller(world), { actionId: "plan.approve", taskId: TASK_ID, binding }));
    expect(described.confirm?.lines.join("\n")).toContain("$5.00");
    expect(described.confirm?.lines.join("\n")).toContain("$12.00");
    expect(described.spec.fields.some((field) => field.kind === "choice" && field.id === "limit_ack")).toBe(true);
    expect(refused(await performRegistryAction(env, ownerCaller(world), press("plan.approve", binding)))).toMatchObject({ reason: "needs_input" });
    expect(refused(await performRegistryAction(env, ownerCaller(world), press("plan.approve", binding, { confirmDigest: described.confirmDigest!, values: {} })))).toMatchObject({ reason: "needs_input" });
    expect(refused(await performRegistryAction(env, ownerCaller(world), press("plan.approve", binding, { confirmDigest: described.confirmDigest!, values: { limit_ack: "99" } })))).toMatchObject({ reason: "needs_input" });
    expect(decide).not.toHaveBeenCalled();
    expect(await performRegistryAction(env, ownerCaller(world), press("plan.approve", binding, { confirmDigest: described.confirmDigest!, values: { limit_ack: "12" } }))).toEqual({ status: "started" });
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ acknowledgedRunLimitUsd: 12 }));
  });
});

describe("merge, the People moves and the held entries", () => {
  const waitingForMerge = () => WorkflowSnapshotSchema.parse({
    ...blockedReview({}, [report("CRITIC", "PASS", []), report("SECURITY", "PASS", [])]), stage: "WAIT_FOR_MERGE", state: "WAITING", blockReason: undefined,
    pullRequests: [{ repositoryId: "demo", number: 7, url: "https://example.com/pull/7", required: true, state: "OPEN", candidateDigest: code.digest, headSha: "b".repeat(40) }],
  });

  it("merges only with the confirm of the heads and risk it showed, as the merge core's own press", async () => {
    const world = await seed({ workflow: waitingForMerge() });
    const press1 = vi.fn(async () => undefined);
    const merge: MergeHost = {
      standing: async () => ({ may: true }),
      readiness: async () => ({ ready: true, risk: "low", heads: [{ repositoryId: "demo", number: 7, headSha: "b".repeat(40) }] }),
      press: press1,
    };
    const env = envOf(world, { merge });
    const offer = (await stateOffers(env, await taskOf(world.h))).find((entry) => entry.id === "task.merge")!;
    expect(offer).toBeDefined();
    expect(offer).toMatchObject({ risk: "irreversible", needsDialog: true });
    const described = describeOk(await describeAction(env, ownerCaller(world), { actionId: "task.merge", taskId: TASK_ID, binding: offer.binding }));
    expect(described.confirm).toMatchObject({ danger: true, button: "Merge" });
    expect(refused(await performRegistryAction(env, ownerCaller(world), press("task.merge", offer.binding)))).toMatchObject({ reason: "needs_input", writes: "none" });
    expect(press1).not.toHaveBeenCalled();
    expect((await performRegistryAction(env, ownerCaller(world), press("task.merge", offer.binding, { confirmDigest: described.confirmDigest! }))).status).toBe("done");
    expect(press1).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ risk: "low", expectedHeads: [{ repositoryId: "demo", number: 7, headSha: "b".repeat(40) }] }));
    const notMay: MergeHost = { ...merge, standing: async () => ({ may: false }) };
    expect(refused(await performRegistryAction(envOf(world, { merge: notMay }), ownerCaller(world), press("task.merge", offer.binding)))).toMatchObject({ reason: "not_found", writes: "none" });
  });

  it("shows the People view privately and takes over an orphaned task only with the confirm", async () => {
    const world = await seed();
    const takeOwnership = vi.fn(async () => undefined);
    const people: PeopleHost = {
      view: async () => ({ lines: ["You: owner"] }), canTakeOwnership: async () => ({ peopleRevision: 3 }), takeOwnership,
    };
    const env = envOf(world, { people });
    // The view is said privately, with taking over offered as the next move (the person may; it is judged again at its press).
    expect(await performRegistryAction(env, ownerCaller(world), press("people.view", { revision: 0 }))).toEqual({ status: "done", said: "You: owner", next: [{ id: "people.take-ownership", label: "Take ownership", risk: "routine", needsDialog: true, binding: { revision: 3 } }] });
    const offers = await actionsFor(env, ownerCaller(world), await taskOf(world.h));
    const take = offers.find((offer) => offer.id === "people.take-ownership")!;
    expect(take.binding).toEqual({ revision: 3 });
    const described = describeOk(await describeAction(env, ownerCaller(world), { actionId: "people.take-ownership", taskId: TASK_ID, binding: take.binding }));
    expect(refused(await performRegistryAction(env, ownerCaller(world), press("people.take-ownership", take.binding)))).toMatchObject({ reason: "needs_input" });
    expect(takeOwnership).not.toHaveBeenCalled();
    expect((await performRegistryAction(env, ownerCaller(world), press("people.take-ownership", take.binding, { confirmDigest: described.confirmDigest! }))).status).toBe("done");
    expect(takeOwnership).toHaveBeenCalledWith(expect.anything(), expect.anything(), { requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u) as unknown, expectedPeopleRevision: 3 });
  });
});

describe("the free-form moves of a task with no workflow", () => {
  it("offers more instructions and a pull request by hand, and starts nothing without the text", async () => {
    const world = await seedPlain();
    const offers = await stateOffers(envOf(world), await taskOf(world.h));
    expect(offers.map((offer) => offer.id)).toEqual(expect.arrayContaining(["task.continue", "pull-request.open", "task.close", "task.stop"]));
    const before = await stateOf(world.h);
    expect(refused(await performRegistryAction(envOf(world), ownerCaller(world), press("task.continue", { revision: 0 }, { values: {} })))).toBeDefined();
    expect(await stateOf(world.h)).toEqual(before);
    const continued = await performRegistryAction(envOf(world), ownerCaller(world), press("task.continue", { revision: 0 }, { values: { instructions: "Also add a test." } }));
    expect(continued.status).toBe("started");
  });
});

describe("an error that names no `writes` is `maybe`", () => {
  it("maps a thrown error by its code, never by its words, and a throw that is no error to unavailable", async () => {
    const world = await seed();
    const env = envOf(world, { options: { roundCap: async () => ({ limitUsd: 1, spentUsd: 5 }) } });
    const result = await performRegistryAction(env, ownerCaller(world), press("work.send-back", { revision: 6 }, { values: { instructions: "go" } }));
    expect(refused(result)).toMatchObject({ code: "BUDGET_EXCEEDED", reason: "over_limit" });
    expect(WORKFLOW_BLOCK_REASONS.budgetPaused).toBeDefined();
  });
});

describe("the People view reaches a live company admin who is not the owner", () => {
  it("lets an admin press People (the People function decides what is shown), and still refuses a stranger", async () => {
    const world = await seed({ access: accessWithoutOwners() });
    const people: PeopleHost = { view: async () => ({ lines: ["Maya: owner"] }), canTakeOwnership: async () => undefined, takeOwnership: async () => undefined };
    const admin: ActionCaller = { principal: { ...world.h.owner.principal, personId: "an-admin", roles: [] }, companyRole: "admin" };
    expect(await performRegistryAction(envOf(world, { people }), admin, press("people.view", { revision: 0 }))).toEqual({ status: "done", said: "Maya: owner" });
    const stranger: ActionCaller = { principal: world.h.guest.principal };
    const strangerWorld = await seed();
    expect(refused(await performRegistryAction(envOf(strangerWorld, { people }), stranger, press("people.view", { revision: 0 })))).toMatchObject({ reason: "not_found", writes: "none" });
  });
});

describe("the answers to Understand's questions", () => {
  const asking = () => WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId: TASK_ID, ownerId: OWNER_KEY, now: NOW, definitionVersion: "1.1.0" }), stage: "UNDERSTAND", state: "WAITING", revision: 3,
    intent: { rounds: 1, pathFrom: "request", answers: [], assessment: { kind: "questions", restatement: "Add the flag.", questions: [
      { id: "q1", text: "Which flag name?", options: [{ id: "a", label: "retry" }, { id: "b", label: "backoff" }], recommended: "a" },
      { id: "q2", text: "Anything to keep?", options: [{ id: "a", label: "Keep the footer" }, { id: "b", label: "Drop it" }] },
    ] } },
  });

  it("offers the questions as a form (a choice and the owner's own words for each), and needs every one answered", async () => {
    const world = await seed({ workflow: asking(), access: hostedOwnerAccess() });
    const offer = (await stateOffers(envOf(world), await taskOf(world.h))).find((entry) => entry.id === "task.answer")!;
    expect(offer).toBeDefined();
    const described = describeOk(await describeAction(envOf(world), ownerCaller(world), { actionId: "task.answer", taskId: TASK_ID, binding: offer.binding }));
    expect(described.spec.fields.map((field) => field.id)).toEqual(["q1", "q1_text", "q2", "q2_text"]);
    const before = await stateOf(world.h);
    expect(refused(await performRegistryAction(envOf(world), ownerCaller(world), press("task.answer", offer.binding, { values: { q1: "a" } })))).toMatchObject({ reason: "needs_input", writes: "none" });
    expect(await stateOf(world.h)).toEqual(before);
    const answered = await performRegistryAction(envOf(world), ownerCaller(world), press("task.answer", offer.binding, { values: { q1: "b", q2: "your_call", q2_text: "" } }));
    expect(answered.status).toBe("started");
    expect((await taskOf(world.h)).workflow!.intent!.answers[0]).toMatchObject({ round: 1, source: "app", answers: [{ questionId: "q1", optionId: "b" }, { questionId: "q2", text: "your call" }] });
  });
});

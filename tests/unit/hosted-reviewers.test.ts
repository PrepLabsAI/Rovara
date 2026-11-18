import { randomUUID, createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DesignReviewBindingSchema, systemOwnerIdOf, ROVARA_CODE_AGENT_ID, agentModelIdentity, consumeReviewerGrant, taskTokenClaimsFor, REVIEWER_GRANT_SECONDS, type RegistryView, type TaskTokenClaims, type JsonValue } from "@agentx/contracts";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { createHostedReviewers, SECOND_PROVIDER_UNAVAILABLE } from "../../packages/broker/src/core-host/hosted-reviewers.js";
import { createHostedDesignReview } from "../../packages/broker/src/core-host/hosted-design-review.js";
import { createTaskTokenDescriber } from "../../packages/broker/src/core/model-gateway/describer.js";
import { readTaskTokenRecords } from "../../packages/broker/src/core/model-gateway/records.js";
import { mintTaskToken } from "../../packages/broker/src/core/model-gateway/token.js";
import { createHostedAdmission, createHostedLedger, createHostedMetering } from "../../packages/broker/src/core-host/hosted-modules.js";
import { reviewerRoomUsd } from "../../packages/broker/src/core-host/reviewer-authority.js";
import { allocateSlotBudgets } from "../../packages/broker/src/core/design-review/slot-keys.js";
import { operationKey, taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { upkeepSettingsKey } from "../../packages/broker/src/core/upkeep/keys.js";
import { secondReviewSettingsKey } from "../../packages/broker/src/core/second-review/settings.js";
import { secondOpinionFromReviewResult } from "../../packages/broker/src/core/second-review/store.js";
import { SPEND_STOP_REASON } from "../../packages/broker/src/core/task-flow/money-stop.js";
import { signingWorld, claimVector } from "../support/model-gateway.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const primary = "claude-sonnet-4-6", second = "openai.gpt-oss-120b-1:0";
const models = [{ model: primary, provider: "anthropic" }, { model: second, provider: "bedrock" }];
const access = () => ({ version: 1, models: models.map(({ model }) => ({ model })), reviewerAccess: { companyId: A, companyLimitUsd: 5, models } });
const route = (alias: string) => ({ alias, api: "anthropic-messages" as const, catalog: alias });
const digest = "d".repeat(64);

async function world() {
  const h = createHarness({ companyId: A }); await h.registerProject();
  const started = await h.flow.start(h.owner, { project: "payments", instructions: "Build it", requestId: newRequestId() });
  const workspace = (await h.store.get(workspaceKey(A, started.task.workspaceId)))!;
  const scope = { workspaceId: started.task.workspaceId, operationId: workspace["activeOperationId"] as string, fence: 1 };
  const opKey = operationKey(A, scope.workspaceId, scope.operationId);
  const tk = taskKey(started.task.taskId);
  await h.store.put({ item: { ...(await h.store.get(tk))!, origin: "app", workflow: { stage: "REVIEW", candidate: { digest } } } });
  await h.store.put({ item: { ...(await h.store.get(opKey))!, kind: "task", status: "RUNNING", workflowMode: "REVIEW", requester: { personId: "a".repeat(64) }, modelChoice: { model: agentModelIdentity(primary), route: route(primary) }, secondReviewPlan: { candidateDigest: digest, caps: { [second]: { capUsd: 3, usdPerMTok: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } } } }, dispatch: { kind: "task", payload: { workflowSecondReviewer: { candidates: [{ model: agentModelIdentity(second), modelRoute: route(second), keySlot: "second_review" }] } } } } });
  await h.store.put({ item: { ...secondReviewSettingsKey(A), default: "shadow" } });
  h.deps.modelAccess = { route: async () => route(primary) };
  const now = () => new Date(h.clock.now);
  const metering = createHostedMetering();
  const ledger = createHostedLedger({ store: h.store, metering, now });
  const settings = { allowedCompanies: [A, B], taskCapMicros: 5_000_000, companyDayCapMicros: 10_000_000 };
  h.deps.admission = createHostedAdmission({ store: h.store, ledger, settings, now, runStopWired: true });
  const registry = { names: () => [], require: (point: string) => point === "storage" ? h.store : point === "metering" ? metering : point === "audit-sink" ? h.deps.audit : {} } as unknown as RegistryView;
  const offered = vi.fn(async (): Promise<unknown> => access());
  const options = { flow: h.deps, registry, companyId: A, offered, taskRoomUsd: (task: { companyId: string; taskId: string; project: string }) => reviewerRoomUsd({ store: h.store, metering, companyId: A, settings, now }, task) };
  const hosted = createHostedReviewers(options);
  const records = () => readTaskTokenRecords(h.deps, scope);
  const grant = async (slot = "second_review") => hosted.grants.describeReviewer!(scope, await records(), slot);
  const book = async (companyId: string, taskId: string, usd: number) => ledger.recordUsage({ companyId, taskId, entryId: randomUUID(), at: now().toISOString(), usage: { provider: "test", modelId: "test", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, reportedCost: { micros: usd * 1_000_000, currency: "USD" } });
  return { h, scope, opKey, tk, registry, options, hosted, grant, records, offered, book };
}

async function setUpkeep(w: Awaited<ReturnType<typeof world>>, enabled: boolean) {
  await w.h.store.put({ item: { ...upkeepSettingsKey({ orgId: A, project: "payments" }), entityType: "UPKEEP_SETTINGS", orgId: A, project: "payments", enabled } });
}

async function designSlot(w: Awaited<ReturnType<typeof world>>) {
  const binding = DesignReviewBindingSchema.parse({ version: 1, round: 1, reviewers: [{ role: "critic", keySlot: "r1-critic", packetDigest: digest, model: agentModelIdentity(primary), modelRoute: route(primary) }] });
  const op = (await w.h.store.get(w.opKey))!;
  await w.h.store.put({ item: { ...op, workflowMode: "PLAN_CRITIQUE", designReview: JSON.parse(JSON.stringify(binding)) as JsonValue } });
  const task = (await w.h.store.get(w.tk))!;
  await w.h.store.put({ item: { ...task, workflow: { stage: "PLAN_CRITIQUE", designReview: { status: "running", rounds: [] } } } });
  await allocateSlotBudgets(w.h.store, { orgId: A, operationId: w.scope.operationId, binding, taskRoomUsd: 2, reviewRoomUsd: 2, nowMs: w.h.clock.now });
}

describe("hosted reviewer grants", () => {
  it("(a) reuses the main AI payer for member, no-origin, wiki build, repair-draft and agent tasks in both reviewer kinds", async () => {
    const member = { kind: "member", developerId: "a".repeat(64) };
    const project = { kind: "project", project: "payments" };
    for (const { origin, purpose, payer } of [
      { origin: "app", payer: member },
      { origin: undefined, payer: member },
      { origin: "automatic", payer: project },
      { origin: "schedule", payer: { kind: "agent", agentId: ROVARA_CODE_AGENT_ID } },
      { origin: "app", purpose: "wiki_build", payer: project },
      { origin: undefined, purpose: "wiki_build", payer: project },
      { origin: "nightly", purpose: "wiki_build", payer: project },
      { origin: "chain", purpose: "wiki_build", payer: project },
      { origin: "offer", purpose: "wiki_build", payer: project },
      { origin: "nightly", purpose: "setup_agent", payer: project },
    ]) {
      const w = await world();
      const task = { ...(await w.h.store.get(w.tk))! }; delete task["origin"];
      await w.h.store.put({ item: { ...task, ...(origin === undefined ? {} : { origin }), ...(purpose === undefined ? {} : { purpose }), developerId: systemOwnerIdOf(A, "payments") } });
      w.h.deps.systemRuns = { enabled: () => true };
      w.h.deps.upkeepRoomCents = async () => 1;
      await setUpkeep(w, true);
      const main = await createTaskTokenDescriber(w.h.deps, w.hosted.grants).describe(w.scope);
      expect(main).toMatchObject({ payer, ...(purpose === "setup_agent" ? { step: "repair_draft" } : {}) });
      const secondGrant = await w.grant();
      expect(secondGrant).toBeDefined(); expect(secondGrant?.payer).toEqual(main?.payer);
      await designSlot(w);
      const designGrant = await w.grant("r1-critic");
      expect(designGrant).toBeDefined(); expect(designGrant?.payer).toEqual(main?.payer);
    }
  });
  it.each(["second_review", "design_review"])("repair-draft %s rechecks all main payer gates and refuses invalid upkeep owners", async kind => {
    const w = await world();
    await w.h.store.put({ item: { ...(await w.h.store.get(w.tk))!, origin: "nightly", purpose: "setup_agent", developerId: systemOwnerIdOf(A, "payments") } });
    if (kind === "design_review") await designSlot(w);
    const slot = kind === "design_review" ? "r1-critic" : "second_review";
    let enabled: unknown = true;
    w.h.deps.systemRuns = { enabled: () => { if (enabled === "throw") throw new Error("gate down"); return enabled as boolean; } };
    let room: number | undefined = 1;
    w.h.deps.upkeepRoomCents = async () => room;
    await setUpkeep(w, true);
    const descriptions = async () => {
      const records = await w.records();
      // A design slot replaces the ordinary invocation. Compare the same checked task's ordinary description.
      const operation = { ...records.operation, workflowMode: "REVIEW" as const }; delete operation.designReview;
      const main = await createTaskTokenDescriber(w.h.deps, w.hosted.grants).describe(w.scope, { ...records, operation });
      return [main, await w.grant(slot)];
    };
    const open = await descriptions();
    for (const answer of open) expect(answer).toMatchObject({ payer: { kind: "project", project: "payments" }, origin: "nightly" });
    expect(open[0]?.step).toBe("repair_draft");
    for (const gate of [false, "true", "throw"]) {
      enabled = gate;
      expect(await descriptions()).toEqual([undefined, undefined]);
    }
    enabled = true;
    const gate = w.h.deps.systemRuns; delete w.h.deps.systemRuns;
    expect(await descriptions()).toEqual([undefined, undefined]);
    w.h.deps.systemRuns = gate;
    await setUpkeep(w, false);
    expect(await descriptions()).toEqual([undefined, undefined]);
    await setUpkeep(w, true);
    for (const value of [undefined, 0, -1, 0.5, NaN, Infinity]) {
      room = value;
      expect(await descriptions()).toEqual([undefined, undefined]);
    }
    room = 1;
    const readRoom = w.h.deps.upkeepRoomCents;
    w.h.deps.upkeepRoomCents = async () => { throw new Error("room unavailable"); };
    expect(await descriptions()).toEqual([undefined, undefined]);
    delete w.h.deps.upkeepRoomCents;
    expect(await descriptions()).toEqual([undefined, undefined]);
    w.h.deps.upkeepRoomCents = readRoom;
    for (const answer of await descriptions()) expect(answer?.payer).toEqual(open[0]?.payer);
    for (const developerId of ["a".repeat(64), systemOwnerIdOf(A, "billing"), systemOwnerIdOf(B, "payments")]) {
      await w.h.store.put({ item: { ...(await w.h.store.get(w.tk))!, developerId } });
      expect(await descriptions()).toEqual([undefined, undefined]);
    }
  });
  it.each(["linear", "invalid"])("both main and reviewer refuse unresolved origin %s even for a wiki build", async origin => {
    const w = await world();
    await w.h.store.put({ item: { ...(await w.h.store.get(w.tk))!, origin, purpose: "wiki_build" } });
    await expect(createTaskTokenDescriber(w.h.deps, w.hosted.grants).describe(w.scope)).rejects.toThrow("could not work out who pays for this task");
    await expect(w.grant()).rejects.toThrow("could not work out who pays for this task");
  });
  it("connected providers prepare exactly one routed reviewer whose ceiling fits its Admission hold", async () => {
    const w = await world(); const admit = vi.spyOn(w.h.deps.admission, "admit");
    const prepared = await w.hosted.secondReview.prepare({ task: (await w.records()).task });
    expect(prepared.field?.candidates).toHaveLength(1);
    expect(prepared.field?.candidates[0]).toMatchObject({ keySlot: "second_review", modelRoute: { alias: second } });
    const asked = admit.mock.calls.find(([request]) => request.action === "model.call")?.[0].estimate?.cost?.micros;
    const ceiling = prepared.record?.caps?.[second]?.capUsd;
    expect(asked).toBeGreaterThan(0); expect(ceiling).toBeGreaterThan(0);
    expect(ceiling! * 1_000_000).toBeLessThanOrEqual(asked!);
  });
  it("never starts an unpriced reviewer or takes a zero-dollar hold for it", async () => {
    const w = await world(); const admit = vi.spyOn(w.h.deps.admission, "admit");
    const unpriced = "vendor.unpriced-review-test";
    const connected = [{ model: primary, provider: "anthropic" }, { model: unpriced, provider: "bedrock" }];
    w.offered.mockImplementation(async () => ({ version: 1, models: connected.map(({ model }) => ({ model })), reviewerAccess: { companyId: A, companyLimitUsd: 5, models: connected } }));
    expect((await w.hosted.secondReview.prepare({ task: (await w.records()).task })).field).toBeUndefined();
    expect(admit.mock.calls.filter(([request]) => request.action === "model.call")).toEqual([]);
  });
  it("(b) refuses at the task dollar limit with zero grant and visible words", async () => {
    const w = await world(); expect(await w.grant()).toBeDefined();
    await w.book(A, (await w.records()).task.taskId, 5);
    expect(await w.grant()).toBeUndefined();
    const prepared = await w.hosted.secondReview.prepare({ task: (await w.records()).task });
    expect(prepared.field).toBeUndefined(); expect(prepared.firstEvent).toBe(SPEND_STOP_REASON);
    expect(prepared.record?.notRun?.reason).toBe("budget");
    const opinion = secondOpinionFromReviewResult({ recorded: prepared.record, operationId: w.scope.operationId, terminalStatus: "SUCCEEDED", result: {}, currentCandidateDigest: digest, now: new Date(w.h.clock.now).toISOString() });
    expect(w.hosted.secondReview.prLines({ secondOpinion: opinion }, digest)).toContain(SPEND_STOP_REASON);
  });
  it("(b) refuses at the company daily cap, including another task's spend", async () => {
    const w = await world(); await w.book(A, "other-task", 10);
    expect(await w.grant()).toBeUndefined();
    const prepared = await w.hosted.secondReview.prepare({ task: (await w.records()).task });
    expect(prepared.field).toBeUndefined(); expect(prepared.firstEvent).toBe(SPEND_STOP_REASON);
  });
  it("keeps a review ceiling inside the remaining company daily room", async () => {
    const w = await world(); await w.book(A, "another-task", 9.75);
    expect((await w.grant())?.reviewer?.ceilingUsd).toBe(0.25);
    const runtime = createHostedDesignReview({ ...w.options, env: {}, blobs: {} as never });
    expect(await runtime.ports.taskRoomUsd((await w.records()).task)).toBe(0.25);
    await w.book(A, "another-task", 0.25);
    expect(await runtime.ports.taskRoomUsd((await w.records()).task)).toBe(0);
    expect(await w.grant()).toBeUndefined();
  });
  it("bounds a grant by remaining task dollars and keeps company B spend and grants isolated", async () => {
    const w = await world(); const records = await w.records();
    await w.book(B, records.task.taskId, 100);
    await w.book(A, records.task.taskId, 4.5);
    expect((await w.grant())?.reviewer?.ceilingUsd).toBe(0.5);
    for (const field of ["task", "operation", "workspace"] as const) {
      expect(await w.hosted.grants.describeReviewer!(w.scope, { ...records, [field]: { ...records[field], companyId: B } }, "second_review")).toBeUndefined();
    }
    w.offered.mockImplementation(async () => ({ ...access(), reviewerAccess: { ...access().reviewerAccess, companyId: B } }));
    expect(await w.grant()).toBeUndefined();
  });
  it("(c) mints each slot once even with concurrent asks, using an explicit short TTL", async () => {
    const w = await world(); const signer = signingWorld();
    const deps = { signer: signer.signer, issuer: claimVector().iss, now: () => w.h.clock.now, describer: createTaskTokenDescriber(w.h.deps, w.hosted.grants) };
    const records = await w.records();
    const outcomes = await Promise.allSettled([1, 2].map(() => mintTaskToken(deps, { ...w.scope, reviewerSlot: "second_review" }, records)));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const minted = outcomes.find((outcome) => outcome.status === "fulfilled")! as PromiseFulfilledResult<{ token: string; expiresAt: number }>;
    const claims = JSON.parse(Buffer.from(minted.value.token.split(".")[1]!, "base64url").toString()) as TaskTokenClaims;
    expect(signer.reference(minted.value.token, Math.floor(w.h.clock.now / 1000))).toBeDefined();
    expect(claims.exp - claims.iat).toBe(REVIEWER_GRANT_SECONDS); expect(REVIEWER_GRANT_SECONDS).toBe(120);
    expect(await w.grant()).toBeUndefined();
  });
  it("design grants use the main payer, allocated ceiling and one slot issuance", async () => {
    const w = await world();
    await designSlot(w);
    const task = (await w.h.store.get(w.tk))!;
    const grant = await w.grant("r1-critic");
    expect(grant).toMatchObject({ payer: { kind: "member", developerId: "a".repeat(64) }, taskId: task["taskId"], step: "design_review", reviewer: { kind: "design_review", slot: "r1-critic", ceilingUsd: 2 } });
    expect(await createTaskTokenDescriber(w.h.deps, w.hosted.grants).describe(w.scope)).toBeUndefined();
    await w.hosted.grants.reviewerMinted!(w.scope, grant!, "opaque-test-token", w.h.clock.now + 120_000);
    expect(await w.grant("r1-critic")).toBeUndefined();
    expect(await w.grant("second_review")).toBeUndefined();
  });
  it("refuses general slots and never turns the second-review slot into a design grant", async () => {
    const w = await world();
    for (const slot of ["general", "third_review", "design_review", "", "reviewer_1"]) expect(await w.grant(slot)).toBeUndefined();
  });
  it("unknown or disconnected second providers show the fixed words on the timeline and PR with no spend admission", async () => {
    const w = await world(); const admit = vi.spyOn(w.h.deps.admission, "admit");
    for (const value of [undefined, { version: 1, models: [{ model: primary }] }, { ...access(), reviewerAccess: { ...access().reviewerAccess, models: [models[0]] } }]) {
      w.offered.mockImplementation(async () => value);
      const prepared = await w.hosted.secondReview.prepare({ task: (await w.records()).task });
      expect(prepared.field).toBeUndefined(); expect(prepared.firstEvent).toBe(SECOND_PROVIDER_UNAVAILABLE);
      const opinion = secondOpinionFromReviewResult({ recorded: prepared.record, operationId: w.scope.operationId, terminalStatus: "SUCCEEDED", result: {}, currentCandidateDigest: digest, now: new Date(w.h.clock.now).toISOString() });
      expect(w.hosted.secondReview.prLines({ secondOpinion: opinion }, digest)).toEqual([SECOND_PROVIDER_UNAVAILABLE]);
    }
    expect(admit).not.toHaveBeenCalled();
  });
  it("design review reads only through createCompanyArtifactReader, refusing another company's artifact", async () => {
    const w = await world(); const records = await w.records(); const body = new TextEncoder().encode("design result");
    const blobs = { get: vi.fn(async () => body), put: vi.fn() };
    const runtime = createHostedDesignReview({ ...w.options, env: {}, blobs: blobs as never });
    const objectKey = `private/other-owner/other-workspace/design.md`;
    await w.h.store.put({ item: { ...workspaceKey(A, w.scope.workspaceId), sk: `ARTIFACT#${w.scope.operationId}#design.md`, objectKey, sha256: createHash("sha256").update(body).digest("hex") } });
    // The record points outside this company's workspace: raw S3 must never be reached.
    expect(await runtime.readArtifactText(records.operation, "design.md", 1000)).toBeUndefined(); expect(blobs.get).not.toHaveBeenCalled();
    const ownKey = `private/${records.workspace.ownerKey}/${w.scope.workspaceId}/design.md`;
    await w.h.store.put({ item: { ...workspaceKey(A, w.scope.workspaceId), sk: `ARTIFACT#${w.scope.operationId}#design.md`, objectKey: ownKey, sha256: createHash("sha256").update(body).digest("hex") } });
    expect(await runtime.readArtifactText(records.operation, "design.md", 1000)).toBe("design result");
    expect(blobs.get).toHaveBeenCalledWith(ownKey, 1000);
  });
});

it("(c) consumes a grant once and refuses replay, another task, another kind and expiry before spend", async () => {
  for (const kind of ["second_review", "design_review"] as const) {
    const claims = taskTokenClaimsFor({ ...claimVector(), stp: kind, mdl: [primary], reviewer: { kind, slot: kind, ceilingUsd: 1 } })!;
    const expected = { cid: claims.cid, pid: claims.pid, tid: claims.tid, ws: claims.ws, op: claims.op, kind, slot: kind, model: primary };
    const used = new Set<string>();
    const consume = vi.fn(async (jti: string) => { if (used.has(jti)) return false; used.add(jti); return true; });
    for (const patch of [{ tid: "another-task" }, { kind: kind === "second_review" ? "design_review" as const : "second_review" as const }, { cid: B }, { model: second }]) {
      expect(await consumeReviewerGrant(claims, { ...expected, ...patch }, claims.iat, consume)).toBe(false);
    }
    expect(await consumeReviewerGrant(claims, expected, claims.exp, consume)).toBe(false);
    expect(consume).not.toHaveBeenCalled();
    expect(await consumeReviewerGrant(claims, expected, claims.iat, async () => { throw new Error("replay store unavailable"); })).toBe(false);
    expect(await Promise.all([1, 2].map(() => consumeReviewerGrant(claims, expected, claims.iat, consume)))).toEqual([true, false]);
    expect(await consumeReviewerGrant(claims, expected, claims.iat, consume)).toBe(false);
  }
});

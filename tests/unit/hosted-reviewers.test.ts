import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DesignReviewBindingSchema, systemOwnerIdOf, ROVARA_CODE_AGENT_ID, agentModelIdentity, consumeReviewerGrant, taskTokenClaimsFor, REVIEWER_GRANT_SECONDS, type RegistryView, type TaskTokenClaims, type JsonValue } from "@agentx/contracts";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { createHostedReviewers, SECOND_PROVIDER_UNAVAILABLE, SECOND_REVIEW_SETTINGS_UNAVAILABLE } from "../../packages/broker/src/core-host/hosted-reviewers.js";
import { createReviewSessionOpener } from "../../packages/worker/src/design-review-sessions.js";
import { createUsageBooking } from "../../packages/broker/src/core-host/usage-booking.js";
import { createHostedDesignReview } from "../../packages/broker/src/core-host/hosted-design-review.js";
import { createTaskTokenDescriber } from "../../packages/broker/src/core/model-gateway/describer.js";
import { readTaskTokenRecords } from "../../packages/broker/src/core/model-gateway/records.js";
import { modelAccessSource } from "../../packages/worker/src/model-access.js";
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
  const settings = { taskCapMicros: 5_000_000, companyDayCapMicros: 10_000_000 };
  h.deps.admission = createHostedAdmission({ store: h.store, ledger, settings, now, runStopWired: true });
  const registry = { names: () => [], require: (point: string) => point === "storage" ? h.store : point === "metering" ? metering : point === "audit-sink" ? h.deps.audit : {} } as unknown as RegistryView;
  const offered = vi.fn(async (): Promise<unknown> => access());
  const options = { flow: h.deps, registry, companyId: A, offered, taskRoomUsd: (task: { companyId: string; taskId: string; project: string }) => reviewerRoomUsd({ store: h.store, metering, companyId: A, settings, now }, task) };
  const hosted = createHostedReviewers(options);
  const records = () => readTaskTokenRecords(h.deps, scope);
  const grant = async (slot = "second_review") => hosted.grants.describeReviewer!(scope, await records(), slot);
  const book = async (companyId: string, taskId: string, usd: number) => ledger.recordUsage({ companyId, taskId, entryId: randomUUID(), at: now().toISOString(), usage: { provider: "test", modelId: "test", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, reportedCost: { micros: usd * 1_000_000, currency: "USD" } });
  return { h, scope, opKey, tk, registry, options, hosted, grant, records, offered, book, settings, metering, ledger, now };
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
  it.each([
    ["DISPATCHING", true], ["RUNNING", true], ["ACCEPTED", false],
    ["CANCEL_REQUESTED", false], ["SUCCEEDED", false], ["INTERRUPTED", false],
  ] as const)("design-review grants at operation status %s: allowed=%s", async (status, allowed) => {
    const w = await world();
    await designSlot(w);
    const checked = await w.records();
    // Pass the stored records directly so this catches the reviewer's own status guard,
    // independently of the model route's record guard.
    const records = { ...checked, operation: { ...checked.operation, status } };
    const description = await w.hosted.grants.describeReviewer!(w.scope, records, "r1-critic");
    expect(description !== undefined).toBe(allowed);
  });

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
  it("keeps a review ceiling inside the gateway company monthly room", async () => {
    const w = await world(); await w.book(A, "another-task", 9.75);
    w.offered.mockImplementation(async () => ({ ...access(), reviewerAccess: { ...access().reviewerAccess, companyLimitUsd: 0.25 } }));
    expect((await w.grant())?.reviewer?.ceilingUsd).toBe(0.25);
    const runtime = createHostedDesignReview({ ...w.options, env: {}, blobs: {} as never });
    expect(await runtime.ports.taskRoomUsd((await w.records()).task)).toBe(0.25);
    w.offered.mockImplementation(async () => ({ ...access(), reviewerAccess: { ...access().reviewerAccess, companyLimitUsd: 0 } }));
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
  it("(c) claims each slot once even with concurrent first asks, then renews the same session", async () => {
    const w = await world(); const signer = signingWorld();
    const deps = { signer: signer.signer, issuer: claimVector().iss, now: () => w.h.clock.now, describer: createTaskTokenDescriber(w.h.deps, w.hosted.grants) };
    const records = await w.records();
    const outcomes = await Promise.allSettled([1, 2].map(() => mintTaskToken(deps, { ...w.scope, reviewerSlot: "second_review" }, records)));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const minted = outcomes.find((outcome) => outcome.status === "fulfilled")! as PromiseFulfilledResult<{ token: string; expiresAt: number }>;
    const claims = JSON.parse(Buffer.from(minted.value.token.split(".")[1]!, "base64url").toString()) as TaskTokenClaims;
    expect(signer.reference(minted.value.token, Math.floor(w.h.clock.now / 1000))).toBeDefined();
    expect(claims.exp - claims.iat).toBe(REVIEWER_GRANT_SECONDS); expect(REVIEWER_GRANT_SECONDS).toBe(120);
    expect((await w.grant())?.reviewer).toEqual(claims.reviewer);
  });
  it("design grants use the main payer, allocated ceiling and one session", async () => {
    const w = await world();
    await designSlot(w);
    const task = (await w.h.store.get(w.tk))!;
    const grant = await w.grant("r1-critic");
    expect(grant).toMatchObject({ payer: { kind: "member", developerId: "a".repeat(64) }, taskId: task["taskId"], step: "design_review", reviewer: { kind: "design_review", slot: "r1-critic", ceilingUsd: 2 } });
    expect(await createTaskTokenDescriber(w.h.deps, w.hosted.grants).describe(w.scope)).toBeUndefined();
    const signer = signingWorld();
    await mintTaskToken({ signer: signer.signer, issuer: claimVector().iss, now: () => w.h.clock.now, describer: createTaskTokenDescriber(w.h.deps, w.hosted.grants) }, { ...w.scope, reviewerSlot: "r1-critic" }, await w.records());
    expect((await w.grant("r1-critic"))?.reviewer).toEqual(grant?.reviewer);
    expect(await w.grant("second_review")).toBeUndefined();
  });

  it.each(["second_review", "design_review"] as const)("renews a four-turn %s over 120 seconds with one jti, ceiling and payer", async kind => {
    const w = await world();
    if (kind === "design_review") await designSlot(w);
    const slot = kind === "design_review" ? "r1-critic" : "second_review";
    const signer = signingWorld();
    const deps = { signer: signer.signer, issuer: claimVector().iss, now: () => w.h.clock.now, describer: createTaskTokenDescriber(w.h.deps, w.hosted.grants) };
    const source = modelAccessSource({ controlPlaneUrl: "https://broker.example", capability: "fake", slot, now: () => w.h.clock.now,
      fetch: async url => {
        expect(new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).searchParams.get("slot")).toBe(slot);
        const minted = await mintTaskToken(deps, { ...w.scope, reviewerSlot: slot }, await w.records());
        return Response.json({ baseUrl: "https://gateway.example", apiKey: minted.token, expiresAt: minted.expiresAt });
      } });
    const turns: TaskTokenClaims[] = [];
    let sessionJti: string | undefined;
    for (let turn = 0; turn < 4; turn++) {
      if (turn > 0) w.h.clock.now += 70_000;
      const answer = await source();
      const claims = signer.reference(answer.apiKey, Math.floor(w.h.clock.now / 1000))!;
      expect(claims).toBeDefined();
      turns.push(claims);
      const expected = { cid: claims.cid, pid: claims.pid, tid: claims.tid, ws: claims.ws, op: claims.op, kind, slot, model: claims.mdl[0]! };
      expect(await consumeReviewerGrant(claims, expected, Math.floor(w.h.clock.now / 1000), async jti => {
        sessionJti ??= jti; return jti === sessionJti;
      })).toBe(true);
    }
    expect(new Set(turns.map(claims => claims.jti)).size).toBe(1);
    expect(turns.map(claims => claims.iat - turns[0]!.iat)).toEqual([0, 70, 140, 210]);
    for (const claims of turns) {
      expect({ ...claims, iat: 0, nbf: 0, exp: 0 }).toEqual({ ...turns[0]!, iat: 0, nbf: 0, exp: 0 });
      expect(claims.exp - claims.iat).toBe(120);
    }
  });
  it.each(["second_review", "design_review"] as const)("never renews %s past 600 seconds or after close", async kind => {
    const w = await world();
    if (kind === "design_review") await designSlot(w);
    const slot = kind === "design_review" ? "r1-critic" : "second_review";
    const signer = signingWorld();
    const deps = { signer: signer.signer, issuer: claimVector().iss, now: () => w.h.clock.now, describer: createTaskTokenDescriber(w.h.deps, w.hosted.grants) };
    const mint = async () => mintTaskToken(deps, { ...w.scope, reviewerSlot: slot }, await w.records());
    const first = await mint(); const start = w.h.clock.now;
    w.h.clock.now = start + 480_000;
    const last = await mint();
    expect(last.expiresAt).toBe(first.expiresAt + 480_000);
    w.h.clock.now = start + 481_000;
    await expect(mint()).rejects.toThrow("invalid or expired model access");
    w.h.clock.now = start + 600_000;
    await expect(mint()).rejects.toThrow("invalid or expired model access");
    w.h.clock.now = start + 70_000;
    await w.h.store.put({ item: { ...(await w.h.store.get(w.tk))!, closedAt: new Date(w.h.clock.now).toISOString() } });
    await expect(mint()).rejects.toThrow("this operation has no model access");
  });
  it("refuses renewal when task, kind, model or payer changes, including stale task records", async () => {
    const w = await world(); const signer = signingWorld();
    const deps = { signer: signer.signer, issuer: claimVector().iss, now: () => w.h.clock.now, describer: createTaskTokenDescriber(w.h.deps, w.hosted.grants) };
    const mint = async () => mintTaskToken(deps, { ...w.scope, reviewerSlot: "second_review" }, await w.records());
    await mint(); w.h.clock.now += 70_000;
    const records = await w.records();
    expect(await w.hosted.grants.describeReviewer!(w.scope, { ...records, task: { ...records.task, taskId: "other-task" } }, "second_review")).toBeUndefined();
    const op = (await w.h.store.get(w.opKey))!;
    await w.h.store.put({ item: { ...op, requester: { personId: "b".repeat(64) } } });
    await expect(mint()).rejects.toThrow("invalid or expired model access");
    await w.h.store.put({ item: { ...op, dispatch: { kind: "task", payload: { workflowSecondReviewer: { candidates: [{ model: agentModelIdentity("another-model"), modelRoute: route("another-model"), keySlot: "second_review" }] } } }, secondReviewPlan: { candidateDigest: digest, caps: { "another-model": { capUsd: 3 } } } } });
    await expect(mint()).rejects.toThrow("invalid or expired model access");
    await w.h.store.put({ item: op });
    await designSlot(w);
    await expect(mint()).rejects.toThrow("invalid or expired model access");
  });
  it("records design-review usage on the task cost record and refuses another task at the engine daily cap", async () => {
    const w = await world(); w.settings.companyDayCapMicros = 5_000_000;
    await w.book(A, "earlier-task", 3); await w.book(B, "other-company-task", 100);
    const tempRoot = process.env.TMPDIR;
    if (tempRoot === undefined) throw new Error("test temporary directory is missing");
    const rootPath = await mkdtemp(join(tempRoot, "l4-hw6c-review-usage-"));
    const payloads: unknown[] = [];
    try {
      const open = createReviewSessionOpener({ rootPath, localFileTools: true, onUsage: payload => { payloads.push(payload); }, runtimeFor: () => ({ model: { provider: "fixture", modelId: "review-model" }, piAdapter: { create: async input => {
        const sessionFile = join(input.sessionDirectory, "review.jsonl"); await writeFile(sessionFile, "");
        return { sessionFile, conversationId: "review", prompt: async () => undefined, abort: async () => undefined, getModel: () => ({ provider: "fixture", modelId: "review-model" }),
          getSessionStats: () => ({ sessionFile, sessionId: "review", userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2, tokens: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, total: 20 }, cost: 2 }),
          subscribe: () => () => undefined, dispose: () => undefined };
      } } }) });
      const session = await open({ purpose: "reviewer", keySlot: "r1-critic", model: { provider: "fixture", modelId: "review-model" }, system: "Critic", tools: [] });
      await session.prompt("Review"); session.dispose(); session.dispose();
      expect(payloads).toHaveLength(1);
      const booking = createUsageBooking({ store: w.h.store, metering: w.metering, now: w.now });
      const events = payloads.map(payload => ({ type: "usage", timestamp: w.now().toISOString(), payload }));
      const operation = (await w.records()).operation;
      expect(await booking.bookOperationEvents(operation, events)).toEqual({ booked: 1, unreadable: 0 });
      expect(await booking.bookOperationEvents(operation, events)).toEqual({ booked: 0, unreadable: 0 });
      const task = (await w.records()).task;
      expect(await w.h.store.get({ pk: `ORG#${A}#COST#${task.taskId}`, sk: "TOTAL" })).toMatchObject({ micros: 2_000_000 });
      expect((await w.ledger.companyDayCost(A, w.now().toISOString().slice(0, 10))).usdMicros).toBe(5_000_000);
      expect(await w.h.deps.admission.admit({ companyId: A, action: "task.start", idempotencyKey: "after-review", subject: { type: "task", id: "next-task" } })).toMatchObject({ allowed: false, code: "company_day_cap" });
    } finally { await rm(rootPath, { recursive: true, force: true }); }
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
  describe("second review settings (fail closed)", () => {
    const failOn = (w: Awaited<ReturnType<typeof world>>, method: "get" | "query") => {
      const real = w.h.store[method].bind(w.h.store) as (...args: unknown[]) => Promise<unknown>;
      return vi.spyOn(w.h.store, method as "get").mockImplementation((async (...args: unknown[]) => {
        if (JSON.stringify(args[0]).includes("SECONDREVIEW#")) throw new Error("settings store down");
        return real(...args);
      }) as never);
    };
    it("a settings read that throws starts no review: no reviewer grant, no gateway call, no admission, and says so", async () => {
      expect(SECOND_REVIEW_SETTINGS_UNAVAILABLE).toBe("second review skipped: settings unavailable");
      for (const method of ["get", "query"] as const) {
        const w = await world(); const admit = vi.spyOn(w.h.deps.admission, "admit"); const spy = failOn(w, method);
        const log = vi.fn(); w.h.deps.log = log;
        const task = (await w.records()).task;
        w.offered.mockClear();
        const prepared = await w.hosted.secondReview.prepare({ task });
        expect(spy.mock.calls.some(([key]) => JSON.stringify(key).includes("SECONDREVIEW#"))).toBe(true);
        expect(prepared).toEqual({ firstEvent: SECOND_REVIEW_SETTINGS_UNAVAILABLE });
        expect(prepared.field).toBeUndefined(); expect(prepared.record).toBeUndefined();
        expect(w.offered).not.toHaveBeenCalled();
        expect(admit).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "second_review.settings_unreadable", errorName: "Error" }));
      }
    });
    it("a settings read that works is unchanged: ON or shadow prepares one reviewer, OFF starts nothing", async () => {
      const shadow = await world();
      expect((await shadow.hosted.secondReview.prepare({ task: (await shadow.records()).task })).field?.candidates).toHaveLength(1);
      const off = await world(); const admit = vi.spyOn(off.h.deps.admission, "admit");
      await off.h.store.put({ item: { ...secondReviewSettingsKey(A), default: "off" } });
      off.offered.mockClear();
      expect(await off.hosted.secondReview.prepare({ task: (await off.records()).task })).toEqual({});
      expect(off.offered).not.toHaveBeenCalled(); expect(admit).not.toHaveBeenCalled();
      const on = await world(); await on.h.store.put({ item: { ...secondReviewSettingsKey(A), default: "on" } });
      const prepared = await on.hosted.secondReview.prepare({ task: (await on.records()).task });
      expect(prepared.firstEvent).not.toBe(SECOND_REVIEW_SETTINGS_UNAVAILABLE);
      expect(prepared.field !== undefined || prepared.record?.notRun?.mode === "on").toBe(true);
    });
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

it("(c) continues the same bound session and refuses another task/kind, close and session expiry before spend", async () => {
  for (const kind of ["second_review", "design_review"] as const) {
    const claims = taskTokenClaimsFor({ ...claimVector(), stp: kind, mdl: [primary], reviewer: { kind, slot: kind, ceilingUsd: 1 } })!;
    const expected = { cid: claims.cid, pid: claims.pid, tid: claims.tid, ws: claims.ws, op: claims.op, kind, slot: kind, model: primary };
    let active = claims, now = claims.iat;
    let session: { jti: string; bind: string; endsAt: number; closed: boolean } | undefined;
    const consume = vi.fn(async (jti: string) => {
      const bind = JSON.stringify({ ...active, iat: 0, nbf: 0, exp: 0 });
      session ??= { jti, bind, endsAt: now + 600, closed: false };
      return jti === session.jti && bind === session.bind && !session.closed && now < session.endsAt;
    });
    for (const patch of [{ tid: "another-task" }, { kind: kind === "second_review" ? "design_review" as const : "second_review" as const }, { cid: B }, { model: second }]) {
      expect(await consumeReviewerGrant(claims, { ...expected, ...patch }, claims.iat, consume)).toBe(false);
    }
    expect(await consumeReviewerGrant(claims, expected, claims.exp, consume)).toBe(false);
    expect(consume).not.toHaveBeenCalled();
    expect(await consumeReviewerGrant(claims, expected, claims.iat, async () => { throw new Error("session store unavailable"); })).toBe(false);
    expect(await Promise.all([1, 2].map(() => consumeReviewerGrant(claims, expected, now, consume)))).toEqual([true, true]);
    active = taskTokenClaimsFor({ ...claims, iat: claims.iat + 140 })!; now = active.iat;
    expect(await consumeReviewerGrant(active, expected, now, consume)).toBe(true);
    session!.closed = true;
    expect(await consumeReviewerGrant(active, expected, now, consume)).toBe(false);
    session!.closed = false;
    active = taskTokenClaimsFor({ ...claims, iat: claims.iat + 540 })!; now = claims.iat + 600;
    expect(await consumeReviewerGrant(active, expected, now, consume)).toBe(false);
  }
});

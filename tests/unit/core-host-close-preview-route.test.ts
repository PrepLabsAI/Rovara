// GET /v1/dev/tasks/<id>/close on the deployed core host, over the REAL createCoreDevRoutes composition (not the route function alone). Every provider here is a fake port, NOT machine proof.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { TaskClosePreviewResponseSchema, change, orgProjectCatalogKey, projectRevisionKey, type JsonValue, type ProjectDefinition } from "@agentx/contracts";
import { devRouteOf as contextDevRouteOf } from "../../packages/broker/src/aws/dev-route-scopes.js";
import { prepareCloseInspection } from "../../packages/broker/src/core/task-flow/close-inspection.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { operationKey, taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createCoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { parityTaskRoute } from "../../packages/broker/src/core-host/parity-task-routes.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";
import type { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";

const OTHER = "org_corehost00000000000b";
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
const WIRED: CoreDevWiring = { origin: () => "https://api.example" };
const get = (path: string) => ({ method: "GET", path, headers: {}, body: "" });
const post = (path: string, body: unknown = {}) => ({ method: "POST", path, headers: {}, body: JSON.stringify(body) });
const callerOf = (companyId: string, personId?: string): DeployedCaller => {
  const base = localOwnerPrincipal({ companyId });
  return { principal: personId === undefined ? base : { ...base, personId }, client: "web", webApp: true };
};

async function register(world: FakeWorld, companyId: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
}

/** The deployed rule the preview needs: the owner of a task acts as its owner (a hosted company; the laptop rule is never used). */
async function world(options: { ownerRule?: boolean } = {}) {
  const w = createFakeWorld();
  await register(w, FAKE_COMPANY);
  await register(w, OTHER);
  // Any member of the company may READ-AND-ACT-check a task here (`canAct`), so only the owner rule (`ownerActing`) keeps another person from the facts.
  const access = options.ownerRule === false ? createOwnerTaskAccess() : { ...createOwnerTaskAccess(), canAct: async () => true, ownerActing: async (principal: { personId: string }, task: { ownerKey: string; developerId: string }) => (principal.personId === task.developerId ? { actorId: task.ownerKey } : undefined) };
  const app = createCoreHostApp({
    modules: w.modules, context: () => w.context(), nowMs: () => w.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access, repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(w.clock.now), log: () => undefined, services: SERVICES, ciReporting: { honest: true as const, ciMode: () => "their_ci_fix" as const } }),
  });
  const members = new Map<string, CompanyMembership>();
  const remember = (companyId: string, personId?: string, role: CompanyMembership["role"] = "owner") => {
    const caller = callerOf(companyId, personId);
    members.set(caller.principal.personId + companyId, { companyId, role });
    return caller;
  };
  const companyOf = async (caller: DeployedCaller) => members.get(caller.principal.personId + caller.principal.companyId);
  const routes = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED });
  const owner = remember(FAKE_COMPANY);
  const runtime = await app.runtimeFor(FAKE_COMPANY);
  const { task } = await runtime.flow.start({ principal: owner.principal, origin: "app", client: "test" }, { requestId: randomUUID(), project: "payments", instructions: "Close preview" });
  const rows = async () => (await (w.store as MemoryDocumentStore).scanPage({ limit: 1000 })).items;
  /** The workspace holder as a finished retained inspection (a fake provider, not a machine). */
  async function retain(findings: boolean) {
    const holder = (await w.store.get(workspaceKey(FAKE_COMPANY, task.workspaceId)))!["activeOperationId"] as string;
    await w.store.update({ key: operationKey(FAKE_COMPANY, task.workspaceId, holder), ops: [change.set("kind", "close"), change.set("status", "RUNNING")] });
    runtime.flow.deps.closeInspection = { async raiseFence() {}, async retained() { return true; }, async inspectWorkspaceForClose() { return { inspection: { safeToClose: !findings, repositories: findings ? [{ name: "demo", reasons: ["unpushed_head"] }] : [], contentDigest: "a".repeat(64) }, retentionId: "kept" }; } };
    expect(await prepareCloseInspection(runtime.flow.deps, task.workspaceId, holder)).toBe(true);
  }
  return { w, app, routes, owner, remember, runtime, task, rows, retain };
}
const path = (taskId: string, query = "?action=close") => `/v1/dev/tasks/${taskId}/close${query}`;
const body = (answer: { body: string } | undefined) => JSON.parse(answer!.body) as Record<string, unknown>;

describe("the route table", () => {
  const id = randomUUID();
  it("owns GET close and GET plan, POST close and the POST actions, and nothing else", () => {
    expect(parityTaskRoute(`/v1/dev/tasks/${id}/close`, "GET")).toEqual({ taskId: id, action: "close" });
    expect(parityTaskRoute(`/v1/dev/tasks/${id}/close`, "POST")).toEqual({ taskId: id, action: "close" });
    expect(parityTaskRoute(`/v1/dev/tasks/${id}/plan`, "GET")).toEqual({ taskId: id, action: "plan" });
    expect(parityTaskRoute(`/v1/dev/tasks/${id}/plan`, "POST")).toBeUndefined();
    for (const action of ["workflow/decision", "workflow/retry", "workflow/publish-retry"]) {
      expect(parityTaskRoute(`/v1/dev/tasks/${id}/${action}`, "POST")).toBeDefined();
      expect(parityTaskRoute(`/v1/dev/tasks/${id}/${action}`, "GET"), action).toBeUndefined();
    }
    for (const method of ["PUT", "DELETE", "PATCH"]) expect(parityTaskRoute(`/v1/dev/tasks/${id}/close`, method)).toBeUndefined();
  });
  it("is registered at the deployed boundary as a read", () => {
    expect(contextDevRouteOf("GET", path(id, ""))?.requires).toBe("tasks:read");
  });
});

describe("GET close on the deployed core host", () => {
  it("answers inspection_required for both actions when no retention provider exists, and writes nothing", async () => {
    const t = await world();
    // A finished task: nothing holds its workspace.
    await t.w.store.update({ key: workspaceKey(FAKE_COMPANY, t.task.workspaceId), ops: [change.set("activeOperationId", null), change.set("status", "READY")] });
    const before = await t.rows();
    const spies = [vi.spyOn(t.w.store, "put"), vi.spyOn(t.w.store, "update"), vi.spyOn(t.w.store, "delete"), vi.spyOn(t.w.store, "transact")];
    const terminate = vi.spyOn(t.runtime.flow.deps.machines, "terminate"), start = vi.spyOn(t.runtime.flow.deps.machines, "start");
    for (const action of ["close", "discard"]) {
      const answer = await t.routes.route(get(path(t.task.taskId, `?action=${action}`)), t.owner);
      expect(answer?.statusCode).toBe(200);
      expect(body(answer)).toEqual({ preview: null, unavailable: "inspection_required" });
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(await t.rows()).toEqual(before);
  });

  it("answers a step that is running as busy (the dialog fails closed on it), and a finished task as inspection_required", async () => {
    const t = await world();
    // Without the provider nothing can be inspected, so a running step changes nothing: inspection_required.
    expect(body(await t.routes.route(get(path(t.task.taskId)), t.owner))).toEqual({ preview: null, unavailable: "inspection_required" });
    t.runtime.flow.deps.closeInspection = { async raiseFence() {}, async retained() { return true; }, async inspectWorkspaceForClose() { throw new Error("not asked"); } };
    // A freshly started task holds its workspace with its preparation: a running step.
    expect(body(await t.routes.route(get(path(t.task.taskId)), t.owner))).toEqual({ preview: null, unavailable: "busy" });
    await t.w.store.update({ key: taskKey(t.task.taskId), ops: [change.set("closedAt", "2026-11-15T10:00:00.000Z")] });
    expect(body(await t.routes.route(get(path(t.task.taskId)), t.owner))).toEqual({ preview: null, unavailable: "inspection_required" });
  });

  it("with a retained inspection (a fake port): the preview envelope Cloud's dialog reads, unchanged; a discard preview has its own digest", async () => {
    const t = await world();
    await t.retain(true);
    const closeAnswer = await t.routes.route(get(path(t.task.taskId, "?action=close")), t.owner);
    const discardAnswer = await t.routes.route(get(path(t.task.taskId, "?action=discard")), t.owner);
    for (const answer of [closeAnswer, discardAnswer]) {
      expect(answer?.statusCode).toBe(200);
      expect(TaskClosePreviewResponseSchema.safeParse(body(answer)).success).toBe(true);
    }
    const close = body(closeAnswer)["preview"] as { action: string; digest: string; unpublished: unknown[]; inspection: { contentDigest: string } };
    const discard = body(discardAnswer)["preview"] as { action: string; digest: string };
    expect(close).toMatchObject({ action: "close", unpublished: [{ repository: "demo", reasons: ["unpushed_head"] }], inspection: { contentDigest: "a".repeat(64) } });
    expect(discard.action).toBe("discard");
    expect(discard.digest).not.toBe(close.digest);
    expect(Object.keys(body(closeAnswer))).toEqual(["preview"]);
  });

  it("is the owner's: another person of the company, and another company, get the missing-task answer, never the facts", async () => {
    const t = await world();
    await t.retain(true);
    const missing = await t.routes.route(get(path(randomUUID())), t.remember(OTHER));
    const stranger = await t.routes.route(get(path(t.task.taskId)), t.remember(OTHER));
    const colleague = await t.routes.route(get(path(t.task.taskId)), t.remember(FAKE_COMPANY, "someone-else"));
    expect(stranger?.statusCode).toBe(404);
    expect(stranger?.body).toBe(missing?.body);
    expect(colleague?.statusCode).toBe(404);
    expect(colleague!.body).not.toContain("demo");
    expect(colleague!.body).not.toContain("unpushed");
  });

  it("an install without an owner rule does not serve it (the boundary then answers its fixed 'not on the core yet'), and reads no facts", async () => {
    const t = await world({ ownerRule: false });
    expect(await t.routes.route(get(path(t.task.taskId)), t.owner)).toBeUndefined();
    expect(await t.routes.route(get(path(t.task.taskId, "?action=discard")), t.owner)).toBeUndefined();
  });

  it("takes exactly one query key, close or discard", async () => {
    const t = await world();
    for (const query of ["", "?action=", "?action=erase", "?action=close&action=discard", "?action=close&x=1", "?x=1", "?action=Close"]) {
      const answer = await t.routes.route(get(path(t.task.taskId, query)), t.owner);
      expect(answer?.statusCode, query).toBe(400);
      expect(body(answer)).toMatchObject({ error: { code: "CONFIG_INVALID" } });
    }
  });
});

describe("a close bound to a preview on the parity POST", () => {
  const bound = { requestId: randomUUID(), expectedPreviewDigest: "a".repeat(64) };
  it("without a retention provider is refused BEFORE any read, with the session route's words", async () => {
    const t = await world();
    const reads = vi.spyOn(t.w.store, "get"), queries = vi.spyOn(t.w.store, "query");
    for (const fields of [bound, { requestId: randomUUID(), discard_unpublished: true }, { requestId: randomUUID(), discardUnpublished: true }, { ...bound, discard_unpublished: true }]) {
      const answer = await t.routes.route(post(`/v1/dev/tasks/${randomUUID()}/close`, fields), t.owner);
      expect(answer?.statusCode).toBe(503);
      expect(body(answer)).toMatchObject({ error: { code: "RUNTIME_UNAVAILABLE", message: "Guarded close and discarding unpublished work are not available yet." } });
    }
    expect(reads).not.toHaveBeenCalled();
    expect(queries).not.toHaveBeenCalled();
  });
  it("with a provider the same body goes on to the close's own checks (a stale digest, never the unavailable words)", async () => {
    const t = await world();
    await t.retain(false);
    const answer = await t.routes.route(post(`/v1/dev/tasks/${t.task.taskId}/close`, bound), t.owner);
    expect(answer?.statusCode).toBe(409);
    expect(body(answer)).toMatchObject({ error: { code: "CHANGE_STALE" } });
  });
  it("a plain requestId-only body is untouched by the readiness check", async () => {
    const t = await world();
    const answer = await t.routes.route(post(`/v1/dev/tasks/${t.task.taskId}/close`, { requestId: randomUUID() }), t.owner);
    expect(answer?.statusCode).toBe(200);
  });
});

// ---- the shared fixture and the exact words (T4) ----
import { readFileSync } from "node:fs";
import { workspaceSessionKey } from "@agentx/contracts";
import { CLOSE_CANNOT_CHECK_WORDS, CLOSE_CHECKING_WORDS, CLOSE_TRY_AGAIN_WORDS, retainedCloseWords } from "../../packages/broker/src/core/task-flow/close-words.js";

const FIXTURE_PATH = new URL("../fixtures/close-envelopes.json", import.meta.url);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
  taskId: string;
  refusals: Record<"retained" | "checking" | "cannot_check" | "try_again", { status: number; final: boolean; body: { error: { code: string; message: string } } }>;
  runtimeUnavailable: { status: number; body: unknown }; badQuery: { status: number; body: unknown };
  previews: Record<"clean" | "discard" | "inspection_required" | "busy", unknown>; acceptedClosing: Record<string, unknown>;
};

describe("the words, byte for byte", () => {
  it("the four 409 sentences are exactly the shared fixture's, and the three final ones are told apart by the sentence, never by the code", () => {
    expect(fixture.refusals.retained.body.error.message).toBe(retainedCloseWords(fixture.taskId));
    expect(fixture.refusals.checking.body.error.message).toBe(CLOSE_CHECKING_WORDS);
    expect(fixture.refusals.cannot_check.body.error.message).toBe(CLOSE_CANNOT_CHECK_WORDS);
    expect(fixture.refusals.try_again.body.error.message).toBe(CLOSE_TRY_AGAIN_WORDS);
    // The exact-match patterns a client uses: anchored, no slack.
    expect(retainedCloseWords(randomUUID())).toMatch(/^This workspace is retained\. Review the Close preview at \/v1\/dev\/tasks\/[0-9a-f-]{36}\/close before closing it\.$/u);
    expect(CLOSE_CHECKING_WORDS).toMatch(/^Rovara is checking this task's workspace for unpublished work, so nothing was closed yet\. Press Close again in a minute\.$/u);
    expect(CLOSE_CANNOT_CHECK_WORDS).toMatch(/^Rovara can't check this task's workspace for unpublished work, so nothing was closed\. If this keeps happening, ask your admin for help\.$/u);
    const all = Object.values(fixture.refusals);
    expect(new Set(all.map((entry) => `${entry.status} ${entry.body.error.code}`))).toEqual(new Set(["409 WORKSPACE_BUSY"]));
    expect(new Set(all.map((entry) => entry.body.error.message)).size).toBe(4);
    expect(all.map((entry) => entry.final)).toEqual([true, true, true, false]);
    for (const text of all.map((entry) => entry.body.error.message)) expect(text).not.toMatch(/[—–]/u);
  });
  it("every preview envelope in the fixture is one the contract reads", () => {
    for (const envelope of Object.values(fixture.previews)) expect(TaskClosePreviewResponseSchema.safeParse(envelope).success).toBe(true);
  });
});

describe("the real answers are the fixture's", () => {
  const substitute = (text: string, taskId: string) => JSON.parse(text.split(taskId).join(fixture.taskId)) as unknown;
  async function machineBacked(t: Awaited<ReturnType<typeof world>>, session = true) {
    await t.w.store.update({ key: workspaceKey(FAKE_COMPANY, t.task.workspaceId), ops: [change.set("activeOperationId", null), change.set("status", "READY"), change.set("machineGeneration", 1), change.set("machine", { machineId: "m-1", machineKey: t.task.workspaceId })] });
    if (session) await t.w.store.put({ item: { ...workspaceSessionKey(t.task.workspaceId), entityType: "WORKSPACE_SESSION", workspaceId: t.task.workspaceId, state: "STOPPED", generation: 1, volumeId: "vol-0123456789abcdef0", availabilityZone: "us-west-2a" } });
    t.runtime.flow.deps.closeGuard = { enforce: true };
  }
  const unbound = (t: Awaited<ReturnType<typeof world>>) => t.routes.route(post(`/v1/dev/tasks/${t.task.taskId}/close`, { requestId: randomUUID() }), t.owner);

  it("G4b over HTTP", async () => {
    const t = await world();
    await machineBacked(t);
    const answer = await unbound(t);
    expect(answer?.statusCode).toBe(fixture.refusals.cannot_check.status);
    expect(substitute(answer!.body, t.task.taskId)).toEqual(fixture.refusals.cannot_check.body);
  });
  it("G4a over HTTP (a check was requested)", async () => {
    const t = await world();
    await machineBacked(t);
    const request = vi.fn(async () => "queued" as const);
    t.runtime.flow.deps.closeCheck = { request };
    const answer = await unbound(t);
    expect(answer?.statusCode).toBe(fixture.refusals.checking.status);
    expect(substitute(answer!.body, t.task.taskId)).toEqual(fixture.refusals.checking.body);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("G3 over HTTP (a retained inspection exists)", async () => {
    const t = await world();
    await t.retain(false);
    await t.w.store.update({ key: workspaceKey(FAKE_COMPANY, t.task.workspaceId), ops: [change.set("machineGeneration", 1), change.set("machine", { machineId: "m-1", machineKey: t.task.workspaceId })] });
    await t.w.store.put({ item: { ...workspaceSessionKey(t.task.workspaceId), entityType: "WORKSPACE_SESSION", workspaceId: t.task.workspaceId, state: "READY", generation: 1 } });
    t.runtime.flow.deps.closeGuard = { enforce: true };
    const answer = await unbound(t);
    expect(answer?.statusCode).toBe(fixture.refusals.retained.status);
    expect(substitute(answer!.body, t.task.taskId)).toEqual(fixture.refusals.retained.body);
  });
  it("the transient 'try again' over HTTP (the commit lost a race), which a client must NOT treat as final", async () => {
    const t = await world();
    await t.w.store.update({ key: workspaceKey(FAKE_COMPANY, t.task.workspaceId), ops: [change.set("activeOperationId", null), change.set("status", "READY")] });
    t.runtime.flow.deps.closeGuard = { enforce: true };
    const transact = t.w.store.transact.bind(t.w.store);
    let fired = false;
    t.w.store.transact = async (items) => { if (!fired) { fired = true; await t.w.store.put({ item: { ...workspaceSessionKey(t.task.workspaceId), entityType: "WORKSPACE_SESSION", workspaceId: t.task.workspaceId, state: "PROVISIONING", generation: 1 } }); } return transact(items); };
    const answer = await unbound(t);
    expect(answer?.statusCode).toBe(fixture.refusals.try_again.status);
    expect(substitute(answer!.body, t.task.taskId)).toEqual(fixture.refusals.try_again.body);
  });
  it("the readiness 503, the bad-query 400 and the accepted-closing answer", async () => {
    const t = await world();
    const unavailable = await t.routes.route(post(`/v1/dev/tasks/${t.task.taskId}/close`, { requestId: randomUUID(), expectedPreviewDigest: "a".repeat(64) }), t.owner);
    expect([unavailable?.statusCode, JSON.parse(unavailable!.body)]).toEqual([fixture.runtimeUnavailable.status, fixture.runtimeUnavailable.body]);
    const bad = await t.routes.route(get(path(t.task.taskId, "?action=x")), t.owner);
    expect([bad?.statusCode, JSON.parse(bad!.body)]).toEqual([fixture.badQuery.status, fixture.badQuery.body]);
    // A bound close accepted but not finished: the same words and `closed: false`.
    await t.retain(false);
    const preview = JSON.parse((await t.routes.route(get(path(t.task.taskId)), t.owner))!.body) as { preview: { digest: string } };
    const accepted = await t.routes.route(post(`/v1/dev/tasks/${t.task.taskId}/close`, { requestId: randomUUID(), expectedPreviewDigest: preview.preview.digest }), t.owner);
    expect(accepted?.statusCode).toBe(200);
    expect(JSON.parse(accepted!.body)).toMatchObject(fixture.acceptedClosing);
  });
});

// ---- T8: composition (both-or-neither) at the runtime the deployed root builds on ----
describe("the guard and the retention provider are wired together or not at all", () => {
  const appWith = (w: FakeWorld, flowOptions: Record<string, unknown>) => createCoreHostApp({
    modules: w.modules, context: () => w.context(), nowMs: () => w.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(w.clock.now), log: () => undefined, services: SERVICES, ciReporting: { honest: true as const, ciMode: () => "their_ci_fix" as const }, flowOptions }),
  });
  const provider = { async raiseFence() {}, async retained() { return true; }, async inspectWorkspaceForClose() { return { inspection: {}, retentionId: "x" }; } };
  it("a guard without the provider, or a provider without the guard, stops the root at creation", async () => {
    await expect(appWith(createFakeWorld(), { closeGuard: { enforce: true } }).runtimeFor(FAKE_COMPANY)).rejects.toThrow(/closeGuard is wired without closeInspection/u);
    await expect(appWith(createFakeWorld(), { closeInspection: provider }).runtimeFor(FAKE_COMPANY)).rejects.toThrow(/closeInspection is wired without closeGuard/u);
    // The guard without the check seam: nothing would ever ask for a preview, so every close without one is refused for ever.
    await expect(appWith(createFakeWorld(), { closeGuard: { enforce: true }, closeInspection: provider }).runtimeFor(FAKE_COMPANY)).rejects.toThrow(/closeGuard is wired without closeCheck/u);
  });
  it("both is accepted, and so is neither", async () => {
    const both = await appWith(createFakeWorld(), { closeGuard: { enforce: true }, closeInspection: provider, closeCheck: { request: async () => "unsupported" } }).runtimeFor(FAKE_COMPANY);
    expect(both.flow.deps.closeGuard).toBeDefined();
    expect(both.flow.deps.closeCheck).toBeDefined();
    expect(both.flow.deps.closeInspection).toBeDefined();
    const neither = await appWith(createFakeWorld(), {}).runtimeFor(FAKE_COMPANY);
    expect(neither.flow.deps.closeGuard).toBeUndefined();
    expect(neither.flow.deps.closeInspection).toBeUndefined();
    expect(neither.flow.deps.closeCheck).toBeUndefined();
  });
  it("the deployed broker root wires the guard, the provider and the check together", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../../packages/broker/src/aws/core-engine-root.ts", import.meta.url), "utf8");
    expect(source).toMatch(/flowOptions: \{ closeGuard: CLOSE_GUARD, closeCheck: closeCheckPort, closeInspection: createBrokerCloseInspection\(/u);
  });
  it("and so does the dispatcher's root, which builds its own flow options", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../../packages/broker/src/aws/worker-machines/dispatcher-core.ts", import.meta.url), "utf8");
    expect(source).toMatch(/closeGuard: CLOSE_GUARD, closeCheck: closeCheckPort,\s+closeInspection: createDispatcherCloseInspection\(/u);
  });
});

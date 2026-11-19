import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { intakeItemIdOf, reportFeatureKey, reportPartition, type OrgId } from "@agentx/contracts";
import { createHarness } from "../../support/task-flow-harness.js";
import { intakePortsOf } from "../../../packages/broker/src/core/intake/wiring.js";
import { ingestIntake } from "../../../packages/broker/src/core/intake/engine.js";
import { readIntakeItem } from "../../../packages/broker/src/core/intake/store.js";
import { createFeatureStore } from "../../../packages/broker/src/core/report/feature-store.js";
import { createSessionStartExtras } from "../../../packages/broker/src/local/app/session-start.js";
import { developerIdOf } from "../../../packages/broker/src/core/sessions/create.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const parent = { kind: "project" as const, id: "parent-1", title: "Payments", url: "https://linear.app/acme/project/parent-1" };
async function world(companyId: OrgId = A) {
  const h = createHarness({ companyId, understandFirst: true });
  h.deps.startExtras = createSessionStartExtras(companyId);
  await h.registerProject();
  await h.registerProject({ ...((await import("../../support/task-flow-harness.js")).definition), name: "ledger" });
  const log = vi.fn();
  const deliver = vi.fn(async () => undefined);
  const items = vi.fn((input: { kind: string; taskId: string }) => [{ kind: "put" as const, item: { pk: "MOMENTS", sk: input.taskId, kind: input.kind } }]);
  const ports = intakePortsOf({ store: h.store, companyId, now: () => h.clock.now, log, identity: { getPrincipal: async () => h.owner.principal, resolveExternalAccount: async () => h.owner.principal }, access: h.deps.access, flow: h.flow, owner: h.owner.principal, fenceKey: Buffer.alloc(32, 1), milestones: { items, deliver } });
  const features = createFeatureStore({ store: h.store, companyId, audit: h.deps.audit, now: () => h.clock.now });
  const start = async (over: { parent?: typeof parent; url?: string; project?: string; system?: "linear" | "jira" } = {}) => {
    const id = randomUUID();
    const system = over.system ?? "linear";
    const candidate = { orgId: companyId, project: over.project ?? "payments", channel: "tracker" as const, externalRef: { system, id, url: over.url ?? (system === "linear" ? `https://linear.app/acme/issue/${id}` : `https://acme.atlassian.net/browse/${id}`) }, title: "Fix payment", body: "Fix it", actor: { kind: "person" as const, account: { provider: system, tenant: "", accountId: "person" } }, parent: over.parent ?? parent };
    const result = await ingestIntake(ports, candidate);
    expect(result, JSON.stringify(log.mock.calls)).toMatchObject({ outcome: "started" });
    if (result.outcome !== "started") throw new Error("start failed");
    expect(await readIntakeItem(ports.table, companyId, candidate.project, intakeItemIdOf(system, id))).toMatchObject({ state: "started", taskId: result.taskId, startedBy: developerIdOf(h.owner.principal) });
    expect(await h.store.get({ pk: `DEVTASK#${result.taskId}`, sk: "META" })).toMatchObject({ origin: "tracker", ticket: { system } });
    expect(await ports.sessionOfTicket(companyId, { kind: "tracker_item", ...candidate.externalRef })).toBeDefined();
    expect(items).toHaveBeenCalledWith(expect.objectContaining({ kind: "started", taskId: result.taskId }), 1, {});
    expect(deliver).toHaveBeenCalledWith(result.taskId);
    return result.taskId;
  };
  return { h, features, ports, log, start };
}
it("files tracker suggestions, reuses a parent across tickets/projects, and isolates companies", async () => {
  const a = await world(), b = await world(B);
  const first = await a.start(), second = await a.start({ project: "ledger" }), foreign = await b.start();
  const assignment = await a.features.taskFeature(first);
  expect(assignment).toMatchObject({ source: "tracker", project: "payments" });
  expect(await a.features.taskFeature(second)).toMatchObject({ featureId: assignment!.featureId, source: "tracker", project: "ledger" });
  expect((await b.features.taskFeature(foreign))!.featureId).not.toBe(assignment!.featureId);
  expect(await a.features.taskFeature(foreign)).toBeUndefined();
  expect((await a.features.list())[0]!.trackerLink).toEqual({ tracker: "linear", id: parent.id, url: parent.url });
});
it("keeps Jira intake on the tracker task origin", async () => {
  const w = await world();
  const id = await w.start({ system: "jira" });
  expect(await w.h.store.get({ pk: `DEVTASK#${id}`, sk: "META" })).toMatchObject({ origin: "tracker", ticket: { system: "jira" } });
});
it("reuses a person's open company-wide name across projects", async () => {
  const w = await world();
  const made = await w.features.create({ name: "Payments" }, { type: "person", id: "owner" });
  const id = await w.start({ project: "ledger" });
  expect(await w.features.taskFeature(id)).toMatchObject({ featureId: made.id, source: "tracker" });
  expect(await w.features.list()).toHaveLength(1);
});
it("follows a merged parent to its target without recreating it", async () => {
  const w = await world();
  const from = await w.features.create({ name: parent.title, trackerLink: { tracker: "linear", id: parent.id, url: parent.url } }, { type: "system", id: "test" });
  const into = await w.features.create({ name: "Destination" }, { type: "system", id: "test" });
  await w.features.merge(from.id, into.id, { type: "person", id: "owner" });
  expect(await w.features.taskFeature(await w.start())).toMatchObject({ featureId: into.id, source: "tracker" });
  expect((await w.features.all()).size).toBe(2);
});
it.each(["done", "merged-done", "empty-parent-url", "long-id", "control-id", "empty-title", "limit", "unavailable"])("%s never prevents marking, binding or announcing the start", async (kind) => {
  const w = await world();
  const actor = { type: "system" as const, id: "test" };
  if (kind === "done" || kind === "merged-done") {
    const f = await w.features.create({ name: parent.title, trackerLink: { tracker: "linear", id: parent.id, url: parent.url } }, actor);
    if (kind === "merged-done") {
      const target = await w.features.create({ name: "Target" }, actor);
      await w.features.merge(f.id, target.id, actor);
      await w.features.setState(target.id, "done", actor);
    } else await w.features.setState(f.id, "done", actor);
  }
  if (kind === "limit") for (let n = 0; n < 500; n++) await w.h.store.put({ item: { ...reportFeatureKey(A, `ft_${n.toString(16).padStart(20, "0")}`), entityType: "REPORT_FEATURE", companyId: A, id: `ft_${n.toString(16).padStart(20, "0")}`, name: `Other ${n}`, state: "open", createdAt: new Date(w.h.clock.now).toISOString(), updatedAt: new Date(w.h.clock.now).toISOString(), version: 1 } });
  if (kind === "unavailable") {
    const query = w.h.store.query.bind(w.h.store);
    vi.spyOn(w.h.store, "query").mockImplementation(async (input) => { if (input.pk === reportPartition(A)) throw new Error("private canary"); return query(input); });
  }
  const id = await w.start({ parent: { ...parent, ...(kind === "empty-parent-url" ? { url: "" } : {}), ...(kind === "long-id" ? { id: "x".repeat(121) } : {}), ...(kind === "control-id" ? { id: "bad\u0000" } : {}), ...(kind === "empty-title" ? { title: "  " } : {}) } });
  expect(await w.features.taskFeature(id)).toBeUndefined();
  if (kind === "limit" || kind === "unavailable") expect(w.log.mock.calls.filter(([event]) => event === "intake.feature_suggestion_skipped")).toEqual([["intake.feature_suggestion_skipped", { companyId: A, code: "FEATURE_SUGGESTION_UNAVAILABLE" }]]);
});

it("task views follow merged features, show No feature, and omit assignments in another project/company", async () => {
  const w = await world();
  const taskId = await w.start();
  const get = () => w.h.flow.get(w.h.owner, taskId);
  const first = (await w.features.taskFeature(taskId))!;
  expect((await get()).feature).toMatchObject({ id: first.featureId, name: parent.title, source: "tracker" });
  const into = await w.features.create({ name: "Merged target" }, { type: "person", id: "owner" });
  await w.features.merge(first.featureId!, into.id, { type: "person", id: "owner" });
  expect((await get()).feature).toEqual({ id: into.id, name: "Merged target", source: "tracker" });
  await w.features.setTaskFeature({ taskId, project: "payments", featureId: null, source: "chosen" }, { type: "person", id: "owner" });
  expect((await get()).feature).toBeNull();
  const { reportTaskFeatureKey } = await import("@agentx/contracts");
  const key = reportTaskFeatureKey(A, taskId), stored = (await w.h.store.get(key))!;
  await w.h.store.put({ item: { ...stored, project: "ledger" } });
  expect(await get()).not.toHaveProperty("feature");
  await w.h.store.put({ item: { ...stored, companyId: B } });
  expect(await get()).not.toHaveProperty("feature");
});

// L4-P2 (owner DEC 254zzl, 254zzt): the HOSTED wiki refresh starter, the one AI kind of system-started runs that is live (core-host/wiki-refresh.ts), over the REAL task flow and the REAL hosted access rule.
// Rules under test: both locks (ceiling AND consent) are read now; no enforced dollar cap means NO AI (`no_cost_cap`: nothing held, nothing recorded); Admission is asked once per night's key and the hold is given back
// when nothing starts; the audit record is written BEFORE the task exists and an unwritable one starts nothing; the task is the project's SYSTEM OWNER's with the work origin `nightly`, and its steps pass the access rule
// only on the build pointer's mark; a repeat of the same night is the same run; nothing starts for a project whose upkeep is off. Mutants are listed in the PR body with the test that kills each.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, change, WORKER_INVOCATION_FEATURES, WIKI_BUILD_FEATURE, PREPARE_PINS_FEATURE, projectMetaKey, systemOwnerIdOf, type Admission, type OrgId, type ProjectDefinition, type WikiPageWrite } from "@agentx/contracts";
import { hostedTaskAccess } from "../../packages/broker/src/aws/core-engine-root.js";
import { createHostedAutomationStop, createHostedWikiRefresh, hostedUnattendedTasks } from "../../packages/broker/src/core-host/wiki-refresh.js";
import { effectiveSystemRunsGateOf } from "../../packages/broker/src/core-host/system-runs.js";
import { parseCoreSwitch } from "../../packages/broker/src/core-host/flags.js";
import { systemRunsConsentKey } from "../../packages/broker/src/core/system-runs/consent.js";
import { nightRequestId } from "../../packages/broker/src/core/upkeep/refresh.js";
import { setUpkeepEnabled } from "../../packages/broker/src/core/upkeep/settings.js";
import { createWikiStore } from "../../packages/broker/src/core/wiki/store.js";
import { readWikiBuildPointer } from "../../packages/broker/src/core/wiki-build/run.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { createHarness, definition } from "../support/task-flow-harness.js";
import { API_SHA } from "../support/wiki-build-fixtures.js";
import { capReader, type CapKind } from "../support/upkeep-cap-fixtures.js";

const A: OrgId = IMPLICIT_COMPANY_ID;
const URL_ = "https://examplehost.test/acme/app";
const PERSON = "ab".repeat(32);
const DAY = "2026-11-18";
const claim = { claimId: "c0001", text: "A claim", citations: [{ repo: "demo", path: "src/index.ts", commit: API_SHA, line: 1, quote: "export {}" }], source: "found" as const, checkedAt: "2026-11-01T00:00:00.000Z" };
const page = (pageId: string): WikiPageWrite => ({
  pageId, kind: pageId === "overview" ? "overview" : "repo", title: `Page ${pageId}`, summary: "Summary", order: 0, repos: [{ repo: "demo", commit: API_SHA }],
  blocks: [{ kind: "paragraph", blockId: "p0001", text: "Text", claimIds: ["c0001"] }], claims: [claim], buildId: "build-0001",
});
const projectOf = (name: string): ProjectDefinition => ({ ...definition, name, repositories: [{ ...definition.repositories[0]!, name: "demo", url: URL_, host: { kind: "fake" } }] });

interface Options { cap?: CapKind; consent?: boolean; flag?: string; enforces?: boolean; upkeep?: boolean; audit?: "fail"; company?: OrgId }

async function build(options: Options = {}) {
  const company = options.company ?? A;
  const h = createHarness({ companyId: company, audit: "recording", machines: { startingChecks: 0, features: [...WORKER_INVOCATION_FEATURES, WIKI_BUILD_FEATURE, PREPARE_PINS_FEATURE] } });
  const project = projectOf("payments");
  await h.registerProject(project);
  await h.store.put({ item: { ...projectMetaKey(company, project.name), entityType: "PROJECT_META" } });
  const model = new FakeHostModel({ url: URL_, id: "1", fullName: "acme/app", initialFiles: { "package.json": "{}", "src/index.ts": "export {}" } });
  const host = new FakeCodeHost(model);
  const registry = createAdapterRegistry();
  registry.register("code-host", "fake", host);
  h.deps.codeHosts = registry;
  const wiki = createWikiStore({ store: h.store, companyId: company, now: () => h.clock.now });
  for (const id of ["overview", "repo-demo"]) await wiki.writePage("payments", page(id));
  await wiki.addFlag("payments", { pageId: "repo-demo", by: { kind: "person", personId: "p1" } });
  if (options.upkeep !== false) await setUpkeepEnabled({ store: h.store, companyId: company, now: () => h.clock.now, standing: async () => ({ access: "manage" }) }, { personId: PERSON, project: "payments", requestId: crypto.randomUUID(), on: true, fromPage: true });
  if (options.consent !== false) await h.store.put({ item: { ...systemRunsConsentKey(company), entityType: "SYSTEM_RUNS_CONSENT", orgId: company, enabled: true, changedAt: "2026-11-17T00:00:00.000Z" } });
  const gate = effectiveSystemRunsGateOf(parseCoreSwitch(options.flag ?? "on").value, company, h.store);
  // The REAL hosted access rule over the harness's store: the system owner is accepted only with the wiki-refresh marks.
  h.deps.access = hostedTaskAccess({ companyId: company, storage: async () => h.store, systemRunsOn: () => gate.enabled(), membershipOf: async () => undefined, projectGrant: async () => false });
  const admitted: Array<{ key: string; action: string }> = [];
  const released: string[] = [];
  const admission: Admission = {
    enforcesCost: options.enforces !== false,
    admit: async (request) => { admitted.push({ key: request.idempotencyKey, action: request.action }); return { allowed: true, reservationId: `hold:${request.idempotencyKey}` }; },
    stage: async () => ({ decision: { allowed: true }, items: [] }), settle: async () => undefined, release: async (id) => { released.push(id); },
  };
  const auditBefore: Array<{ action: string; pointerPresent: boolean }> = [];
  const real = h.deps.audit;
  h.deps.audit = {
    stage: (event) => real.stage(event),
    record: async (event) => {
      if (event.action === "system_run.requested") {
        auditBefore.push({ action: event.action, pointerPresent: (await readWikiBuildPointer(h.store, company, "payments")) !== undefined });
        if (options.audit === "fail") throw new Error("audit down");
      }
      await real.record(event);
    },
  };
  const refresh = createHostedWikiRefresh({ flow: h.deps, companyId: company, now: () => h.clock.now, gate, admission: options.enforces === false ? { ...admission, enforcesCost: false } : admission, modelAccessConfigured: true, map: { standing: async () => ({ access: "none" }), hostFor: () => host }, cap: capReader(options.cap ?? "enforced", () => h.clock.now) });
  return { h, wiki, refresh, admitted, released, auditBefore, gate, company };
}
const go = (w: Awaited<ReturnType<typeof build>>) => w.refresh("payments", DAY, { includeUnwritten: false });

describe("the two locks and the cap stand before anything is held or started", () => {
  // MUTANT the AND (or the gate not read): the refresh starts on the flag alone, or on the consent alone.
  it("without the company's consent, or with the ceiling off, nothing is asked, held, recorded or started", async () => {
    for (const options of [{ consent: false }, { flag: "off" }, { flag: "off", consent: false }, { flag: `on:org_bbbbbbbbbbbbbbbbbbbb` }] as Options[]) {
      const w = await build(options);
      expect(await go(w), JSON.stringify(options)).toEqual({ outcome: "unavailable" });
      expect(w.admitted).toEqual([]);
      expect(w.auditBefore).toEqual([]);
      expect(await readWikiBuildPointer(w.h.store, w.company, "payments")).toBeUndefined();
    }
  });

  // MUTANT: the refresh declares an enforced cap that the admission does not (or skips the door's cap check).
  it("a dollar cap that is not enforced means NO AI: `no_cost_cap`, nothing held, nothing recorded, no task", async () => {
    const w = await build({ enforces: false });
    expect(await go(w)).toEqual({ outcome: "no_cost_cap" });
    expect(w.admitted).toEqual([]);
    expect(w.auditBefore).toEqual([]);
    expect(await readWikiBuildPointer(w.h.store, w.company, "payments")).toBeUndefined();
  });
});

describe("a started refresh", () => {
  it("is the project's system owner's task with the work origin `nightly`, the unattended mark on its pointer, one admission keyed by the night, and the audit record BEFORE the task exists", async () => {
    const w = await build();
    const answer = await go(w);
    expect(answer).toMatchObject({ outcome: "started", duplicate: false });
    const pointer = (await readWikiBuildPointer(w.h.store, w.company, "payments"))!;
    expect(pointer).toMatchObject({ unattended: true, requestedBy: systemOwnerIdOf(w.company, "payments"), buildKind: "refresh" });
    const task = (await w.h.store.get(taskKey(pointer.taskId)))!;
    expect(task).toMatchObject({ developerId: systemOwnerIdOf(w.company, "payments"), purpose: "wiki_build", origin: "nightly", companyId: w.company, project: "payments" });
    const holds = w.admitted.filter((entry) => entry.action === "automation.run");
    expect(holds).toHaveLength(1);
    expect(holds[0]!.key).toBe(`automation.run#${nightRequestId(w.company, "payments", DAY)}`);
    // The audit record: written before the pointer (and so before the task), naming the kind and the project's system owner.
    expect(w.auditBefore).toEqual([{ action: "system_run.requested", pointerPresent: false }]);
    const event = w.h.audit.find((entry: { action: string }) => entry.action === "system_run.requested") as { actor: unknown; details: unknown };
    expect(event.actor).toEqual({ type: "system", id: systemOwnerIdOf(w.company, "payments") });
    expect(event.details).toMatchObject({ kind: "wiki_refresh", reason: "nightly" });
  });

  // MUTANT: the step rule accepts the wiki purpose without the pointer's mark.
  it("its steps pass the real access rule only while the pointer's mark stands: a person's build pointer, a missing pointer and the consent withdrawn all stop it", async () => {
    const w = await build();
    await go(w);
    const pointer = (await readWikiBuildPointer(w.h.store, w.company, "payments"))!;
    const step = { taskId: pointer.taskId, developerId: systemOwnerIdOf(w.company, "payments"), project: "payments" };
    expect((await w.h.deps.access.checkStep(step)).allowed).toBe(true);
    await w.h.store.put({ item: { ...(await w.h.store.get(systemRunsConsentKey(w.company)))!, enabled: false } });
    expect((await w.h.deps.access.checkStep(step)).allowed).toBe(false);
    await w.h.store.put({ item: { ...(await w.h.store.get(systemRunsConsentKey(w.company)))!, enabled: true } });
    expect((await w.h.deps.access.checkStep(step)).allowed).toBe(true);
    const row = (await w.h.store.get({ pk: `ORG#${w.company}#WIKI_BUILD#payments`, sk: "RUN" }))!;
    await w.h.store.put({ item: { ...row, unattended: false } });
    expect((await w.h.deps.access.checkStep(step)).allowed).toBe(false);
  });

  it("a repeat of the same night answers the same run and takes no second hold", async () => {
    const w = await build();
    const first = await go(w);
    const again = await go(w);
    expect(first).toMatchObject({ outcome: "started" });
    expect(again).toMatchObject({ outcome: "started", duplicate: true });
    expect((again as { taskId: string }).taskId).toBe((first as { taskId: string }).taskId);
    expect(w.admitted.filter((entry) => entry.action === "automation.run")).toHaveLength(1);
  });

  // MUTANT: the audit write is made after the start, or its failure is swallowed.
  it("an audit record that cannot be written starts nothing and gives the hold back", async () => {
    const w = await build({ audit: "fail" });
    await expect(go(w)).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(await readWikiBuildPointer(w.h.store, w.company, "payments")).toBeUndefined();
    expect(w.released).toHaveLength(1);
    expect(w.released[0]).toMatch(/^hold:automation\.run#/u);
  });

  it("the sweep settles the finished run's reservation and reads a missing task as gone (hosted task reader)", async () => {
    const w = await build();
    const answer = await go(w) as { taskId: string };
    const tasks = hostedUnattendedTasks(w.h.deps);
    expect(await tasks.read(answer.taskId)).toEqual({ waiting: false });
    expect(await tasks.read("no-such-task")).toBeUndefined();
    const settled: string[] = [];
    const service = createHostedAutomationStop({ flow: w.h.deps, companyId: w.company, admission: { enforcesCost: true, admit: async () => ({ allowed: true }), stage: async () => ({ decision: { allowed: true }, items: [] }), settle: async (id) => { settled.push(id); }, release: async () => undefined }, now: () => w.h.clock.now });
    // Nothing has ended: the open run stays open.
    expect(await service.pass({ budgetMs: 1_000 })).toMatchObject({ settled: 0, open: 1 });
    // The task ends (closed): the reservation is settled and the open record goes.
    await w.h.store.update({ key: taskKey(answer.taskId), ops: [change.set("closedAt", "2026-11-18T09:00:00.000Z")] });
    expect(await service.pass({ budgetMs: 1_000 })).toMatchObject({ settled: 1, open: 0 });
    expect(settled).toHaveLength(1);
  });
});


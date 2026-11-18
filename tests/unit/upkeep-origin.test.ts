// Lead 4 N1: the work origin `nightly` is minted ONLY for upkeep AI. The gateway holds a call whose TC-1 token says `src: "nightly"` to the project's monthly upkeep cap (Cloud L4-E contract), and nothing else may
// carry it with a model key. Three places keep that true, each pinned here with its mutant:
//   1. a PERSON's wiki build starter refuses a caller whose origin is `nightly` (createWikiBuildStarter);
//   2. the upkeep starter forces `nightly` itself and starts only as the project's OWN system owner (createUpkeepWikiStarter);
//   3. the token describer gives model access to an origin-`nightly` task only when it is a wiki build (the model-free nightly test run, or any other task marked nightly, gets none).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, UPKEEP_ORIGIN, systemOwnerIdOf, type OrgId, type Principal } from "@agentx/contracts";
import { createTaskTokenDescriber } from "../../packages/broker/src/core/model-gateway/describer.js";
import { createUpkeepWikiStarter, createWikiBuildStarter } from "../../packages/broker/src/core/wiki-build/starter.js";
import { readWikiBuildPointer, startWikiBuild, wikiBuildRequestText, type WikiBuildDeps } from "../../packages/broker/src/core/wiki-build/run.js";
import { operationKey, taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import type { TaskTokenOperation } from "../../packages/broker/src/core/model-gateway/token.js";
import { createHarness, type Harness } from "../support/task-flow-harness.js";
import { API_SHA, area, fileMap, repoEntry } from "../support/wiki-build-fixtures.js";

const company = IMPLICIT_COMPANY_ID as OrgId;
const HEAD = "b".repeat(40);

function system(project: string): Principal {
  return { companyId: company, personId: systemOwnerIdOf(company, project), displayName: `Rovara (project: ${project})`, roles: [], provider: "system" };
}

async function world() {
  const h: Harness = createHarness({ companyId: company });
  await h.registerProject();
  // The hosted access adapter lets a project's system owner start work; the default owner-only access does not (it is the install's job to say so).
  h.deps.access = { ...h.deps.access, checkStart: async () => ({ allowed: true }) } as never;
  h.deps.modelAccess = { route: async () => ({ alias: "claude-sonnet-4-5", api: "anthropic-messages", catalog: "claude-sonnet-4-5" }) };
  const cancelled: string[] = [];
  const cancel = async (request: { taskId: string }) => { cancelled.push(request.taskId); };
  const map = { ...fileMap([repoEntry("demo", [area("src", { rank: 1 })])]), project: "payments" };
  const base = (starter: WikiBuildDeps["starter"]): WikiBuildDeps => ({
    store: h.store, companyId: company, now: () => h.deps.now!().getTime(), starter, standing: async () => ({ access: "manage" }), modelAccessConfigured: true, aiKey: async () => "connected",
    fileMap: async () => map, defaultBranchHeads: async () => [{ repo: "demo", commit: HEAD }], limitSetting: async () => ({ budgetCents: 700, pageReserveCents: 50 }),
  });
  return { h, cancel, base, cancelled };
}

/** The describer's answer for the build task's own running operation. */
async function describeOf(h: Harness, taskId: string, patch: Record<string, unknown> = {}) {
  const task = (await h.store.get(taskKey(taskId)))!;
  const workspaceId = task["workspaceId"] as string;
  const workspace = (await h.store.get(workspaceKey(company, workspaceId)))!;
  const scope: TaskTokenOperation = { workspaceId, operationId: workspace["activeOperationId"] as string, fence: 1 };
  const key = operationKey(company, workspaceId, scope.operationId);
  const operation = (await h.store.get(key))!;
  await h.store.put({ item: { ...operation, kind: "task", status: "RUNNING", programStepId: "wiki", requester: { personId: "a".repeat(64), provider: "test" }, dispatch: { kind: "task", payload: {} } } });
  if (Object.keys(patch).length > 0) await h.store.put({ item: { ...task, ...patch } as typeof task });
  return createTaskTokenDescriber(h.deps).describe(scope);
}

describe("a person's starter never carries the upkeep origin", () => {
  it("refuses a caller whose origin is nightly when it is made", async () => {
    const w = await world();
    expect(() => createWikiBuildStarter({ flow: w.h.deps, caller: { ...w.h.owner, origin: "nightly" }, cancel: w.cancel })).toThrow(/not valid/u);
    expect(() => createWikiBuildStarter({ flow: w.h.deps, caller: w.h.owner, cancel: w.cancel })).not.toThrow();
  });

  it("a person's build is an app task: its token origin is app, never nightly, and it is paid by the project", async () => {
    const w = await world();
    const deps = w.base(createWikiBuildStarter({ flow: w.h.deps, caller: w.h.owner, cancel: w.cancel }));
    await startWikiBuild(deps, w.h.owner.principal.personId, "payments", { requestId: randomUUID() });
    const pointer = (await readWikiBuildPointer(w.h.store, company, "payments"))!;
    const description = await describeOf(w.h, pointer.taskId);
    expect(description).toMatchObject({ origin: "app", payer: { kind: "project", project: "payments" } });
    expect(description?.origin).not.toBe(UPKEEP_ORIGIN);
  });
});

describe("the upkeep starter: origin nightly, set here, as the project's own system owner only", () => {
  const startOnce = async (w: Awaited<ReturnType<typeof world>>, caller: Principal, project = "payments") => {
    const starter = createUpkeepWikiStarter({ flow: w.h.deps, caller: { principal: caller, origin: "app", client: "test" }, cancel: w.cancel });
    return starter.start({
      requestId: randomUUID(), project, text: wikiBuildRequestText(project), payer: { kind: "project", project }, limits: { pages: 10, budgetCents: 700, wallClockMin: 60, pageReserveCents: 50 }, pins: [{ repo: "demo", commit: HEAD }],
      pointerItemFor: () => ({ kind: "put", item: { pk: `X#${randomUUID()}`, sk: "RUN" } }), notesItemFor: () => undefined,
    });
  };

  it("starts a wiki_build task with origin nightly whatever origin the caller object carried, and its token says nightly with the project paying", async () => {
    const w = await world();
    const started = await startOnce(w, system("payments"));
    const task = (await w.h.store.get(taskKey(started.taskId)))!;
    expect(task).toMatchObject({ origin: "nightly", purpose: "wiki_build" });
    expect(await describeOf(w.h, started.taskId)).toMatchObject({ origin: "nightly", payer: { kind: "project", project: "payments" }, models: ["claude-sonnet-4-5"] });
  });

  it("refuses a person, and another project's system owner, and a made-up system id", async () => {
    const w = await world();
    await expect(startOnce(w, w.h.owner.principal)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(startOnce(w, system("other"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(startOnce(w, { ...system("payments"), personId: `sysowner_${"0".repeat(64)}` })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("still refuses another payer than the project (money)", async () => {
    const w = await world();
    const starter = createUpkeepWikiStarter({ flow: w.h.deps, caller: { principal: system("payments"), origin: "app" }, cancel: w.cancel });
    await expect(starter.start({
      requestId: randomUUID(), project: "payments", text: "x", payer: { kind: "project", project: "other" }, limits: { pages: 10, budgetCents: 700, wallClockMin: 60, pageReserveCents: 50 }, pins: [{ repo: "demo", commit: HEAD }],
      pointerItemFor: () => ({ kind: "put", item: { pk: "X#1", sk: "RUN" } }), notesItemFor: () => undefined,
    })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("the token describer: model access for origin nightly only to a wiki build", () => {
  it("a task marked nightly that is not a wiki build (the model-free nightly test run) gets no model access at all", async () => {
    const w = await world();
    const started = await w.h.flow.start(w.h.owner, { project: "payments", instructions: "Build it", requestId: randomUUID() });
    expect(await describeOf(w.h, started.task.taskId, { origin: "nightly" })).toBeUndefined();
    // The same task marked app is described as before, so the tightening is only about the nightly origin.
    expect(await describeOf(w.h, started.task.taskId, { origin: "app" })).toMatchObject({ origin: "app" });
  });

  it("a wiki build marked nightly is described with origin nightly and the project as payer", async () => {
    const w = await world();
    const started = await w.h.flow.start(w.h.owner, { project: "payments", instructions: "Build it", requestId: randomUUID() });
    expect(await describeOf(w.h, started.task.taskId, { origin: "nightly", purpose: "wiki_build" })).toMatchObject({ origin: "nightly", payer: { kind: "project", project: "payments" } });
  });
});

void API_SHA;

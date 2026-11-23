// Lead 4 Opus review of the stale-pin lane (b2a314c8c): the one automatic new snapshot carries the money of the run it replaces, checks the cap, never retries a nightly run,
// and plans the same pages the person asked for.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PREPARE_PIN_MOVED_MARKER, WORKER_INVOCATION_FEATURES, type OrgId } from "@agentx/contracts";
import { createWikiBuildStarter } from "../../packages/broker/src/core/wiki-build/starter.js";
import { readWikiBuildPointer, resnapshotWikiBuild, startWikiBuild, type WikiBuildDeps } from "../../packages/broker/src/core/wiki-build/run.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { locateWorkspace } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { createHarness, type Harness } from "../support/task-flow-harness.js";
import { area, fileMap, repoEntry } from "../support/wiki-build-fixtures.js";

const companyId = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const HEAD = "b".repeat(40);
const MOVED = "c".repeat(40);
const movedError = `the commit the control plane pinned for demo ${PREPARE_PIN_MOVED_MARKER} (main); start again to pin the current head`;
const RUN_KEY = { pk: `ORG#${companyId}#WIKI_BUILD#payments`, sk: "RUN" };

interface Built { h: Harness; deps: WikiBuildDeps }
function build(): Built {
  const h = createHarness({ companyId, machines: { startingChecks: 0, features: [...WORKER_INVOCATION_FEATURES] } });
  const chips = [{ id: "skip-gen", kind: "skip_generated" as const, repo: "demo", path: "gen", label: "Skip? demo/gen", defaultOn: true }];
  const map = { ...fileMap([repoEntry("demo", [area("src", { rank: 1 }), area("gen", { rank: 2 })])], chips), project: "payments" };
  let heads = HEAD;
  const deps: WikiBuildDeps = {
    store: h.store, companyId, now: () => h.deps.now!().getTime(), starter: createWikiBuildStarter({ flow: h.deps, caller: h.owner, cancel: async () => undefined }),
    standing: async () => ({ access: "manage" }), modelAccessConfigured: true, aiKey: async () => "connected",
    fileMap: async () => map, defaultBranchHeads: async () => [{ repo: "demo", commit: heads }], limitSetting: async () => ({ budgetCents: 700, pageReserveCents: 50 }),
  };
  h.deps.wikiBuildResnapshot = ({ project, taskId }) => { heads = MOVED; return resnapshotWikiBuild(deps, project, taskId); };
  return { h, deps };
}
async function start(b: Built, body: Record<string, unknown> = {}) {
  await b.h.registerProject();
  await startWikiBuild(b.deps, b.h.owner.principal.personId, "payments", { requestId: randomUUID(), ...body });
  const pointer = (await readWikiBuildPointer(b.h.store, companyId, "payments"))!;
  return { pointer, workspaceId: (await b.h.store.get(taskKey(pointer.taskId)))!["workspaceId"] as string };
}
async function failPreparation(b: Built, workspaceId: string) {
  expect(await b.h.flow.dispatchOnce()).toMatchObject({ delivered: 1 });
  const machine = ((await locateWorkspace(b.h.deps, workspaceId))!.workspace["machine"] as { machineId: string }).machineId;
  const [prepare] = b.h.machines.delivered(machine);
  await b.h.flow.recordResult({ workspaceId, operationId: prepare!.operationId, fence: prepare!.fence, status: "FAILED", error: movedError });
}
const setOnRun = async (b: Built, path: string, value: unknown) => { await b.h.store.update({ key: RUN_KEY, ops: [{ op: "set", path: [path], value }] } as never); };

describe("review: the automatic new snapshot and money", () => {
  // MUTANT spend: the retry starts its spend at zero, so a run that already spent part of its cap gets the whole cap again.
  it("carries what the earlier runs spent into the retry", async () => {
    const b = build();
    const run = await start(b);
    await setOnRun(b, "spentEarlierCents", 300);
    await failPreparation(b, run.workspaceId);
    const next = (await readWikiBuildPointer(b.h.store, companyId, "payments"))!;
    expect(next).toMatchObject({ resnapshotOf: run.pointer.taskId, spentEarlierCents: 300 });
  });
  // MUTANT cap: the retry starts with no room under the cap for one more page.
  it("starts no retry when the cap has no room for one more page; the run stays ended code_moved", async () => {
    const b = build();
    const run = await start(b);
    await setOnRun(b, "spentEarlierCents", 680);
    await failPreparation(b, run.workspaceId);
    const last = (await readWikiBuildPointer(b.h.store, companyId, "payments"))!;
    expect(last.taskId).toBe(run.pointer.taskId);
    expect(last.end).toMatchObject({ word: "code_moved" });
  });
  // MUTANT nightly: a nightly refresh is retried by the hook (its own night re-maps; an unattended retry would spend outside the night's admission).
  it("never retries a nightly (unattended) run", async () => {
    const b = build();
    const run = await start(b);
    await setOnRun(b, "unattended", true);
    await failPreparation(b, run.workspaceId);
    const last = (await readWikiBuildPointer(b.h.store, companyId, "payments"))!;
    expect(last.taskId).toBe(run.pointer.taskId);
    expect(last.end).toMatchObject({ word: "code_moved" });
  });
});

describe("review: the retry plans what the person asked for", () => {
  // FINDING: an untouched first build is planned again with chipsOn undefined (the map's defaults), so the person's chip choices on Build are lost.
  it("a first build whose person turned a default chip off is retried with the same pages", async () => {
    const b = build();
    const run = await start(b, { chipsOn: [] });
    expect(run.pointer.plan.some((page) => page.path === "gen")).toBe(true);
    await failPreparation(b, run.workspaceId);
    const next = (await readWikiBuildPointer(b.h.store, companyId, "payments"))!;
    expect(next.resnapshotOf).toBe(run.pointer.taskId);
    expect(next.plan.map((page) => page.id)).toEqual(run.pointer.plan.map((page) => page.id));
  });
});

// The one automatic new snapshot of a wiki build whose pinned commit is gone from the default branch, wired as the hosted core wires it: the person's LIVE standing gates it, the new map is made ONCE (the plan and the pins
// come from the same snapshot), and a company's task of another company starts nothing.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { PREPARE_PIN_MOVED_MARKER, WORKER_INVOCATION_FEATURES, type OrgId } from "@agentx/contracts";
import { hostedWikiResnapshot } from "../../packages/broker/src/aws/wiki-resnapshot.js";
import type { FileMapHost } from "../../packages/broker/src/core/wiki/file-map.js";
import { createWikiBuildStarter } from "../../packages/broker/src/core/wiki-build/starter.js";
import { continueWikiBuild, readWikiBuildPointer, resnapshotWikiBuild, startWikiBuild, type WikiBuildDeps } from "../../packages/broker/src/core/wiki-build/run.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { locateWorkspace } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import type { SetupRunStanding } from "../../packages/broker/src/core-host/setup-run-routes.js";
import { createHarness, type Harness } from "../support/task-flow-harness.js";
import { area, fileMap, repoEntry } from "../support/wiki-build-fixtures.js";

const companyId = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const HEAD = "b".repeat(40);
const MOVED = "c".repeat(40);
const movedError = `the commit the control plane pinned for demo ${PREPARE_PIN_MOVED_MARKER} (main); start again to pin the current head`;

function world() {
  const h: Harness = createHarness({ companyId, machines: { startingChecks: 0, features: [...WORKER_INVOCATION_FEATURES] } });
  const map = { ...fileMap([repoEntry("demo", [area("src", { rank: 1 })])]), project: "payments" };
  const deps: WikiBuildDeps = {
    store: h.store, companyId, now: () => h.deps.now!().getTime(), starter: createWikiBuildStarter({ flow: h.deps, caller: h.owner, cancel: async () => undefined }),
    standing: async () => ({ access: "manage" }), modelAccessConfigured: true, aiKey: async () => "connected",
    fileMap: async () => map, defaultBranchHeads: async () => [{ repo: "demo", commit: HEAD }], limitSetting: async () => ({ budgetCents: 700, pageReserveCents: 50 }),
  };
  return { h, deps };
}
async function startAndFail(w: ReturnType<typeof world>) {
  await w.h.registerProject();
  await startWikiBuild(w.deps, w.h.owner.principal.personId, "payments", { requestId: randomUUID() });
  const first = (await readWikiBuildPointer(w.h.store, companyId, "payments"))!;
  const workspaceId = (await w.h.store.get(taskKey(first.taskId)))!["workspaceId"] as string;
  expect(await w.h.flow.dispatchOnce()).toMatchObject({ delivered: 1 });
  const machine = ((await locateWorkspace(w.h.deps, workspaceId))!.workspace["machine"] as { machineId: string }).machineId;
  const [prepare] = w.h.machines.delivered(machine);
  await w.h.flow.recordResult({ workspaceId, operationId: prepare!.operationId, fence: prepare!.fence, status: "FAILED", error: movedError });
  return { first, last: (await readWikiBuildPointer(w.h.store, companyId, "payments"))! };
}

describe("hosted: the automatic new snapshot", () => {
  const hostWith = (heads: ReturnType<typeof vi.fn>): FileMapHost => ({ baseBranchHead: heads as never, repositoryTree: async () => ({ entries: [{ path: "src/a.ts", kind: "file" }], complete: true }) });
  const hooked = (w: ReturnType<typeof world>, standing: (personId: string) => Promise<SetupRunStanding>, host: FileMapHost) => {
    w.h.deps.wikiBuildResnapshot = hostedWikiResnapshot({ flow: w.h.deps, companyId, now: () => w.h.deps.now!().getTime(), map: { standing: async () => ({ access: "none" }), hostFor: () => host }, standing: async (personId) => standing(personId), modelAccessConfigured: () => true });
  };

  // MUTANT once: the hook forces a new map for the plan and again for the pins, so every repository is read twice and a push between the two splits plan from pins.
  it("makes ONE new file map per retry and pins what it read, for the person who started the run (live standing: manage)", async () => {
    const w = world();
    const heads = vi.fn(async () => MOVED);
    hooked(w, async () => ({ access: "manage", basis: "company-owner" }), hostWith(heads));
    const { first, last } = await startAndFail(w);
    expect(last.taskId).not.toBe(first.taskId);
    expect(last).toMatchObject({ resnapshotOf: first.taskId, pins: [{ repo: "demo", commit: MOVED }] });
    expect(heads).toHaveBeenCalledTimes(1);
  });

  // MUTANT gate: the retry starts although the person no longer manages the project (a start the Build button would refuse).
  it.each([
    ["no longer manages the project", async () => ({ access: "view" as const })],
    ["has no standing", async () => ({ access: "none" as const })],
    ["is a manager by an unknown basis", async () => ({ access: "manage", basis: "someone" } as unknown as SetupRunStanding)],
    ["cannot be read", async (): Promise<SetupRunStanding> => { throw new Error("down"); }],
  ])("starts nothing when the person %s: the run stays ended code_moved", async (_name, standing) => {
    const w = world();
    const heads = vi.fn(async () => MOVED);
    hooked(w, standing, hostWith(heads));
    const { first, last } = await startAndFail(w);
    expect(last.taskId).toBe(first.taskId);
    expect(last.end).toMatchObject({ word: "code_moved" });
    expect(heads).not.toHaveBeenCalled();
  });

  // MUTANT company: a task row that says another company is retried by this company's hook (the row is read by id; its own company must still be this one).
  it("starts nothing for a task row that is not this company's", async () => {
    const w = world();
    const heads = vi.fn(async () => MOVED);
    hooked(w, async () => ({ access: "manage", basis: "company-owner" }), hostWith(heads));
    const inner = w.h.deps.wikiBuildResnapshot!;
    w.h.deps.wikiBuildResnapshot = async (run) => {
      await w.h.store.update({ key: taskKey(run.taskId), ops: [{ op: "set", path: ["companyId"], value: "org_cccccccccccccccccccc" }] } as never);
      return inner(run);
    };
    const { first, last } = await startAndFail(w);
    expect(last.taskId).toBe(first.taskId);
    expect(heads).not.toHaveBeenCalled();
  });
});

describe("the chips the person chose survive a new snapshot", () => {
  // MUTANT chain: a run started by the retry forgets the person's chips, so Continue after a second rewrite plans the map's defaults.
  it("Continue after the retry's own preparation also failed plans the same pages as the first Build", async () => {
    const w = world();
    const chips = [{ id: "skip-gen", kind: "skip_generated" as const, repo: "demo", path: "gen", label: "Skip? demo/gen", defaultOn: true }];
    const map = { ...fileMap([repoEntry("demo", [area("src", { rank: 1 }), area("gen", { rank: 2 })])], chips), project: "payments" };
    w.deps.fileMap = async () => map;
    w.h.deps.wikiBuildResnapshot = ({ project, taskId }) => resnapshotWikiBuild(w.deps, project, taskId);
    await w.h.registerProject();
    await startWikiBuild(w.deps, w.h.owner.principal.personId, "payments", { requestId: randomUUID(), chipsOn: [] });
    const first = (await readWikiBuildPointer(w.h.store, companyId, "payments"))!;
    const failOne = async () => {
      const pointer = (await readWikiBuildPointer(w.h.store, companyId, "payments"))!;
      const workspaceId = (await w.h.store.get(taskKey(pointer.taskId)))!["workspaceId"] as string;
      expect(await w.h.flow.dispatchOnce()).toMatchObject({ delivered: 1 });
      const machine = ((await locateWorkspace(w.h.deps, workspaceId))!.workspace["machine"] as { machineId: string }).machineId;
      const [prepare] = w.h.machines.delivered(machine);
      await w.h.flow.recordResult({ workspaceId, operationId: prepare!.operationId, fence: prepare!.fence, status: "FAILED", error: movedError });
    };
    await failOne();
    const retry = (await readWikiBuildPointer(w.h.store, companyId, "payments"))!;
    expect(retry.resnapshotOf).toBe(first.taskId);
    expect(retry.chipsOn).toEqual([]);
    await failOne();
    expect((await readWikiBuildPointer(w.h.store, companyId, "payments"))!.end).toMatchObject({ word: "code_moved" });
    await continueWikiBuild(w.deps, w.h.owner.principal.personId, "payments", { requestId: randomUUID() });
    const next = (await readWikiBuildPointer(w.h.store, companyId, "payments"))!;
    expect(next.plan.map((page) => page.id)).toEqual(first.plan.map((page) => page.id));
    expect(next.chipsOn).toEqual([]);
  });
});

describe("the retry is wired where the engines are built", () => {
  // MUTANT wiring: the hook is not installed on the hosted runtime, so a rewrite ends plain code_moved there. (The engines need a whole deployment to boot; the assignment is pinned here.)
  it.each([["hosted", "../../packages/broker/src/aws/core-engine-root.ts", /flow\.deps\.wikiBuildResnapshot = hostedWikiResnapshot\(/u]])("%s", (_name, file, pattern) => {
    expect(readFileSync(new URL(file, import.meta.url), "utf8")).toMatch(pattern);
  });
});

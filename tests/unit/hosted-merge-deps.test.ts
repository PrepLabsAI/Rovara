// Owner DEC 254zzz104: the merge core's seams for one company's runtime on the hosted install (aws/hosted-merge-deps.ts). Every seam answers for THIS company only, readiness needs PASSED checks, the base
// branch is Rovara's own record, and an install without a CI mode reader builds nothing (the route then says merging is not set up).
import { describe, expect, it } from "vitest";
import { DEFAULT_CODE_SETTINGS, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { hostedMergeDependencies, HOSTED_MERGE_SETTINGS_REFUSED } from "../../packages/broker/src/aws/hosted-merge-deps.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { recoveryRowKey } from "../../packages/broker/src/core/merge/store.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId, B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const TASK = "11111111-2222-4333-8444-555555555555";

function build(options: { ciMode?: false; policyHook?: boolean; mergeWait?: (task: unknown) => string | undefined; audit?: unknown } = {}) {
  const store = new MemoryDocumentStore();
  const settingsAsked: string[] = [];
  const projectsAsked: string[] = [];
  const registry = { require: (point: string) => ({ point, capabilities: {} }), get: () => undefined, names: () => [] } as never;
  const runtime = {
    companyId: A, services: {},
    flow: { deps: { store, companyId: A, audit: { stage: () => [], record: async () => undefined }, projects: { revision: async (project: string) => { projectsAsked.push(project); return undefined; } }, ...(options.mergeWait === undefined ? {} : { secondReview: { mergeWait: options.mergeWait } }) } },
    ...(options.ciMode === false ? {} : { ciReporting: { honest: true, ciMode: async () => "their_ci_fix" } }),
  } as never;
  const deps = () => hostedMergeDependencies({ runtime, registry, settings: { read: async (orgId: OrgId, project: string) => { settingsAsked.push(`${orgId}/${project}`); return { ...DEFAULT_CODE_SETTINGS, mergeMethod: "merge" }; } }, defaults: DEFAULT_CODE_SETTINGS, now: () => 1_000, policyHook: options.policyHook === true, ...(options.audit === undefined ? {} : { audit: options.audit as never }) });
  return { store, deps, settingsAsked, projectsAsked };
}

describe("hosted merge dependencies", () => {
  it("needs passed checks and keeps every seam to its own company", async () => {
    const { store, deps, settingsAsked, projectsAsked } = build();
    const d = deps();
    expect(d.requirePassingCi).toBe(true);
    expect(await d.host.repository("web", 1, "app", B)).toBeUndefined();
    // Another company's repository is never even looked up in this company's projects.
    expect(projectsAsked).toEqual([]);
    expect(await d.host.repository("web", 1, "app", A)).toBeUndefined();
    expect(projectsAsked).toEqual(["web"]);
    await expect(d.settings.read(B, "web")).rejects.toThrow(HOSTED_MERGE_SETTINGS_REFUSED);
    expect((await d.settings.read(A, "web")).mergeMethod).toBe("merge");
    expect(settingsAsked).toEqual([`${A}/web`]);
    expect(d.host.scope(A)).toEqual({ orgId: A });
    await store.put({ item: { ...taskKey(TASK), taskId: TASK, companyId: B, project: "web", startingRevision: 1, workspaceId: "ws", ownerKey: "o", developerId: "d" } });
    expect(await d.host.loadTask(TASK)).toBeUndefined();
    await store.put({ item: { ...taskKey(TASK), taskId: TASK, companyId: A, project: "web", startingRevision: 1, workspaceId: "ws", ownerKey: "o", developerId: "d" } });
    expect(await d.host.loadTask(TASK)).toMatchObject({ taskId: TASK, orgId: A });
  });

  it("a branch the host needs up to date makes the task's tracking row due now", async () => {
    const { store, deps } = build();
    await store.put({ item: { ...recoveryRowKey(TASK), kind: "tracking", taskId: TASK, nextAttemptAt: 99_999, quiet: 3 } });
    await deps().host.requireSyncForMerge!({ taskId: TASK } as never);
    expect(await store.get(recoveryRowKey(TASK))).toMatchObject({ nextAttemptAt: 1_000, quiet: 0 });
  });

  it("builds nothing while the install has a company rules service (it is asked only at an approver's verdict)", () => {
    expect(() => build({ policyHook: true }).deps()).toThrow();
  });

  it("the second review's wait reads the task's own opinion and acknowledgements, and the merge order seam is wired", async () => {
    const seen: unknown[] = [];
    const { store, deps } = build({ mergeWait: (task) => { seen.push(task); return "wait"; } });
    await store.put({ item: { ...taskKey(TASK), taskId: TASK, companyId: A, project: "web", startingRevision: 1, workspaceId: "ws", ownerKey: "o", developerId: "d", secondOpinion: { status: "did_not_run" }, secondReviewAcknowledged: ["k"] } });
    const d = deps();
    const task = await d.host.loadTask(TASK);
    expect(d.mergeWait!(task!)).toBe("wait");
    expect(seen[0]).toMatchObject({ secondOpinion: { status: "did_not_run" }, secondReviewAcknowledged: ["k"] });
    expect(typeof d.repositoryEdges).toBe("function");
  });

  it("builds nothing without the runtime's CI mode reader", () => {
    expect(() => build({ ciMode: false }).deps()).toThrow();
  });
});

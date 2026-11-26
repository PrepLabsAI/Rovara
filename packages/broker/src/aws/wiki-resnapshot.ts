// A hosted wiki build whose preparation found the commit it was pinned to gone from the default branch (a rewrite, a force-push) is started again ONCE over a new snapshot, with no person asked (core/wiki-build `resnapshotWikiBuild`).
// This is the broker's wiring of that hook (`TaskFlowDeps.wikiBuildResnapshot`): the task's own person starts the new run, with the SAME live access rule as the Build button (a person who no longer manages the project starts nothing),
// a new file map from the company's own code host (the kept map is bypassed), and the same wiki build starter. The dispatcher has no code host and wires nothing: there the run stays ended `code_moved` and the next Build pins again.
import type { OrgId, WikiFileMap } from "@agentx/contracts";
import { cancelTask } from "../core/task-flow/cancel.js";
import type { TaskFlowDeps, TaskStartCaller } from "../core/task-flow/deps.js";
import { readTask } from "../core/task-flow/reads.js";
import type { FileMapRepository } from "../core/wiki/file-map.js";
import { createWikiStore } from "../core/wiki/store.js";
import { resnapshotWikiBuild, type WikiBuildDeps } from "../core/wiki-build/run.js";
import { createWikiBuildStarter } from "../core/wiki-build/starter.js";
import { ensureCoreInUse } from "../core-host/core-task-mark.js";
import type { SetupRunStanding } from "../core-host/setup-run-routes.js";
import { hostOf, wikiMapServiceOf, type HostedWikiMapWiring } from "../core-host/wiki-map-routes.js";

export interface HostedWikiResnapshotInputs {
  flow: TaskFlowDeps;
  companyId: OrgId;
  now: () => number;
  /** The file map's wiring (the company's own code host); the kept map service is its own. */
  map: HostedWikiMapWiring;
  /** The person's live standing on the project (the Build button's rule). */
  standing: (personId: string, companyId: OrgId, project: string) => Promise<SetupRunStanding>;
  modelAccessConfigured: () => boolean;
}

const manages = (standing: SetupRunStanding): boolean =>
  standing?.access === "manage" && (standing.basis === "company-owner" || standing.basis === "company-admin" || standing.basis === "project-admin");

export function hostedWikiResnapshot(inputs: HostedWikiResnapshotInputs): NonNullable<TaskFlowDeps["wikiBuildResnapshot"]> {
  const { flow, companyId } = inputs;
  return async ({ project, taskId }) => {
    const task = await readTask(flow, taskId);
    const latest = await flow.projects.latest(project);
    if (task === undefined || latest === undefined || task.companyId !== companyId) return undefined;
    const personId = task.developerId;
    const live = async (): Promise<boolean> => { try { return manages(await inputs.standing(personId, companyId, project)); } catch { return false; } };
    if (!(await live())) return undefined;
    const repositories = latest.definition.repositories;
    const caller: TaskStartCaller = { principal: { companyId, personId, displayName: task.developerName, roles: ["member"], provider: task.provider }, client: task.client, origin: "app" };
    const flowForStart: TaskFlowDeps = { ...flow, access: { ...flow.access, async checkStart(principal) { return principal.companyId === companyId && await live() ? { allowed: true } : { allowed: false, code: "FORBIDDEN", message: "not allowed" }; } } };
    const base = createWikiBuildStarter({ flow: flowForStart, caller, cancel: async (request) => { await cancelTask(flow, request.taskId); } });
    const service = wikiMapServiceOf(inputs.map, inputs.now, undefined);
    const wiki = createWikiStore({ store: flow.store, companyId, now: inputs.now });
    // ONE forced map per retry: the plan and the pins are read from the SAME snapshot (a second forced map would read every repository again, and a push between the two would split them).
    let made: Promise<WikiFileMap> | undefined;
    const readMap: WikiBuildDeps["fileMap"] = async (name) => {
      const targets: FileMapRepository[] = repositories.map((repository) => ({ name: repository.name, url: repository.url, defaultBranch: repository.defaultBranch, host: hostOf(inputs.map, repository) }));
      made ??= service.make(companyId, name, targets, { orgId: companyId }, { force: true });
      return await made;
    };
    const deps: WikiBuildDeps = {
      store: flow.store, companyId, now: inputs.now,
      starter: { start: async (request) => { await ensureCoreInUse(flow.store, companyId); return await base.start(request); }, cancel: (request) => base.cancel(request) },
      standing: async () => ((await live()) ? { access: "manage" } : { access: "none" }),
      modelAccessConfigured: inputs.modelAccessConfigured(), aiKey: async () => "unknown",
      fileMap: readMap,
      // The commits a build pins are the ones the map was read at, so the plan and the pins describe the same tree.
      defaultBranchHeads: async (name) => (await readMap(name))?.repositories.flatMap((repository) => (repository.status === "unavailable" || repository.commit === undefined ? [] : [{ repo: repository.name, commit: repository.commit }])) ?? [],
      async requireNewWork(name) {
        const found = await flow.projects.latest(name);
        if (found?.archived === true) throw new Error("archived");
      },
      recordBuild: (record) => wiki.writeBuild(project, record),
    };
    return await resnapshotWikiBuild(deps, project, taskId);
  };
}

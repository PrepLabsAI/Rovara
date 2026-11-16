// The after-merge watcher on a laptop (M7 slice 2): the same service as the deployed engine's, over this install's store, registry and one company. Off by default: it does nothing for a project until that project's own
// `afterMergeWatch` setting says on, and it starts no paid work and never opens a revert (a person's press does, and its routes are not wired here yet). A laptop has no public address, so nothing is pushed in: the periodic pass
// closes windows that ended and sends again what could not be sent; deployment and alarm events, and the deploy read for a merge, join in when a source of them is wired (`afterMerge.codeHostEvent`, `.triggerEvent`).
import type { AdapterRegistry, OrgId } from "@agentx/contracts";
import { createAfterMergeReporter } from "../../core/after-merge/reporter.js";
import { createAfterMergeService, type AfterMergeService } from "../../core/after-merge/service.js";
import { createProjectAfterMergeSettings, createStoreAfterMergeTasks, createTaskHosts } from "../../core/after-merge/host-seams.js";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";
import type { DeploymentTarget } from "../../core/after-merge/deploy-source.js";

export interface LocalAfterMergeOptions {
  flow: Pick<TaskFlowDeps, "store" | "projects">;
  registry: AdapterRegistry;
  companyId: OrgId;
  now: () => number;
  /** The recent merges to ask the code host about (a host that can name them). Absent: no deploy read. */
  recentMerges?: () => Promise<readonly DeploymentTarget[]>;
  log: (entry: Record<string, unknown>) => void;
}

export function createLocalAfterMerge(options: LocalAfterMergeOptions): AfterMergeService {
  const { store } = options.flow;
  const hosts = createTaskHosts({ store, registry: options.registry, projectsOf: () => options.flow.projects });
  const log = (event: string, fields: Record<string, unknown>): void => options.log({ component: "after_merge", event, ...fields });
  return createAfterMergeService({
    companyId: options.companyId,
    deps: {
      store, audit: options.registry.require("audit-sink"), tasks: createStoreAfterMergeTasks(store),
      settings: createProjectAfterMergeSettings(store, () => options.flow.projects),
      reporter: createAfterMergeReporter({ store, hosts, registry: options.registry, now: options.now, log }),
      now: () => new Date(options.now()), log,
    },
    hosts,
    ...(options.recentMerges === undefined ? {} : { recentMerges: options.recentMerges }),
  });
}

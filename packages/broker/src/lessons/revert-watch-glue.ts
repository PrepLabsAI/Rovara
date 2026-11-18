// Lane L4-LM1b: the revert watch (`core/proof/revert/revert-watch.ts`) joined to ONE company's lessons host, the same way for a deployed install (`core-host/lessons.ts`, inside the lessons pass) and a laptop
// (`local/app/lessons.ts`, its own timer). The hosts are the ones the company's own tasks' pinned projects name (`createTaskHosts`, the after-merge watcher's binding: a task of another company reads as absent).
import type { AdapterRegistry, DocumentStore, OrgId, RegistryView } from "@agentx/contracts";
import { createTaskHosts } from "../core/after-merge/host-seams.js";
import type { ProjectSource } from "../core/task-flow/deps.js";
import { createRevertWatch, type RevertWatch } from "../core/proof/revert/revert-watch.js";
import type { LessonsHost } from "./host-glue.js";

export interface LessonsRevertWatchOptions {
  store: DocumentStore;
  registry: AdapterRegistry | RegistryView;
  companyId: OrgId;
  /** The lessons host of the same company: told of each newly recorded revert. */
  host: Pick<LessonsHost, "noteReverted">;
  projectsOf?: ((orgId: OrgId) => ProjectSource) | undefined;
  now: () => number;
  log: (event: string, fields?: Record<string, unknown>) => void;
}

export function createLessonsRevertWatch(options: LessonsRevertWatchOptions): RevertWatch {
  const hosts = createTaskHosts({ store: options.store, registry: options.registry as RegistryView, ...(options.projectsOf === undefined ? {} : { projectsOf: options.projectsOf }) });
  return createRevertWatch({
    companyId: options.companyId, store: options.store, hosts, now: options.now, log: (event, fields) => options.log(event, fields),
    onReverted: async ({ finding, files }) => { await options.host.noteReverted(finding.taskId, { via: finding.via, files }); },
  });
}

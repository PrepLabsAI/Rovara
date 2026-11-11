// The meta repository's head, read through the code host the repository's record names (the `CodeHost` port), for `metaPrepareFor`. The commit it gives is the one a task's worker materializes and
// every stage reads: it is pinned when the task starts and never taken from the worker.
import type { OrgId, RegistryView, StoredProjectDefinition } from "@agentx/contracts";
import { metaRepositoryOf } from "@agentx/contracts";
import { codeHostForRecord } from "../../plugins/routing.js";
import type { MetaHeadReader } from "./prepare-meta.js";

/** `undefined` when the install has no code host at all (the caller then refuses the task: a meta repo that cannot be read is never skipped). */
export function codeHostMetaHeadReader(codeHosts: RegistryView | undefined, definition: Pick<StoredProjectDefinition, "repositories">): MetaHeadReader | undefined {
  if (codeHosts === undefined) return undefined;
  const meta = metaRepositoryOf(definition);
  if (meta === undefined) return undefined;
  return {
    async getHead(input: { orgId: OrgId | undefined; repositoryUrl: string; branch: string }): Promise<string> {
      const host = codeHostForRecord(codeHosts, meta);
      return host.baseBranchHead({ url: input.repositoryUrl }, input.branch, input.orgId === undefined ? { system: "install" } : { orgId: input.orgId });
    },
  };
}

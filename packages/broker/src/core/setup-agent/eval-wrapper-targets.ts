// The project's repositories as targets for the eval wrapper (DEC 254zzz43: this replaces the lessons file's `createLessonRepositories(...).targets`, which is deleted with the repo lessons file, DEC 254zzz14). Each target is the
// repository's PLACE (`<host kind>:repo/<the host's own repository id>`), the code host that serves it and the scope to call it in (`{ orgId: company }`). The id is the host's immutable one, asked of the host
// (`repositoryIdentity`), never the project's name for it, so a rename or a repository another project calls the same cannot stand in for it. A host that cannot say leaves the repository out. No new connection: it is the
// code host the company already has (the same `codeHostForRecord` the eval card's file reads use), from the project's latest definition. An answer is kept for a few minutes.
import { codeRepositoriesOf, type HostScope, type OrgId, type RegistryView, type RepositoryRef } from "@agentx/contracts";
import { codeHostForRecord, providerOf } from "../../plugins/routing.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import type { EvalWrapperTarget } from "./eval-wrapper-host.js";

const KEEP_MS = 5 * 60_000;

export function createEvalWrapperTargets(input: { flow: Pick<TaskFlowDeps, "projects">; registry: RegistryView; companyId: OrgId; now: () => number }): (project: string) => Promise<EvalWrapperTarget[]> {
  const scope: HostScope = { orgId: input.companyId };
  const kept = new Map<string, { at: number; value: EvalWrapperTarget | undefined }>();

  async function place(project: string, entry: { name: string; url: string; host?: { kind: string } | undefined }): Promise<EvalWrapperTarget | undefined> {
    const key = `${project}\u0000${entry.name}\u0000${entry.url}`;
    const known = kept.get(key);
    if (known !== undefined && input.now() - known.at < KEEP_MS) return known.value;
    let value: EvalWrapperTarget | undefined;
    try {
      const host = codeHostForRecord(input.registry, entry.host === undefined ? {} : { host: { kind: entry.host.kind } });
      const repository: RepositoryRef = { url: entry.url };
      const identity = await host.repositoryIdentity(repository, scope);
      if (identity !== undefined && /^[A-Za-z0-9_.-]{1,100}$/u.test(identity.id)) value = { name: entry.name, place: `${providerOf(host)}:repo/${identity.id}`, repository, scope, host };
    } catch { value = undefined; }
    // A failure is not remembered for long: the next ask looks again.
    kept.set(key, { at: value === undefined ? input.now() - KEEP_MS + 30_000 : input.now(), value });
    return value;
  }

  return async (project) => {
    const latest = await input.flow.projects.latest(project);
    if (latest === undefined) throw new Error("the project cannot be read");
    const targets: EvalWrapperTarget[] = [];
    for (const entry of codeRepositoriesOf(latest.definition)) {
      const target = await place(project, entry);
      if (target !== undefined) targets.push(target);
    }
    return targets;
  };
}

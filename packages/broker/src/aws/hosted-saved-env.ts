// The saved-image rules over the hosted runtime's company-scoped adapters.
import { HostedSavedEnvRegistryAuthSchema, type AdapterRegistry, type CodeHost } from "@agentx/contracts";
import type { TaskFlowDeps } from "../core/task-flow/deps.js";
import { createSavedEnvCleanupDeps } from "../core/test-env/saved-env-real.js";
import { headOf } from "../core/setup-agent/snapshot.js";
import { codeHostForRepositoryAddress } from "../plugins/routing.js";

export function hostedSavedEnvDeps(input: { registry: AdapterRegistry; flow: TaskFlowDeps; companyId: string; env: NodeJS.ProcessEnv; now: () => number }) {
  if (input.registry.names("image-registry").length === 0) return undefined;
  const { registry, flow, companyId, env, now } = input;
  const host = async (project: string, url: string): Promise<CodeHost> => {
    const found = await flow.projects.latest(project);
    if (found === undefined) throw new Error("saved environment project is unavailable");
    return codeHostForRepositoryAddress(registry, url, found.definition.repositories);
  };
  // Key reads are held to the project's registered connection, never a fallback
  // guessed from the URL. A cut tree or missing object id yields no key.
  const saved = createSavedEnvCleanupDeps({
    test: { store: registry.require("storage"), audit: registry.require("audit-sink"), now, env },
    flow, registry: registry.require("image-registry"), adapters: registry,
    env,
    envName: env["AGENTX_ENV"] ?? "",
    baseImageDigest: async () => /@(sha256:[a-f0-9]{64})$/u.exec(env["AGENTX_SANDBOX_IMAGE"] ?? "")?.[1],
    keyHost: (company, project) => {
      if (company !== companyId) throw new Error("saved environment company is unavailable");
      return {
        listTree: async (repository, commit) => {
          const code = await host(project, repository.url);
          if (code.repositoryTree === undefined || code.setupFileVersions === undefined) return undefined;
          const scope = { orgId: companyId };
          const tree = await code.repositoryTree({ url: repository.url }, commit, scope, { timeoutMs: 10_000 });
          if (!tree.complete) return undefined;
          const files = await code.setupFileVersions({ url: repository.url }, commit, scope, { match: () => true, max: 100_000, timeoutMs: 10_000 });
          if (!files.complete) return undefined;
          const ids = new Map(files.files.map(file => [file.path, file.id]));
          return { truncated: false, entries: tree.entries.map(entry => ({ path: entry.path, type: entry.kind === "dir" ? "tree" : entry.kind === "submodule" ? "commit" : "blob", mode: entry.kind === "dir" ? "040000" : entry.kind === "submodule" ? "160000" : entry.kind === "symlink" ? "120000" : "100644", sha: ids.get(entry.path) ?? "" })) };
        },
        readText: async (repository, commit, path) => (await host(project, repository.url)).fileAtRevision({ url: repository.url }, path, commit, { orgId: companyId }, { timeoutMs: 10_000, maxBytes: 262_144 }),
      };
    },
    headOf: async (_company, repository, project) => {
      if (_company !== companyId) throw new Error("saved environment company is unavailable");
      return headOf(await host(project, repository.url), repository, { orgId: companyId });
    },
  });
  saved.session.ports.registryAuthSchema = HostedSavedEnvRegistryAuthSchema;
  return saved;
}

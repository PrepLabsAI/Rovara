// Saved project images: the registry's real bindings, built only while the install's saved-environments switch is on. Nothing here makes a decision: the rules are in `saved-env.ts` and its siblings.
//   store            the document-store adapter (`saved-env-store.ts`), with the audit sink;
//   session          the `image-registry` port with the install's environment name; without a registry that can do something the registry's decisions say so (`registry_cannot_build`);
//   approved / proveHolds  the project's newest approved test environment (its digest is `testEnvDigest`) and the Prove report recorded for that digest;
//   defaultHeads     the head of each repository's default branch, through whatever code host the install gives (`headOf`), or undefined when any cannot be read;
//   currentKey       the environment key of the default branches AT the heads the registry read: worked out from the code host's tree listing (blob ids of the key files, `saved-env-key.ts`), the approved
//                    environment (revision, key-file globs, secret names) and the base image digest the install says. Anything missing gives undefined, and the registry then queues nothing (`no_key`): it fails closed;
//   keep / lightAfterIdleDays  the defaults (the company settings are not stored yet);
//   onQueued         starts the job the registry queued (`saved-env-triggers.ts`).
import {
  SAVED_ENV_KEEP_DEFAULT, SAVED_ENV_LIGHT_AFTER_IDLE_DAYS_DEFAULT, testEnvDigest, testEnvIsProved, workerProjectDefinition,
  type ImageRegistry, type RegistryView,
} from "@agentx/contracts";
import type { ProjectSource, TaskFlowDeps } from "../task-flow/deps.js";
import type { TestEnvDeps } from "./deps.js";
import { readApprovedTestEnvironment, readTestEnvProveReport } from "./environment.js";
import type { SavedEnvDeps } from "./saved-env.js";
import { KeyListingCache, expectedEnvironmentKey, type KeyHost } from "./saved-env-key.js";
import { savedEnvBuildInputsOf, type SavedEnvBuildInputs } from "./saved-env-rebuild.js";
import { documentSavedEnvStore } from "./saved-env-store.js";
import { savedEnvEnabled } from "./saved-env-switch.js";
import { savedEnvOnQueued } from "./saved-env-triggers.js";

/** The head of each repository's default branch, by repository name; undefined when the project has none or any head cannot be read. */
export async function savedEnvDefaultHeads(
  input: { projects: Pick<ProjectSource, "latest">; headOf(repository: { name: string; url: string; defaultBranch: string }): Promise<string> },
  project: string,
): Promise<ReadonlyMap<string, string> | undefined> {
  try {
    const found = await input.projects.latest(project);
    if (found === undefined) return undefined;
    const heads = new Map<string, string>();
    for (const repository of workerProjectDefinition(found.definition).repositories) {
      const commit = await input.headOf({ name: repository.name, url: repository.url, defaultBranch: repository.defaultBranch });
      if (!/^[a-f0-9]{40}$/u.test(commit)) return undefined;
      heads.set(repository.name, commit);
    }
    return heads;
  } catch {
    return undefined;
  }
}

export interface SavedEnvWiring {
  test: TestEnvDeps;
  flow: TaskFlowDeps;
  registry: ImageRegistry;
  /** The adapter registry, read for the `build-system` point's key-file globs. */
  adapters: Pick<RegistryView, "get" | "names">;
  /** The code host's side of the key (a tree listing and a file read at a commit). Without a listing no key is worked out. */
  keyHost(orgId: string): KeyHost;
  headOf(orgId: string, repository: { name: string; url: string; defaultBranch: string }): Promise<string>;
  /** The digest of the image the project's commands run in (the worker image), or undefined (then no key). */
  baseImageDigest(): Promise<string | undefined>;
  /** The environment name in repository names. Default `local`. */
  envName?: string;
  keep?: (orgId: string) => Promise<number>;
  lightAfterIdleDays?: (orgId: string, projectId: string) => Promise<number>;
  ownerFor?: Parameters<typeof savedEnvOnQueued>[0]["ownerFor"];
  env?: NodeJS.ProcessEnv;
  log?: (event: string, extra?: Record<string, unknown>) => void;
}

/** The registry's dependencies, or undefined when the switch is off. */
export function createSavedEnvDeps(wiring: SavedEnvWiring): SavedEnvDeps | undefined {
  const env = wiring.env ?? process.env;
  if (!savedEnvEnabled(env)) return undefined;
  const keyCache = new KeyListingCache();
  const now = (): number => wiring.test.now();
  const approved = async (orgId: string, project: string) => {
    const found = await readApprovedTestEnvironment(wiring.test, orgId, project);
    return found === undefined ? undefined : { revision: found.revision, digest: testEnvDigest(found.environment) };
  };
  const inputsOf = (orgId: string, project: string) => savedEnvBuildInputsOf({ test: wiring.test, registry: wiring.adapters, baseImageDigest: () => wiring.baseImageDigest() }, orgId, project);
  const deps: SavedEnvDeps = {
    store: documentSavedEnvStore({ store: wiring.test.store, audit: wiring.test.audit, now }),
    session: {
      config: { enabled: true, env: wiring.envName ?? "local" },
      ports: {
        registry: wiring.registry,
        readApproved: approved,
        // The report proves the APPROVED environment of exactly this digest, judged with its own dependencies (a report without the dependency steps does not prove an environment that has some); no such environment, no proof.
        proveHolds: async (orgId, project, digest) => {
          const found = await readApprovedTestEnvironment(wiring.test, orgId, project);
          if (found === undefined || testEnvDigest(found.environment) !== digest) return false;
          return testEnvIsProved(await readTestEnvProveReport(wiring.test, orgId, project, digest), digest, found.environment);
        },
        now,
      },
    },
    approved,
    currentKey: async (orgId, project, heads) => {
      if (heads === undefined) return undefined;
      const inputs = await inputsOf(orgId, project);
      if (inputs === undefined) return undefined;
      const found = await wiring.flow.projects.latest(project);
      if (found === undefined) return undefined;
      const repositories = workerProjectDefinition(found.definition).repositories.map((repository) => ({ name: repository.name, url: repository.url }));
      return expectedEnvironmentKey(wiring.keyHost(orgId), { orgId, repositories, commits: heads, detectorGlobs: inputs.detectorGlobs, testEnvRevision: inputs.revision, secretNames: inputs.secretNames, baseImageDigest: inputs.baseImageDigest }, keyCache);
    },
    defaultHeads: (orgId, project) => savedEnvDefaultHeads({ projects: wiring.flow.projects, headOf: (repository) => wiring.headOf(orgId, repository) }, project),
    keep: wiring.keep ?? (async () => SAVED_ENV_KEEP_DEFAULT),
    lightAfterIdleDays: wiring.lightAfterIdleDays ?? (async () => SAVED_ENV_LIGHT_AFTER_IDLE_DAYS_DEFAULT),
    now,
  };
  deps.onQueued = savedEnvOnQueued({
    flow: wiring.flow, saved: () => deps, test: wiring.test, env,
    inputs: async (orgId, project): Promise<SavedEnvBuildInputs | undefined> => {
      const inputs = await inputsOf(orgId, project);
      return inputs === undefined ? undefined : { baseImageDigest: inputs.baseImageDigest, secretNames: inputs.secretNames, detectorGlobs: inputs.detectorGlobs };
    },
    ...(wiring.ownerFor === undefined ? {} : { ownerFor: wiring.ownerFor }),
    ...(wiring.log === undefined ? {} : { log: wiring.log }),
  });
  return deps;
}

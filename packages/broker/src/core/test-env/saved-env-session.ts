// Saved environment images: what the broker decides before it asks the image registry for a login, and the squatting check. The registry itself is the `image-registry` port (contracts
// `ports/image-registry.ts`): Cloud's adapter mints sessions of the hosted registry on fixed-name roles, Code's local adapter runs a registry container. Nothing here knows which.
//
// Two kinds of login, each for ONE repository (the adapter refuses to give one for a repository that is not the shape `savedEnvRepositoryName` makes, and a worker never sees the registry's own credentials):
//   - push: for the build after a passing Prove of an APPROVED environment, 60 minutes (a large seed takes most of that; the worker refuses a login with under a minute left);
//   - pull: for one prepare of one task of that project, 30 minutes (the caller also pins the digest in the prepare payload).
// SQUATTING: before a push or pull login is minted, the broker asks the registry whether the repository is the one Rovara makes (`registry.inspect`): a repository someone made first, with other settings,
// answers `unusable` and is refused as `unavailable`. A repository that does not exist yet is fine for a push (the first push creates it) and is verified again by `verifyRepository` after the push, before the
// digest is recorded.
//
// What this refuses, each with its own fixed word and no value in it:
//   `disabled`      the install's switch for saved environments is off (the caller passes it; with it off nothing here reaches the registry);
//   `not_approved`  the project has no approved test environment, or the one named is not the newest approved revision, or its digest is not the one named;
//   `not_proved`    (push) the Prove report recorded for the approved digest did not pass;
//   `bad_ids`       a company or project id that is not text;
//   `unavailable`   the registry could not give a login (it is down, the repository is not the one Rovara makes, the registry cannot push or pull for a worker).
// The company and the project come from the broker's own verified operation, never from the worker's request: the worker names neither (the caller derives the repository from the operation's project).
import {
  SAVED_ENV_PULL_SESSION_SECONDS,
  SAVED_ENV_PUSH_SESSION_SECONDS,
  SavedEnvRegistryAuthSchema,
  savedEnvRepositoryName,
  type ImageRegistry,
  type SavedEnvRegistryAuth,
  type SavedEnvRegistryAuthParser,
} from "@agentx/contracts";

export interface SavedEnvSessionConfig {
  /** The install's switch for saved environments: on only when exactly "1" (`saved-env-switch.ts`). */
  enabled: boolean;
  /** The environment name in repository names (`rovara-env/<env>/...`). Code uses `local`. */
  env: string;
}

export interface SavedEnvSessionPorts {
  registry: ImageRegistry;
  /** What the adapter's login is read through. Absent: Code's own (a loopback registry is allowed); a hosted install passes `HostedSavedEnvRegistryAuthSchema`. */
  registryAuthSchema?: SavedEnvRegistryAuthParser;
  /** The newest approved test environment of the project, or undefined. Bind to `readApprovedTestEnvironment` (the digest is `testEnvDigest(environment)`). */
  readApproved(orgId: string, projectId: string): Promise<{ revision: number; digest: string } | undefined>;
  /** The Prove report recorded for that exact digest: whether it passed (`testEnvIsProved`). */
  proveHolds(orgId: string, projectId: string, digest: string): Promise<boolean>;
  now(): number;
}

export type SessionRefusal = "disabled" | "not_approved" | "not_proved" | "bad_ids" | "unavailable";
export type MintResult = { ok: true; auth: SavedEnvRegistryAuth; expiresAtMs: number } | { ok: false; reason: SessionRefusal };

export interface ApprovedPin { revision: number; digest: string }

/** The repository of a project, or undefined for an id that is not text (a name is never built from something unchecked). */
export function repositoryOf(config: SavedEnvSessionConfig, orgId: string, projectId: string): string | undefined {
  try { return savedEnvRepositoryName({ env: config.env, orgId, projectId }); } catch { return undefined; }
}

async function mint(
  ports: SavedEnvSessionPorts, access: "push" | "pull", orgId: string, repository: string, maxSeconds: number,
): Promise<MintResult> {
  try {
    const login = await ports.registry.login({ companyId: orgId, repository, access, maxSeconds });
    // The adapter's answer is read again through the contract: a login for another repository, or one that outlives the ask, is not given on.
    const parsed = (ports.registryAuthSchema ?? SavedEnvRegistryAuthSchema).safeParse(login.auth);
    if (!parsed.success || parsed.data.repository !== repository || login.expiresAtMs > ports.now() + (maxSeconds + 5) * 1000) return { ok: false, reason: "unavailable" };
    return { ok: true, auth: parsed.data, expiresAtMs: Math.min(login.expiresAtMs, Date.parse(parsed.data.expiresAt)) };
  } catch {
    // Nothing from the error is kept: a registry's own message can carry an address or a request id.
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * Whether the project's repository is the one Rovara makes. `absent` is `"absent"` (a push may go ahead: the first push creates it; verify again after the push). Any other difference, or any error, is
 * `unavailable`.
 */
export async function verifyRepository(config: SavedEnvSessionConfig, ports: SavedEnvSessionPorts, input: { orgId: string; projectId: string }): Promise<{ ok: true; state: "matches" | "absent" } | { ok: false; reason: SessionRefusal }> {
  if (!config.enabled) return { ok: false, reason: "disabled" };
  const repository = repositoryOf(config, input.orgId, input.projectId);
  if (repository === undefined) return { ok: false, reason: "bad_ids" };
  try {
    const state = await ports.registry.inspect({ companyId: input.orgId, repository });
    return state === "unusable" ? { ok: false, reason: "unavailable" } : { ok: true, state };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * A push login for the project's repository. Only when the install's setting is on, the registry can take a push from a worker, the project has an approved test environment, the caller's `approved` pin IS
 * that environment's newest revision and digest, the Prove report for that digest passed, and the repository (if it exists) is the one Rovara makes. The caller (the rebuild job) holds the pin from the job it
 * queued; if the project's approved environment moved since, the push is refused and the job is requeued.
 */
export async function mintPushSession(config: SavedEnvSessionConfig, ports: SavedEnvSessionPorts, input: { orgId: string; projectId: string; approved: ApprovedPin }): Promise<MintResult> {
  if (!config.enabled) return { ok: false, reason: "disabled" };
  const repository = repositoryOf(config, input.orgId, input.projectId);
  if (repository === undefined) return { ok: false, reason: "bad_ids" };
  if (!ports.registry.capabilities.workerPush) return { ok: false, reason: "unavailable" };
  const current = await ports.readApproved(input.orgId, input.projectId);
  if (current === undefined || current.revision !== input.approved.revision || current.digest !== input.approved.digest) return { ok: false, reason: "not_approved" };
  if (!(await ports.proveHolds(input.orgId, input.projectId, current.digest))) return { ok: false, reason: "not_proved" };
  const verified = await verifyRepository(config, ports, input);
  if (!verified.ok) return verified;
  return mint(ports, "push", input.orgId, repository, SAVED_ENV_PUSH_SESSION_SECONDS);
}

/** A pull login for the project's repository, for a task pinned to `approved`. Refused when that is no longer the project's newest approved revision (the image of another revision is not used), when the registry cannot serve a worker's pull, and when the repository is missing or is not the one Rovara makes. */
export async function mintPullSession(config: SavedEnvSessionConfig, ports: SavedEnvSessionPorts, input: { orgId: string; projectId: string; approved: ApprovedPin }): Promise<MintResult> {
  if (!config.enabled) return { ok: false, reason: "disabled" };
  const repository = repositoryOf(config, input.orgId, input.projectId);
  if (repository === undefined) return { ok: false, reason: "bad_ids" };
  if (!ports.registry.capabilities.workerPull) return { ok: false, reason: "unavailable" };
  const current = await ports.readApproved(input.orgId, input.projectId);
  if (current === undefined || current.revision !== input.approved.revision || current.digest !== input.approved.digest) return { ok: false, reason: "not_approved" };
  const verified = await verifyRepository(config, ports, input);
  if (!verified.ok || verified.state !== "matches") return { ok: false, reason: "unavailable" };
  return mint(ports, "pull", input.orgId, repository, SAVED_ENV_PULL_SESSION_SECONDS);
}

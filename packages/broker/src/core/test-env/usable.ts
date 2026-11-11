// Test environment: which approved environment a TASK may use, and how it is pinned.
//
// A task uses the project's approved environment only if EVERYTHING in it is something the task flow can carry out today. The approved environment is a project setting a maintainer approved; this is the check that
// stands between that setting and a worker, so it does not trust the approval alone (an environment approved by an earlier build, or by a path with fewer checks, is read here again):
//   - the production deny list: nothing the environment points at may be on it, and an environment that reaches a remote with no list is refused (`testEnvProdDenyViolations`, the same matcher the approval used);
//   - recordings only where the app and its data die with the round: sandbox and per-task preview (`mediaTierAllowed`), never the shared environment;
//   - sandbox only: the preview and shared tiers, services (mock or pre-prod) and test accounts are not carried out by the task flow yet (no mock is started, no pre-prod session is opened, no account is
//     provisioned), so an environment that has any is NOT applied, and the task runs the project's own checks with the evidence saying so. A task is never told it used a mock or a pre-prod it did not.
// The task pins the revision it started with: a later approval changes the NEXT task, never one that is running.
import { mediaTierAllowed, projectPk, testEnvDigest, testEnvProdDenyViolations, when, type DocumentKey, type OrgId, type TestEnvironment, type TransactItem } from "@agentx/contracts";
import { documentOf, expiryOf, type StoreOnly, type TestEnvDeps } from "./deps.js";
import { readApprovedTestEnvironment } from "./environment.js";
import { dependenciesStartableNow } from "./dependency-plan.js";
import { DEPENDENCIES_WITH_DEVCONTAINER_WORDS, projectUsesDevcontainer } from "./devcontainer-check.js";
import { testEnvironmentEnabled } from "./switch.js";
import { testServicesEnabled } from "./test-services-switch.js";

export const UNUSED_REASONS = ["none", "unreadable", "names_production", "recording_not_allowed", "services_not_connected", "accounts_not_connected", "tier_not_connected", "dependencies_not_connected", "dependencies_not_available_yet", "dependencies_with_devcontainer"] as const;
export type UnusedReason = (typeof UNUSED_REASONS)[number];

/** What a person reads when the approved environment was not used (fixed words). */
export const UNUSED_WORDS: Record<UnusedReason, string> = {
  none: "No approved test environment",
  unreadable: "The approved test environment could not be read",
  names_production: "The approved test environment points at production",
  recording_not_allowed: "The approved test environment asks for recordings where they are not allowed",
  services_not_connected: "The approved test environment calls services, which tasks do not use yet",
  accounts_not_connected: "The approved test environment uses test accounts, which tasks do not use yet",
  tier_not_connected: "The approved test environment is not a sandbox, which tasks do not use yet",
  dependencies_not_connected: "The approved test environment lists dependencies, which tasks do not start yet",
  dependencies_not_available_yet: "The approved test environment asks for a kind of backing that tasks do not start yet",
  dependencies_with_devcontainer: DEPENDENCIES_WITH_DEVCONTAINER_WORDS,
};

/** `judged` is the environment the refusal is about, so a pin names the revision that was judged and not one approved a moment later. */
export type UsableEnvironment = { ok: true; environment: TestEnvironment } | { ok: false; reason: UnusedReason; judged?: TestEnvironment };

/**
 * Whether an approved environment may be carried out by a task now, and if not, why not. Pure apart from the install switches in `env`. Dependencies (test services) are carried out only with the switch `tx` on, and
 * only real software from the catalog (`dependenciesStartableNow`); v1 `services` stay refused as before. Whether the catalog can PIN each one is asked at dispatch (`taskDependencyPlansOf`), which has the catalog.
 */
export function environmentUnusedReason(environment: TestEnvironment, env: NodeJS.ProcessEnv = process.env): UnusedReason | undefined {
  const body = environment.environment;
  if (testEnvProdDenyViolations(body).length > 0) return "names_production";
  if ((body.capture.video || body.capture.traces) && !mediaTierAllowed(body.tier)) return "recording_not_allowed";
  if (body.tier !== "sandbox" || body.preview !== undefined || body.shared !== undefined) return "tier_not_connected";
  if (body.services.length > 0) return "services_not_connected";
  if (body.accounts.length > 0) return "accounts_not_connected";
  if (body.dependencies !== undefined && body.dependencies.length > 0) {
    if (!testServicesEnabled(env)) return "dependencies_not_connected";
    if (!dependenciesStartableNow(body.dependencies)) return "dependencies_not_available_yet";
  }
  return undefined;
}

/**
 * The project's newest approved environment if a task may use it, else why not. Never throws: a store that cannot be read is `unreadable`, and the task then runs without an environment (the project's own checks).
 * With the switch off it is always `none` and reads nothing.
 */
export async function usableTestEnvironment(deps: TestEnvDeps, orgId: OrgId, project: string, revision?: number, env: NodeJS.ProcessEnv = process.env): Promise<UsableEnvironment> {
  if (!testEnvironmentEnabled(env)) return { ok: false, reason: "none" };
  let approved: TestEnvironment | undefined;
  try {
    approved = await readApprovedTestEnvironment(deps, orgId, project, revision);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (approved === undefined) return { ok: false, reason: "none" };
  const reason = environmentUnusedReason(approved, env);
  return reason === undefined ? { ok: true, environment: approved } : { ok: false, reason, judged: approved };
}

// ---- the pin

const pinKey = (orgId: OrgId, project: string, taskId: string): DocumentKey => ({ pk: projectPk(orgId, project), sk: `TESTENV#PIN#${taskId}` });
const PIN_TTL_SECONDS = 400 * 86_400;

export interface TestEnvPin { revision: number; digest: string; unused?: UnusedReason; /** The digest of a newer revision whose change the task's owner declined: the card does not come back for it. */ declined?: string }

/** The item that pins the revision a task started with, for the task's start transaction. `unused` records an environment that existed but was not applied, so the evidence can say why. */
export function testEnvPinItem(input: { orgId: OrgId; project: string; taskId: string; nowMs: number; used?: TestEnvironment; unused?: { revision: number; digest: string; reason: UnusedReason } }): TransactItem | undefined {
  const pin: TestEnvPin | undefined = input.used !== undefined ? { revision: input.used.revision, digest: testEnvDigest(input.used.environment) }
    : input.unused !== undefined ? { revision: input.unused.revision, digest: input.unused.digest, unused: input.unused.reason } : undefined;
  if (pin === undefined) return undefined;
  return { kind: "put", item: documentOf({ ...pinKey(input.orgId, input.project, input.taskId), entityType: "TEST_ENV_PIN", orgId: input.orgId, project: input.project, taskId: input.taskId, ...pin, ...expiryOf(input.nowMs + PIN_TTL_SECONDS * 1000) }), condition: when.absent() };
}

/** The pin of a task, or undefined (none, another org's, or damaged). Never throws. */
export async function readTestEnvPin(deps: StoreOnly, orgId: OrgId, project: string, taskId: string): Promise<TestEnvPin | undefined> {
  try {
    const stored = (await deps.store.get(pinKey(orgId, project, taskId))) as Record<string, unknown> | undefined;
    if (stored === undefined || stored["orgId"] !== orgId || stored["project"] !== project || stored["taskId"] !== taskId) return undefined;
    const revision = stored["revision"];
    const digest = stored["digest"];
    const unused = stored["unused"];
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1 || typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) return undefined;
    if (unused !== undefined && !(UNUSED_REASONS as readonly unknown[]).includes(unused)) return undefined;
    const declined = stored["declined"];
    return { revision, digest, ...(unused === undefined ? {} : { unused: unused as UnusedReason }), ...(typeof declined === "string" && /^[a-f0-9]{64}$/u.test(declined) ? { declined } : {}) };
  } catch {
    return undefined;
  }
}

/** What a task start does with the project's environment: the environment it uses and the pin item (or why it uses none). With the switch off: nothing at all, and nothing read. */
export async function testEnvironmentForStart(deps: TestEnvDeps, input: { orgId: OrgId; project: string; taskId: string }, env: NodeJS.ProcessEnv = process.env): Promise<{ used?: TestEnvironment; pin?: TransactItem }> {
  if (!testEnvironmentEnabled(env)) return {};
  const found = await usableTestEnvironment(deps, input.orgId, input.project, undefined, env);
  // Test services: dependencies and a dev container do not combine yet. The environment is then not applied, and the pin says why (a project without dependencies is never asked).
  if (found.ok && (found.environment.environment.dependencies?.length ?? 0) > 0 && await projectUsesDevcontainer(deps, input.orgId, input.project)) {
    const pin = testEnvPinItem({ ...input, nowMs: deps.now(), unused: { revision: found.environment.revision, digest: testEnvDigest(found.environment.environment), reason: "dependencies_with_devcontainer" } });
    return pin === undefined ? {} : { pin };
  }
  if (found.ok) return { used: found.environment, pin: testEnvPinItem({ ...input, nowMs: deps.now(), used: found.environment })! };
  if (found.reason === "none" || found.reason === "unreadable") return {};
  // An environment exists but is not applied: say which, from the revision that was judged, so the evidence names it.
  const approved = found.judged;
  const pin = approved === undefined ? undefined : testEnvPinItem({ ...input, nowMs: deps.now(), unused: { revision: approved.revision, digest: testEnvDigest(approved.environment), reason: found.reason } });
  return pin === undefined ? {} : { pin };
}

// The company rules service (the hosted policy hook) as the core engine's per-task limit reads it, shared by the broker's core root (aws/core-engine-root.ts) and the dispatcher
// (aws/dispatcher.ts). Kept apart from the root so the dispatcher's bundle does not take the broker's whole composition root.
import { HostedPolicyHookSettingsSchema, type HostedPolicyHookSettings } from "@agentx/contracts";
import type { PolicyHookInstall } from "../core/policy-hook/index.js";
import type { ProjectTaskCap } from "../core-host/hosted-modules.js";
import { policyHookInstallFromEnvironment } from "./hosted-wiring.js";
import { projectTaskCapReader, type ProjectSettingsHook } from "./project-settings.js";

/** The variable that holds the install's policy hook settings (JSON: `{ address, jwks, thumbprints }`). Absent or empty: no hook. */
export const CORE_POLICY_HOOK_VARIABLE = "ROVARA_POLICY_HOOK";

/**
 * The hosted install's policy hook settings (ROVARA_POLICY_HOOK, JSON `{ address, jwks, thumbprints }`).
 * Absent or empty gives undefined. Unreadable settings throw in fixed words, so an install meant to ask always has a hook.
 * Developer-API composition (#717) uses the same resolved setting and hosted client.
 */
export function policyHookSettingsFromEnvironment(env: NodeJS.ProcessEnv): HostedPolicyHookSettings | undefined {
  const raw = env[CORE_POLICY_HOOK_VARIABLE]?.trim() ?? "";
  if (raw === "") return undefined;
  let settings: unknown;
  try { settings = JSON.parse(raw); } catch { throw new Error("the policy hook settings are not JSON"); }
  const parsed = HostedPolicyHookSettingsSchema.safeParse(settings);
  if (!parsed.success) throw new Error("the policy hook settings are not readable");
  return parsed.data;
}

/** L2-5 (b): the company rules service the engine's per-task limit is resolved through, as the settings page's: none on an install without one; settings that did not read, or no
 * install signer, throw (the limit is then unreadable and the work refused). `fetch` reaches the rules service (absent: the global fetch). */
export function enginePolicyHook(settings: HostedPolicyHookSettings | undefined, problem: boolean, install: (() => PolicyHookInstall | undefined) | undefined, fetch?: typeof globalThis.fetch): ProjectSettingsHook | undefined {
  if (settings === undefined && !problem) return undefined;
  const signer = install?.();
  if (settings === undefined || signer === undefined) throw new Error("the policy hook is not usable");
  return { settings, install: signer, ...(fetch === undefined ? {} : { fetch }) };
}

type KmsSender = Parameters<typeof policyHookInstallFromEnvironment>[1];

/**
 * CORE-DISPATCH-HOOK-SIGNER-20261117: the dispatcher's reader of a project's per-task limit, resolved as the broker's root resolves it (the project's stored choice, then the company's
 * rules service when the install has one), so a model run is never dispatched past a company limit the broker's booking stop would apply. The install's question signer is the
 * dispatcher's own KMS signer over POLICY_HOOK_KEY_ARN (with DEVELOPER_TOKEN_ISSUER), built once. Settings that do not read, a missing signer, a signer that fails, or a rules service
 * that does not answer: the reader throws, and the run is refused (spend unknown), never let through on the project's limit alone.
 */
export function dispatcherProjectTaskCap(env: NodeJS.ProcessEnv, deps: Parameters<typeof projectTaskCapReader>[0], kms: KmsSender, fetch?: typeof globalThis.fetch): ProjectTaskCap {
  let settings: HostedPolicyHookSettings | undefined;
  let problem = false;
  try { settings = policyHookSettingsFromEnvironment(env); } catch { problem = true; }
  const install = settings === undefined && !problem ? undefined : policyHookInstallFromEnvironment(env, kms);
  return projectTaskCapReader(deps, () => enginePolicyHook(settings, problem, () => install, fetch));
}

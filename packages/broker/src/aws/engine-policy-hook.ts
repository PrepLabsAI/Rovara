// The company rules service (the hosted policy hook) as the core engine's per-task limit reads it, for the broker's core root (aws/core-engine-root.ts). Kept apart from the root so
// another function can read it without taking the broker's whole composition root.
import { HostedPolicyHookSettingsSchema, type HostedPolicyHookSettings } from "@agentx/contracts";
import type { PolicyHookInstall } from "../core/policy-hook/index.js";
import type { ProjectSettingsHook } from "./project-settings.js";

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

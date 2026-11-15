// Lane H (plan v3.2 section 7.5; decision 214.6): the policy hook (Code asks the company rules service). A generic Code feature: an install that names a policy address in its
// settings (`policyHook`) asks it before a task starts and on every approval, and can read company values through `withPolicyHookValues`. With no address
// set, nothing here runs and the install behaves exactly as before.
import type { AdapterRegistry, AuditSink, PolicyHookSettings } from "@agentx/contracts";
import { withPolicyHookAdmission, type PolicyHookAdmissionOptions } from "./admission.js";
import { withPolicyHookApprovers } from "./approvers.js";
import { createPolicyHookClient, type PolicyHookClient, type PolicyHookInstall } from "./client.js";

export { POLICY_HOOK_RETRY_DELAYS_MS, POLICY_HOOK_START_HOLD_CAP_MS, withPolicyHookAdmission, type PolicyHookAdmissionOptions } from "./admission.js";
export { STRICTER_DEFAULT_ANSWER, stricterRequirement, withPolicyHookApprovers, type PolicyHookApproversOptions } from "./approvers.js";
export { createPolicyHookClient, type PolicyHookClient, type PolicyHookClientOptions, type PolicyHookInstall, type PolicyHookResult, type PreparedPolicyQuestion } from "./client.js";
export { policyHookValuesAsker } from "./values.js";

export const POLICY_HOOK_ADAPTER_NAME = "policy-hook";

export interface ApplyPolicyHookOptions {
  fetch?: typeof fetch;
  now?: () => number;
  audit?: AuditSink;
  log?: (event: Record<string, unknown>) => void;
  admission?: PolicyHookAdmissionOptions;
}

export class PolicyHookSetupError extends Error {
  constructor() {
    super("the policy hook is set, but this install has no signing key to ask with");
    this.name = "PolicyHookSetupError";
  }
}

/**
 * Puts the hook in front of the registry's `admission` and `approvers` adapters, before the registry is sealed. No settings: returns undefined and changes
 * nothing. Settings without an install key: throws, so an install that should ask never starts without asking.
 */
export function applyPolicyHook(registry: AdapterRegistry, settings: PolicyHookSettings | undefined, install: PolicyHookInstall | undefined, options: ApplyPolicyHookOptions = {}): PolicyHookClient | undefined {
  if (settings === undefined) return undefined;
  if (install === undefined) throw new PolicyHookSetupError();
  const client = createPolicyHookClient({
    settings, install,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.audit === undefined ? {} : { audit: options.audit }),
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  const admissionName = registry.names("admission")[0];
  const admission = registry.require("admission");
  const approversName = registry.names("approvers")[0];
  const approvers = registry.require("approvers");
  registry.unregister("admission", admissionName!);
  registry.register("admission", POLICY_HOOK_ADAPTER_NAME, withPolicyHookAdmission(admission, client, { ...(options.now === undefined ? {} : { now: options.now }), ...options.admission }));
  registry.unregister("approvers", approversName!);
  registry.register("approvers", POLICY_HOOK_ADAPTER_NAME, withPolicyHookApprovers(approvers, client, options.now === undefined ? {} : { now: options.now }));
  return client;
}

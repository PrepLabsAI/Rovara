// Lane H: the asker behind `withPolicyHookValues` (contracts, ports/policy-hook-values.ts): one signed "values" question, one attempt, one audit line.
// Locks the install cannot read as its own company locks count as no answer there.
import type { PolicyHookClient } from "./client.js";

export function policyHookValuesAsker(hook: PolicyHookClient) {
  return async (companyId: string, projectName: string | undefined): Promise<{ locks: Readonly<Record<string, unknown>>; expiresAt: number } | undefined> => {
    const prepared = await hook.prepare("values", { cid: companyId, ...(projectName === undefined ? {} : { pid: projectName }) });
    if (prepared === undefined) return undefined;
    const result = await hook.send(prepared);
    await hook.audit(prepared, { answered: result.answered, attempts: 1 });
    return result.answered ? { locks: result.answer.locks, expiresAt: result.expiresAt } : undefined;
  };
}

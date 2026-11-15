import { z } from "zod";
import { PolicyResolveRequestSchema, PolicyRowsSchema, policyDataObject, resolvePolicy, type PolicyOperatorOptions, type PolicyResolveRequest, type ResolvedPolicy } from "../policy.js";

/** An opaque, adapter-issued scope. Only the adapter maps it to a company/project/branch.
 * It is not an authorization credential: authenticate the caller before issuing this key.
 */
export interface PolicyScope { readonly key: string }
export interface PolicySource { resolve(scope: PolicyScope, request: PolicyResolveRequest): Promise<ResolvedPolicy> }
export type { PolicyResolveRequest, ResolvedPolicy } from "../policy.js";
export interface PolicyRowsRead { readonly scope: PolicyScope; readonly rows: unknown }
/** Return { scope, rows: {} } for an authorized scope without rows; undefined for missing/foreign scopes.
 * Never query another company's rows while serving this scope. No default-company fallback or cache.
 */
export type PolicyRowsReader = (scope: PolicyScope) => Promise<PolicyRowsRead | undefined>;
const scopeSchema = z.unknown().refine(policyDataObject).pipe(z.object({ key: z.string().min(1).max(256).regex(/^[a-zA-Z0-9_:/.-]+$/u) }).strict());
const readSchema = z.unknown().refine(policyDataObject).pipe(z.object({ scope: scopeSchema, rows: PolicyRowsSchema }).strict());

/** Operator options come from installation configuration, never the row reader or resolve request. */
export function createRowsPolicySource(read: PolicyRowsReader, operator: PolicyOperatorOptions = {}): PolicySource {
  return {
    async resolve(scope, request) {
      try {
        const checkedScope = scopeSchema.parse(scope);
        const checkedRequest = PolicyResolveRequestSchema.parse(request);
        // A retained copy prevents even a reader mutating its argument from changing the expected scope.
        const key = checkedScope.key;
        const found = readSchema.parse(await read(Object.freeze({ key })));
        if (found.scope.key !== key) throw new Error("policy_unavailable");
        const result = resolvePolicy({ ...found.rows, ...checkedRequest }, operator);
        if (result.status === "refused") throw new Error("policy_unavailable");
        return result;
      } catch {
        // Identical fixed refusal for absent, foreign, unreadable and malformed rows. Never echo reader errors.
        throw new Error("policy_unavailable");
      }
    },
  };
}

/** Code laptop compatibility: no stored rows, no preset implicitly selected. */
export function createDefaultPolicySource(operator: PolicyOperatorOptions = {}): PolicySource {
  return createRowsPolicySource(async (scope) => ({ scope, rows: {} }), operator);
}

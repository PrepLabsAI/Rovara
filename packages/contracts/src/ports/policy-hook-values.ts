// Lane H (plan v3.2 section 7.5): "what are the company's values?" over a `PolicySource`. The answer's locks can only make a resolved value stricter (each field by its own direction).
// Read with a short cache: an answer is used until its own expiry; when a refresh gets no answer, the last good answer is used for a few more minutes (five by
// default), and after that the strictest default applies, which is the source's fixed refusal (`policy_unavailable`): nothing runs on unknown company values.
import { POLICY_FIELDS, PolicyRowsSchema, stricterPolicyValue, type PolicyValue, type ResolvedPolicy } from "../policy.js";
import { POLICY_HOOK_VALUES_GRACE_SECONDS } from "../policy-hook.js";
import type { PolicyScope as PolicySourceScope, PolicySource } from "./policy-source.js";

/** Asks the company rules service for one company's (and project's) locks. Undefined: no answer. `expiresAt` is the answer's own expiry (ms). */
export type PolicyHookValuesAsker = (companyId: string, projectName: string | undefined) => Promise<{ locks: Readonly<Record<string, unknown>>; expiresAt: number } | undefined>;

export interface PolicyHookValuesOptions {
  /** The company and project a scope stands for, as the adapter that issued the scope knows it. Undefined: refuse. */
  scopeOf: (scope: PolicySourceScope) => { companyId: string; projectName?: string } | undefined;
  now?: () => number;
  graceMs?: number;
  /** At most this many companies and projects are remembered. */
  maxEntries?: number;
}

type Locks = Readonly<Record<string, PolicyValue>>;
interface Entry { locks: Locks; expiresAt: number }

const unavailable = (): Error => new Error("policy_unavailable");

export function withPolicyHookValues(base: PolicySource, ask: PolicyHookValuesAsker, options: PolicyHookValuesOptions): PolicySource {
  const now = options.now ?? Date.now;
  const graceMs = options.graceMs ?? POLICY_HOOK_VALUES_GRACE_SECONDS * 1000;
  const maxEntries = options.maxEntries ?? 1000;
  const cache = new Map<string, Entry>();
  const pending = new Map<string, Promise<Entry | undefined>>();

  async function fetchLocks(companyId: string, projectName: string | undefined): Promise<Entry | undefined> {
    const answer = await ask(companyId, projectName).catch(() => undefined);
    // The answer's locks must be readable as company locks by Code's own field list; anything else is no answer.
    if (answer === undefined || !PolicyRowsSchema.safeParse({ companyLocks: answer.locks }).success) return undefined;
    return { locks: Object.freeze({ ...answer.locks }) as Locks, expiresAt: answer.expiresAt };
  }

  async function locksFor(companyId: string, projectName: string | undefined): Promise<Locks | undefined> {
    const key = `${companyId}\u0000${projectName ?? ""}`;
    const cached = cache.get(key);
    if (cached !== undefined && now() < cached.expiresAt) return cached.locks;
    let inflight = pending.get(key);
    if (inflight === undefined) {
      inflight = fetchLocks(companyId, projectName).finally(() => pending.delete(key));
      pending.set(key, inflight);
    }
    const fresh = await inflight;
    if (fresh !== undefined) {
      cache.delete(key);
      cache.set(key, fresh);
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
      return fresh.locks;
    }
    if (cached !== undefined && now() < cached.expiresAt + graceMs) return cached.locks;
    return undefined;
  }

  return {
    async resolve(scope, request) {
      const resolved = await base.resolve(scope, request);
      // Refused and switched-off results stand as they are: there is nothing looser to tighten.
      if (resolved.status !== "resolved") return resolved;
      const target = options.scopeOf(scope);
      if (target === undefined) throw unavailable();
      const locks = await locksFor(target.companyId, target.projectName);
      if (locks === undefined) throw unavailable();
      const values: ResolvedPolicy["values"] = Object.assign(Object.create(null) as ResolvedPolicy["values"], resolved.values);
      for (const row of POLICY_FIELDS) {
        const next = locks[row.id];
        const current = values[row.id];
        if (next === undefined || current === undefined) continue;
        if (stricterPolicyValue(row.id, next, current.value)) values[row.id] = { value: next, origin: "company_lock", clampedBy: "company_lock" };
      }
      return { status: resolved.status, values, issues: [...resolved.issues] };
    },
  };
}

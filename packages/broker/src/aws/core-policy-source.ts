// L4-HW3d: the hosted core's PolicySource for merge tracking and the task readers (`policyCiReporting` asks it for a project's CI mode, `real_check`).
// It resolves exactly as the project's settings page and the per-task limit reader do (`createProjectSettingsPolicySource`, project-settings.ts): the project's stored choice
// (PROJECT_SETTINGS), then the company's rules service when the install has one (`hook`, its locks only tighten a value, never loosen it). It only adds a short cache, so a pass
// over many tasks of one project asks once, not once per task.
//   - Scope: `company/<org>/project/<name>` (the one `policyCiReporting` issues). Anything else, or a company or project name that does not parse, refuses; the company is never
//     read from the request, only from the scope the root built from the task's own company, and a stored row that names another company refuses.
//   - Cache: per company AND project, `ttlMs` at most (default 30 s), and never past the rules service's own answer expiry. A request that carries anything (a task's raise) is not cached.
//   - Fail closed: a row that does not read, a rules service that gives no answer (or no install signer) refuses with the fixed `policy_unavailable`, never a default and never a
//     looser value. A refusal is remembered for `failureTtlMs` (default 5 s) so a pass does not ask again for every task; it never lasts into the next minute.
import { OrgIdSchema, type PolicySource, type ResolvedPolicy } from "@agentx/contracts";
import type { DeveloperRouteDependencies } from "./developer-routes.js";
import { createProjectSettingsPolicySource, type ProjectSettingsHook } from "./project-settings.js";

export const HOSTED_POLICY_TTL_MS = 30_000;
export const HOSTED_POLICY_FAILURE_TTL_MS = 5_000;
const MAX_ENTRIES = 500;
const SCOPE = /^company\/([A-Za-z0-9_-]{1,64})\/project\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})$/u;

interface Entry { readonly expiresAt: number; readonly result: ResolvedPolicy | undefined }

export interface HostedPolicySourceOptions { ttlMs?: number; failureTtlMs?: number; maxEntries?: number }

const unavailable = (): Error => new Error("policy_unavailable");

export function hostedPolicySource(
  deps: Pick<DeveloperRouteDependencies, "documentClient" | "tableName" | "now">,
  hook: () => ProjectSettingsHook | undefined,
  options: HostedPolicySourceOptions = {},
): PolicySource {
  const ttlMs = options.ttlMs ?? HOSTED_POLICY_TTL_MS;
  const failureTtlMs = options.failureTtlMs ?? HOSTED_POLICY_FAILURE_TTL_MS;
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  const cache = new Map<string, Entry>();
  const pending = new Map<string, Promise<Entry>>();

  async function read(companyId: string, projectName: string, request: Parameters<PolicySource["resolve"]>[1]): Promise<Entry> {
    const startedAt = deps.now();
    try {
      const policy = createProjectSettingsPolicySource(deps, { companyId, projectName }, hook());
      const result = await policy.source.resolve(policy.scope, request);
      const answered = policy.answerExpiresAt();
      return { result, expiresAt: Math.min(startedAt + ttlMs, answered ?? Number.POSITIVE_INFINITY) };
    } catch {
      return { result: undefined, expiresAt: startedAt + failureTtlMs };
    }
  }

  return {
    async resolve(scope, request) {
      const match = typeof scope?.key === "string" ? SCOPE.exec(scope.key) : null;
      const company = OrgIdSchema.safeParse(match?.[1]);
      if (match === null || !company.success) throw unavailable();
      const companyId = company.data, projectName = match[2]!;
      if (request !== undefined && request !== null && Object.keys(request).length > 0) {
        const entry = await read(companyId, projectName, request);
        if (entry.result === undefined) throw unavailable();
        return entry.result;
      }
      const key = `${companyId}\u0000${projectName}`;
      let entry = cache.get(key);
      if (entry === undefined || entry.expiresAt <= deps.now()) {
        cache.delete(key);
        let inflight = pending.get(key);
        if (inflight === undefined) {
          inflight = read(companyId, projectName, {}).finally(() => pending.delete(key));
          pending.set(key, inflight);
        }
        entry = await inflight;
        cache.delete(key);
        cache.set(key, entry);
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
      }
      if (entry.result === undefined) throw unavailable();
      return structuredClone(entry.result);
    },
  };
}

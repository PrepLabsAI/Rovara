// Saved project images: the lease token's one hand-off. The registry keeps a rebuild job's lease token (the secret that alone asks for the push login and posts the result), and the worker that builds must be
// sent it, or its build is refused (worker/saved-env/rebuild.ts). The dispatcher is the only caller: for the job the BROKER stored with the operation (never a job a request or a payload named) and for that
// operation, it first CHECKS (read only, before it starts any machine) that the lease can be handed over, and later TAKES the token and puts it into that one invocation. The token is given only while the job's lease is
// live and the project is live, to the one operation the job was started for (a retried delivery of the same operation is given the same token again; any other operation, or a newer job of the same project, is
// given nothing and marks nothing). What this returns is a token or a fixed reason: the reasons are words, so a refusal can be logged and shown without the token in it.
// A seam, not a call into the registry from the dispatcher: the dispatcher's flow dependencies are ports (a laptop and the hosted broker have none and are never asked), and the registry's store is
// the company's own on the hosted dispatcher only; the seam keeps the task flow from importing the registry (one real wiring today, the hosted dispatcher's; rule 3 is for the controller to rule).
import { OrgIdSchema, type AuditSink, type DocumentStore } from "@agentx/contracts";
import { canLeaseForDispatch, leaseForDispatch, type SavedEnvStoreDeps } from "./saved-env.js";
import { documentSavedEnvStore } from "./saved-env-store.js";
import { savedEnvEnabled } from "./saved-env-switch.js";

export type SavedEnvLeaseRefusal = "disabled" | "nothing_to_dispatch" | "stale_write";
export interface SavedEnvLeaseAsk { projectId: string; jobId: string; operationId: string }

export interface SavedEnvDispatchLease {
  /** Read only, takes nothing: could the lease of `jobId` be handed to `operationId` now? */
  check(input: SavedEnvLeaseAsk): Promise<{ ok: true } | { ok: false; reason: SavedEnvLeaseRefusal }>;
  /** Takes the lease token of `jobId` of `projectId` (of the company the seam was made for), for `operationId`. */
  take(input: SavedEnvLeaseAsk): Promise<{ ok: true; leaseToken: string } | { ok: false; reason: SavedEnvLeaseRefusal }>;
}

/** Run-time guards as well as types: a project, job or operation that is not a non-empty text is never passed on (the registry would then answer for whatever job the project has). */
const wellFormed = (orgId: string, input: SavedEnvLeaseAsk): boolean =>
  OrgIdSchema.safeParse(orgId).success && [input.projectId, input.jobId, input.operationId].every((id) => typeof id === "string" && id !== "");

/** The seam over a registry's store, for ONE company (never the company a message or a payload names). */
export function savedEnvDispatchLeaseOf(deps: SavedEnvStoreDeps, orgId: string): SavedEnvDispatchLease {
  return {
    async check(input) {
      if (!wellFormed(orgId, input)) return { ok: false, reason: "nothing_to_dispatch" };
      return canLeaseForDispatch(deps, { orgId, projectId: input.projectId }, input.operationId, input.jobId);
    },
    async take(input) {
      if (!wellFormed(orgId, input)) return { ok: false, reason: "nothing_to_dispatch" };
      const given = await leaseForDispatch(deps, { orgId, projectId: input.projectId }, input.operationId, input.jobId);
      // Defence in depth: whatever the registry answered, the token goes out only for the job asked for.
      if (!given.ok) return { ok: false, reason: given.reason };
      return given.job.jobId === input.jobId ? { ok: true, leaseToken: given.job.leaseToken } : { ok: false, reason: "nothing_to_dispatch" };
    },
  };
}

/** The dispatcher's seam over the install's document store and audit sink; undefined while the install's saved-environments switch is off (a rebuild is then never delivered). */
export function savedEnvDispatchLeaseFor(input: { companyId: string; store: DocumentStore; audit?: AuditSink | undefined; env: NodeJS.ProcessEnv; now: () => number }): SavedEnvDispatchLease | undefined {
  if (!savedEnvEnabled(input.env)) return undefined;
  const deps: SavedEnvStoreDeps = { store: documentSavedEnvStore({ store: input.store, ...(input.audit === undefined ? {} : { audit: input.audit }), now: input.now }), now: input.now, session: { config: { enabled: true } } };
  return savedEnvDispatchLeaseOf(deps, input.companyId);
}

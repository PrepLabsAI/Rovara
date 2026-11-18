// L4-EVW3 (DEC 254zzz20 D2): what a host passes the setup run's callback so the eval report can open the wrapper pull request (`eval-wrapper.ts`). One piece, used by the hosted root and by `rovara up`, so the audit
// record and its actor are the same everywhere.
//
// The targets are the project's repositories on the COMPANY'S OWN code host, built by the same repository builder the lessons file pass uses (`createLessonRepositories(...).targets`, `local/app/lessons-repos.ts`): the
// project's pinned address, the host that serves it, the scope of the company, and the host's own repository id. No new route, no new permission and no new outside call: it is the code host connection the company already has.
// The actor is the setup run, never a person: `setup-run:<taskId>`. The audit is written BEFORE the host write; a failed audit is no write (`eval-wrapper.ts`).
import type { AuditSink, OrgId, DocumentStore } from "@agentx/contracts";
import type { EvalWrapperDeps } from "./eval-wrapper.js";

/** The audit actor of a proposal the setup run's own report opened. */
export const setupRunActorOf = (taskId: string): string => `setup-run:${taskId}`;

export function setupRunEvalWrapper(input: { store: DocumentStore; companyId: OrgId; now: () => number; targets: EvalWrapperDeps["targets"]; audit: AuditSink; log?: EvalWrapperDeps["log"] }): EvalWrapperDeps {
  return {
    store: input.store, companyId: input.companyId, now: input.now, targets: input.targets, ...(input.log === undefined ? {} : { log: input.log }),
    async audit(event) {
      const taskId = event.details["taskId"];
      // No run to name, no proposal: the record must say what asked.
      if (taskId === undefined || taskId === "") throw new Error("the proposal names no setup run");
      await input.audit.record({
        eventId: `${event.action}:${input.companyId}:${event.project}:${taskId}:${event.details["repository"] ?? ""}:${event.details["digest"] ?? ""}:${event.details["language"] ?? ""}`,
        companyId: input.companyId, at: new Date(input.now()).toISOString(), actor: { type: "system", id: setupRunActorOf(taskId) }, action: event.action,
        subject: { type: "project", id: event.project }, details: { project: event.project, ...event.details },
      });
    },
  };
}

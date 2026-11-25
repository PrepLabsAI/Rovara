// R1 + L1 6.2 (plan 0.1 #3): the company's milestones host on a hosted install, OUTSIDE lessons.
//
// A milestone is the hook the task flow writes at the moments a person cares about (started, plan ready, pull request opened, merged, closed) and that the ticket write-back, the chat thread and lessons' capture hear.
// Until now the one table lived inside `createCoreLessons`, which is built only where the lessons switch covers the company, so a company without lessons had no milestone handler at all: no comment and no status move
// on its Linear ticket, no thread notice. This host is built for every company that has any handler to register (Linear write-back, chat threads, lessons); lessons register on it and do not own it.
//
// Its sweep (`deliverDue`: a handler that was not told, or failed, is told again) is NOT lessons' pass any more. Its home is the always-wired `notify-deliver` job (every 5 minutes, the cadence the lessons pass had):
// `withMilestoneSweep` runs it first in that job's pass, and with it the one-time flip of the seeded status default (`flipSeededStatusDefaults`), so neither depends on the lessons switch or on a schedule of its own
// (the clean-up is removing schedules, not adding them).
import type { AuditEvent, DocumentStore, OrgId } from "@agentx/contracts";
import { flipSeededStatusDefaults } from "../core/ticket-updates/status-default.js";
import { companyProjects } from "../core-host/lessons.js";
import { createDocumentMilestones, type DocumentMilestones } from "../core/milestones/milestones.js";
import type { TaskFlow } from "../core/task-flow/flow.js";
import type { CoreService, CoreServiceName } from "../core-host/core-runtime.js";

/** The company's milestones host, or undefined when nothing would register on it (the flow's milestone slot then stays empty, byte-identical to before). */
export function companyMilestones(input: { flow: Pick<TaskFlow, "deps">; companyId: OrgId; now: () => number; log: (entry: Record<string, unknown>) => void; anyHandler: boolean }): DocumentMilestones | undefined {
  if (!input.anyHandler) return undefined;
  const { companyId } = input;
  return createDocumentMilestones({ store: input.flow.deps.store, now: input.now, companyId, log: (event, fields) => input.log({ component: "milestones", companyId, event, ...fields }) });
}

/**
 * The services with the milestone sweep run first in the pass of `notify-deliver`, and, where the company has the Linear write-back (`linear`), the one-time flip of the seeded status default before it. Unchanged
 * when the company has no milestones host. A failure of either is logged and never stops the notices.
 */
export function withMilestoneSweep(
  services: Partial<Record<CoreServiceName, CoreService>>,
  input: {
    milestones: DocumentMilestones | undefined; companyId: OrgId; linear: boolean; store: DocumentStore; now: () => number; audit: { record(event: AuditEvent): Promise<unknown> };
    log: (entry: Record<string, unknown>) => void;
  },
): Partial<Record<CoreServiceName, CoreService>> {
  const { milestones, companyId } = input;
  if (milestones === undefined) return services;
  const notices = services["notify-deliver"];
  const fail = (event: string, error: unknown): void => input.log({ component: "milestones", companyId, event, error: error instanceof Error ? error.name : "unknown" });
  const flip = (): Promise<unknown> => flipSeededStatusDefaults({
    store: input.store, now: input.now, audit: input.audit, projects: () => companyProjects(input.store, companyId), log: (event, fields) => input.log({ component: "intake", companyId, event, ...fields }),
  }, companyId);
  return {
    ...services,
    "notify-deliver": {
      async pass(options) {
        if (input.linear) await flip().catch((error: unknown) => { fail("status_default_flip_failed", error); });
        const swept = await milestones.deliverDue().catch((error: unknown) => { fail("sweep_failed", error); return { attempted: 0 }; });
        const report = notices === undefined ? {} : await notices.pass(options);
        return { ...report, milestones: swept.attempted };
      },
    },
  };
}

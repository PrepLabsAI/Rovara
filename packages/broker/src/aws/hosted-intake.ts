// Lead 2 L2-4 (DEC 254o c): the tracker intake on a hosted install, so the Linear app's routed events (guided onboarding PR 20, linear-app-intake.ts) start work on hosted Code.
//
// Per company, from that company's core runtime only (never the install's or another company's):
//   - the engine's ports (`intakePortsOf`): the company's store, its task access (`hostedTaskAccess.checkStart`: live membership and the project grant), its task flow's `start` as
//     the member, and the install's ticket fence key (derived from the callback signing key, so a ticket's author cannot guess the fence);
//   - who a Linear account is: the company's own account links (linear-account-links.ts), counted only while the company is connected to that Linear workspace, then the person read
//     live; any other account is nobody, so the ticket waits;
//   - the waiting list and "Start" / "Not this one" for the routes (hosted-intake-routes.ts, which decide WHO may); "Start" runs as the member who pressed it, through the same engine
//     path the laptop uses (`startWaitingIntake`), so the member's own right to start work on the project is checked again by the start;
//   - the ticket write-back: the ticket updates handler with the company's OWN Linear connection (`linearCompanyTracker(companyId)`), registered on that company's milestones. No
//     install-wide tracker is ever used for a company's tickets.
// A company whose new tasks do not start on the core has no intake here (`intakeFor` is undefined, so the webhook logs `linear.intake_not_wired` and nothing starts).
import { createHash, createHmac } from "node:crypto";
import {
  OrgIdSchema, companyLog, type AuditSink, type DocumentStore, type IdentityProvider, type IntakeWaitingList, type OrgId, type Principal, type Tracker,
} from "@agentx/contracts";
import { dismissIntakeItem, intakePortsOf, listWaitingIntakeItems, readIntakeItem, startWaitingIntake, type IntakePorts } from "../core/intake/index.js";
import type { MomentTable } from "../core/ticket-updates/moments.js";
import { ticketUpdatesHandler } from "../core/ticket-updates/handler.js";
import type { CodeMilestoneHandler } from "../core/milestones/milestones.js";
import { developerIdOf } from "../core/sessions/create.js";
import type { StartExtras, StartExtrasInput, TaskAccess } from "../core/task-flow/deps.js";
import type { TaskFlow } from "../core/task-flow/flow.js";
import { waitingViewOf } from "../local/app/intake.js";
import { createSessionStartExtras } from "../local/app/session-start.js";
import { linearAccountResolver } from "./linear-account-links.js";
import { linearCompanyTracker } from "./linear-app-intake.js";
import type { LinearConnections } from "./linear-connections.js";

/** The pieces of one company's core runtime the intake uses. */
export interface HostedIntakeCompany {
  store: DocumentStore;
  access: Pick<TaskAccess, "checkStart">;
  flow: Pick<TaskFlow, "start">;
  /** The hosted identity point: a member of THIS company, read live (membership and the sign-in record). */
  identity: Pick<IdentityProvider, "getPrincipal">;
  audit: Pick<AuditSink, "record">;
  /** The company's milestones (where it has a milestones host): the ticket's `started` moment. Absent: none is written. */
  milestones?: MomentTable["milestones"] | undefined;
}

export interface HostedIntakeDeps {
  /** The company's runtime pieces, or undefined when its new tasks do not start on the core. A runtime that cannot be built throws (a retry may pass). */
  companyFor(companyId: OrgId): Promise<HostedIntakeCompany | undefined>;
  connections: Pick<LinearConnections, "connection">;
  /** `intakeFenceKeyOf(callback signing key)`. */
  fenceKey: Uint8Array;
  now: () => number;
  log: (entry: Record<string, unknown>) => void;
}

export type HostedIntakeStart =
  | { outcome: "started"; taskId: string; sessionId?: string | undefined }
  | { outcome: "waiting"; reason: string }
  | { outcome: "duplicate"; state: string }
  | { outcome: "not_found" }
  | { outcome: "forbidden" };

/** What the routes call, for a company and project they have already checked the caller against. */
export interface HostedIntake {
  /** The engine's ports for one company's deliveries (no presser), or undefined: no intake for that company here. */
  intakeFor(companyId: OrgId): Promise<IntakePorts | undefined>;
  /** The project's waiting tickets (the laptop's list shape; a hosted project has no polled sources). */
  waiting(companyId: OrgId, project: string): Promise<IntakeWaitingList>;
  /** "Start" by this member: the work is theirs. */
  start(companyId: OrgId, project: string, itemId: string, personId: string): Promise<HostedIntakeStart>;
  /** "Not this one" by this member. `false`: no such waiting ticket. */
  dismiss(companyId: OrgId, project: string, itemId: string, personId: string): Promise<boolean>;
}

/**
 * The hosted flow's `startExtras` for intake: a start that carries a ticket (only intake sets one) writes the task's session and its ticket binding in the start's own transaction, exactly as
 * the laptop does (`createSessionStartExtras`), so the engine's one-session-per-ticket rule and the write-back find the ticket. A start without a ticket gets nothing added, except (HW5) a start from a chat thread where chat threads are served.
 */
export function ticketSessionStartExtras(companyId: OrgId, options: { chatThreads?: boolean } = {}): (input: StartExtrasInput) => StartExtras {
  const session = createSessionStartExtras(OrgIdSchema.parse(companyId));
  // HW5: where chat threads are served, a start from a chat thread (the Slack start's own client name) gets its session too: the task's plan card and what needs a person are told through its session, as on a laptop.
  return (input) => (input.ticket === undefined && !(options.chatThreads === true && input.client === "slack") ? { items: [] } : session(input));
}

/** The ticket fence key of a hosted install: derived from its callback signing key under its own label, so it is the install's own and never the key itself. */
export function intakeFenceKeyOf(callbackSigningKey: string): Uint8Array {
  return createHmac("sha256", callbackSigningKey).update("agentx:intake-ticket-fence:v1").digest();
}

const ITEM_ID = /^[a-f0-9]{32}$/u;
/** An audit event id that names one act for good (the same act recorded twice is recorded once). */
const auditId = (kind: string, ...parts: string[]): string => `evt_intake_${kind}_${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 40)}`;

export function createHostedIntake(deps: HostedIntakeDeps): HostedIntake {
  const portsOf = (companyId: OrgId, company: HostedIntakeCompany, presser?: Principal): IntakePorts => {
    const log = companyLog(companyId, deps.log);
    const principalOf = (orgId: OrgId, personId: string) => company.identity.getPrincipal(orgId, personId);
    return intakePortsOf({
      store: company.store, companyId, now: deps.now,
      log: (event, fields) => { log({ component: "intake", event, ...fields }); },
      identity: { getPrincipal: principalOf, resolveExternalAccount: linearAccountResolver({ store: company.store, connections: deps.connections, principalOf }) },
      access: company.access, flow: company.flow, fenceKey: deps.fenceKey,
      ...(presser === undefined ? {} : { owner: presser }),
      ...(company.milestones === undefined ? {} : { milestones: company.milestones }),
      // A flood of tickets nobody can start is not stored past the limit: said once in the company's log; the list says how many wait.
      notifyWaitingFull: async (_org, project) => { log({ component: "intake", event: "waiting_full", project }); },
    });
  };
  const companyOf = async (companyId: OrgId): Promise<HostedIntakeCompany | undefined> => deps.companyFor(OrgIdSchema.parse(companyId));
  return {
    async intakeFor(companyId) {
      const company = await companyOf(companyId);
      return company === undefined ? undefined : portsOf(companyId, company);
    },
    async waiting(companyId, project) {
      const company = await companyOf(companyId);
      if (company === undefined) return { items: [], sources: [] };
      const items = await listWaitingIntakeItems({ store: company.store, now: deps.now }, companyId, project);
      return { items: items.map(waitingViewOf), sources: [] };
    },
    async start(companyId, project, itemId, personId) {
      if (!ITEM_ID.test(itemId)) return { outcome: "not_found" };
      const company = await companyOf(companyId);
      if (company === undefined) return { outcome: "not_found" };
      // The presser read live in THIS company (never the caller's word): the engine's `mayStart` and the start itself are theirs.
      const presser = await company.identity.getPrincipal(companyId, personId);
      if (presser === undefined || presser.companyId !== companyId || presser.personId !== personId) return { outcome: "forbidden" };
      const outcome = await startWaitingIntake(portsOf(companyId, company, presser), { orgId: companyId, project, itemId, approver: developerIdOf(presser) });
      if (outcome.outcome === "started") {
        // The task names its person; this records the press itself (best effort: the task stands without it).
        await company.audit.record({
          eventId: auditId("started", companyId, project, itemId, outcome.taskId), companyId, at: new Date(deps.now()).toISOString(), actor: { type: "person", id: personId },
          action: "intake.ticket_started", subject: { type: "intake_item", id: itemId }, details: { project, taskId: outcome.taskId },
        }).catch(() => { companyLog(companyId, deps.log)({ component: "intake", event: "audit_failed", action: "intake.ticket_started" }); });
        return { outcome: "started", taskId: outcome.taskId, ...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }) };
      }
      if (outcome.outcome === "waiting") return { outcome: "waiting", reason: outcome.reason };
      if (outcome.outcome === "duplicate") return { outcome: "duplicate", state: outcome.state };
      if (outcome.outcome === "skipped") return { outcome: "duplicate", state: "waiting" };
      return outcome;
    },
    async dismiss(companyId, project, itemId, personId) {
      if (!ITEM_ID.test(itemId)) return false;
      const company = await companyOf(companyId);
      if (company === undefined) return false;
      const presser = await company.identity.getPrincipal(companyId, personId);
      if (presser === undefined || presser.companyId !== companyId || presser.personId !== personId) return false;
      const table = { store: company.store, now: deps.now };
      const dismissed = await dismissIntakeItem(table, companyId, project, itemId, developerIdOf(presser))
        // A repeat after it was dismissed answers the same (and records the same act again, once).
        || (await readIntakeItem(table, companyId, project, itemId))?.state === "dismissed";
      if (!dismissed) return false;
      // Recorded after the change; a failure is the request's (503), and the repeat records the same event id once.
      await company.audit.record({
        eventId: auditId("dismissed", companyId, project, itemId), companyId, at: new Date(deps.now()).toISOString(), actor: { type: "person", id: personId },
        action: "intake.ticket_dismissed", subject: { type: "intake_item", id: itemId }, details: { project },
      });
      return true;
    },
  };
}

/**
 * The ticket updates handler for ONE company on a hosted install: a Linear ticket is written with the company's own OAuth connection only (`linearCompanyTracker`, which refuses any
 * other company's scope before a token is read); any other tracker has no write-back here. Registered on the company's milestones.
 */
export function hostedTicketUpdatesHandler(input: {
  companyId: OrgId; store: DocumentStore; connections: Pick<LinearConnections, "accessToken">; fetch?: typeof fetch | undefined; now: () => number; log: (entry: Record<string, unknown>) => void;
}): CodeMilestoneHandler {
  const companyId = OrgIdSchema.parse(input.companyId);
  const log = companyLog(companyId, input.log);
  return ticketUpdatesHandler({
    store: input.store, now: input.now, scope: { orgId: companyId }, trackerFor: hostedTrackerFor(companyId, input.connections, input.fetch),
    log: (event, fields) => { log({ component: "intake", event, ...fields }); },
  });
}

/** The trackers a company's tickets are written with: Linear through the company's own connection; nothing else. */
export function hostedTrackerFor(companyId: OrgId, connections: Pick<LinearConnections, "accessToken">, fetchImpl?: typeof fetch): (system: string) => Tracker | undefined {
  const company = OrgIdSchema.parse(companyId);
  return (system) => (system === "linear" ? linearCompanyTracker({ connections, companyId: company, fetch: fetchImpl }) : undefined);
}

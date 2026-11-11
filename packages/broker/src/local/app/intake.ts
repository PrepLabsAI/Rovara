// Tickets that ask for work, on a laptop. This is what `rovara up` adds around the intake core (`core/intake`) and the ticket updates (`core/ticket-updates`):
//
//   the project's intake rule   the places a project's work is asked for (a label put on a ticket, a ticket assigned to Rovara's account), read on a timer through the tracker adapters the registry holds
//                               (a laptop has no webhook): `PUT /v1/app/projects/{project}/intake/sources`;
//   the start                   a ticket starts a task only from an act the owner made (an account the owner linked in the config); anyone else's ticket WAITS in the list, and the owner says "Start" or "Not this one".
//                               A ticket never approves anything: the plan waits for the owner's page like every plan;
//   the write-back              a comment on the ticket (and, only when turned on, its status) at five moments, with the pull request's link: a milestone handler on the ticket the task started from.
//   GET  /v1/app/projects/{project}/intake                   the waiting tickets and the sources (`IntakeWaitingListSchema`)
//   GET  /v1/app/projects/{project}/intake/notices            the owner's notices (a source that keeps failing)
//   POST /v1/app/projects/{project}/intake/{itemId}/start     the owner says "Start" for a waiting ticket   (the work is theirs)
//   POST /v1/app/projects/{project}/intake/{itemId}/dismiss   the owner says "Not this one"
//   POST /v1/app/projects/{project}/intake/sources            replace the project's sources
//   GET|POST /v1/app/projects/{project}/intake/updates        the ticket updates settings and each tracker's write access (and replace them)
// `rovara up` answers GET and POST only, so a replace is a POST here; the function takes PUT too (the hosted product's verb) so one body and one handler serve both.
// An unknown project answers the same 404 as a missing one. The ticket's words are shown as text only; nothing here builds a link from them.
import {
  AgentXError, IntakeChannelRefSchema, IntakeDismissBodySchema, IntakeSourceErrorSchema, IntakeStartBodySchema, TicketUpdatesPutBodySchema, agentXError,
  type AdapterRegistry, type HostScope, type IntakeSourceView, type IntakeWaitingItem, type OrgId, type Principal, type Tracker,
} from "@agentx/contracts";
import { z } from "zod";
import {
  INTAKE_MAX_SOURCES_PER_PROJECT, dismissIntakeItem, intakePortsOf, intakeSearchOfTracker, intakeSourceIdOf, listIntakeSources, listWaitingIntakeItems, readIntakeItem, readIntakeNotices, replaceIntakeSources, runIntakePoll,
  startWaitingIntake, writeIntakeNotice, type IntakeItemRecord, type IntakePorts, type IntakeSourceRecord, type PollReport,
} from "../../core/intake/index.js";
import type { DocumentMilestones } from "../../core/milestones/milestones.js";
import { developerIdOf } from "../../core/sessions/create.js";
import type { SessionChange } from "../../core/sessions/summary.js";
import type { TaskCaller } from "../../core/task-flow/deps.js";
import type { TaskFlow } from "../../core/task-flow/flow.js";
import { createStoreProjectSource } from "../../core/task-flow/project-source.js";
import { readTicketUpdates, readWriteAccess, saveTicketUpdates, ticketMomentsOnChange, ticketUpdatesHandler } from "../../core/ticket-updates/index.js";
import type { BrokerRequest, BrokerResponse } from "../../handler.js";

/** The paths this module owns under `/v1/app/projects/`. */
export const INTAKE_PATH = /^\/v1\/app\/projects\/([^/]+)\/intake(?:\/(sources|updates|notices)|\/([a-f0-9]{32})\/(start|dismiss))?$/u;

const json = (statusCode: number, value: unknown): BrokerResponse => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
const PutSourcesBodySchema = z.object({ sources: z.array(IntakeChannelRefSchema).max(INTAKE_MAX_SOURCES_PER_PROJECT) }).strict();

export interface LocalIntakeDeps {
  registry: Pick<AdapterRegistry, "get" | "names" | "require">;
  flow: TaskFlow;
  companyId: OrgId;
  owner: Principal;
  milestones: Pick<DocumentMilestones, "register" | "items" | "deliver">;
  now: () => number;
  /** A key only this install holds (derived from its root key): a ticket's fence label is made from it. */
  fenceKey: Uint8Array;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

export interface LocalIntake {
  /** The routes above for the owner's session. `undefined` when the path is not one of them. */
  routes(request: BrokerRequest, caller: TaskCaller): Promise<BrokerResponse | undefined>;
  /** One pass of the poll over every source that is due (the timer calls it). */
  poll(): Promise<PollReport>;
  /** For `SummaryDependencies.onChange`: a ticket's task whose plan waits, or that was closed, tells its ticket. */
  onSessionChange(change: SessionChange): Promise<void>;
  /** The engine's ports, for tests and for a later webhook receiver. */
  readonly ports: IntakePorts;
}

function parsed<Schema extends z.ZodType>(schema: Schema, body: unknown): z.infer<Schema> {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  // Field names only: the values are the person's text.
  throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
}

function bodyOf(request: BrokerRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body); } catch { throw agentXError("CONFIG_INVALID", "the request body is not JSON"); }
}

/** A source as the owner sees it: a failing one says since when and its last code (a code from an allow-list, never the tracker's words). */
export function sourceViewOf(record: IntakeSourceRecord): IntakeSourceView {
  const failing = record.failures > 0;
  const code = IntakeSourceErrorSchema.safeParse(record.lastError);
  return {
    sourceId: record.sourceId, ref: record.ref, failing,
    ...(failing && typeof record.failingSince === "number" && Number.isFinite(record.failingSince) ? { failingSince: new Date(record.failingSince).toISOString() } : {}),
    ...(failing && code.success ? { lastError: code.data } : {}),
  };
}

function waitingViewOf(record: IntakeItemRecord): IntakeWaitingItem {
  return {
    itemId: record.itemId, channel: record.channel, system: record.system, id: record.id, url: record.url, title: record.title,
    requester: { display: record.requester.display, standing: record.requester.standing },
    reason: record.reason ?? "outsider", ...(record.lastRefusal === undefined ? {} : { lastRefusal: record.lastRefusal }), waitingSince: record.since,
  };
}

export function createLocalIntake(deps: LocalIntakeDeps): LocalIntake {
  const { registry, flow, companyId, owner } = deps;
  const store = flow.deps.store;
  const log = (event: string, fields: Record<string, unknown>): void => deps.log?.({ component: "intake", event, ...fields });
  const scope: HostScope = { orgId: companyId };
  const ownerId = developerIdOf(owner);
  const table = { store, now: deps.now };
  const trackerFor = (system: string): Tracker | undefined => registry.get("tracker", system);
  const projects = createStoreProjectSource(store, companyId);

  const ports = intakePortsOf({
    store, companyId, now: deps.now, log, identity: registry.require("identity"), access: flow.deps.access, flow, owner, milestones: deps.milestones, fenceKey: deps.fenceKey,
    // A flood of tickets nobody can start is not stored past the limit: the owner is told once by a line in the log and by the list itself, which says how many wait.
    notifyWaitingFull: async (_org, project) => { log("waiting_full", { project }); },
  });

  // The write-back: a milestone handler on the ticket the task started from. Registered once, before the first milestone is written.
  deps.milestones.register(ticketUpdatesHandler({ store, now: deps.now, trackerFor, scope, log }));
  const momentTable = { store, milestones: deps.milestones, now: deps.now, log };
  const onSessionChange = ticketMomentsOnChange(momentTable);

  const poll = (): Promise<PollReport> => runIntakePoll({
    ports, pollAll: true,
    searchFor: (system) => intakeSearchOfTracker(trackerFor(system), scope),
    notify: async (notice) => {
      await writeIntakeNotice(table, [ownerId], notice);
      log("source_failing", { project: notice.project, system: notice.system, minutes: notice.failingMinutes, code: notice.lastError });
    },
  });

  const projectFor = async (rawName: string): Promise<string> => {
    const name = decodeURIComponent(rawName);
    if ((await projects.latest(name)) === undefined) throw agentXError("PROJECT_NOT_FOUND", "There is no such project.");
    return name;
  };

  async function serve(request: BrokerRequest, caller: TaskCaller, match: RegExpExecArray): Promise<BrokerResponse> {
    // One owner: whoever the identity port vouched for is the owner on this install; another company's person is nobody.
    if (caller.principal.companyId !== companyId) throw agentXError("FORBIDDEN", "this person belongs to another company");
    const name = await projectFor(match[1]!);
    const method = request.method;
    const person = developerIdOf(caller.principal);
    if (match[2] === "updates") {
      const trackers = registry.names("tracker");
      if (method === "GET") return json(200, { settings: (await readTicketUpdates(table, companyId, name)).settings, canEdit: true, access: await readWriteAccess(table, companyId, trackers) });
      if (method !== "PUT" && method !== "POST") throw agentXError("NOT_FOUND", "no such route");
      const { requestId, settings } = parsed(TicketUpdatesPutBodySchema, bodyOf(request));
      const saved = await saveTicketUpdates(table, { orgId: companyId, project: name, settings, requestId, by: person });
      return json(200, { settings: saved, canEdit: true, access: await readWriteAccess(table, companyId, trackers) });
    }
    if (match[2] === "notices") {
      if (method !== "GET") throw agentXError("NOT_FOUND", "no such route");
      return json(200, { notices: await readIntakeNotices(table, companyId, ownerId) });
    }
    if (match[2] === "sources") {
      if (method !== "PUT" && method !== "POST") throw agentXError("NOT_FOUND", "no such route");
      const { sources } = parsed(PutSourcesBodySchema, bodyOf(request));
      if (new Set(sources.map(intakeSourceIdOf)).size !== sources.length) throw agentXError("CONFIG_INVALID", "sources: the same place is named twice");
      const saved = await replaceIntakeSources(table, { orgId: companyId, project: name, refs: sources, setBy: person });
      return json(200, { sources: saved.map(sourceViewOf) });
    }
    if (match[3] !== undefined && match[4] === "dismiss") {
      if (method !== "POST") throw agentXError("NOT_FOUND", "no such route");
      parsed(IntakeDismissBodySchema, bodyOf(request));
      if (await dismissIntakeItem(table, companyId, name, match[3], person)) return json(200, { dismissed: true });
      // A repeat after it was dismissed answers the same; a ticket that does not wait (started, or no such ticket) is the same 404, so nothing is learned about other tickets.
      if ((await readIntakeItem(table, companyId, name, match[3]))?.state === "dismissed") return json(200, { dismissed: true });
      throw agentXError("NOT_FOUND", "no such waiting ticket");
    }
    if (match[3] !== undefined) {
      if (method !== "POST") throw agentXError("NOT_FOUND", "no such route");
      parsed(IntakeStartBodySchema, bodyOf(request));
      // The work is the owner's: they start it and the task is theirs. The ticket's words are read again from what was stored when it was handed over (inert), never from the request.
      const outcome = await startWaitingIntake(ports, { orgId: companyId, project: name, itemId: match[3], approver: person });
      if (outcome.outcome === "not_found") throw agentXError("NOT_FOUND", "no such waiting ticket");
      if (outcome.outcome === "forbidden") throw agentXError("FORBIDDEN", `You can't start work on ${name}.`);
      if (outcome.outcome === "started") return json(202, { started: true, taskId: outcome.taskId, ...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }) });
      if (outcome.outcome === "waiting") return json(200, { started: false, reason: outcome.reason });
      return json(200, { started: false, state: outcome.outcome === "duplicate" ? outcome.state : "waiting" });
    }
    if (method !== "GET") throw agentXError("NOT_FOUND", "no such route");
    const waiting = await listWaitingIntakeItems(table, companyId, name);
    const sources = await listIntakeSources(table, companyId, name);
    return json(200, { items: waiting.map(waitingViewOf), sources: sources.map(sourceViewOf) });
  }

  return {
    ports,
    poll,
    onSessionChange,
    async routes(request, caller) {
      const path = request.path.split("?")[0] ?? request.path;
      const match = INTAKE_PATH.exec(path);
      if (match === null) return undefined;
      try {
        return await serve(request, caller, match);
      } catch (error) {
        if (error instanceof AgentXError) return json(error.statusCode, { error: { code: error.code, message: error.message.slice(error.code.length + 2) } });
        throw error;
      }
    },
  };
}

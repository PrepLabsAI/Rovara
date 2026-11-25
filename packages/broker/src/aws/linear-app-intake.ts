// Guided onboarding PR 20 (design section 3d step 3), rewritten for R1 + L1 6.2b: a Linear OAuth app event, already verified and routed by `linear-app-webhook.ts` to ONE company's project (by the workspace's bound
// company, then the project's picked team), RINGS A DOORBELL. The delivery's body is never believed about who did what: it names one issue by id, and the company's own token then reads THAT issue from Linear
// (its team, its labels, its assignee, and the history of who changed them), and the answer, not the body, is what the intake engine is given.
//
//   - The rule (core/intake/trigger.ts): the issue is assigned to Rovara's own app user, or carries the label `rovara`, whether set at creation or added later; the issue's team, as Linear says, is the project's STORED pick.
//   - Standing: the act's author is the history entry's actor (a Linear account id; Rovara's own writes are Rovara's and start nothing). A linked member (a link made BEFORE the act) starts; anyone else waits.
//   - Freshness: an act older than the project's team pick is skipped (connecting a team does not fill the waiting list); an act older than the member's link is not their consent and waits (a late link starts nothing).
//   - Once: the history entry is the change (`eventId` `linear:<issue id>:<entry id>`): claimed once per company, and a NEW entry after the task ended starts the next generation. Comment events do not ring it.
//   - Bounded: a person's tracker starts are capped per hour (`TRACKER_STARTS_PER_PERSON_HOUR`); the rest wait, saying why.
// The issue is read, and replies are written, with the COMPANY's own OAuth access token (actor=app, `linearCompanyApiAccess`), never an API key, never another company's token. A company whose connection is not
// `connected` starts nothing and is logged with its status (the notice is Cloud's, PR 13).
import { z } from "zod";
import { AgentXError, OrgIdSchema, TrackerSearchError, TrackerWriteRefusedError, agentXError, type OrgId, type Tracker } from "@agentx/contracts";
import { ingestIntake, type IntakeActor, type IntakeCandidate, type IntakePorts } from "../core/intake/engine.js";
import { ROVARA_TRIGGER_LABEL, admitTrackerStart } from "../core/intake/trigger.js";
import { createLinearApiAccess, workspaceOfIssueUrl } from "../plugins/tracker/linear/api.js";
import { linearTracker, type LinearTrackerAccess } from "../plugins/tracker/linear/index.js";
import type { LinearProjectEvent } from "./linear-app-webhook.js";
import type { LinearAppSettings, LinearConnections } from "./linear-connections.js";

/**
 * The Linear tracker's access for ONE company over its OAuth connection: every call sends that company's own access token (`Bearer`), refreshed as needed. The app acts as
 * itself (actor=app), so what it writes is Rovara's own.
 */
export function linearCompanyApiAccess(connections: Pick<LinearConnections, "accessToken">, companyId: string, fetchImpl?: typeof fetch) {
  const company = OrgIdSchema.parse(companyId);
  return createLinearApiAccess({
    apiKey: async () => `Bearer ${await connections.accessToken(company)}`, companyId: company, ownAccountIsRovara: true, ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });
}

/** Codes of a refusal that a retry of the same delivery would meet again. */
const PERMANENT_CODES: ReadonlySet<string> = new Set(["CALLBACK_FORBIDDEN", "FORBIDDEN", "CONFIG_INVALID"]);

export const LINEAR_OTHER_COMPANY = "This Linear connection belongs to another company.";

/**
 * The Linear tracker for ONE company over its OAuth connection: reads and replies with that company's own access token only. Every call names its company in its scope, and a scope of another company is refused
 * before anything is read.
 */
export function linearCompanyTracker(input: {
  connections: Pick<LinearConnections, "accessToken">; companyId: string; fetch?: typeof fetch | undefined;
  /** The connected workspace's url key: an issue read whose link is in another workspace (the token changed workspace meanwhile) is no issue. */
  workspace?: string | undefined;
}): Tracker {
  const company = OrgIdSchema.parse(input.companyId);
  const api = linearCompanyApiAccess(input.connections, company, input.fetch);
  const read = api.readIssue;
  const write = api.reply;
  const listComments = api.listComments;
  const move = api.moveIssue;
  if (read === undefined || write === undefined) throw agentXError("CONFIG_INVALID", "the Linear access is incomplete");
  const own = (orgId: string): void => { if (orgId !== company) throw agentXError("FORBIDDEN", LINEAR_OTHER_COMPANY); };
  const access: LinearTrackerAccess = {
    readIssue: async (orgId, key) => {
      own(orgId);
      const issue = await read(orgId, key);
      return issue === undefined || (input.workspace !== undefined && workspaceOfIssueUrl(issue.url) !== input.workspace.toLowerCase()) ? undefined : issue;
    },
    // L4-SRC-TK: the comments on an issue (fetch only), with the company's own token; another company's scope is refused before anything is read.
    listComments: async (orgId, key, query) => { own(orgId); return listComments?.(orgId, key, query); },
    // The company's own port, whole: a reply (in a thread, when the request names a parent) and a rewrite of a comment Rovara wrote (the ticket thread's root, edited in place). Each names its company, and another company's is refused before anything is sent.
    reply: {
      reply: async (request) => { own(request.orgId); return write.reply(request); },
      ...(write.edit === undefined ? {} : { edit: async (request: Parameters<NonNullable<typeof write.edit>>[0]) => { own(request.orgId); return write.edit!(request); } }),
    },
    // R1 + L1 6.2: the move of the ticket's status (In Progress, In Review, Done) goes through the same company token as the comments; the access names no company, so the tracker call below refuses another company's scope first.
    moveIssue: move,
  };
  const tracker = linearTracker(access);
  const setStatusByName = tracker.setStatusByName?.bind(tracker);
  if (setStatusByName !== undefined) {
    tracker.setStatusByName = async (ref, name, scope) => { own("orgId" in scope ? scope.orgId : ""); return setStatusByName(ref, name, scope); };
  }
  return tracker;
}


export interface LinearAppIntakeWiring {
  connections: Pick<LinearConnections, "connection" | "accessToken" | "teamPicks">;
  app: () => Promise<LinearAppSettings | undefined>;
  /**
   * The intake engine's ports for ONE company (`actAt`: the time of the act they are for, so a link made after it is nobody's consent for it). Absent, or undefined for a company: this install has no tracker intake there.
   */
  intakeFor?: ((companyId: OrgId, options?: { actAt?: string | undefined }) => Promise<IntakePorts | undefined>) | undefined;
  /**
   * Whether the core root has been built yet. A delivery that arrives before it (a cold start) is answered 503 so Linear tries again; a company that has no intake once the root IS built is a quiet skip, never a 503
   * (Linear would retry it for ever). Absent: the root is taken to be built.
   */
  rootBuilt?: (() => boolean) | undefined;
  fetch?: typeof fetch | undefined;
  now?: (() => number) | undefined;
  log: (entry: Record<string, unknown>) => void;
}

const READ_TIMEOUT_MS = 15_000;
const IssueRef = z.object({ data: z.object({ id: z.string().regex(/^[A-Za-z0-9-]{1,100}$/) }).passthrough() }).passthrough();
type Ids = { companyId: OrgId; project: string; type: string; action: string };
type TeamPick = Awaited<ReturnType<LinearAppIntakeWiring["connections"]["teamPicks"]>>[number];

/** Whether the connection and the project's STORED pick still say this delivery may be heard, and the pick: the company's connection decides at the moment of intake, the pick is never the event's own word. */
async function heardBy(wiring: LinearAppIntakeWiring, ids: Ids, workspace: string): Promise<{ pick: TeamPick; connectedWorkspace: string } | undefined> {
  const connection = await wiring.connections.connection(ids.companyId);
  if (connection === undefined || connection.status !== "connected" || connection.organizationId !== workspace) {
    wiring.log({ event: "linear.intake_skipped", ...ids, reason: connection === undefined ? "not_connected" : connection.status !== "connected" ? connection.status : "other_workspace" });
    return undefined;
  }
  const pick = (await wiring.connections.teamPicks(ids.companyId)).find((entry) => entry.project === ids.project);
  if (pick === undefined) wiring.log({ event: "linear.intake_skipped", ...ids, reason: "no_team_pick" });
  return pick === undefined ? undefined : { pick, connectedWorkspace: connection.organizationId };
}

type Asked = NonNullable<Awaited<ReturnType<NonNullable<LinearTrackerAccess["askedIssue"]>>>>;
type ProvenItem = NonNullable<Asked["item"]> & { occurredAt: string; change: NonNullable<NonNullable<Asked["item"]>["change"]> };

/** The item when Linear says it asks for work now, in the project's team, by an act that is proven and made after the team was picked; else nothing, and why in the log. */
function provenItem(wiring: LinearAppIntakeWiring, ids: Ids, asked: Asked, pick: TeamPick): ProvenItem | undefined {
  const skip = (reason: string): undefined => { wiring.log({ event: "linear.intake_skipped", ...ids, reason }); return undefined; };
  // The team is Linear's word, not the delivery's.
  if (asked.teamId.toLowerCase() !== pick.teamId.toLowerCase()) return skip("other_team");
  const { item } = asked;
  if (item === undefined) return undefined;
  const at = item.occurredAt === undefined ? Number.NaN : Date.parse(item.occurredAt);
  if (item.actor === undefined || item.occurredAt === undefined || !Number.isFinite(at) || item.change === undefined) return skip("act_unproven");
  // An act made before the team was picked is not a request to this project: it does not even wait.
  if (at < Date.parse(pick.setAt)) return skip("act_before_pick");
  return { ...item, occurredAt: item.occurredAt, change: item.change };
}

/**
 * The webhook's `deliver`: one routed Issue event rings the bell for the company's project. A failure that may pass throws, so the webhook gives the delivery back (503) and Linear retries it; the history entry's
 * event key keeps the retry from starting a second task.
 */
export function linearAppIntakeDeliver(wiring: LinearAppIntakeWiring): (event: LinearProjectEvent) => Promise<void> {
  return async (event) => {
    const companyId = OrgIdSchema.parse(event.companyId);
    const ids: Ids = { companyId, project: event.project, type: event.type, action: event.action };
    if (event.type !== "Issue" || (event.action !== "create" && event.action !== "update")) return;
    const heard = await heardBy(wiring, ids, event.organizationId);
    if (heard === undefined) return;
    const named = IssueRef.safeParse(event.body);
    if (!named.success) { wiring.log({ event: "linear.intake_skipped", ...ids, reason: "no_issue" }); return; }
    const issueId = named.data.data.id;
    // A company with no intake here spends no Linear read: asked before anything is read (the ports are rebuilt below for the act's own time).
    if (await wiring.intakeFor?.(companyId) === undefined) {
      if (wiring.rootBuilt?.() === false) throw agentXError("RUNTIME_UNAVAILABLE", "the core is not built yet");
      wiring.log({ event: "linear.intake_not_wired", ...ids });
      return;
    }
    const asked = await readAsk(wiring, ids, { companyId, issueId, workspace: heard.connectedWorkspace });
    const item = asked === undefined ? undefined : provenItem(wiring, ids, asked, heard.pick);
    if (item === undefined) return;
    const ports = await wiring.intakeFor?.(companyId, { actAt: item.occurredAt });
    if (ports === undefined) return;
    await ingestAsked(wiring, ports, ids, { item, issueId });
  };
}

/** The act's author as the engine knows them: a person only with the account Linear named (stamped with the workspace), else just what kind of author it was. */
function actorOf(item: ProvenItem): IntakeActor {
  const { actor } = item;
  return actor === undefined ? { kind: "unknown" } : actor.account === undefined ? { kind: actor.kind } : { kind: actor.kind, account: actor.account };
}

/** The proven act as the engine's candidate: the history entry is the change (`eventId`), the act's author is the actor, and a person's starts per hour are bounded. */
async function ingestAsked(wiring: LinearAppIntakeWiring, ports: IntakePorts, ids: Ids, input: { item: ProvenItem; issueId: string }): Promise<void> {
  const { item } = input;
  const actor = actorOf(item);
  const candidate: IntakeCandidate = {
    orgId: ids.companyId, project: ids.project, channel: "tracker", externalRef: { system: item.ref.tracker, id: item.ref.id, url: item.ref.url ?? "" }, title: item.title, body: item.body,
    ...(item.parent === undefined ? {} : { parent: item.parent }), ...(item.reporter === undefined ? {} : { reporter: { display: item.reporter } }),
    occurredAt: item.occurredAt, eventId: `linear:${input.issueId}:${item.change.id}`, act: item.change.act, trackerWord: "required", actor,
  };
  // The allowance is taken only when work would start (the engine asks just before).
  const developerId = actor.account === undefined ? undefined : await ports.memberOfAccount(ids.companyId, actor.account);
  const now = wiring.now ?? Date.now;
  try {
    // The act was read from Linear's own history through the company's token, so it is the tracker's word, not a delivery's.
    const outcome = await ingestIntake(ports, candidate, {
      confirmActor: async () => "person",
      ...(developerId === undefined ? {} : { admit: () => admitTrackerStart({ store: ports.table.store, now }, ids.companyId, developerId) }),
    });
    wiring.log({ event: "linear.intake_delivered", ...ids, outcome: outcome.outcome === "waiting" || outcome.outcome === "skipped" ? `${outcome.outcome}:${outcome.reason}` : outcome.outcome });
  } catch (error) {
    // A refusal that will never pass is said once and answered 200, so Linear does not retry it; anything else may pass and is thrown for a 503 and Linear's retry. The error's code only, never its words.
    const permanent = error instanceof TrackerWriteRefusedError || (error instanceof AgentXError && PERMANENT_CODES.has(error.code));
    wiring.log({ event: "linear.intake_failed", ...ids, code: error instanceof AgentXError ? error.code : error instanceof TrackerWriteRefusedError ? "TRACKER_WRITE_REFUSED" : "unknown", retry: !permanent });
    if (!permanent) throw error;
  }
}

/** The doorbell's one read: the issue by id through the company's own token. Permanent refusals are said once and read as nothing; a fault that may pass is thrown. */
async function readAsk(wiring: LinearAppIntakeWiring, ids: Ids, input: { companyId: OrgId; issueId: string; workspace: string }) {
  const app = await wiring.app();
  if (app === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "Linear app webhooks are not set up");
  const ask = linearCompanyApiAccess(wiring.connections, input.companyId, wiring.fetch).askedIssue!;
  try {
    const asked = await ask({ issueId: input.issueId, label: ROVARA_TRIGGER_LABEL, workspace: input.workspace, signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    if (asked === undefined) wiring.log({ event: "linear.intake_skipped", ...ids, reason: "issue_not_found" });
    return asked;
  } catch (error) {
    const permanent = error instanceof TrackerSearchError && (error.code === "CONNECTION_MISSING" || error.code === "CONNECTION_REFUSED");
    wiring.log({ event: "linear.intake_failed", ...ids, code: error instanceof TrackerSearchError ? error.code : error instanceof AgentXError ? error.code : "unknown", retry: !permanent });
    if (permanent) return undefined;
    throw error;
  }
}

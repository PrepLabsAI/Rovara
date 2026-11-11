// one rule for a ticket that asks for work, whatever tracker it is from.
//
//   A task starts only from a MEMBER ACT. The act is checked, not the label: who put the label on, or assigned the ticket, is resolved to a member of the org (a link the
//   tracker's account has to a member, read live) who holds a role on the project that starts tasks. Anything else waits:
//     - someone outside the company                                            -> waits for a member to say "Start"  (reason `outsider`)
//     - a person's tracker account no member is linked to                      -> waits, and says so                  (reason `unlinked`)
//     - an automation                                                          -> waits (reason `bot`); Rovara's own account starts nothing (the loop guard)
//     - a member who may not start tasks on the project                        -> waits (reason `no_authority`)
//   The ticket's text is data: it is framed as untrusted, redacted and made inert (`ticket-text.ts`), and nothing in it can name a person, a project, a budget or a tool.
//
//   One session per ticket: the ticket is one item (`store.ts`), claimed with a conditional write, so a poll that sees the ticket again, a webhook delivered twice or two members
//   pressing "Start" at once start it once. A start that is refused (the budget, the project) leaves the ticket waiting, with the refusal's code, for a member to try again; a fault
//   that may pass (the start service away) is thrown, after the ticket is given back, so the poll or the webhook's retry does it again.
//
// Nothing here knows a tracker. An adapter (a webhook provider, a poll's search) turns its tracker's words into an `IntakeCandidate`; this file decides.
import {
  AgentXError,
  INTAKE_TITLE_MAX,
  IntakeExternalRefSchema,
  intakeItemIdOf,
  type CodeIntentRequest,
  type ExternalAccountRef,
  type IntakeExternalRef,
  type IntakeStanding,
  type IntakeTrackerChannel,
  type IntakeWaitReason,
  type OrgId,
  type SessionBinding,
} from "@agentx/contracts";
import { ticketRunInput, inertTitle, inertTicketLine, inertWriter, prepareTicketBody, WAITING_BODY_MAX_BYTES } from "./ticket-text.js";
import { intakeRequestId } from "./ids.js";
import { ownWriteVerdictOf } from "./own-writes.js";
import { type IntakeChangeClaim, claimIntakeChange, claimIntakeEvent, claimIntakeItem, claimIntakeStart, giveBackIntakeItem, intakeItemIsTakeable, listWaitingIntakeItems, markIntakeStarted, readIntakeItem, releaseIntakeChange, releaseIntakeEvent, releaseIntakeItem, reopenIntakeItem, INTAKE_MAX_WAITING_PER_PROJECT, type IntakeItemRecord, type IntakeTable } from "./store.js";

/** Who made the act that asks for work, as the tracker's adapter knows them. Only `account` (the neutral outside-account shape: provider, tenant, account id) can ever make them a member, and only through a link the identity port holds. */
export interface IntakeActor {
  kind: "person" | "bot" | "rovara" | "unknown";
  /** The tracker's stable id for the account (never an email or a name taken from the ticket's text). */
  account?: ExternalAccountRef;
  display?: string;
}

/** What a channel's adapter hands the engine for one ticket. Every string is outsider-written text until the engine has made it safe. */
export interface IntakeCandidate {
  orgId: OrgId;
  project: string;
  channel: IntakeTrackerChannel;
  externalRef: IntakeExternalRef;
  title: string;
  body?: string | undefined;
  /** Who wrote the ticket (shown to the session as information about the text; never trusted). */
  reporter?: { display?: string | undefined } | undefined;
  /** Who made the act that asks for work. Absent for a poll that can't tell: then nobody is known to be a member and the ticket waits. */
  actor?: IntakeActor | undefined;
  /** The ticket's text is read for the session once, now. */
  occurredAt?: string | undefined;
  /**
   * The label event (or assignment) that asked for work: its own key, so that an event handed over twice is one event. Only a webhook has one. A candidate WITHOUT it (a poll, which only sees
   * that the ticket carries a label) never restarts a ticket whose task ended: only a new label event does.
   */
  eventId?: string | undefined;
  /** What the act put on the ticket (a label, or an assignee): so that a label or assignment Rovara wrote itself is told from a member's (`own-writes.ts`). Absent for a poll. */
  act?: { kind: "label" | "assignee"; value: string } | undefined;
  /**
   * The tracker's own change that made `actor`'s act, as a POLL read it from the tracker's change log through the company's connection (so it is the tracker's word, not a sender's). Set
   * only by a poll's search; a webhook never carries it (its change is confirmed by `confirmActor`). It is claimed once per company the same way a confirmed webhook's change is.
   */
  change?: { id: string; act: { kind: "label" | "assignee"; value: string } } | undefined;
  /**
   * The tracker says a delivery's person is believed only on its own word (`IngestContext.confirmActor`): a delivery is signed with a secret the people who made the hook have seen, so what it names is not
   * enough. Set by an adapter whose deliveries are like that. Without the tracker's word such an act waits (reason `unverified`).
   */
  trackerWord?: "required" | undefined;
  /** Other spellings of the ticket's id (a Jira issue has a key and a numeric id): a note of Rovara's under any of them is the ticket's. */
  alternateIds?: readonly string[] | undefined;
}

export type IntakeOutcome =
  | { outcome: "started"; taskId: string; sessionId?: string | undefined }
  | { outcome: "waiting"; reason: IntakeWaitReason }
  | { outcome: "duplicate"; state: IntakeItemRecord["state"] }
  | { outcome: "skipped"; reason: "caused_by_rovara" | "invalid" | "waiting_full" };

/** What the engine reads and does outside itself. Each is the broker's own function in production; the tests supply others. */
export interface IntakePorts {
  table: IntakeTable;
  log(event: string, fields: Record<string, unknown>): void;
  /**
   * The member of the org this tracker account is linked to, read now (a member who is removed or revoked is nobody), or undefined. `ticketUrl` is the ticket's own link, checked by the schema
   * (a Jira account is linked per site, and the site is the link's host).
   */
  memberOfAccount(orgId: OrgId, account: ExternalAccountRef): Promise<string | undefined>;
  /** Whether the member, read now, holds a role on the project that starts tasks. A read that failed throws. */
  mayStart(orgId: OrgId, developerId: string, project: string): Promise<boolean>;
  /** `startCodeIntent`, as that member. Throws what a start throws. */
  start(orgId: OrgId, developerId: string, request: CodeIntentRequest): Promise<{ task: { taskId: string }; sessionId?: string | undefined }>;
  /** The session this ticket already follows in the org (a binding, whoever made it), or undefined. `ended`: its task finished, failed, was cancelled or closed (absent: it runs). */
  sessionOfTicket(orgId: OrgId, binding: Extract<SessionBinding, { kind: "tracker_item" }>): Promise<{ sessionId: string; ended?: boolean | undefined } | undefined>;
  /** Lets an ended session's hold on its ticket go (the binding and the surface), so a new session may follow the ticket. Absent: a ticket is never started a second time. */
  freeTicket?(orgId: OrgId, sessionId: string): Promise<void>;
  /** Links the new session to the one it follows (its `retryOf`). Best effort: a failure is logged and the new session stands. */
  linkPrevious?(orgId: OrgId, nextSessionId: string, previousSessionId: string): Promise<void>;
  /** Tells the project's maintainers once that a flood of waiting tickets is not being stored (optional). */
  notifyWaitingFull?(orgId: OrgId, project: string): Promise<void>;
  /** Told once a ticket's task started and its item says so (the ticket updates' `started` moment). Best effort: it never throws, and the start stands without it. */
  started?(orgId: OrgId, started: { taskId: string; sessionId?: string | undefined }): Promise<void>;
}

/** A tracker's change id (the id of one entry of its change log): plain id characters, so it is safe in a key and cannot carry a separator. */
const CHANGE_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const errorCode = (error: unknown): string => (error instanceof AgentXError ? error.code : error instanceof Error ? error.name : "unknown");
/** A start's own refusal that will not pass by itself (the budget, the project, the process). A busy answer and anything from 500 up may pass, and are thrown to be tried again. */
const BUSY_CODES: ReadonlySet<string> = new Set(["WORKSPACE_BUSY", "TOO_MANY_REQUESTS"]);
const isPassing = (error: unknown): boolean => error instanceof AgentXError && error.statusCode < 500 && !BUSY_CODES.has(error.code);

interface Resolved {
  standing: IntakeStanding;
  developerId?: string;
  /** With `waiting` as the outcome of this: why. Absent when the act may start work. */
  reason?: IntakeWaitReason;
}

/**
 * Who asked, as the org knows them. A `person` with a linked account who holds a role that starts tasks is a member who may start. A linked member without that role is a member who
 * waits for someone who has it. Everything else is an outsider or a bot; an actor that is Rovara's own never reaches here.
 */
async function resolveStanding(ports: IntakePorts, candidate: IntakeCandidate, unattributed: boolean): Promise<Resolved> {
  // An act that can't be told from Rovara's own change, or that its tracker would not confirm, is not taken for a member's (fail closed): the ticket waits for someone to say "Start".
  if (unattributed) return { standing: "outsider", reason: "unverified" };
  const actor = candidate.actor;
  if (actor === undefined || actor.kind === "unknown") return { standing: "outsider", reason: "outsider" };
  if (actor.kind === "bot") return { standing: "bot", reason: "bot" };
  // An account of another provider than the ticket's tracker is nobody's here: a tracker can only vouch for its own accounts.
  if (actor.account === undefined || actor.account.provider !== candidate.externalRef.system) return { standing: "outsider", reason: "outsider" };
  const developerId = await ports.memberOfAccount(candidate.orgId, actor.account);
  // A person the tracker names, whom no member is linked to (by a verified email or a link an admin made): the ticket waits, and says why. Rovara never guesses who they are.
  if (developerId === undefined) return { standing: "outsider", reason: "unlinked" };
  if (!await ports.mayStart(candidate.orgId, developerId, candidate.project)) return { standing: "member", developerId, reason: "no_authority" };
  return { standing: "member", developerId };
}

function requestOf(record: Pick<IntakeItemRecord, "orgId" | "project" | "system" | "id" | "url" | "channel" | "generation">, input: CodeIntentRequest["input"], developerId: string): CodeIntentRequest {
  const source = record.channel;
  return {
    requestId: intakeRequestId(record.orgId, record.system, record.id, developerId, record.generation ?? 1), project: record.project, input, source,
    binding: { kind: "tracker_item", system: record.system, id: record.id, url: record.url },
  };
}

/** The ticket's own link and ids were checked by the schema; build the binding the session follows. */
const bindingOf = (record: Pick<IntakeItemRecord, "system" | "id" | "url">): Extract<SessionBinding, { kind: "tracker_item" }> => ({ kind: "tracker_item", system: record.system, id: record.id, url: record.url });

/**
 * Starts the ticket that this caller already holds (`starting`, under `developerId`'s lease) as `developerId`. Everything it writes to the item is conditioned on that lease, so a start whose
 * lease was taken over changes nothing. A start that is refused leaves the ticket waiting with the refusal's code; a start that finds the ticket already has a session records that
 * session; a start that worked is a start even if the item can no longer be marked; a fault that may pass gives the item back and is thrown. `admit` is asked just before the work
 * would start (never for a ticket that waits): when it says no, the ticket waits with `RATE_LIMITED`, for a member to press Start.
 */
async function startHeld(ports: IntakePorts, record: IntakeItemRecord, input: CodeIntentRequest["input"], developerId: string, created: boolean, admit?: IngestContext["admit"]): Promise<IntakeOutcome> {
  const previousSessionId = record.previousSessionId;
  const { table } = ports;
  const { orgId, project, itemId } = record;
  const existing = await ports.sessionOfTicket(orgId, bindingOf(record));
  if (existing !== undefined) {
    await markIntakeStarted(table, orgId, project, itemId, { holder: developerId, sessionId: existing.sessionId, requester: record.requester });
    return { outcome: "duplicate", state: "started" };
  }
  if (admit !== undefined && !await admit()) {
    await giveBackIntakeItem(table, orgId, project, itemId, developerId, "start_refused", "RATE_LIMITED");
    ports.log("intake.start_not_admitted", { orgId, project, system: record.system });
    return { outcome: "waiting", reason: "start_refused" };
  }
  try {
    const started = await ports.start(orgId, developerId, requestOf(record, input, developerId));
    if (!await markIntakeStarted(table, orgId, project, itemId, { holder: developerId, taskId: started.task.taskId, sessionId: started.sessionId, requester: record.requester })) {
      ports.log("intake.mark_not_holder", { orgId, project, system: record.system });
    }
    // A ticket asked for again after its task ended: the new session points back to the old one (best effort; the new session stands without the link).
    if (previousSessionId !== undefined && started.sessionId !== undefined && ports.linkPrevious !== undefined) {
      await ports.linkPrevious(orgId, started.sessionId, previousSessionId).catch((error: unknown) => { ports.log("intake.link_previous_failed", { orgId, project, error: errorCode(error) }); });
    }
    ports.log("intake.started", { orgId, project, system: record.system, channel: record.channel });
    await ports.started?.(orgId, { taskId: started.task.taskId, sessionId: started.sessionId }).catch(() => undefined);
    return { outcome: "started", taskId: started.task.taskId, ...(started.sessionId === undefined ? {} : { sessionId: started.sessionId }) };
  } catch (error) {
    if (isPassing(error)) {
      // The start's own refusal (no budget, the project is archived, the process is unavailable): the ticket waits, with the code, for a member to try again. A refusal that is "this ticket
      // already has a session" is the ticket being started by someone else first.
      const raced = await ports.sessionOfTicket(orgId, bindingOf(record)).catch(() => undefined);
      if (raced !== undefined) {
        await markIntakeStarted(table, orgId, project, itemId, { holder: developerId, sessionId: raced.sessionId, requester: record.requester });
        return { outcome: "duplicate", state: "started" };
      }
      await giveBackIntakeItem(table, orgId, project, itemId, developerId, "start_refused", errorCode(error));
      ports.log("intake.start_refused", { orgId, project, system: record.system, code: errorCode(error) });
      return { outcome: "waiting", reason: "start_refused" };
    }
    // A fault that may pass: the item is given back (or, if this call created it just to start it, forgotten), and the poll's next tick or the webhook's retry does it again.
    if (created) await releaseIntakeItem(table, orgId, project, itemId, developerId);
    else await giveBackIntakeItem(table, orgId, project, itemId, developerId, record.reason ?? "outsider");
    ports.log("intake.start_failed", { orgId, project, system: record.system, error: errorCode(error) });
    throw error;
  }
}

export interface IngestContext {
  /** How many items the project already has waiting (computed once for a batch; the engine keeps it up to date as it stores more). */
  waiting?: { count: number };
  /** Asked just before work would start (a member's act, or a member pressing Start from a ticket's event): false means "not now", and the ticket waits instead of being dropped. Dispatch counts its allowances here. */
  admit?: () => Promise<boolean>;
  /**
   * The tracker's own word on who made the act, asked only for an act that looks like a person's and would start work (never for one that waits anyway): "person" (it confirms it), "rovara" (it
   * was done through Rovara's own app) or "unverified" (it can't say). A fault or any other answer counts as "unverified", so the ticket waits. Absent where the tracker has no such word.
   */
  confirmActor?: () => Promise<"person" | "rovara" | "unverified">;
}

/**
 * One ticket that asks for work. Idempotent: the same ticket handed over again is `duplicate` (unless it waits and this time a member asked, which starts it). Never throws for a
 * refusal; throws a fault that may pass, after leaving the ticket as it can be tried again.
 */
export async function ingestIntake(ports: IntakePorts, candidate: IntakeCandidate, context: IngestContext = {}): Promise<IntakeOutcome> {
  const ref = IntakeExternalRefSchema.safeParse(candidate.externalRef);
  if (!ref.success || candidate.title.trim() === "") return { outcome: "skipped", reason: "invalid" };
  // The loop guard: what Rovara's own account did never starts what Rovara does.
  if (candidate.actor?.kind === "rovara") return { outcome: "skipped", reason: "caused_by_rovara" };
  const { orgId, project, eventId } = candidate;
  // Rovara's own writes, whatever account they went through: an event for a label or assignment Rovara wrote itself starts nothing. (A read that fails throws, and the delivery is made again.)
  const own = await ownWriteVerdictOf(ports.table, { orgId, project, externalRef: ref.data, alternateIds: candidate.alternateIds, act: candidate.act, occurredAt: candidate.occurredAt });
  if (own === "own") {
    ports.log("intake.own_write", { orgId, project, system: ref.data.system });
    return { outcome: "skipped", reason: "caused_by_rovara" };
  }
  let unattributed = own === "touched";
  // a Jira webhook's body is signed only with the hook's secret, which the people who made the hook have seen, so the person it names is believed only on Jira's own word
  // (`confirmActor`, read through the company's connection). Without one, the act is not taken for a member's: the ticket waits.
  if (!unattributed && candidate.trackerWord === "required" && eventId !== undefined && eventId !== "" && context.confirmActor === undefined && candidate.actor?.kind === "person") unattributed = true;
  // The tracker's own word on who did it, where it has one: asked for an act that looks like a person's and is a linked member's (so that every real act a member could be replayed from is
  // seen, whichever project it first reached, and an outsider's act costs no read).
  // `claimable`: the tracker's change and act, once the tracker itself has said they are real (a webhook after `confirmActor`, or a poll that read them from the change log).
  let claimable: { changeId: string; act: { kind: string; value: string } } | undefined;
  if (!unattributed && context.confirmActor !== undefined && candidate.actor?.kind === "person" && candidate.actor.account !== undefined && await isLinkedMember(ports, candidate)) {
    const word = await context.confirmActor().catch(() => "unverified" as const);
    if (word === "rovara") {
      ports.log("intake.own_write", { orgId, project, system: ref.data.system, by: "tracker" });
      return { outcome: "skipped", reason: "caused_by_rovara" };
    }
    unattributed = word !== "person";
    // (A confirmation names a change id and the act, so a confirmed act always has both here.)
    const changeId = word === "person" && candidate.trackerWord === "required" ? changeIdOf(eventId) : undefined;
    if (changeId !== undefined && candidate.act !== undefined) claimable = { changeId, act: candidate.act };
  } else if (!unattributed && (eventId === undefined || eventId === "") && candidate.change !== undefined && candidate.actor?.kind === "person" && CHANGE_ID.test(candidate.change.id)) {
    claimable = { changeId: candidate.change.id, act: candidate.change.act };
  }
  const itemId = intakeItemIdOf(ref.data.system, ref.data.id);
  // A change the tracker said is real is used once per company: the claim is written only now, after that word, so a made-up change id (which the tracker would not confirm) never reaches it and
  // cannot use up a real one. The same act handed to another project's hook or poll (a replay by someone who holds that hook's secret, or a second project watching the same label) finds it
  // taken: nothing starts as the person, and the ticket WAITS (reason `unverified`) where a maintainer sees it and can press Start. The same project and ticket again passes.
  let held: IntakeChangeClaim | undefined;
  let eventKey = eventId;
  if (claimable !== undefined) {
    const claim: IntakeChangeClaim = { orgId, system: ref.data.system, site: siteOf(ref.data.url), changeId: claimable.changeId, act: claimable.act, project, itemId };
    const taken = await claimIntakeChange(ports.table, claim);
    if (taken === "taken") {
      ports.log("intake.change_replayed", { orgId, project, system: ref.data.system });
      unattributed = true;
    } else if (taken === "claimed") held = claim;
    // A webhook act confirmed by the tracker is told apart from a repeat by what the tracker confirmed (site, change, act), never by the body's own event key, which holds fields (the issue's
    // numeric id) the tracker did not check: a real change re-sent with another id is the same event.
    if (eventId !== undefined && eventId !== "") eventKey = `${ref.data.system}:${claim.site}:${claim.changeId}:${claim.act.kind}:${claim.act.value}`;
  }
  const giveBack = async (): Promise<void> => { if (held !== undefined) await releaseIntakeChange(ports.table, held); };
  if (eventKey === undefined || eventKey === "") {
    try {
      return await ingestOnce(ports, candidate, context, unattributed);
    } catch (error) {
      await giveBack();
      throw error;
    }
  }
  // Each label event counts once: an event handed over again (a webhook delivered twice, a replay) is the same event. A fault that may pass gives the event back, so the redelivery is handled.
  try {
    if (!await claimIntakeEvent(ports.table, orgId, project, itemId, eventKey)) {
      const seen = await readIntakeItem(ports.table, orgId, project, itemId);
      return { outcome: "duplicate", state: seen?.state ?? "started" };
    }
  } catch (error) {
    await giveBack();
    throw error;
  }
  try {
    return await ingestOnce(ports, candidate, context, unattributed);
  } catch (error) {
    await releaseIntakeEvent(ports.table, orgId, project, itemId, eventKey);
    await giveBack();
    throw error;
  }
}

/** The tracker's id of the change an event came from: the last part of its key (a Jira changelog id). Nothing for a key that does not end in one. */
const changeIdOf = (eventId: string | undefined): string | undefined => {
  const last = eventId?.split(":").at(-1);
  return last !== undefined && CHANGE_ID.test(last) ? last : undefined;
};
/** The tracker's host, from the ticket's link (the same host the tracker's confirmation read). */
const siteOf = (url: string): string => { try { return new URL(url).hostname.toLowerCase(); } catch { return url; } };

/** Whether the act, taken at its word, is a linked member's (so that it is worth asking the tracker to confirm it). */
async function isLinkedMember(ports: IntakePorts, candidate: IntakeCandidate): Promise<boolean> {
  const account = candidate.actor?.account;
  return account !== undefined && account.provider === candidate.externalRef.system && await ports.memberOfAccount(candidate.orgId, account) !== undefined;
}

async function ingestOnce(ports: IntakePorts, candidate: IntakeCandidate, context: IngestContext, unattributed: boolean): Promise<IntakeOutcome> {
  const ref = IntakeExternalRefSchema.parse(candidate.externalRef);
  const { orgId, project } = candidate;
  const itemId = intakeItemIdOf(ref.system, ref.id);
  const known = await readIntakeItem(ports.table, orgId, project, itemId);
  // A ticket that is started or being started is done with, whoever asks again, unless a new label EVENT asks for a ticket whose task has ended (below). (A start whose lease ran out was cut short; it is taken over like a waiting ticket.)
  const relabeling = known?.state === "started" && candidate.eventId !== undefined && candidate.eventId !== "";
  if (known !== undefined && !relabeling && !intakeItemIsTakeable(known, ports.table.now())) return { outcome: "duplicate", state: known.state };
  const resolved = await resolveStanding(ports, candidate, unattributed);
  const title = inertTitle(candidate.title, ref.id).slice(0, INTAKE_TITLE_MAX);
  const writer = inertWriter(candidate.reporter?.display);
  const input = ticketRunInput({ system: ref.system, id: ref.id, title, body: prepareTicketBody(candidate.body), writer });
  const requester = { display: inertTicketLine(candidate.actor?.display ?? candidate.reporter?.display ?? "someone", 80) || "someone", standing: resolved.standing, ...(resolved.developerId === undefined ? {} : { developerId: resolved.developerId }) };
  const base = { orgId, project, itemId, channel: candidate.channel, system: ref.system, id: ref.id, url: ref.url, title, writer, requester };
  const mayStartNow = resolved.reason === undefined && resolved.developerId !== undefined;

  if (known !== undefined && relabeling) return relabel(ports, known, { base, body: prepareTicketBody(candidate.body, WAITING_BODY_MAX_BYTES), input, resolved, mayStartNow, context, binding: bindingOf(known) });

  if (known !== undefined) {
    // The ticket waits (or a start of it was cut short). A member's act now starts it; anything else leaves it as it was, waiting where a maintainer can see it.
    if (!mayStartNow) {
      if (known.state === "starting" && known.startedBy !== undefined) await giveBackIntakeItem(ports.table, orgId, project, itemId, known.startedBy, known.reason ?? resolved.reason ?? "outsider");
      return { outcome: "duplicate", state: "waiting" };
    }
    if (!await claimIntakeStart(ports.table, orgId, project, itemId, resolved.developerId!)) return { outcome: "duplicate", state: "starting" };
    return startHeld(ports, { ...known, ...base, state: "starting" }, input, resolved.developerId!, false, context.admit);
  }

  if (mayStartNow) {
    const claimed = await claimIntakeItem(ports.table, { ...base, state: "starting", startedBy: resolved.developerId!, body: prepareTicketBody(candidate.body, WAITING_BODY_MAX_BYTES) });
    if (claimed.result !== "created") return { outcome: "duplicate", state: claimed.result === "exists" ? claimed.record.state : "waiting" };
    return startHeld(ports, { ...base, state: "starting", since: new Date(ports.table.now()).toISOString(), updatedAt: new Date(ports.table.now()).toISOString() }, input, resolved.developerId!, true, context.admit);
  }

  // Waits for a member. A project holds a bounded number of waiting tickets, so a flood of outsiders' tickets costs a bounded amount.
  const waiting = context.waiting ?? { count: (await listWaitingIntakeItems(ports.table, orgId, project)).length };
  if (waiting.count >= INTAKE_MAX_WAITING_PER_PROJECT) {
    ports.log("intake.waiting_full", { orgId, project });
    await ports.notifyWaitingFull?.(orgId, project).catch(() => undefined);
    return { outcome: "skipped", reason: "waiting_full" };
  }
  const claimed = await claimIntakeItem(ports.table, { ...base, state: "waiting", reason: resolved.reason!, body: prepareTicketBody(candidate.body, WAITING_BODY_MAX_BYTES) });
  if (claimed.result !== "created") return { outcome: "duplicate", state: claimed.result === "exists" ? claimed.record.state : "waiting" };
  waiting.count += 1;
  ports.log("intake.waiting", { orgId, project, system: ref.system, reason: resolved.reason });
  return { outcome: "waiting", reason: resolved.reason! };
}

/**
 * A new label event on a ticket that was started. While its session still runs it is a duplicate. Once the session has ended (finished, failed, cancelled or closed, or its hold is gone)
 * the ticket lets go of it and is asked for again: a member's act starts a NEW task (the next generation, with a request id of its own), linked to the old one; anyone else's act makes the
 * ticket wait for a member to say "Start", as a first ask does. The same checks as the first start apply, because the same code runs them.
 */
async function relabel(
  ports: IntakePorts, known: IntakeItemRecord,
  ctx: { base: Omit<IntakeItemRecord, "state" | "since" | "updatedAt">; body: string; input: CodeIntentRequest["input"]; resolved: Resolved; mayStartNow: boolean; context: IngestContext; binding: Extract<SessionBinding, { kind: "tracker_item" }> },
): Promise<IntakeOutcome> {
  const { orgId, project, itemId } = known;
  const current = await ports.sessionOfTicket(orgId, ctx.binding);
  if (current !== undefined && current.ended !== true) return { outcome: "duplicate", state: "started" };
  // Without a way to let the old session go, a ticket is never started a second time (fail closed).
  if (ports.freeTicket === undefined) return { outcome: "duplicate", state: "started" };
  const generation = known.generation ?? 1;
  const previousSessionId = known.sessionId ?? current?.sessionId;
  const reopen = { orgId, project, itemId, generation, title: ctx.base.title, body: ctx.body, writer: ctx.base.writer ?? "someone", requester: ctx.base.requester, previousSessionId, previousTaskId: known.taskId };
  if (!ctx.mayStartNow) {
    const waiting = ctx.context.waiting ?? { count: (await listWaitingIntakeItems(ports.table, orgId, project)).length };
    if (waiting.count >= INTAKE_MAX_WAITING_PER_PROJECT) return { outcome: "skipped", reason: "waiting_full" };
    if (current !== undefined) await ports.freeTicket(orgId, current.sessionId);
    if (!await reopenIntakeItem(ports.table, { ...reopen, to: "waiting", reason: ctx.resolved.reason ?? "outsider" })) return { outcome: "duplicate", state: "started" };
    waiting.count += 1;
    ports.log("intake.waiting", { orgId, project, system: known.system, reason: ctx.resolved.reason, again: true });
    return { outcome: "waiting", reason: ctx.resolved.reason ?? "outsider" };
  }
  const developerId = ctx.resolved.developerId!;
  // The old session lets go first (it is repeatable): a ticket still held by an ended session could not be started again, and a lost race for the item below only leaves it free.
  if (current !== undefined) await ports.freeTicket(orgId, current.sessionId);
  if (!await reopenIntakeItem(ports.table, { ...reopen, to: "starting", holder: developerId })) return { outcome: "duplicate", state: "started" };
  const next: IntakeItemRecord = { ...known, ...ctx.base, state: "starting", generation: generation + 1, startedBy: developerId, ...(previousSessionId === undefined ? {} : { previousSessionId }), ...(known.taskId === undefined ? {} : { previousTaskId: known.taskId }) };
  delete next.sessionId;
  delete next.taskId;
  return startHeld(ports, next, ctx.input, developerId, false, ctx.context.admit);
}

/**
 * Hands a batch of tickets to `ingestIntake`, counting the project's waiting items once. It stops at a fault that may pass (answered as `fault`; the rest are handed over again by the next
 * poll) and at `deadline` (epoch ms on the table's clock; answered as `stoppedEarly`), so a batch never runs past the time its caller has.
 */
export async function ingestIntakeBatchWithin(ports: IntakePorts, candidates: readonly IntakeCandidate[], options: { deadline?: number } = {}): Promise<{ outcomes: IntakeOutcome[]; fault?: unknown; stoppedEarly: boolean }> {
  const counts = new Map<string, { count: number }>();
  const outcomes: IntakeOutcome[] = [];
  for (const candidate of candidates) {
    if (options.deadline !== undefined && ports.table.now() >= options.deadline) return { outcomes, stoppedEarly: true };
    try {
      const key = `${candidate.orgId}\0${candidate.project}`;
      let waiting = counts.get(key);
      if (waiting === undefined) {
        waiting = { count: (await listWaitingIntakeItems(ports.table, candidate.orgId, candidate.project)).length };
        counts.set(key, waiting);
      }
      outcomes.push(await ingestIntake(ports, candidate, { waiting }));
    } catch (fault) {
      return { outcomes, fault, stoppedEarly: false };
    }
  }
  return { outcomes, stoppedEarly: false };
}

/** `ingestIntakeBatchWithin` without a deadline, throwing the fault that stopped it. */
export async function ingestIntakeBatch(ports: IntakePorts, candidates: readonly IntakeCandidate[]): Promise<IntakeOutcome[]> {
  const done = await ingestIntakeBatchWithin(ports, candidates);
  if (done.fault !== undefined) throw done.fault instanceof Error ? done.fault : new Error("intake fault");
  return done.outcomes;
}

/**
 * A member says "Start" for a ticket that waits. `approver` is the member pressing it: they must hold a role on the project that starts tasks (checked here and again by the start
 * itself), and the work is theirs: they start it and they pay. The ticket's text is read again from what was stored when it was handed over (inert), never from the request.
 */
export async function startWaitingIntake(
  ports: IntakePorts,
  input: { orgId: OrgId; project: string; itemId: string; approver: string },
): Promise<IntakeOutcome | { outcome: "not_found" } | { outcome: "forbidden" }> {
  const { orgId, project, itemId, approver } = input;
  if (!await ports.mayStart(orgId, approver, project)) return { outcome: "forbidden" };
  const record = await readIntakeItem(ports.table, orgId, project, itemId);
  if (record === undefined) return { outcome: "not_found" };
  if (!intakeItemIsTakeable(record, ports.table.now())) return { outcome: "duplicate", state: record.state };
  if (!await claimIntakeStart(ports.table, orgId, project, itemId, approver)) {
    const now = await readIntakeItem(ports.table, orgId, project, itemId);
    return { outcome: "duplicate", state: now?.state ?? "starting" };
  }
  // The text is what was handed over and stored (already inert); the request carries none.
  const ticket = ticketRunInput({ system: record.system, id: record.id, title: record.title, body: record.body ?? "", writer: record.writer ?? "someone" });
  return startHeld(ports, { ...record, state: "starting" }, ticket, approver, false);
}

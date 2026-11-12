// Stop, retry and tell on a session (lane L6b, inventory B6; the hosted product's Plan 5 Tasks 11 and 13). A session acts on paid work, so each of these asks the task flow to do the real thing through the
// control host (lane L6a fills it: the task's own cancel, its workflow retry, its notes and live steer), after this module checked who is asking. The request is recorded once under its request id, with the
// event and the audit steps, in ONE transaction, so a repeat answers what was answered and writes nothing.
//
// Who may act: the hosted product's session levels (`access.ts`): a message to the agent needs `use`; stop, retry and close need `edit` (a company owner or admin may stop). On a Code install the local owner holds
// `edit` on every session and nobody else holds anything; a company's members come in through `members`. A person with no level reads a missing session; a person short of the level reads what they need. The caller
// is a `Principal` the surface already authenticated through the Identity seam; nothing here believes an id it is handed.
//
// What a message to the agent is: information for the model, never an instruction that can decide an approval, change a tool or a budget. It is stored as the session's message with its fate
// (`queued`, `delivered`, `not_delivered`), and its text is in no log line and no event.
import { createHash } from "node:crypto";
import {
  INDEX_EXPIRY_ATTRIBUTE, SESSION_ENDED_MESSAGE, SESSION_MESSAGE_MAX_CHARS, SessionMessageSchema, agentSessionKey, cleanSessionName, redactText, sessionEventId, when,
  type AgentSessionRecord, type AuditSink, type DocumentStore, type IdentityProvider, type OrgId, type PresentedCredential, type Principal, type SessionEvent, type SessionId, type SessionMessage, type TransactItem,
} from "@agentx/contracts";
import { createSessionAccess, requireLevelOf, type SessionAccess, type SessionMembers } from "./access.js";
import { developerIdOf } from "./create.js";
import { answerMessage, queuedSteersItem } from "./steer.js";
import { SessionStore, jsonOf, sessionEventItem } from "./store.js";

/** What the task flow does for a session's task. Each is called only after this module checked the person. Without a host, the action answers `unavailable` and writes nothing. */
export interface SessionControlHost {
  /** The task's own cancel, idempotent by `requestId`. */
  cancelTask(taskId: string, requestId: string): Promise<{ nothingRunning: boolean; message?: string } | void>;
  /** Closes the task (the task flow's own close, as the person who asked), idempotent by `requestId`. */
  closeTask?(taskId: string, requestId: string, principal: Principal): Promise<void>;
  /** The task's own workflow retry, at the task's revision now; idempotent by `requestId`. Throws when the workflow is not blocked. */
  retryWorkflow(taskId: string, requestId: string): Promise<void>;
  /**
   * Gives a person's message to the agent: live to the running step when the worker takes one (through the worker machines port), else as a note the next step reads. Answers where it went. Idempotent by
   * `messageId`. Never carries authority: the text is information.
   */
  deliverMessage?(taskId: string, message: { messageId: string; text: string }): Promise<{ state: "queued" | "delivered" | "not_delivered"; reason?: string }>;
  /**
   * The two-step form of `deliverMessage` that a host with notes uses: it decides where the message goes and answers the items to write in the message's OWN transaction (the note, the note count,
   * the rate token), so a queued message is never without its note and a note never without its message; `goLive` then hands a queued message to a step that is running (after the transaction applied). When
   * the host has it, `deliverMessage` is not called. A plan whose transaction lost a race (a rate token, the note count) is made again. A host has one of the two.
   */
  planMessage?(taskId: string, message: MessageToDeliver): Promise<MessagePlan>;
  // REQUIREMENT on the host (the hosted product's STEER_RATE and note cap are not in this module): it limits how often one person may message a session in an hour and how many notes a task keeps, and answers
  // `not_delivered` with a reason when a limit is hit. A live message can mean paid model work.
}

/** What a host is told of a message to deliver: the text is already cleaned, redacted and cut. */
export interface MessageToDeliver { messageId: string; text: string; sessionId: SessionId; author: { developerId: string; name: string }; owner: boolean }

export interface MessagePlan {
  state: "queued" | "delivered" | "not_delivered";
  reason?: string;
  /** Written in the message's transaction. */
  items?: readonly TransactItem[];
  /** Hands a queued message to the running step. `taken` says it did; `items` are written with the answer (the note's `liveDeliveredAt`). Never throws. */
  goLive?: () => Promise<{ taken: boolean; items?: readonly TransactItem[] }>;
}

export interface ControlDependencies {
  store: DocumentStore;
  audit: AuditSink;
  host?: SessionControlHost | undefined;
  /** Needed to act with a raw credential (`{ credential }`) instead of a principal the surface already authenticated. */
  identity?: IdentityProvider | undefined;
  /** Where the company's people come from for the session levels. Default: the local owner alone. */
  members?: SessionMembers | undefined;
  /** Replaces the session levels with a yes or no of its own (a test, or an adapter with its own rules). A no reads as a missing session. */
  authorize?: (principal: Principal, session: AgentSessionRecord, action: "stop" | "retry" | "tell" | "close") => boolean | Promise<boolean>;
  /** Recomputes the session's summary after the action (the sweep does it anyway). A failure is logged, never thrown. */
  refresh?: (orgId: OrgId, sessionId: SessionId) => Promise<unknown>;
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
}

/** Who is acting: a principal the surface already authenticated through the Identity seam, or the raw credential, which this module authenticates itself (it never trusts an id it was handed). */
export type ControlActor = Principal | { credential: PresentedCredential };

export type ControlRefusal = "not_found" | "forbidden" | "task_access_denied" | "ended" | "unavailable" | "nothing_to_retry" | "invalid" | "request_id_reused";

export type ControlResult<T = unknown> =
  | ({ status: "done"; session: AgentSessionRecord; repeated: boolean } & T)
  | { status: "refused"; reason: ControlRefusal; message: string };

const KEEP_SECONDS = 400 * 86_400;
/** How many times a message is planned again after it lost a race on a rate token or the note count. */
const TELL_ATTEMPTS = 4;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const refuse = (reason: ControlRefusal, message: string): { status: "refused"; reason: ControlRefusal; message: string } => ({ status: "refused", reason, message });

export const NOT_AVAILABLE = "That isn't available right now.";
export const NOTHING_TO_RETRY = "There is nothing to retry: the task is not blocked.";
export const FAILED_TASK_NEEDS_NEW_TASK = "This task failed and has ended. Start a new task.";

/** What a stop, retry or message answered, kept under its request id on the session so a repeat answers it again and writes nothing. */
interface ControlRequest { action: "stop" | "retry" | "tell" | "close"; by: string; at: string; messageId?: string; nothingRunning?: boolean; message?: string }

const requestKey = (session: { orgId: OrgId; sessionId: SessionId }, requestId: string) => agentSessionKey(session.orgId, session.sessionId, `REQUEST#${requestId}`);

function requestOf(document: Record<string, unknown> | undefined): ControlRequest | undefined {
  if (document === undefined) return undefined;
  const { action, by, at } = document;
  if ((action !== "stop" && action !== "retry" && action !== "tell" && action !== "close") || typeof by !== "string" || typeof at !== "string") return undefined;
  return {
    action, by, at, ...(typeof document["messageId"] === "string" ? { messageId: document["messageId"] } : {}),
    ...(document["nothingRunning"] === true ? { nothingRunning: true } : {}), ...(typeof document["message"] === "string" ? { message: document["message"] } : {}),
  };
}

const isEnded = (session: AgentSessionRecord): boolean => session.endedAt !== undefined;

export function createSessionControl(deps: ControlDependencies) {
  const sessions = new SessionStore(deps.store);
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...entry })));
  const access = createSessionAccess({ store: deps.store, members: deps.members });

  /** The principal behind the actor: a principal as given, or the one the Identity seam vouches for. A credential it does not know is a missing session to the caller. */
  async function principalOf(actor: ControlActor): Promise<Principal | undefined> {
    if (!("credential" in actor)) return actor;
    if (deps.identity === undefined) return undefined;
    const result = await deps.identity.authenticate(actor.credential);
    return result.ok ? result.principal : undefined;
  }

  /** The session the person may act on (with their access when the session levels judged it), or the refusal. A session of another company reads as absent. */
  async function open(principal: Principal, orgId: OrgId, sessionId: SessionId, action: "stop" | "retry" | "tell" | "close"): Promise<{ session: AgentSessionRecord; access?: SessionAccess } | ReturnType<typeof refuse>> {
    if (principal.companyId !== orgId) return refuse("not_found", "There is no such session.");
    const session = await sessions.get(orgId, sessionId);
    if (session === undefined) return refuse("not_found", "There is no such session.");
    if (deps.authorize !== undefined) {
      // A person who may not act reads the answer a missing session gets, so a session id tells them nothing.
      return (await deps.authorize(principal, session, action)) ? { session } : refuse("not_found", "There is no such session.");
    }
    try {
      const found = await access.of(principal, session);
      const judged = action === "tell" ? requireLevelOf(found, "use", "send messages to the agent")
        : action === "stop" ? requireLevelOf(found, "edit", "stop it", { orgAdminMay: true })
          : requireLevelOf(found, "edit", action === "retry" ? "retry it" : "close it");
      return { session, access: judged };
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      // No level at all reads as a missing session; a level short of the action says what is needed (the hosted product's SESSION_LEVEL_REQUIRED); a task whose owner cannot be read is TASK_ACCESS_DENIED.
      if (code === "SESSION_LEVEL_REQUIRED") return refuse("forbidden", messageOf(error));
      if (code === "TASK_ACCESS_DENIED") return refuse("task_access_denied", messageOf(error));
      if (code === "NOT_FOUND") return refuse("not_found", "There is no such session.");
      throw error;
    }
  }

  async function afterControl(session: AgentSessionRecord): Promise<void> {
    try { await deps.refresh?.(session.orgId, session.sessionId); } catch (error) { log({ event: "agent_session.refresh_after_control_failed", sessionId: session.sessionId, error: error instanceof Error ? error.name : "unknown" }); }
  }

  /** Records the request, its event and the audit in one transaction. A lost race (the request is there now) answers the stored request. */
  async function commit(session: AgentSessionRecord, requestId: string, request: ControlRequest, extra: readonly TransactItem[], event: SessionEvent, audit: { action: string; person: Principal }): Promise<ControlRequest | undefined> {
    const result = await commitOnce(session, requestId, request, extra, event, audit);
    return result.applied ? undefined : result.prior;
  }

  /** `commit`, saying whether it applied: a transaction that did not apply with no request stored lost a race on one of the `extra` items (a rate token, a note count), and the caller may plan again. */
  async function commitOnce(session: AgentSessionRecord, requestId: string, request: ControlRequest, extra: readonly TransactItem[], event: SessionEvent, audit: { action: string; person: Principal }): Promise<{ applied: true } | { applied: false; prior: ControlRequest | undefined }> {
    const at = now();
    const items: TransactItem[] = [
      { kind: "put", item: { ...requestKey(session, requestId), entityType: "AGENT_SESSION_REQUEST", orgId: session.orgId, sessionId: session.sessionId, requestId, ...jsonOf(request), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(at.getTime() / 1000) + KEEP_SECONDS }, condition: when.absent() },
      sessionEventItem(session, event),
      ...extra,
      ...deps.audit.stage({ eventId: `session:${session.sessionId}:${request.action}:${requestId}`, companyId: session.orgId, at: at.toISOString(), actor: { type: "person", id: audit.person.personId }, action: audit.action, subject: { type: "session", id: session.sessionId } }),
    ];
    const result = await deps.store.transact(items);
    if (result.applied) return { applied: true };
    // The request is there: another call with this id got in first (or the event is already told). Answer what it answered.
    return { applied: false, prior: requestOf(await deps.store.get(requestKey(session, requestId))) };
  }

  const nameOf = (principal: Principal) => cleanSessionName(principal.displayName) ?? "Someone";
  const actorOf = (principal: Principal): SessionEvent["actor"] => ({ kind: "member", developerId: developerIdOf(principal), name: nameOf(principal) });

  return {
    /** Stops the session's task through the task flow's own cancel. The session stays open and shows `stopped`; a budget pause stays a pause. Idempotent by `requestId`. */
    async stop(actor: ControlActor, orgId: OrgId, sessionId: SessionId, input: { requestId: string }): Promise<ControlResult<{ nothingRunning?: true; message?: string }>> {
      if (!REQUEST_ID.test(input.requestId)) return refuse("invalid", "The request ID is not valid.");
      const principal = await principalOf(actor);
      if (principal === undefined) return refuse("not_found", "There is no such session.");
      const found = await open(principal, orgId, sessionId, "stop");
      if ("status" in found) return found;
      const { session } = found;
      const prior = requestOf(await deps.store.get(requestKey(session, input.requestId)));
      if (prior !== undefined) {
        if (prior.action !== "stop") return refuse("request_id_reused", "That request ID was already used for something else.");
        return { status: "done", session, repeated: true, ...(prior.nothingRunning === true ? { nothingRunning: true as const } : {}), ...(prior.message === undefined ? {} : { message: prior.message }) };
      }
      if (isEnded(session)) return refuse("ended", SESSION_ENDED_MESSAGE);
      if (session.subject.kind !== "task" || deps.host === undefined) return refuse("unavailable", NOT_AVAILABLE);
      const answer = await deps.host.cancelTask(session.subject.taskId, input.requestId);
      const nothingRunning = answer !== undefined && answer.nothingRunning;
      const request: ControlRequest = { action: "stop", by: developerIdOf(principal), at: now().toISOString(), ...(nothingRunning ? { nothingRunning: true } : {}), ...(answer?.message === undefined ? {} : { message: answer.message }) };
      const event: SessionEvent = { eventId: sessionEventId("stopped", input.requestId), at: request.at, type: "stopped", actor: actorOf(principal), text: `${nameOf(principal)} stopped this.` };
      const repeated = await commit(session, input.requestId, request, [], event, { action: "session.stopped", person: principal });
      if (repeated === undefined) await afterControl(session);
      return { status: "done", session, repeated: repeated !== undefined, ...(nothingRunning ? { nothingRunning: true as const } : {}), ...(answer?.message === undefined ? {} : { message: answer.message }) };
    },

    /** Retries a blocked task through the task flow's own workflow retry, in the same session. Idempotent by `requestId`. */
    async retry(actor: ControlActor, orgId: OrgId, sessionId: SessionId, input: { requestId: string }): Promise<ControlResult> {
      if (!REQUEST_ID.test(input.requestId)) return refuse("invalid", "The request ID is not valid.");
      const principal = await principalOf(actor);
      if (principal === undefined) return refuse("not_found", "There is no such session.");
      const found = await open(principal, orgId, sessionId, "retry");
      if ("status" in found) return found;
      const { session } = found;
      const prior = requestOf(await deps.store.get(requestKey(session, input.requestId)));
      if (prior !== undefined) return prior.action === "retry" ? { status: "done", session, repeated: true } : refuse("request_id_reused", "That request ID was already used for something else.");
      // Only a blocked workflow is retried; a task that failed and ended needs a new task.
      if (isEnded(session) || session.summary.workflowBlocked !== true) {
        return refuse("nothing_to_retry", isEnded(session) && session.summary.status === "failed" ? FAILED_TASK_NEEDS_NEW_TASK : NOTHING_TO_RETRY);
      }
      if (session.subject.kind !== "task" || deps.host === undefined) return refuse("unavailable", NOT_AVAILABLE);
      await deps.host.retryWorkflow(session.subject.taskId, input.requestId);
      const request: ControlRequest = { action: "retry", by: developerIdOf(principal), at: now().toISOString() };
      const event: SessionEvent = { eventId: sessionEventId("retried", input.requestId), at: request.at, type: "retried", actor: actorOf(principal), text: `${nameOf(principal)} retried this.` };
      const repeated = await commit(session, input.requestId, request, [], event, { action: "session.retried", person: principal });
      if (repeated === undefined) await afterControl(session);
      return { status: "done", session, repeated: repeated !== undefined };
    },

    /** Closes a session's task through the task flow's own close, after the same checks as a stop. The session ends with it; a closed session has nothing to close. Idempotent by `requestId`; the request, the event and the audit are one transaction. */
    async close(actor: ControlActor, orgId: OrgId, sessionId: SessionId, input: { requestId: string }): Promise<ControlResult> {
      if (!REQUEST_ID.test(input.requestId)) return refuse("invalid", "The request ID is not valid.");
      const principal = await principalOf(actor);
      if (principal === undefined) return refuse("not_found", "There is no such session.");
      const found = await open(principal, orgId, sessionId, "close");
      if ("status" in found) return found;
      const { session } = found;
      const prior = requestOf(await deps.store.get(requestKey(session, input.requestId)));
      if (prior !== undefined) return prior.action === "close" ? { status: "done", session, repeated: true } : refuse("request_id_reused", "That request ID was already used for something else.");
      if (isEnded(session)) return refuse("ended", SESSION_ENDED_MESSAGE);
      if (session.subject.kind !== "task" || deps.host?.closeTask === undefined) return refuse("unavailable", NOT_AVAILABLE);
      await deps.host.closeTask(session.subject.taskId, input.requestId, principal);
      const request: ControlRequest = { action: "close", by: developerIdOf(principal), at: now().toISOString() };
      const event: SessionEvent = { eventId: sessionEventId("status", `closed-${input.requestId}`), at: request.at, type: "status", actor: actorOf(principal), text: `${nameOf(principal)} closed this.` };
      const repeated = await commit(session, input.requestId, request, [], event, { action: "session.closed", person: principal });
      if (repeated === undefined) await afterControl(session);
      return { status: "done", session, repeated: repeated !== undefined };
    },

    /** Gives the agent a message. It is information, kept with its fate; a session that has ended takes none. Idempotent by `requestId` (the same id is the same message). */
    async tell(actor: ControlActor, orgId: OrgId, sessionId: SessionId, input: { requestId: string; text: string }): Promise<ControlResult<{ message: SessionMessage }>> {
      if (!REQUEST_ID.test(input.requestId)) return refuse("invalid", "The request ID is not valid.");
      const text = [...redactText(input.text).replace(/(?![\t\n\r])[\p{Cc}\p{Cf}]/gu, "").trim()].slice(0, SESSION_MESSAGE_MAX_CHARS).join("");
      if (text === "") return refuse("invalid", "A message needs some text.");
      const principal = await principalOf(actor);
      if (principal === undefined) return refuse("not_found", "There is no such session.");
      const found = await open(principal, orgId, sessionId, "tell");
      if ("status" in found) return found;
      const { session } = found;
      // Whether the sender is the task's effective owner (the taker once it was taken over): only their message is an instruction inside the approved plan; anyone else's is information.
      const senderIsOwner = found.access !== undefined ? found.access.owner : session.owner.developerId === developerIdOf(principal);
      const messageId = `msg_${sha(`${session.sessionId}\u0000${input.requestId}`).slice(0, 20)}`;
      const key = agentSessionKey(session.orgId, session.sessionId, `MESSAGE#${messageId}`);
      const prior = await deps.store.get(key);
      if (prior !== undefined) {
        const stored = SessionMessageSchema.safeParse(Object.fromEntries(Object.entries(prior).filter(([name]) => !["pk", "sk", "entityType", "orgId", INDEX_EXPIRY_ATTRIBUTE].includes(name))));
        if (stored.success) return { status: "done", session, repeated: true, message: stored.data };
        return refuse("request_id_reused", "That request ID was already used for something else.");
      }
      if (isEnded(session)) return refuse("ended", SESSION_ENDED_MESSAGE);
      if (session.subject.kind !== "task" || deps.host === undefined) return refuse("unavailable", NOT_AVAILABLE);
      const { host } = deps;
      const taskId = session.subject.taskId;
      if (host.planMessage === undefined && host.deliverMessage === undefined) return refuse("unavailable", NOT_AVAILABLE);
      const principalName = nameOf(principal);
      const author = { developerId: developerIdOf(principal), name: principalName };
      for (let attempt = 1; attempt <= TELL_ATTEMPTS; attempt += 1) {
        const at = now().toISOString();
        // A host with notes plans the message (its items join the message's transaction); any other host answers where it went.
        const plan: MessagePlan = host.planMessage !== undefined
          ? await host.planMessage(taskId, { messageId, text, sessionId: session.sessionId, author, owner: senderIsOwner })
          : await host.deliverMessage!(taskId, { messageId, text });
        const message: SessionMessage = SessionMessageSchema.parse({
          messageId, sessionId: session.sessionId, kind: "steer", source: "app", author, text, createdAt: at, rev: 1,
          delivery: { state: plan.state, at, ...(plan.reason === undefined ? {} : { reason: plan.reason.slice(0, 200) }) },
        });
        const event: SessionEvent = {
          eventId: sessionEventId("steer", messageId), at, type: plan.state === "not_delivered" ? "steer_not_delivered" : plan.state === "delivered" ? "steer_delivered" : "steer", actor: actorOf(principal), source: "app", messageId,
          // The event never holds the message's text.
          text: plan.state === "not_delivered" ? `${principalName} sent a message; it was not delivered${plan.reason === undefined ? "" : `: ${plan.reason}`}.` : `${principalName} sent a message to the agent.`,
        };
        const request: ControlRequest = { action: "tell", by: developerIdOf(principal), at, messageId };
        const stored: TransactItem = { kind: "put", item: { ...key, entityType: "AGENT_SESSION_MESSAGE", orgId: session.orgId, ...jsonOf(message), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(Date.parse(at) / 1000) + KEEP_SECONDS }, condition: when.absent() };
        const extra: TransactItem[] = [stored, ...(plan.items ?? []), ...(plan.state === "queued" ? [queuedSteersItem(session, 1, Date.parse(at))] : [])];
        const committed = await commitOnce(session, input.requestId, request, extra, event, { action: "session.message_sent", person: principal });
        if (!committed.applied && committed.prior === undefined && attempt < TELL_ATTEMPTS) continue;
        if (!committed.applied && committed.prior === undefined) return refuse("unavailable", "That message could not be saved just now. Try again.");
        if (committed.applied && plan.state === "queued" && plan.goLive !== undefined) {
          // Handed to the step that is running, when there is one; otherwise it stays queued and the next step reads its note.
          const live = await plan.goLive();
          if (live.taken) {
            const answered = await answerMessage({ store: deps.store, now, log }, session, message, { state: "delivered" }, live.items ?? []);
            return { status: "done", session, repeated: false, message: answered.message ?? message };
          }
        }
        return { status: "done", session, repeated: !committed.applied, message };
      }
      return refuse("unavailable", "That message could not be saved just now. Try again.");
    },
  };
}

/** An AgentXError's own message (without its code), else a fixed sentence. */
function messageOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : "";
  return typeof code === "string" && message.startsWith(`${code}: `) ? message.slice(code.length + 2) : message === "" ? NOT_AVAILABLE : message;
}

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

// What a task tells the chat thread it was started from, besides what needs a person (`core/notify`, which is unchanged): the PLAN CARD, and three MILESTONES. A milestone handler on the milestone hook (`core/milestones`), so each
// one is written once, in the transaction of the change that caused it, and told again after a failure by the hook's own retries.
//
//   plan ready      the plan waits for review. When the host has a decision gate, this is the plan's approval card (`cards.ts`): it shows the plan's risk, and for a low or medium risk plan it has Approve and Request changes buttons that go
//                   through the same decision gate as the web app (the owner's link, the risk rules, the stale-revision refusal and the repeat answer are the gate's and the sink's). A high risk plan, or one whose approvers do
//                   not take a decision made in this chat, has no button: the card links to the task page, where the signed-in owner decides (owner decision of 2026-11-12; DEC 254zzz73: no step-up). With no gate, a plain line with the link.
//   pull request    the pull request was marked ready for review: one line with its link.
//   done            the task merged or was closed: one line.
//   setup paused    (L4-U5) the task paused before Build because the project's setup stopped working: one message, in the page's own fixed words and where to go, once per re-check (so a task paused twice by the same break says it once). It is a
//                   "someone must act" notice, so it is not one of the milestone lines the host's `milestones` switch turns off. No buttons and no cost: what a fix costs is said where it is pressed, on the web.
//                   The pull request line also carries the setup's evidence line when the check could not be made or finished (a pass never posts here).
//
// Needs-you notices are not these: they are `deliverAttention`'s and stay as they are. There is no step-by-step narration: nothing else is told here.
//
// Every message goes to the task's own thread only (the row `recordTaskThread` wrote when the work started there), and only when that thread's tenant is the task's company's and the host serves the person who started it
// (owner decision 131: `companyOf` and `isMember`; a failing answer sends nothing). Each is sent once: a claim row per session and moment (per plan revision, per set of pull requests) is taken before the send, so a milestone
// told again sends nothing, and the event id is made from the claim, so an adapter drops a resend that raced. The host's `milestones` option turns the three lines off (default on); the plan card is the approval, not a milestone, and
// stays on while the host gives a gate. Nothing here is a reason for the work to fail: a handler that throws is told again, up to the hook's limit.
import { createHash } from "node:crypto";
import { applicationNoticeText } from "../e2e/application-notices.js";
import {
  EVAL_CI_LINE_PATTERN, INDEX_EXPIRY_ATTRIBUTE, SESSION_RETENTION_DAYS, change, orgScoped, when,
  type AgentSessionRecord, type ChannelEvent, type CodeMilestone, type CodeMilestoneKind, type DocumentKey, type DocumentStore, type OrgId, type RegistryView, type WorkflowSnapshot,
} from "@agentx/contracts";
import type { CodeMilestoneHandler } from "../milestones/milestones.js";
import type { DecisionGate } from "../decisions/approval-gate.js";
import { CHAT_METHOD_PREFIX } from "../decisions/strong-methods.js";
import { WORKFLOW_DOCUMENT_KIND, waitingDocumentDigest } from "../decisions/workflow-subject.js";
import { taskKey } from "../task-flow/keys.js";
import { readPlanFeature } from "../report/plan-feature.js";
import { taskSessionId } from "../sessions/create.js";
import { inertTicketTitle } from "../ticket-updates/handler.js";
import { setupBrokenTaskWords, setupEvidenceOf, setupBrokenWarningMessage, setupTrustLineOf } from "../setup-agent/recheck-rows.js";
import { postApprovalCard } from "./cards.js";
import type { OfferCapabilities } from "../task-actions/offers.js";
import { registryPlanCard, sendRegistryNextMessage } from "./thread-task-actions.js";
import type { TaskRecord } from "../task-flow/records.js";
import { personIsServed, tenantIsCompanys, type ChannelCompanyOf, type ChannelMemberRule } from "./company.js";
import { readTaskThread, type TaskThread } from "./threads.js";

type Log = (event: string, fields: Record<string, unknown>) => void;

/** The handler's name on the milestone hook. */
export const CHANNEL_THREAD_HANDLER = "channel_thread";

type Moment = "plan_ready" | "pr_opened" | "done" | "setup_paused";
const MOMENT_OF: Partial<Record<CodeMilestoneKind, Moment>> = { plan_ready: "plan_ready", pr_ready: "pr_opened", merged: "done", closed: "done", setup_paused: "setup_paused" };

/** How long a claim on a notice holds, and how often a send in progress renews it: a send that takes longer than the lease (a slow chat tool) keeps its claim, so a second one cannot take over and post a second card. */
const CLAIM_LEASE_MS = 60_000;
const CLAIM_RENEW_MS = CLAIM_LEASE_MS / 3;
const PULL_REQUESTS_MAX = 3;

export interface ThreadNoticeDeps {
  /** Safe snapshot blocks, loaded only after live thread recipient checks. */
  e2e?: (taskId: string, taskPageUrl?: string) => Promise<unknown[] | undefined>;
  store: DocumentStore;
  /** The chat adapters (`registry.get("channel", name)`). */
  registry: Pick<RegistryView, "get">;
  now: () => number;
  /** Owner decision 131: which company a chat tenant belongs to. A thread in another company's tenant (or nobody's) is never sent to. Absent: one company, whose every tenant is. */
  companyOf?: ChannelCompanyOf | undefined;
  /** Owner decision 131: whether the host serves the person who started the task now. False or a failure sends nothing. Absent: every person is served. */
  isMember?: ChannelMemberRule | undefined;
  /** The three milestone lines, on or off (read at each use). Default on. */
  milestones?: boolean | (() => boolean) | undefined;
  /** The task's page, when the host has an https address for it (a hosted install). Absent: the words tell where to open it. HW5: it is given the task's recorded session id and project too (the page is the session's, or the project's when the task has no session), when the handler knows them. */
  taskUrl?: ((taskId: string, task?: { sessionId?: string; project?: string }) => string | undefined) | undefined;
  /** What tells a person where to open a task when the host has no address to link (fixed words, set by the install). */
  footer?: string | undefined;
  /** L4-U5: the project's setup page, when the host has an https address for it (a hosted install). Absent: the words tell the person to open it in Rovara. */
  setupUrl?: ((project: string) => string | undefined) | undefined;
  /** The decision gate, for the plan card: its risk, revision and digest come from the same load a decision is made on. Absent: no card, and a plain line says the plan is ready. */
  plan?: { gate: Pick<DecisionGate, "requirement"> } | undefined;
  /** Hosted document details, prepared inside the card's durable send claim. */
  document?: ((taskId: string, workflow: WorkflowSnapshot, thread: TaskThread) => Promise<{ url?: string; summary?: string[] }>) | undefined;
  closeout?: ((taskId: string, thread: TaskThread) => Promise<string | undefined>) | undefined;
  /**
   * S1: what the host can serve of the task action registry. Where it is given AND the thread's adapter declares `taskActions` (the host wired the press), the plan card and the pull request line carry the registry's buttons (judged again
   * at each press, for whoever presses); otherwise the cards are exactly what they were.
   */
  taskActions?: OfferCapabilities | undefined;
  log?: Log | undefined;
}

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const eventIdOf = (orgId: OrgId, sessionId: string, key: string): string => `evt_${createHash("sha256").update(JSON.stringify(["thread-notice", orgId, sessionId, key]), "utf8").digest("base64url").slice(0, 32)}`;

/** A pull request's address when it is a plain https address (no sign-in data), else nothing. */
function plainHttpsLink(link: string): string | undefined {
  try {
    const url = new URL(link);
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

const claimKey = (orgId: OrgId, sessionId: string, key: string): DocumentKey => ({ pk: orgScoped(orgId, `CHANNEL_NOTICE#${sessionId}`), sk: key });

async function claim(store: Pick<DocumentStore, "put" | "get">, orgId: OrgId, sessionId: string, key: string, nowMs: number): Promise<"claimed" | "done" | "busy"> {
  const written = await store.put({
    item: { ...claimKey(orgId, sessionId, key), entityType: "CHANNEL_NOTICE", state: "sending", leaseUntil: nowMs + CLAIM_LEASE_MS, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + SESSION_RETENTION_DAYS * 86_400 },
    condition: when.or(when.absent(), when.and(when.eq("state", "sending"), when.lt("leaseUntil", nowMs))),
  });
  if (written.applied) return "claimed";
  return (await store.get(claimKey(orgId, sessionId, key)))?.["state"] === "sending" ? "busy" : "done";
}

/** The key a plan's card is claimed under: one per plan revision and content (the card handler and the reminder's check agree on it). */
const planCardKey = (revision: number, artifactDigest: string): string => `plan#${String(revision)}#${artifactDigest.slice(0, 16)}`;

/**
 * Whether the plan this task waits on now already got its approval card in the thread: the answer the needs-you reminder asks (`deliverAttention`'s `planCarded`), so the thread is not told twice. True only for a task whose plan
 * waits for review right now and whose card for exactly that revision and content was sent and can still be answered; a task waiting for anything else, or a plan revised since its card, is not carded.
 */
export function planCardPosted(deps: { store: Pick<DocumentStore, "get">; now: () => number }): (session: AgentSessionRecord) => Promise<boolean> {
  return async (session) => {
    if (session.subject.kind !== "task") return false;
    const task = await deps.store.get(taskKey(session.subject.taskId));
    const workflow = task?.["workflow"] as Partial<WorkflowSnapshot> | undefined;
    if (task === undefined || (task["orgId"] ?? task["companyId"]) !== session.orgId || task["closedAt"] !== undefined || workflow?.stage !== "PLAN_REVIEW" || workflow.state !== "WAITING" || typeof workflow.revision !== "number") return false;
    const digest = waitingDocumentDigest(workflow as WorkflowSnapshot);
    if (digest === undefined) return false;
    const sessionId = typeof task["sessionId"] === "string" ? task["sessionId"] : session.sessionId;
    const claimed = await deps.store.get(claimKey(session.orgId, sessionId, planCardKey(workflow.revision, digest)));
    // A card nobody can answer any more (it stops being answerable after CARD_TTL_SECONDS) is no card: the reminder is then sent.
    return claimed?.["state"] === "done" && typeof claimed["cardUntil"] === "number" && claimed["cardUntil"] * 1000 > deps.now();
  };
}

/**
 * L4-U5 / DEC 254zzz447: whether the setup message (a task that was paused by an earlier break, or a setup warning) was already told in its thread, for the break that holds the task now: the answer the needs-you reminder asks (`deliverAttention`'s
 * `setupPausedTold`), so the thread is not told twice for one pause. True only for a task that is blocked on a broken re-check whose message was sent; anything else (or a read that fails) is "not told".
 */
export function setupPausedPosted(deps: { store: Pick<DocumentStore, "get"> }): (session: AgentSessionRecord) => Promise<boolean> {
  return async (session) => {
    if (session.subject.kind !== "task") return false;
    const task = await deps.store.get(taskKey(session.subject.taskId));
    const workflow = task?.["workflow"] as Partial<WorkflowSnapshot> | undefined;
    const project = task?.["project"];
    if (task === undefined || (task["orgId"] ?? task["companyId"]) !== session.orgId || task["closedAt"] !== undefined || workflow?.state !== "BLOCKED" || typeof project !== "string") return false;
    const evidence = await setupEvidenceOf({ store: deps.store, companyId: session.orgId }, project, session.subject.taskId);
    if (evidence?.state !== "broken" || evidence.recheckKey === undefined) return false;
    // Only a task still PAUSED by the old setup words (written before DEC 254zzz447, the match `auto-resume.ts` uses): the warning's own claim (a task that keeps running) says nothing about a later block for another reason.
    if (workflow.blockReason !== setupBrokenTaskWords(evidence.failedStep ?? "setup")) return false;
    const sessionId = typeof task["sessionId"] === "string" ? task["sessionId"] : session.sessionId;
    return (await deps.store.get(claimKey(session.orgId, sessionId, `setup_paused#${evidence.recheckKey}`)))?.["state"] === "done";
  };
}

/**
 * Whether the session's task was started from a chat thread: the `follows` of the milestone moments (`ticket-updates/moments.ts`), so a `plan_ready` and a `closed` milestone are written for it. A read only; the row is the
 * company's own, so another company's session reads as not followed.
 */
export function threadFollows(deps: { store: Pick<DocumentStore, "get"> }): (orgId: OrgId, sessionId: string) => Promise<boolean> {
  return async (orgId, sessionId) => (await readTaskThread(deps.store, orgId, sessionId)) !== undefined;
}

/**
 * The two steps every message to a task's thread goes through, shared by the milestone lines and the task log's mirror (`log-mirror.ts`): `reach` finds the adapter of a thread that is this company's and whose person is served,
 * and `send` claims a notice (one row per session and key) before it is delivered, renews the claim while the delivery runs and gives it back when the delivery fails, so a notice is sent once and a failed one is sent again.
 */
export function threadSender(deps: Pick<ThreadNoticeDeps, "store" | "registry" | "now" | "companyOf" | "isMember" | "log">) {
  const log: Log = deps.log ?? (() => undefined);
  /** The thread to tell, when it is this company's and its person is served; otherwise nothing is sent. */
  async function reach(orgId: OrgId, thread: TaskThread) {
    const { conversation } = thread;
    if (!(await tenantIsCompanys(deps.companyOf, orgId, conversation.channel, conversation.tenant))) { log("channel_thread.other_company", { channel: conversation.channel }); return undefined; }
    // A host with a member rule needs the account that started the work to ask it about; a row without one is not sent to.
    if (deps.isMember !== undefined && (thread.actor === undefined || !(await personIsServed(deps.isMember, orgId, thread.personId, thread.actor)))) { log("channel_thread.not_member", { channel: conversation.channel }); return undefined; }
    const adapter = deps.registry.get("channel", conversation.channel);
    return adapter === undefined ? undefined : adapter;
  }

  /** `deliver` may answer when a card it sent stops being answerable (seconds): kept on the claim, so the reminder's check knows an expired card is no card. */
  async function send(orgId: OrgId, sessionId: string, key: string, deliver: () => Promise<void | { cardUntil: number }>): Promise<void> {
    const claimed = await claim(deps.store, orgId, sessionId, key, deps.now());
    if (claimed === "done") return;
    if (claimed === "busy") throw new Error("thread notice in flight");
    const at = claimKey(orgId, sessionId, key);
    // The claim is renewed while the send runs, however long it takes.
    const renew = setInterval(() => { void deps.store.update({ key: at, ops: [change.set("leaseUntil", deps.now() + CLAIM_LEASE_MS)], condition: when.eq("state", "sending") }).catch(() => undefined); }, CLAIM_RENEW_MS);
    renew.unref();
    let sent: void | { cardUntil: number };
    try {
      sent = await deliver();
    } catch (error) {
      await deps.store.delete({ key: at, condition: when.eq("state", "sending") }).catch(() => undefined);
      throw error;
    } finally {
      clearInterval(renew);
    }
    await deps.store.update({ key: at, ops: [change.set("state", "done"), change.remove("leaseUntil"), ...(sent === undefined ? [] : [change.set("cardUntil", sent.cardUntil)])] }).catch(() => undefined);
  }
  return { reach, send };
}

// Cleanup and a request for a person still run when milestone lines are muted.
function handlesMoment(moment: Moment, cards: boolean, milestones: boolean): boolean {
  return moment === "setup_paused" || moment === "done" || (moment === "plan_ready" ? cards || milestones : milestones);
}

export function channelThreadHandler(deps: ThreadNoticeDeps): CodeMilestoneHandler {
  const log: Log = deps.log ?? (() => undefined);
  const milestonesOn = (): boolean => (typeof deps.milestones === "function" ? deps.milestones() : deps.milestones !== false);
  const open = (taskId: string, where?: { sessionId?: string; project?: string }): string => {
    const link = deps.taskUrl?.(taskId, where);
    return link !== undefined ? link : deps.footer ?? "";
  };
  const { reach, send } = threadSender({ ...deps, log });

  return {
    name: CHANNEL_THREAD_HANDLER,
    async on(milestone: CodeMilestone): Promise<void> {
      const moment = MOMENT_OF[milestone.kind];
      if (moment === undefined) return;
      const cards = deps.plan !== undefined;
      if (!handlesMoment(moment, cards, milestonesOn())) return;
      const { orgId, taskId } = milestone;
      const task = await deps.store.get(taskKey(taskId));
      const taskOrg = task?.["orgId"] ?? task?.["companyId"];
      if (task === undefined || taskOrg !== orgId) return;
      const sessionId = typeof task["sessionId"] === "string" ? task["sessionId"] : milestone.sessionId ?? taskSessionId(taskId);
      const thread = await readTaskThread(deps.store, orgId, sessionId);
      if (thread === undefined) return;
      const adapter = await reach(orgId, thread);
      if (adapter === undefined) return;
      // The task's own page: its recorded session (a task without one has none), else its project's.
      const taskWhere = { ...(typeof task["sessionId"] === "string" ? { sessionId: task["sessionId"] } : {}), ...(typeof task["project"] === "string" ? { project: task["project"] } : {}) };
      const title = inertTicketTitle(typeof task["title"] === "string" ? task["title"] : "");
      const { conversation } = thread;
      const base = (key: string) => ({ version: 1 as const, id: eventIdOf(orgId, sessionId, key), channel: conversation.channel, conversation, createdAt: new Date(deps.now()).toISOString() });
      const tell = (event: ChannelEvent): Promise<void> => adapter.deliver(event);
      const where = open(taskId, taskWhere);

      if (moment === "setup_paused") {
        // The words come from the project's own re-check rows (never from the milestone's text), and only while the task's re-check says the setup is broken. Once per session and break (the claim key).
        const project = typeof task["project"] === "string" ? task["project"] : undefined;
        if (project === undefined || task["closedAt"] !== undefined) return;
        const evidence = await setupEvidenceOf({ store: deps.store, companyId: orgId }, project, taskId);
        if (evidence?.state !== "broken" || evidence.recheckKey === undefined) return;
        const key = `setup_paused#${evidence.recheckKey}`;
        await send(orgId, sessionId, key, () => tell({ ...base(key), type: "progress", data: { text: setupBrokenWarningMessage(evidence.failedStep ?? "setup", deps.setupUrl?.(project)) } }));
        return;
      }

      if (moment === "plan_ready") {
        const workflow = task["workflow"] as Partial<WorkflowSnapshot> | undefined;
        if (task["closedAt"] !== undefined || workflow?.stage !== "PLAN_REVIEW" || workflow.state !== "WAITING") return;
        if (deps.plan === undefined) {
          const key = `plan_ready#${String(workflow.revision)}`;
          await send(orgId, sessionId, key, () => tell({ ...base(key), type: "progress", data: { text: `The plan for "${title}" is ready for review.${where === "" ? "" : ` ${where}`}` } }));
          return;
        }
        // The plan as a decision is made on it: its revision, digest and risk come from the gate's own load of the subject. A plan that no longer waits has no card.
        const found = await deps.plan.gate.requirement(orgId, WORKFLOW_DOCUMENT_KIND, taskId);
        if (found === undefined) return;
        const risk = found.risk === "low" || found.risk === "medium" ? found.risk : "high";
        const key = planCardKey(found.revision, found.artifactDigest);
        // Buttons only where the approvers take a decision made in this chat (and never for a high risk plan); otherwise the card is a pointer to the task page.
        const chatTakes = risk !== "high" && found.requirement.methods.includes(`${CHAT_METHOD_PREFIX}${conversation.channel}`);
        const taskUrl = deps.taskUrl?.(taskId, taskWhere);
        // Lead 4 PCF: the task's feature as one line (no cost, no controls here: "Change" is on the task page). A read that fails leaves the line out and never holds the card back.
        const feature = await readPlanFeature({ store: deps.store, companyId: orgId, now: deps.now }, { taskId, project: typeof task["project"] === "string" ? task["project"] : "" }, { mayFile: false, manager: false, admin: false });
        const words = `The plan for "${title}" is ready for review. Risk: ${risk}.${feature === undefined ? "" : `\n${feature.feature === null ? feature.line : feature.line.replace(feature.feature.name, inertTicketTitle(feature.feature.name))}`}`;
        // Request changes asks "What should change?" in a form the chat opens (an adapter that declares `forms`); a chat with none sends the person to the task page for it instead, and the card offers Approve alone.
        const asks = adapter.capabilities.forms === true;
        const extra = chatTakes
          ? (asks ? (taskUrl === undefined ? undefined : `Details: ${taskUrl}`) : `To ask for changes, open the task page.${taskUrl !== undefined ? ` ${taskUrl}` : deps.footer !== undefined ? `\n${deps.footer}` : ""}`)
          : (taskUrl === undefined ? deps.footer : undefined);
        await send(orgId, sessionId, key, async () => {
          const document = await deps.document?.(taskId, workflow as WorkflowSnapshot, thread);
          const detail = [document?.summary?.join("\n"), document?.url].filter(Boolean).join("\n");
          const cardWords = `${extra === undefined ? words : `${words}\n${extra}`}${detail === "" ? "" : `\n${detail}`}`;
          // S1: where the adapter takes the registry's presses, the plan card is the registry's: Approve, Request changes (and Reject where the approvers take it from the chat), judged again at each press.
          const registryCard = await registryPlanCard({
            capabilities: adapter.capabilities, served: deps.taskActions, chatTakes, requirement: found.requirement, chatMethod: `${CHAT_METHOD_PREFIX}${conversation.channel}`,
            task: task as unknown as TaskRecord, taskUrl, text: cardWords, nowMs: deps.now(), deliver: (data) => adapter.deliver({ ...base(key), type: "message", data }),
          });
          if (registryCard !== undefined) return registryCard;
          const posted = await postApprovalCard({ store: deps.store, orgId, now: deps.now, companyOf: deps.companyOf }, {
            channel: conversation.channel, adapter, conversation, kind: "plan_approval", subject: { type: WORKFLOW_DOCUMENT_KIND, id: taskId }, revision: found.revision, artifactDigest: found.artifactDigest, risk, signInOnly: !chatTakes,
            text: cardWords,
            ...(taskUrl === undefined ? {} : { taskUrl }),
            actions: chatTakes ? [{ decision: "APPROVE", label: "Approve" }, ...(asks ? [{ decision: "REQUEST_CHANGES" as const, label: "Request changes" }] : [])] : [],
          });
          return { cardUntil: posted.expiresAt };
        });
        return;
      }

      if (moment === "pr_opened") {
        const requests = (milestone.pullRequests ?? []).slice(0, PULL_REQUESTS_MAX);
        const key = `pr_opened#${sha(requests.map((request) => `${request.repository}#${String(request.number)}`).join(",")).slice(0, 24)}`;
        const links = requests.flatMap((request) => plainHttpsLink(request.url) ?? []);
        // L4-U5: when the setup could not be re-checked (or the check did not finish), the one evidence line goes with the pull request, in the page's own words. A pass never does.
        const project = typeof task["project"] === "string" ? task["project"] : undefined;
        const trust = project === undefined ? undefined : await setupTrustLineOf({ store: deps.store, companyId: orgId }, project, taskId);
        // L4-EVCI: the customer's own eval result, when it had landed by the time the pull request was marked ready: the same one line as in the description (fixed words, numbers and a plain https address; a line that is
        // not exactly Rovara's own words is not sent). The typed pull request card has no place for either line, so a ready line that carries one is the plain progress text (which keeps the verdict heading).
        const evalLine = milestone.evalLine !== undefined && EVAL_CI_LINE_PATTERN.test(milestone.evalLine) ? milestone.evalLine : undefined;
        const e2e = applicationNoticeText(await deps.e2e?.(taskId, deps.taskUrl?.(taskId, taskWhere)).catch(() => undefined));
        await send(orgId, sessionId, key, () => tell(links.length === 1 && trust === undefined && evalLine === undefined && e2e === ""
          ? { ...base(key), type: "pr", data: { url: links[0]!, title, action: "opened", ...(milestone.verdict === undefined ? {} : { verdict: milestone.verdict }) } }
          : { ...base(key), type: "progress", data: { text: `A pull request is ready for review for "${title}".${milestone.verdict === undefined ? "" : ` ${milestone.verdict}.`}${links.map((link) => `\n${link}`).join("")}${evalLine === undefined ? "" : `\n${evalLine}`}${trust === undefined ? "" : `\n${trust}`}${e2e === "" ? "" : `\n${e2e}`}`.slice(0, adapter.capabilities.maxTextLength) } }));
        // S1: where the adapter takes the registry's presses, what the task offers once its pull request is ready (merge, close, ...) follows as buttons, judged again at each press.
        const next = `${key}#actions`;
        await sendRegistryNextMessage({ capabilities: adapter.capabilities, served: deps.taskActions, task: task as unknown as TaskRecord, taskUrl: deps.taskUrl?.(taskId, taskWhere),
          send: (deliver) => send(orgId, sessionId, next, deliver), deliver: (data) => tell({ ...base(next), type: "message", data }) });
        return;
      }

      // done: merged or closed, one line. A task is done once.
      const merged = milestone.kind === "merged";
      const tellDone = async (closeout: string | undefined): Promise<void> => {
        if (milestonesOn()) await send(orgId, sessionId, "done", () => tell({ ...base("done"), type: "done", data: { text: closeout ?? (merged ? `"${title}" is merged.` : `"${title}" was closed without a merge.`), outcome: merged ? "succeeded" : "cancelled" } }));
      };
      await Promise.resolve().then(() => deps.closeout?.(taskId, thread)).then(tellDone, async (error: unknown) => {
        // The final post has its own durable claim. Preserve the cleanup failure
        // even if posting also fails, so pending deletion always stays due.
        await tellDone(undefined).catch(() => undefined);
        throw error;
      });
    },
  };
}

// What a task tells the chat thread it was started from when its plan waits for review: the PLAN CARD (`cards.ts`). A milestone handler on the milestone hook (`core/milestones`), so a `plan_ready` milestone is written once, in the
// transaction of the change that caused it, and told again after a failure by the hook's own retries.
//
//   plan ready      the plan waits for review. The card shows the plan's risk; for a low or medium risk plan it has Approve and Request changes buttons that go through the same decision gate as the web app (the owner's link, the risk
//                   rules, the stale-revision refusal and the repeat answer are the gate's and the sink's). A high risk plan, or one whose approvers do not take a decision made in this chat, has no button: the card links to the task
//                   page, where approval needs a fresh sign-in (owner decision of 2026-11-12).
//
// The card goes to the task's own thread only (the row `recordTaskThread` wrote when the work started there), and only when that thread's tenant is the task's company's and the host serves the person who started it (owner decision 131:
// `companyOf` and `isMember`; a failing answer sends nothing). It is posted once per plan revision: a claim row per session and plan is taken before the send, so a milestone told again sends nothing. A handler that throws is told
// again, up to the hook's limit.
import {
  INDEX_EXPIRY_ATTRIBUTE, SESSION_RETENTION_DAYS, change, orgScoped, when,
  type CodeMilestone, type DocumentKey, type DocumentStore, type OrgId, type RegistryView, type WorkflowSnapshot,
} from "@agentx/contracts";
import type { CodeMilestoneHandler } from "../milestones/milestones.js";
import type { DecisionGate } from "../decisions/approval-gate.js";
import { CHAT_METHOD_PREFIX } from "../decisions/strong-methods.js";
import { WORKFLOW_DOCUMENT_KIND } from "../decisions/workflow-subject.js";
import { taskKey } from "../task-flow/keys.js";
import { taskSessionId } from "../sessions/create.js";
import { inertTicketTitle } from "../ticket-updates/handler.js";
import { postApprovalCard } from "./cards.js";
import { personIsServed, tenantIsCompanys, type ChannelCompanyOf, type ChannelMemberRule } from "./company.js";
import { readTaskThread, type TaskThread } from "./threads.js";

type Log = (event: string, fields: Record<string, unknown>) => void;

/** The handler's name on the milestone hook. */
export const CHANNEL_THREAD_HANDLER = "channel_thread";

const CLAIM_LEASE_MS = 60_000;

export interface ThreadNoticeDeps {
  store: DocumentStore;
  /** The chat adapters (`registry.get("channel", name)`). */
  registry: Pick<RegistryView, "get">;
  now: () => number;
  /** Owner decision 131: which company a chat tenant belongs to. A thread in another company's tenant (or nobody's) is never sent to. Absent: one company, whose every tenant is. */
  companyOf?: ChannelCompanyOf | undefined;
  /** Owner decision 131: whether the host serves the person who started the task now. False or a failure sends nothing. Absent: every person is served. */
  isMember?: ChannelMemberRule | undefined;
  /** The task's page, when the host has an https address for it (a hosted install). Absent: the words tell where to open it. */
  taskUrl?: ((taskId: string) => string | undefined) | undefined;
  /** What tells a person where to open a task when the host has no address to link (fixed words, set by the install). */
  footer?: string | undefined;
  /** The decision gate, for the plan card: its risk, revision and digest come from the same load a decision is made on. Absent: no card. */
  plan?: { gate: Pick<DecisionGate, "requirement"> } | undefined;
  log?: Log | undefined;
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

/**
 * Whether the session's task was started from a chat thread: the `follows` of the milestone moments (`ticket-updates/moments.ts`), so a `plan_ready` and a `closed` milestone are written for it. A read only; the row is the
 * company's own, so another company's session reads as not followed.
 */
export function threadFollows(deps: { store: Pick<DocumentStore, "get"> }): (orgId: OrgId, sessionId: string) => Promise<boolean> {
  return async (orgId, sessionId) => (await readTaskThread(deps.store, orgId, sessionId)) !== undefined;
}

export function channelThreadHandler(deps: ThreadNoticeDeps): CodeMilestoneHandler {
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

  async function send(orgId: OrgId, sessionId: string, key: string, deliver: () => Promise<void>): Promise<void> {
    const claimed = await claim(deps.store, orgId, sessionId, key, deps.now());
    if (claimed === "done") return;
    if (claimed === "busy") throw new Error("thread notice in flight");
    try {
      await deliver();
    } catch (error) {
      await deps.store.delete({ key: claimKey(orgId, sessionId, key), condition: when.eq("state", "sending") }).catch(() => undefined);
      throw error;
    }
    await deps.store.update({ key: claimKey(orgId, sessionId, key), ops: [change.set("state", "done"), change.remove("leaseUntil")] }).catch(() => undefined);
  }

  return {
    name: CHANNEL_THREAD_HANDLER,
    async on(milestone: CodeMilestone): Promise<void> {
      if (milestone.kind !== "plan_ready" || deps.plan === undefined) return;
      const { orgId, taskId } = milestone;
      const task = await deps.store.get(taskKey(taskId));
      const taskOrg = task?.["orgId"] ?? task?.["companyId"];
      if (task === undefined || taskOrg !== orgId) return;
      const sessionId = typeof task["sessionId"] === "string" ? task["sessionId"] : milestone.sessionId ?? taskSessionId(taskId);
      const thread = await readTaskThread(deps.store, orgId, sessionId);
      if (thread === undefined) return;
      const adapter = await reach(orgId, thread);
      if (adapter === undefined) return;
      const title = inertTicketTitle(typeof task["title"] === "string" ? task["title"] : "");
      const { conversation } = thread;
      const workflow = task["workflow"] as Partial<WorkflowSnapshot> | undefined;
      if (task["closedAt"] !== undefined || workflow?.stage !== "PLAN_REVIEW" || workflow.state !== "WAITING") return;
      // The plan as a decision is made on it: its revision, digest and risk come from the gate's own load of the subject. A plan that no longer waits has no card.
      const found = await deps.plan.gate.requirement(orgId, WORKFLOW_DOCUMENT_KIND, taskId);
      if (found === undefined) return;
      const risk = found.risk === "low" || found.risk === "medium" ? found.risk : "high";
      const key = `plan#${String(found.revision)}#${found.artifactDigest.slice(0, 16)}`;
      // Buttons only where the approvers take a decision made in this chat (and never for a high risk plan); otherwise the card is a pointer to the task page.
      const chatTakes = risk !== "high" && found.requirement.methods.includes(`${CHAT_METHOD_PREFIX}${conversation.channel}`);
      const taskUrl = deps.taskUrl?.(taskId);
      const words = `The plan for "${title}" is ready for review. Risk: ${risk}.`;
      await send(orgId, sessionId, key, async () => {
        await postApprovalCard({ store: deps.store, orgId, now: deps.now, companyOf: deps.companyOf }, {
          channel: conversation.channel, adapter, conversation, kind: "plan_approval", subject: { type: WORKFLOW_DOCUMENT_KIND, id: taskId }, revision: found.revision, artifactDigest: found.artifactDigest, risk, signInOnly: !chatTakes,
          text: chatTakes && taskUrl !== undefined ? `${words}\nDetails: ${taskUrl}` : taskUrl === undefined && deps.footer !== undefined ? `${words}\n${deps.footer}` : words,
          ...(taskUrl === undefined ? {} : { taskUrl }),
          actions: chatTakes ? [{ decision: "APPROVE", label: "Approve" }, { decision: "REQUEST_CHANGES", label: "Request changes" }] : [],
        });
      });
    },
  };
}

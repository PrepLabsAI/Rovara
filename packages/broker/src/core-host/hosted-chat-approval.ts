// HW5b (owner decision 2026-11-18, matching the laptop's rule of 2026-11-12: `ports/policy-defaults.ts` `chat`): the ONE more method the hosted approvers offer where the deployment serves a chat, `chat-<channel>` (`chat-slack`).
// (`hosted-approvers.ts` has the install's one other method, `rovara-step-up`, and the rule for who may decide a task's plan.)
//
// A chat press proves one act and no sign-in, so it is never a strong method (`core/decisions/strong-methods.ts`): it is offered only for a task's plan of LOW or MEDIUM risk, only for an approval or a request for changes (never a
// rejection, never a setup candidate), and `verify` accepts it only when ALL of these hold, each read now and none taken from the press:
//   - the press names a chat account of this chat, in a workspace that belongs to the request's company (`chat.companyOf`);
//   - that account is linked to a Rovara person (`chat.personOf`: the company's own link or the chat's sign-in membership) who is a LIVE member of the company (the identity point);
//   - that person is the task's own person (`developerId` on the stored task, the web's rule) and still holds a project grant (`chat.holdsProjectGrant`, the web performer's `ownTask` rule);
//   - the request is the gate's own (the proof binds nothing the gate did not build from stored state: request id, revision and digest are checked against the request; the card ref is not used).
// There is no one-time part to claim: the gate's used-proof marker (one per card and account, `chat-decision.ts` `chatPressToken`) is what makes a press act once; a repeat of a finished decision verifies again and replays.
// Refusals are fixed words (a reason code), never the token, the person or what was sent. This file writes nothing.
import { OrgIdSchema, type ApprovalProof, type ApprovalRequest, type ApprovalVerdict, type DocumentStore, type ExternalAccountRef, type IdentityProvider, type Principal } from "@agentx/contracts";
import type { ChannelCompanyOf } from "../core/channel/company.js";
import { taskKey } from "../core/task-flow/keys.js";
import { CHAT_METHOD_PREFIX } from "../ports/policy-defaults.js";

/** The chat a deployment lets a person approve a low or medium risk plan in. Every answer is read at each use. */
export interface HostedChatApproval {
  /** The chat's name (`slack`); its method is `chat-<channel>`. */
  channel: string;
  /** Which company a workspace of the chat belongs to (undefined, or a failure: nobody's). */
  companyOf: ChannelCompanyOf;
  /** The Rovara person a chat account is in this company, by a link or the chat's own sign-in membership; undefined: nobody (unlinked). */
  personOf(companyId: string, account: ExternalAccountRef): Promise<string | undefined>;
  /** Whether the person holds a grant on the project now (the web performer's rule). A failure is no grant. */
  holdsProjectGrant(companyId: string, personId: string, project: string): Promise<boolean>;
}

/** The credential method a press in this chat carries. */
export const chatApprovalMethod = (channel: string): string => `${CHAT_METHOD_PREFIX}${channel}`;

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The chat method as one more method of a request's requirement: for a task's plan of low or medium risk only (a probe, a setup candidate, any other subject or a high risk offers none). */
export function chatMethodsOf(chat: HostedChatApproval | undefined, request: Pick<ApprovalRequest, "subject" | "risk"> | undefined): string[] {
  return chat !== undefined && request?.subject?.type === "task" && (request.risk === "low" || request.risk === "medium") ? [chatApprovalMethod(chat.channel)] : [];
}

export interface ChatVerifyDeps {
  store: Pick<DocumentStore, "get">;
  identity: Pick<IdentityProvider, "getPrincipal">;
  now: () => number;
}

/** A press in the chat (see the file comment). Every refusal is decided before anything is read past the checks; this writes nothing. */
export async function verifyChatPress(deps: ChatVerifyDeps, allowed: HostedChatApproval, request: ApprovalRequest, proof: ApprovalProof): Promise<ApprovalVerdict> {
  const refuse = (reason: string): ApprovalVerdict => ({ approved: false, reason });
  const companyId = request.companyId;
  const subject = request.subject;
  // A task's plan only: never a project's setup candidate, never another kind of subject.
  if (typeof companyId !== "string" || !OrgIdSchema.safeParse(companyId).success || subject?.type !== "task" || typeof subject.id !== "string" || !TASK_ID.test(subject.id)) return refuse("no_rule_for_this_request");
  // Never above medium (a request with no risk named is not low), never a rejection.
  if (request.risk !== "low" && request.risk !== "medium") return refuse("chat_not_enough_for_this_risk");
  const outcome = request.outcome ?? "approve";
  if (outcome !== "approve" && outcome !== "request_changes") return refuse("chat_cannot_reject");
  if (typeof request.requestId !== "string" || proof.requestId !== request.requestId) return refuse("other_request");
  if (proof.revision !== request.revision) return refuse("other_revision");
  if (proof.artifactDigest !== request.artifactDigest) return refuse("other_content");
  if (typeof proof.token !== "string" || proof.token === "") return refuse("not_a_valid_proof");
  if (request.expiresAt !== undefined && !(deps.now() < Date.parse(request.expiresAt))) return refuse("expired");
  const account = proof.claimedAccount;
  if (account === undefined || account.provider !== allowed.channel || typeof account.tenant !== "string" || typeof account.accountId !== "string") return refuse("account_mismatch");
  // The workspace the press came from must be this company's.
  let workspaceCompany: string | undefined;
  try { workspaceCompany = await allowed.companyOf({ channel: allowed.channel, tenant: account.tenant }); } catch { workspaceCompany = undefined; }
  if (workspaceCompany !== companyId) return refuse("wrong_company");
  // Who: the account's linked person, a live member of the company, and the task's own person with the project's grant (all read now).
  let personId: string | undefined;
  let person: Principal | undefined;
  let task: Record<string, unknown> | undefined;
  try {
    personId = await allowed.personOf(companyId, account);
    person = personId === undefined ? undefined : await deps.identity.getPrincipal(companyId, personId);
    task = person === undefined ? undefined : await deps.store.get(taskKey(subject.id));
  } catch {
    return refuse("people_unreadable");
  }
  if (personId === undefined || person === undefined || person.companyId !== companyId || person.personId !== personId) return refuse("not_a_member");
  if (task === undefined || task["companyId"] !== companyId || task["taskId"] !== subject.id || typeof task["developerId"] !== "string" || task["developerId"] !== personId) return refuse("not_the_task_owner");
  if (typeof task["project"] !== "string" || (request.projectName !== undefined && task["project"] !== request.projectName)) return refuse("not_the_task_owner");
  const granted = await allowed.holdsProjectGrant(companyId, personId, task["project"]).then((answer) => answer === true, () => false);
  if (!granted) return refuse("not_the_task_owner");
  return { approved: true, approver: { ...person }, method: proof.method, proofId: proof.proofId };
}

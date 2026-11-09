// Lane L8: commands in pull request and issue comments (`/rovara approve`, `/rovara changes: ...`, `/rovara lesson 3 wrong`, `/rovara stop`). The grammar is
// the loop's own (contracts/rovara-comment.ts). What this adds is the question the loop never had to ask when the person ran it on their own machine:
// is this comment good enough to act on? A comment is a claim, not a fact, so:
//
//   - only a freshly created comment runs; an edit never does (a person could approve a plan, then edit the comment into something else);
//   - the permission of its author comes from the code host, looked up by the comment's id, never from the event's own payload;
//   - an approval is a W0 `ApprovalProof` with method `code-host-comment` and the comment id as its token: the task flow hands it to the `Approvers`
//     seam, which looks the comment up again and checks that it names this request, revision and digest;
//   - a comment posted before the plan it would approve was posted does not approve that plan (the plan moved on; the person is asked again);
//   - one comment runs once: webhook redelivery finds its claim in the document store and does nothing.
//
// Nothing here knows GitHub: the event, the permission lookup and the reply come from the code host adapter, through the three seams below.
import {
  IMPLICIT_COMPANY_ID, companyScoped, parseRovaraComment, when,
  type ApprovalProof, type DocumentStore, type ExternalAccountRef,
} from "@agentx/contracts";
import { CODE_HOST_COMMENT_METHOD } from "../../ports/policy-defaults.js";
import type { ApprovalOffer, LocalActionResult } from "../local-pages/views.js";

/** A comment on a pull request or an issue, as the code host adapter reports it. */
export interface PrCommentEvent {
  companyId: string;
  /** Only `created` runs. */
  action: "created" | "edited" | "deleted";
  /** The repository as the code host names it (`owner/name` on GitHub). */
  repository: string;
  number: number;
  commentId: string;
  body: string;
  /** When the comment was posted (ISO time), as the code host recorded it. */
  createdAt: string;
  author: ExternalAccountRef;
  /** The author is an automation account (including Rovara's own). */
  authorIsBot: boolean;
}

export type CommentPermission = "none" | "read" | "write" | "admin";

/** The code host adapter's answers. Each looks the comment up at the host; none believes the event. */
export interface PrCommentHost {
  /** The permission the comment's author holds on the comment's repository, looked up by the comment's id. */
  authorPermission(event: PrCommentEvent): Promise<CommentPermission>;
  /** Posts a short reply under the comment. A failure to reply never undoes a command. */
  reply(event: PrCommentEvent, text: string): Promise<void>;
}

/** What waits for a decision on this change request. */
export interface PendingOffer {
  taskId: string;
  approval: ApprovalOffer;
  /** When the plan or design this offer is for was posted (ISO time). */
  postedAt: string;
  /** The repository the task works on, as the host names it. */
  repository: string;
}

/** The task flow's side (lanes L6b and L7b implement it). */
export interface PrCommandWorld {
  pendingFor(change: { repository: string; number: number }): Promise<PendingOffer | undefined>;
  decide(input: { taskId: string; decision: "approve" | "changes"; note?: string; approval: ApprovalOffer; proof: ApprovalProof }): Promise<LocalActionResult>;
  /** `number` is the position in the "Lessons used" list of the pull request. */
  lesson(input: { repository: string; number: number; lessonNumber: number; verdict: "wrong" | "right" | "retire" }): Promise<LocalActionResult>;
  stop(input: { repository: string; number: number }): Promise<LocalActionResult>;
}

export type PrCommandOutcome =
  | { handled: false; reason: "not_a_command" | "not_created" | "bot" | "no_permission" | "duplicate" | "other_command" }
  | { handled: true; command: "approve" | "changes" | "lesson" | "stop" | "invalid"; result: "done" | LocalActionResult };

export interface PrCommandsOptions {
  store: DocumentStore;
  host: PrCommentHost;
  world: PrCommandWorld;
  /** Seconds a claim on a comment is kept (a redelivery after this is a new comment to the store). Default: 30 days. */
  claimSeconds?: number;
  now?: () => Date;
}

const CLAIMS = "PRCOMMENT";
const SPEAKS = new Set<CommentPermission>(["write", "admin"]);

const sentenceFor = (result: LocalActionResult, done: string): string =>
  result.ok ? (result.message ?? done) : result.reason === "stale" ? "That changed after you wrote this, so nothing was sent. Read the latest and say it again." : result.message;

export function createPrCommentCommands(options: PrCommandsOptions): { handle(event: PrCommentEvent): Promise<PrCommandOutcome> } {
  const now = options.now ?? (() => new Date());
  const claimSeconds = options.claimSeconds ?? 30 * 24 * 3600;

  const say = async (event: PrCommentEvent, text: string): Promise<void> => {
    try {
      await options.host.reply(event, text);
    } catch { /* a reply that fails never undoes what was done */ }
  };

  return {
    async handle(event) {
      if (event.action !== "created") return { handled: false, reason: "not_created" };
      if (event.authorIsBot) return { handled: false, reason: "bot" };
      const parsed = parseRovaraComment(event.body);
      if (parsed.kind === "reply") return { handled: false, reason: "not_a_command" };
      if (parsed.kind === "other" || parsed.kind === "file") return { handled: false, reason: "other_command" };
      const permission = await options.host.authorPermission(event);
      if (!SPEAKS.has(permission)) return { handled: false, reason: "no_permission" };

      // One comment, one run. The claim is taken first; a failure that the host could retry gives it back.
      const key = { pk: companyScoped(event.companyId === "" ? IMPLICIT_COMPANY_ID : event.companyId, CLAIMS), sk: `${event.repository}#${event.commentId}` };
      const claimed = await options.store.put({ item: { ...key, claimedAt: now().toISOString(), expiresAt: Math.floor(now().getTime() / 1000) + claimSeconds }, condition: when.absent() });
      if (!claimed.applied) return { handled: false, reason: "duplicate" };
      try {
        if (parsed.kind === "invalid") {
          await say(event, parsed.reason);
          return { handled: true, command: "invalid", result: "done" };
        }
        if (parsed.kind === "stop") {
          const result = await options.world.stop({ repository: event.repository, number: event.number });
          await say(event, sentenceFor(result, "Stopped."));
          return { handled: true, command: "stop", result };
        }
        if (parsed.kind === "lesson") {
          const result = await options.world.lesson({ repository: event.repository, number: event.number, lessonNumber: parsed.number, verdict: parsed.verdict });
          await say(event, sentenceFor(result, "Thanks. I noted that."));
          return { handled: true, command: "lesson", result };
        }
        // approve / changes
        const pending = await options.world.pendingFor({ repository: event.repository, number: event.number });
        if (pending === undefined) {
          await say(event, "Nothing is waiting for a decision here.");
          return { handled: true, command: parsed.kind, result: { ok: false, reason: "not_found", message: "Nothing is waiting for a decision here." } };
        }
        if (parsed.kind === "approve" && parsed.repo !== undefined && parsed.repo.toLowerCase() !== pending.repository.toLowerCase()) {
          const message = `That names ${parsed.repo}, but this is about ${pending.repository}. Nothing was approved.`;
          await say(event, message);
          return { handled: true, command: "approve", result: { ok: false, reason: "refused", message } };
        }
        // A comment written before the plan was posted answers an older plan.
        if (Date.parse(event.createdAt) < Date.parse(pending.postedAt)) {
          const message = "That was written before the latest version was posted, so nothing was sent. Read the latest and say it again.";
          await say(event, message);
          return { handled: true, command: parsed.kind, result: { ok: false, reason: "stale", message } };
        }
        const proof: ApprovalProof = {
          proofId: `pr-comment-${event.commentId}`, method: CODE_HOST_COMMENT_METHOD, requestId: pending.approval.requestId, revision: pending.approval.revision,
          artifactDigest: pending.approval.artifactDigest, token: event.commentId, claimedAccount: event.author,
        };
        const result = await options.world.decide({
          taskId: pending.taskId, decision: parsed.kind, ...(parsed.kind === "changes" ? { note: parsed.text } : {}), approval: pending.approval, proof,
        });
        await say(event, sentenceFor(result, parsed.kind === "approve" ? "Approved. I am going ahead." : "Got it. I will change the plan and post it again."));
        return { handled: true, command: parsed.kind, result };
      } catch (error) {
        // Give the claim back so the host's redelivery can try again, then let the caller see the failure.
        await options.store.delete({ key }).catch(() => undefined);
        throw error;
      }
    },
  };
}

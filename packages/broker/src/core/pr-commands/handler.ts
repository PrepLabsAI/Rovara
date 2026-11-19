// Lane L8: commands in pull request and issue comments (`/rovara approve`, `/rovara changes: ...`, `/rovara lesson 3 wrong`, `/rovara stop`). The grammar is
// the loop's own (contracts/rovara-comment.ts). What this adds is the question the loop never had to ask when the person ran it on their own machine:
// is this comment good enough to act on? A comment is a claim, not a fact, so:
//
//   - only a freshly created comment runs; an edit never does (a person could approve a plan, then edit the comment into something else: the host's own edit record decides, `updatedAt`);
//   - the comment itself (text, author, time, permission) is read back from the code host by id; the webhook only names it;
//   - an approval is a W0 `ApprovalProof` with method `code-host-comment` and the comment id as its token: the task flow hands it to the `Approvers`
//     seam, which looks the comment up again and checks that it names this request, revision and digest;
//   - a comment posted before the plan it would approve was posted does not approve that plan (the plan moved on; the person is asked again);
//   - one comment runs once: webhook redelivery finds its claim in the document store and does nothing.
//
// Nothing here knows GitHub: the event, the permission lookup and the reply come from the code host adapter, through the three seams below.
import {
  IMPLICIT_COMPANY_ID, companyScoped, isRovareReplyComment, parseRovaraComment, when,
  type ApprovalProof, type DocumentStore, type ExternalAccountRef,
} from "@agentx/contracts";
import { CODE_HOST_COMMENT_METHOD } from "../../ports/policy-defaults.js";
import { digestNamed, shortDigest } from "./comment-checks.js";
import type { ApprovalOffer, LocalActionResult } from "../local-pages/views.js";

/** What the webhook says happened. Only the reference is believed: everything else is read back from the host (`PrCommentHost.lookupComment`). */
export interface PrCommentEvent {
  companyId: string;
  /** Only `created` runs. */
  action: "created" | "edited" | "deleted";
  /** The repository as the code host names it (`owner/name` on GitHub). */
  repository: string;
  number: number;
  commentId: string;
}

export type CommentPermission = "none" | "read" | "write" | "admin";

/** A comment as the code host itself reports it. */
export interface LookedUpComment {
  body: string;
  /** When the host recorded the comment (ISO time). */
  createdAt: string;
  author: ExternalAccountRef;
  /** The author's permission on the comment's repository. */
  authorPermission: CommentPermission;
  /** The author is an automation account. */
  authorIsBot: boolean;
  /** When the host last recorded a change to the text (`createdAt` again when it was never edited). */
  updatedAt: string;
  /** The change request or issue it is on, as the host names it. A webhook or a poll only says where to look; this is where the comment IS. */
  on: { repository: string; number: number };
}

/** The code host adapter's side. */
export interface PrCommentHost {
  /** Reads the comment back by repository and id, so no text, author or time comes from the webhook payload. Undefined when it is gone. */
  lookupComment(ref: { repository: string; number: number; commentId: string }): Promise<LookedUpComment | undefined>;
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
  /** What waits on this change request. `"several"`: more than one task works here, so a comment cannot say which it means (it names no task): the person decides on the page. */
  pendingFor(change: { repository: string; number: number }): Promise<PendingOffer | undefined | "several">;
  decide(input: { taskId: string; decision: "approve" | "changes"; note?: string; approval: ApprovalOffer; proof: ApprovalProof }): Promise<LocalActionResult>;
  /** `number` is the position in the "Lessons used" list of the pull request. */
  /** `author` is the comment's own author, as the host says: the one who asked, whatever the install's owner is. */
  lesson(input: { repository: string; number: number; lessonNumber: number; verdict: "wrong" | "right" | "retire"; author: ExternalAccountRef }): Promise<LocalActionResult>;
  /** `"several"` is refused by the world itself (it answers `refused`); the handler never picks one. */
  stop(input: { repository: string; number: number }): Promise<LocalActionResult>;
}

export type PrCommandOutcome =
  | { handled: false; reason: "not_a_command" | "not_created" | "bot" | "own_comment" | "gone" | "no_permission" | "duplicate" | "other_command" | "edited" | "other_thread" }
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
      const comment = await options.host.lookupComment({ repository: event.repository, number: event.number, commentId: event.commentId });
      if (comment === undefined) return { handled: false, reason: "gone" };
      // Rovara's own replies carry its marker (a host account that is also a person's); the core reads them as Rovara's, wherever the host says they came from.
      if (isRovareReplyComment(comment.body)) return { handled: false, reason: "own_comment" };
      // The delivery or the poll only named a place; the comment is where the host says it is.
      if (comment.on.repository.toLowerCase() !== event.repository.toLowerCase() || comment.on.number !== event.number) return { handled: false, reason: "other_thread" };
      if (comment.authorIsBot) return { handled: false, reason: "bot" };
      const parsed = parseRovaraComment(comment.body);
      if (parsed.kind === "reply") return { handled: false, reason: "not_a_command" };
      if (parsed.kind === "other" || parsed.kind === "file") return { handled: false, reason: "other_command" };
      if (!SPEAKS.has(comment.authorPermission)) return { handled: false, reason: "no_permission" };
      // A comment the host records an edit of never runs, whatever it says now (a person could approve, then edit the comment into something else).
      if (comment.updatedAt !== comment.createdAt && Date.parse(comment.updatedAt) !== Date.parse(comment.createdAt)) return { handled: false, reason: "edited" };

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
          const result = await options.world.lesson({ repository: event.repository, number: event.number, lessonNumber: parsed.number, verdict: parsed.verdict, author: comment.author });
          await say(event, sentenceFor(result, "Thanks. I noted that."));
          return { handled: true, command: "lesson", result };
        }
        // approve / changes
        const pending = await options.world.pendingFor({ repository: event.repository, number: event.number });
        if (pending === "several") {
          const message = "Several tasks wait on this change, and a comment cannot say which one it means. Decide on the task's page.";
          await say(event, message);
          return { handled: true, command: parsed.kind, result: { ok: false, reason: "refused", message } };
        }
        if (pending === undefined) {
          await say(event, "Nothing is waiting for a decision here.");
          return { handled: true, command: parsed.kind, result: { ok: false, reason: "not_found", message: "Nothing is waiting for a decision here." } };
        }
        if (parsed.kind === "approve" && parsed.repo !== undefined && parsed.repo.toLowerCase() !== pending.repository.toLowerCase()) {
          const message = `That names ${parsed.repo}, but this is about ${pending.repository}. Nothing was approved.`;
          await say(event, message);
          return { handled: true, command: "approve", result: { ok: false, reason: "refused", message } };
        }
        // An approval names the version it approves: the one Rovara posted a notice for. A bare approve, or one for another version, approves nothing and is told which version waits.
        if (parsed.kind === "approve" && !digestNamed(parsed.digest, pending.approval.artifactDigest)) {
          const short = shortDigest(pending.approval.artifactDigest);
          const message = `Version ${short} is waiting. To approve that one, say /rovara approve ${short}.`;
          await say(event, message);
          return { handled: true, command: "approve", result: { ok: false, reason: "stale", message } };
        }
        // The permission above is on the comment's repository. The task's repository must be that one, or a writer on another repository could decide this task.
        if (pending.repository.toLowerCase() !== event.repository.toLowerCase()) {
          const message = "That is not the repository this task works on. Nothing was sent.";
          await say(event, message);
          return { handled: true, command: parsed.kind, result: { ok: false, reason: "refused", message } };
        }
        // A comment written before the plan was posted answers an older plan. A time that cannot be read counts as before.
        const wrote = Date.parse(comment.createdAt);
        const posted = Date.parse(pending.postedAt);
        if (!Number.isFinite(wrote) || !Number.isFinite(posted) || wrote < posted) {
          const message = "That was written before the latest version was posted, so nothing was sent. Read the latest and say it again.";
          await say(event, message);
          return { handled: true, command: parsed.kind, result: { ok: false, reason: "stale", message } };
        }
        const proof: ApprovalProof = {
          proofId: `pr-comment-${event.commentId}`, method: CODE_HOST_COMMENT_METHOD, requestId: pending.approval.requestId, revision: pending.approval.revision,
          artifactDigest: pending.approval.artifactDigest, token: event.commentId, claimedAccount: comment.author,
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

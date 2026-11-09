// Lane L12 (owner decision 66): EVERY safety check on a comment that is offered as a proof lives here, in Rovara's core. A code-host plug-in only FETCHES a comment: its text, author, the times, the change
// request or issue it is on, and the author's permission (`HostComment`, `CodeHost.comments`). It never says whether the comment "approves".
//
// A comment proves a decision only when ALL of these hold, each decided from the fetched facts and from the request Rovara itself holds:
//   - it is on the change request (repository and number) this decision was posted on                                   -> `comment_on_other_change`
//   - it was written after the version being decided was posted (a comment about an older plan approves nothing new)       -> `comment_before_request`
//   - it is as it was first written: a comment the host records an edit of is never a command                              -> `comment_edited`
//   - it is a command of the right kind for the answer: `/rovara approve` for an approval, `/rovara changes: ...` for a request for changes -> `no_approving_comment`
//   - it names, if it names a repository, this one                                                                         -> `comment_on_other_change`
//   - its author is a person (not a bot) and not Rovara itself (the reply marker)                                          -> `no_approving_comment`
//   - its author may write to the repository (the Approvers seam checks `permission`), and the comment is spent once (the gate marks it used)
import { ROVARA_REPLY_MARKER, parseRovaraComment, type ExternalAccountRef } from "@agentx/contracts";

/** What a code host reported about one comment, plus the author's permission (read separately through the host's `standing`). No part of it is a judgement. */
export interface FetchedComment {
  /** Who wrote it, as the host reports it. */
  author: ExternalAccountRef;
  /** The author's permission on the repository the comment is in. */
  permission: "none" | "read" | "write" | "admin";
  authorIsBot: boolean;
  body: string;
  createdAt: string;
  updatedAt: string;
  /** The change request or issue it is on: the repository as the host names it (`owner/name`) and the number. */
  on: { repository: string; number: number };
}

/** Where, and since when, Rovara's own record says the request being decided was posted. */
export interface CommentRequestContext {
  repository: string;
  number: number;
  /** When the version being decided was posted (ISO). */
  postedAt: string;
}

export type CommentRefusal = "no_approving_comment" | "comment_on_other_change" | "comment_before_request" | "comment_edited" | "no_request_thread";

export type CommentCheck = { ok: true } | { ok: false; reason: CommentRefusal };

export function checkCommentProof(input: {
  comment: FetchedComment | undefined;
  context: CommentRequestContext | undefined;
  /** The answer being given. Absent: an approval. */
  outcome?: "approve" | "reject" | "request_changes" | undefined;
}): CommentCheck {
  const { comment, context } = input;
  if (comment === undefined) return { ok: false, reason: "no_approving_comment" };
  // A comment answers a request only on the thread the request was posted on.
  if (context === undefined) return { ok: false, reason: "no_request_thread" };
  if (comment.authorIsBot || comment.body.includes(ROVARA_REPLY_MARKER)) return { ok: false, reason: "no_approving_comment" };
  const outcome = input.outcome ?? "approve";
  const parsed = parseRovaraComment(comment.body);
  if (!((outcome === "approve" && parsed.kind === "approve") || (outcome === "request_changes" && parsed.kind === "changes"))) return { ok: false, reason: "no_approving_comment" };
  if (comment.on.repository.toLowerCase() !== context.repository.toLowerCase() || comment.on.number !== context.number) return { ok: false, reason: "comment_on_other_change" };
  if (parsed.kind === "approve" && parsed.repo !== undefined && parsed.repo.toLowerCase() !== context.repository.toLowerCase()) return { ok: false, reason: "comment_on_other_change" };
  const wrote = Date.parse(comment.createdAt);
  const posted = Date.parse(context.postedAt);
  const updated = Date.parse(comment.updatedAt);
  // A time that cannot be read counts as too early; an edit is any difference between the two times.
  if (!Number.isFinite(wrote) || !Number.isFinite(posted) || wrote < posted) return { ok: false, reason: "comment_before_request" };
  if (!Number.isFinite(updated) || updated !== wrote) return { ok: false, reason: "comment_edited" };
  return { ok: true };
}

// Port lane P6 (item E1, owner decision 62): the comment-command seam, keyed on "an item or a change request". INTERFACE ONLY: nothing reads these yet. Comment commands (`/rovara approve`, `@rovara stop`)
// work only on a code host's change requests today (`CodeHost.comments`, `core/pr-commands/`); a comment on a tracker's item (a Jira or Linear ticket) has no seam. This file gives the seam its shape so a
// tracker adapter can add `comments` later without a second protocol, and the handler can be keyed on a subject instead of a pull request when chains are switched on (decision 45.10).
//
// The rule is the one owner decision 66 set for change requests, unchanged: the adapter only FETCHES a comment (text, author, time, the subject it is on); every safety check (the right subject, written after the
// plan, edited or not, may the author approve) is Rovara's, in the core. The text is untrusted.
import { z } from "zod";
import { ChangeRequestRefSchema, type HostComment } from "./code-host.js";
import { ExternalIdSchema, HostAccountSchema, ISO_TIME, type HostScope } from "./common.js";
import { TrackerItemRefSchema } from "./tracker.js";

/** What a comment is on: a code host's change request, or a tracker's item. (Not the task page's comment target, `CommentTarget` in `task-comments.ts`.) */
export const CommentSubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("change-request"), ref: ChangeRequestRefSchema }).strict(),
  z.object({ kind: z.literal("item"), ref: TrackerItemRefSchema }).strict(),
]);
export type CommentSubject = z.infer<typeof CommentSubjectSchema>;

/** A comment on a subject, as the adapter reports it. Nothing in it is a decision. `updatedAt` differs from `createdAt` once the adapter records an edit. */
export const SubjectCommentSchema = z.object({
  id: ExternalIdSchema,
  subject: CommentSubjectSchema,
  /** `isBot`: an automation account, as the adapter's own plug-in decides. */
  author: HostAccountSchema.extend({ isBot: z.boolean() }).strict(),
  body: z.string().max(65_536),
  createdAt: ISO_TIME,
  updatedAt: ISO_TIME,
}).strict();
export type SubjectComment = z.infer<typeof SubjectCommentSchema>;
export const SubjectCommentsPageSchema = z.object({ comments: z.array(SubjectCommentSchema).max(200), nextPage: z.number().int().positive().optional() }).strict();
export type SubjectCommentsPage = z.infer<typeof SubjectCommentsPageSchema>;

/**
 * The seam, for an adapter that has comments on a kind of subject. Both methods are optional on the real ports (`CodeHost.comments`, `Tracker.comments`); this is the one shape a caller keyed on a
 * subject programs against.
 */
export interface CommentSource {
  /** Comments on the subject, oldest first, created or edited since `since` (an ISO time; absent: from the start), 100 a page. FETCH ONLY. */
  comments(subject: CommentSubject, options: { since?: string; page?: number }, scope: HostScope): Promise<SubjectCommentsPage>;
  /** ONE comment of Rovara's own fixed text on the subject. `gone` when the subject is. */
  postComment?(subject: CommentSubject, text: string, scope: HostScope): Promise<"posted" | "gone">;
}

/** A stable key for a subject, for claims and de-duplication: `change-request:<repository>#<id>` or `item:<tracker>:<id>`. */
export function commentSubjectKey(subject: CommentSubject): string {
  return subject.kind === "change-request" ? `change-request:${subject.ref.repository.url}#${subject.ref.id}` : `item:${subject.ref.tracker}:${subject.ref.id}`;
}

/** A change request's comment (the code host's shape) as a comment on a subject, so one handler can take both. */
export function subjectCommentFromHost(comment: HostComment): SubjectComment {
  return { id: comment.id, subject: { kind: "change-request", ref: comment.ref }, author: comment.author, body: comment.body, createdAt: comment.createdAt, updatedAt: comment.updatedAt };
}

// Lane L12 (owner decision 66): the two reads the Approvers seam makes for a comment proof, as a test double. The "code host" only reports what a comment holds; the checks are Rovara's (`checkCommentProof`).
import type { CommentRequestContext, FetchedComment } from "../../packages/broker/src/core/pr-commands/comment-checks.js";

export const THREAD = { repository: "example/repo", number: 12 } as const;
export const POSTED_AT = "2026-11-09T10:00:00.000Z";
export const WRITTEN_AT = "2026-11-09T10:05:00.000Z";

/** A fresh `/rovara approve` on the request's thread by `author`, who has `permission`. Anything can be overridden. */
export function freshComment(author: FetchedComment["author"], overrides: Partial<FetchedComment> = {}): FetchedComment {
  return { author, permission: "write", authorIsBot: false, body: "/rovara approve", createdAt: WRITTEN_AT, updatedAt: WRITTEN_AT, on: { ...THREAD }, ...overrides };
}

export const threadContext = (overrides: Partial<CommentRequestContext> = {}): CommentRequestContext => ({ ...THREAD, postedAt: POSTED_AT, ...overrides });

/** `fetchComment` / `commentContext` for `createLocalOwnerApprovers`: one comment (by `id`, default any) and the request's thread. */
export function commentReads(comment: FetchedComment | undefined, options: { id?: string; context?: CommentRequestContext | undefined } = {}) {
  return {
    fetchComment: (commentId: string) => (options.id === undefined || commentId === options.id ? comment : undefined),
    commentContext: () => ("context" in options ? options.context : threadContext()),
  };
}

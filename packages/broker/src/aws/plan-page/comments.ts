// Spec 061 slice 2: comments as the task page shows them, in its HTML and in its JSON API. A stored comment becomes a
// view with no IDs of people: the author's name, whether they are an owner, whether they are the reader, and the AgentX
// chip only for an item AgentX wrote. Text is redacted again here; the page escapes it (HTML) or sets it as text (script).
import {
  ANSWER_STALE_MS, plannerReplyCommentId, redactText,
  type CommentDocument, type CommentTarget, type TaskComment, type WorkflowArtifact,
} from "@agentx/contracts";

export interface PageCommentView {
  id: string;
  parentId?: string;
  document: CommentDocument;
  version: number;
  target: CommentTarget;
  author: { kind: "person" | "agentx"; name: string; owner: boolean; you: boolean };
  text: string;
  createdAt: string;
  edited: boolean;
  deleted: boolean;
  /** Sent with a decision: it can no longer be edited or deleted. */
  sent: boolean;
  rev: number;
  /** A person's comment that asked AgentX, or was sent with Request changes: what became of the answer. */
  agentx?: "answering" | "answered" | "couldnt" | "not_answered" | "unavailable";
  /** A planner reply: what the planner did, and in which version. */
  planner?: { outcome: "done" | "not_changed"; version: number };
}

/** A name as a comment shows it: one line, redacted, at most 80 characters. */
function shownName(name: string): string {
  const characters = Array.from(redactText(name).replace(/[\p{Cc}\s]+/gu, " ").trim());
  if (characters.length === 0) return "A teammate";
  return characters.length <= 80 ? characters.join("") : `${characters.slice(0, 79).join("")}…`;
}

export interface CommentViewContext {
  /** The reader's developer ID: only to say "you", never passed on. */
  readerId: string;
  now: number;
  /** The task's documents, to tell whether the planner answered a comment sent with Request changes. */
  artifacts: ReadonlyArray<Pick<WorkflowArtifact, "id" | "type" | "version">>;
}

/**
 * The task's comments as the page shows them, oldest first. A comment sent with Request changes reads "Not answered"
 * once a later version of its document exists with no planner reply for it; a question to AgentX that failed, or has
 * waited longer than ANSWER_STALE_MS, reads "couldn't answer".
 */
export function pageCommentViews(comments: readonly TaskComment[], context: CommentViewContext): PageCommentView[] {
  const ids = new Set(comments.map((comment) => comment.commentId));
  return comments.map((comment) => {
    const person = comment.author.kind === "person" ? comment.author : undefined;
    const agentxAuthor = comment.author.kind === "agentx" ? comment.author : undefined;
    let agentx: PageCommentView["agentx"];
    if (comment.ask !== undefined) {
      const state = comment.ask.state;
      const stale = state === "answering" && context.now - Date.parse(comment.ask.at) > ANSWER_STALE_MS;
      agentx = state === "answered" ? "answered" : state === "failed" || stale ? "couldnt" : state === "unavailable" ? "unavailable" : "answering";
    }
    if (person !== undefined && comment.lockedBy?.decision === "REQUEST_CHANGES") {
      const later = context.artifacts.filter((artifact) => artifact.type === comment.document && artifact.version > comment.version);
      if (later.length > 0 && !later.some((artifact) => ids.has(plannerReplyCommentId(comment.commentId, artifact.id)))) agentx = "not_answered";
    }
    return {
      id: comment.commentId,
      ...(comment.parentId === undefined ? {} : { parentId: comment.parentId }),
      document: comment.document, version: comment.version, target: comment.target,
      author: person !== undefined
        ? { kind: "person", name: shownName(person.name), owner: person.owner, you: person.developerId === context.readerId }
        : { kind: "agentx", name: "AgentX", owner: false, you: false },
      text: comment.deletedAt === undefined ? redactText(comment.text) : "",
      createdAt: comment.createdAt,
      edited: comment.editedAt !== undefined,
      deleted: comment.deletedAt !== undefined,
      sent: comment.lockedBy !== undefined,
      rev: comment.rev,
      ...(agentx === undefined ? {} : { agentx }),
      ...(agentxAuthor?.source === "planner" && agentxAuthor.outcome !== undefined
        ? { planner: { outcome: agentxAuthor.outcome, version: agentxAuthor.forVersion ?? comment.version } } : {}),
    };
  });
}

// Spec 061 slice 2: comments as the task page shows them, in its HTML and in its JSON API. A stored comment becomes a
// view with no IDs of people: the author's name, whether they are an owner, whether they are the reader, and the AgentX
// chip only for an item AgentX wrote. Text is redacted again here; the page escapes it (HTML) or sets it as text (script).
import { redactText, type CommentDocument, type CommentTarget } from "@agentx/contracts";
import { escapeHtml } from "../web-session.js";
import type { PlanAnchor } from "./render-plan.js";

/** A piece of a planner's reply: words, or a claim number of the version that handled the comment. */
export type ReplyPart = { text: string } | { claim: string };

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
  /** Which decision it was sent with (the stored `lockedBy.decision`). */
  sentWith?: "APPROVE" | "REQUEST_CHANGES";
  rev: number;
  /** A person's comment that asked AgentX, or was sent with Request changes: what became of the answer. */
  agentx?: "answering" | "answered" | "couldnt" | "not_answered" | "unavailable" | "skipped" | "sent_to_coding";
  /** AgentX's answer to an asked comment: the asker's name, from that stored comment (never from the answer). */
  answering?: string;
  /**
   * A planner reply: what the planner did, and in which version of which document (`document`). `in`: after an Approve,
   * the document that handled the comment (it is not the one the comment sits on). `claim`: the claim of that version
   * that cites the comment. `parts`: the reply's words with each claim number that exists in that version marked, for a
   * link to it (only when it has any). All of them are worked out when the page is read; none is stored with the reply.
   */
  planner?: { outcome: "done" | "not_changed"; version: number; document: CommentDocument; in?: CommentDocument; claim?: string; parts?: ReplyPart[] };
}


/** A suggestion as the page shows it: who suggested which option on which decision, and whether it is the reader's. */
export interface PageSuggestionView { decisionId: string; optionId: string; name: string; you: boolean }

/** Text made safe for HTML: secrets removed again, then escaped. */
const t = (value: string): string => escapeHtml(redactText(value));

/** "claim:2.1", "decision:d1", "check:unit-tests" or "document": where a thread sits, as the page's data attributes name it. */
export function targetKey(target: CommentTarget): string {
  return target.kind === "document" ? "document" : `${target.kind}:${target.id}`;
}

/** "1 comment" / "3 comments", as a badge; nothing for none. */
export function commentCountBadge(count: number): string {
  return count === 0 ? "" : ` <span class="badge badge-comments">${count} ${count === 1 ? "comment" : "comments"}</span>`;
}

const AGENTX_STATES: Record<NonNullable<PageCommentView["agentx"]>, string> = {
  answering: "Rovara is answering…",
  answered: "",
  couldnt: "Rovara couldn't answer this one.",
  not_answered: "Not answered",
  unavailable: "Rovara can answer comments only on tasks started in Slack.",
  skipped: "Edited after it was asked, so Rovara didn't answer.",
  sent_to_coding: "Sent to coding when the plan was approved.",
};

/** The document a planner reply names ("in the coding plan") and the page anchor its claim links go to. */
const HANDLED_IN: Record<CommentDocument, { the: string; bare: string; anchor: PlanAnchor }> = {
  requirements: { the: "the requirements", bare: "requirements", anchor: "requirements" },
  design: { the: "the design", bare: "design", anchor: "design" },
  plan: { the: "the coding plan", bare: "coding plan", anchor: "coding-plan" },
};
const CLAIM_ID = /^[1-9][0-9]{0,2}(\.[1-9][0-9]{0,2}){0,2}$/;

/** The element ID of a claim of a stored version (the same one render-plan's claimAnchor builds). */
const claimElementId = (anchor: PlanAnchor, version: number, claimId: string): string => `${anchor}-v${version}-${claimId.replace(/\./gu, "-")}`;

/**
 * What a locked comment says under it, for its author: its own owner sent it with their own decision, a teammate's was
 * sent with the owner's. Both are in the page's script copy too.
 */
function sentNote(comment: Pick<PageCommentView, "author" | "sentWith">): string {
  if (comment.sentWith === "REQUEST_CHANGES") return "Sent with Request changes, so it can't be edited.";
  if (comment.sentWith === undefined) return "Sent with a decision, so it can't be edited.";
  return comment.author.owner ? "Sent with your approval, so it can't be edited." : "Sent with the owner's approval, so it can't be edited.";
}

const shortTime = (at: string): string => {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`;
};

/**
 * One comment: who wrote it (the AgentX chip only for an item AgentX wrote, the Owner tag only from the stored flag),
 * when, where it came from, its text as plain escaped text, and what became of any answer. Edit, Delete and Reply are
 * hidden until the page's script turns them on.
 */
function commentHtml(comment: PageCommentView, context: { shownVersion: number; canComment: boolean }, reply: boolean): string {
  const author = comment.author.kind === "agentx" && comment.answering !== undefined
    ? `<span class="chip chip-agentx">Rovara (AI)</span> <span class="answering"><span aria-hidden="true">· </span>answering ${t(comment.answering)}</span>`
    : comment.author.kind === "agentx" && comment.planner !== undefined
    ? `<span class="chip chip-agentx">Rovara</span> <span class="answering"><span aria-hidden="true">· </span>from ${HANDLED_IN[comment.planner.document].bare} v${comment.planner.version}</span>`
    : comment.author.kind === "agentx"
    ? '<span class="chip chip-agentx">Rovara</span>'
    : `<span class="comment-author">${t(comment.author.name)}</span>${comment.author.owner ? ' <span class="tag tag-owner">Owner</span>' : ""}`;
  const from = comment.version < context.shownVersion ? ` <span class="from-version">from v${comment.version}</span>` : "";
  const edited = comment.edited && !comment.deleted ? ' <span class="comment-edited">(edited)</span>' : "";
  const header = `<p class="comment-meta">${author} <time datetime="${escapeHtml(comment.createdAt)}">${escapeHtml(shortTime(comment.createdAt))}</time>${from}${edited}</p>`;
  let body: string;
  if (comment.deleted) body = '<p class="comment-deleted">Comment deleted</p>';
  else if (comment.author.kind === "agentx" && comment.planner !== undefined) {
    const { outcome, claim, version } = comment.planner;
    const document = HANDLED_IN[comment.planner.document];
    // After an Approve the comment was handled in the next document; after Request changes, in the same one again.
    const handled = comment.planner.in === undefined ? "" : ` in ${document.the}`;
    const lead = handled === "" ? (outcome === "done" ? "Done: " : "Not changed because: ") : `${outcome === "done" ? "Done" : "Not changed"}${handled}: `;
    // The link is to that version's own claim (the element ID render-plan's claimAnchor builds), which a later version may have renumbered.
    const link = claim === undefined || !CLAIM_ID.test(claim) ? ""
      : `<p class="comment-link">See <a class="claim-link" href="#${escapeHtml(claimElementId(document.anchor, version, claim))}">claim ${escapeHtml(claim)}</a> in ${document.bare} v${version}.</p>`;
    // A claim number of that version in the reply's words is a link to the same element.
    const words = comment.planner.parts === undefined ? t(comment.text)
      : comment.planner.parts.map((part) => "claim" in part
        ? `<a class="claim-link" href="#${escapeHtml(claimElementId(document.anchor, version, part.claim))}">${t(part.claim)}</a>` : t(part.text)).join("");
    body = `<p class="comment-text">${lead}${words}</p>${link}`;
  } else body = `<p class="comment-text">${t(comment.text)}</p>`;
  const state = comment.agentx === undefined || AGENTX_STATES[comment.agentx] === "" ? "" : `<p class="comment-state">${AGENTX_STATES[comment.agentx]}</p>`;
  const yours = comment.author.kind === "person" && comment.author.you && !comment.deleted;
  const sent = yours && comment.sent ? `<p class="comment-sent">${sentNote(comment)}</p>` : "";
  const controls: string[] = [];
  if (yours && !comment.sent && context.canComment) {
    controls.push(`<button type="button" class="comment-edit" data-comment="${escapeHtml(comment.id)}" aria-describedby="comment-${escapeHtml(comment.id)}" hidden>Edit</button>`);
    controls.push(`<button type="button" class="comment-delete" data-comment="${escapeHtml(comment.id)}" aria-describedby="comment-${escapeHtml(comment.id)}" hidden>Delete</button>`);
  }
  if (!reply && context.canComment && comment.author.kind === "person" && !comment.deleted) {
    controls.push(`<button type="button" class="reply-open" data-comment="${escapeHtml(comment.id)}" aria-describedby="comment-${escapeHtml(comment.id)}" hidden>Reply</button>`);
  }
  const actions = controls.length === 0 ? "" : `<p class="comment-actions">${controls.join(" ")}</p>`;
  return `<article class="comment${comment.author.kind === "agentx" ? " comment-agentx" : ""}" id="comment-${escapeHtml(comment.id)}" data-comment="${escapeHtml(comment.id)}" data-rev="${comment.rev}">${header}${body}${state}${sent}${actions}</article>`;
}

/**
 * The threads on one place of a document, oldest first, each with its replies (one level), then the Comment control
 * for someone who may comment (hidden until the script turns it on). `threads` holds the top-level comments and their
 * replies; replies whose comment is not among them are left out.
 */
export function renderThreads(threads: readonly PageCommentView[], context: { shownVersion: number; canComment: boolean; target: string; label?: string; controlLabel?: string; /** false: the Comment control sits elsewhere (a checks row). */ open?: boolean }): string {
  const top = threads.filter((comment) => comment.parentId === undefined);
  const items = top.map((comment) => {
    const replies = threads.filter((reply) => reply.parentId === comment.id);
    const replyList = replies.length === 0 ? "" : `<ol class="replies">${replies.map((reply) => `<li>${commentHtml(reply, context, true)}</li>`).join("")}</ol>`;
    return `<li class="thread">${commentHtml(comment, context, false)}${replyList}</li>`;
  }).join("");
  const list = items === "" ? "" : `<ol class="threads">${items}</ol>`;
  const open = context.canComment && context.open !== false ? `<button type="button" class="comment-open" data-target="${escapeHtml(context.target)}" hidden>${t(context.controlLabel ?? "Comment")}</button>` : "";
  if (list === "" && open === "") return "";
  const label = context.label === undefined ? "" : `<h4 class="comments-label">${t(context.label)}</h4>`;
  return `<section class="comments" data-comments="${escapeHtml(context.target)}">${label}${list}${open}</section>`;
}

/** "Priya", "Priya and Sam", "Priya, Sam and Lee": names joined for one sentence, each escaped. */
function joinedNames(names: readonly string[]): string {
  const safe = names.map(t);
  return safe.length <= 1 ? safe.join("") : `${safe.slice(0, -1).join(", ")} and ${safe.at(-1)!}`;
}

/** The suggestion lines of one decision: "Priya and Sam suggest: Above", one line per suggested option, in option order. */
export function suggestionLines(suggestions: readonly PageSuggestionView[], options: ReadonlyArray<{ id: string; label: string }>): string {
  return options.flatMap((option) => {
    const names = suggestions.filter((suggestion) => suggestion.optionId === option.id).map((suggestion) => suggestion.name);
    if (names.length === 0) return [];
    return [`<p class="suggestions">${joinedNames(names)} ${names.length === 1 ? "suggests" : "suggest"}: ${t(option.label)}</p>`];
  }).join("");
}

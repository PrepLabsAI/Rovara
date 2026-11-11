// What people do to the spec pull request. Rovara opened it and never pushes to it again, so a head that is not the recorded one is a person's edit: the task owner is asked "The spec changed.
// Re-plan or keep?" and the code pull requests wait for the answer. A review that approves the recorded head is the approval `spec_first` waits for. The facts come from GitHub (never from the event), so a
// missed or repeated delivery changes nothing; the same refresh runs when a delivery arrives and whenever the held code pull request is looked at again.
import { SpecStateSchema, approved, edited, type SpecState } from "./state.js";
import type { SpecStore } from "./hooks.js";

export interface SpecPullRequestFacts {
  state: "open" | "closed" | "merged";
  headSha: string;
  /**
   * The reviews, oldest first. `eligible` is the broker's answer, not GitHub's: the reviewer is a person (not a bot, not the app) with write or admin access to the meta repository. A review with no `eligible: true`
   * is never an approval and never an objection.
   */
  reviews: ReadonlyArray<{ state: string; commitId: string; login?: string; userId?: string; eligible?: boolean }>;
  /** The list of reviews was cut: what is past it is not known, so no approval may be read from it. */
  reviewsIncomplete?: boolean | undefined;
}

const SHA = /^[a-f0-9]{40}$/u;

/** The state after what GitHub shows now, or undefined when nothing changes. Pure. */
export function specStateFromFacts(state: SpecState, facts: SpecPullRequestFacts, now: string): SpecState | undefined {
  const link = state.specPullRequest;
  if (state.status !== "published" || link === undefined || !SHA.test(facts.headSha)) return undefined;
  // A head that is not the recorded one: a person's edit (this runs even when the pull request was closed since).
  if (facts.headSha !== link.commit) {
    const changed = edited(state, { headSha: facts.headSha }, now);
    if (changed !== undefined) return changed;
    // Already asked about this head, or kept at it: nothing more to say about the edit.
    if (state.editPrompt?.headSha === facts.headSha) return undefined;
  }
  if (facts.state === "closed") {
    // Closed without a merge: the spec is gone, and the owner chooses (retry writes it again; continuing goes on without).
    return failedAfterPublish(state, now);
  }
  if (state.target.linkStyle !== "spec_first" || state.approvedAt !== undefined) return undefined;
  if (facts.reviewsIncomplete === true && facts.state !== "merged") return undefined;
  const approver = approvingReviewer(facts.reviews, link.commit);
  if (facts.state === "merged") return approved(state, { headSha: link.commit, by: approver?.login ?? "merged" }, now);
  if (approver === undefined) return undefined;
  return approved(state, { headSha: link.commit, by: approver.login ?? "reviewer" }, now);
}

/**
 * Who has approved the recorded head: the latest decisive review of each eligible reviewer (approved, changes requested or dismissed; a comment changes nothing) counts, so a reviewer who asked for changes
 * and later approved is an approval and one who approved and later asked for changes is an objection. Only reviews of the head count. An approval needs no objection from another eligible reviewer.
 */
export function approvingReviewer(reviews: SpecPullRequestFacts["reviews"], head: string): { login?: string } | undefined {
  const latest = new Map<string, (typeof reviews)[number]>();
  for (const review of reviews) {
    if (review.eligible !== true || review.commitId !== head) continue;
    if (review.state !== "APPROVED" && review.state !== "CHANGES_REQUESTED" && review.state !== "DISMISSED") continue;
    latest.set(review.userId ?? review.login ?? "?", review);
  }
  const decisive = [...latest.values()];
  if (decisive.some((review) => review.state === "CHANGES_REQUESTED")) return undefined;
  const approver = decisive.find((review) => review.state === "APPROVED");
  return approver === undefined ? undefined : { ...(approver.login === undefined ? {} : { login: approver.login }) };
}

function failedAfterPublish(state: SpecState, now: string): SpecState | undefined {
  // The spec pull request is gone without a merge: the spec fails (retry writes it again; continuing goes on without).
  return SpecStateSchema.parse({ ...state, status: "failed", failure: { code: "spec_closed", at: now }, revision: state.revision + 1, updatedAt: now });
}

/** Reads GitHub's view of the spec pull request and stores the state it implies. `read` returns undefined when GitHub cannot say; then nothing changes. Returns the state to use now. */
export async function refreshSpecState(
  env: { store: SpecStore; now(): string; read(state: SpecState): Promise<SpecPullRequestFacts | undefined> }, taskId: string,
): Promise<{ state: SpecState | undefined; changed: boolean }> {
  const { state } = await env.store.load(taskId);
  if (state === undefined || state.status !== "published" || state.specPullRequest === undefined || state.continuedWithoutSpec !== undefined) return { state, changed: false };
  let facts: SpecPullRequestFacts | undefined;
  try { facts = await env.read(state); } catch { facts = undefined; }
  if (facts === undefined) return { state, changed: false };
  const next = specStateFromFacts(state, facts, env.now());
  if (next === undefined) return { state, changed: false };
  // A lost race (another refresh or an owner's choice moved the state first) is read again by the next look.
  return (await env.store.save(next, state.revision)) ? { state: next, changed: true } : { state, changed: false };
}


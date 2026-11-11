// Which lessons may ever go into ONE repository's `.rovara/lessons.md`.
//
// The rule (50a.1): a lesson is eligible for repository R only if EVERY input the reflector was given was readable by everyone who can read R, and its text names nobody. Checked by code, fail closed: an input of an
// unknown kind or an unknown place makes the lesson not eligible. Nothing in this file calls a model or reads a store: every function is pure.
//   - `repoVisibilityOf`: at reflection, from the task's own inputs and every span the reflector was given, sets `provenance.repoOnly` (and the fixed codes of what blocked it, `repoBlockCodes`).
//   - `mergedRepoVisibility`: at a merge (`curate.ts#mergeInto`, which a person's merge `foldDuplicate` also uses), the AND of the two sides: kept only when both carry it for the SAME repository.
//   - `isRepoFileEligible` / `repoFileBlockers`: whether a stored lesson may go into repository R's file now.
// The table of inputs (one kind of span each):
//   pr_comment, human_edit, outcome, fact, and a CI result or an intent that carries a repository place  -> yes, if the place is ONE repository and the span's audience is that repository's readers (or the project, a public repository)
//   send_back, remembered, close_reason (typed in Rovara)                                                -> never
//   plan, review_finding, ci_failure written by Rovara (no person)                                       -> only if everything else passes (they are derived from the task's inputs)
//   a person's words in a plan / finding, a span from Slack, a tracker, MCP or Rovara itself, a loaded lesson, another repository, an unknown kind -> never
//   a task's own start and steering that are not spans (typed task text, answers, notes, connections)     -> never, unless the subject source PROVED them repository-visible (`ReflectSubject.repoInputs`)
import { hasStaleCitation, namesAPerson } from "./trial.js";
import { REPO_PLACE, repoOnlyScopes } from "./project-repo-audience.js";
import { REPO_BLOCK_CODES, SPAN_KINDS, type Audience, type Lesson, type LessonCitation, type LessonProvenance, type RepoBlockCode } from "./types.js";

/** What the eligibility rule reads of a lesson: a `Lesson` fits, and so does the reduced item the measurement script reads (it never needs the rest). */
export type RepoEligibilityLesson = Pick<Lesson, "status" | "tier" | "trial" | "approvals" | "reviewRequired" | "retireProposedAt" | "counters" | "citationChecks" | "title" | "description" | "body"> & {
  provenance: Pick<LessonProvenance, "audience" | "repoOnly" | "repoBlockCodes">;
  tierReasons?: Lesson["tierReasons"];
};

/** Whether a text is a repository place (`<source>:repo/<id>`), the shape the Team record names a code-host repository with. */
export const isRepoPlace = (place: string): boolean => REPO_PLACE.test(place);

/** What this module reads of a span: structural, so a `MarkedSpan` and an `EvidenceSpan` both fit. */
export interface RepoInputSpan {
  kind: string; trust?: string; authorId?: string | undefined; authorIds?: readonly string[] | undefined; audience?: Audience | undefined; scopes?: readonly string[] | undefined;
}
/** The proof a subject source gives that a task's own start and steering were repository-visible, and which repository it is: the place, the project's name for it, and its pull request URL prefix. */
export interface RepoInputsProof {
  place: string; repository: string; linkPrefix: string;
  /**
   * The project's REGISTERED repository address (its URL in the project definition), proved by the code host's own identity to be the repository the place stands for. When given, the link prefix is judged against it, without case
   * (a host's name may have capitals and the project's name may differ from the host's); when absent, the older rule applies: the prefix's repository segment is the project's name, exactly.
   */
  repositoryUrl?: string;
}
export interface RepoInputSubject {
  kind: string; inheritedTasks?: readonly string[] | undefined; repoInputs?: RepoInputsProof | undefined;
  /** The prompt header names these repositories and links: they are inputs too. */
  repositories?: readonly string[] | undefined; links?: readonly string[] | undefined;
}

const KNOWN_KINDS: ReadonlySet<string> = new Set(SPAN_KINDS);
/** Kinds that are the repository's own words, work or facts: they pass when their place and readers are one repository's. */
const REPOSITORY_KINDS: ReadonlySet<string> = new Set(["pr_comment", "human_edit", "outcome", "fact"]);
/** Kinds a person types in Rovara (or its CLI, chat or Slack-linked session): never repository-visible, whatever place they carry. */
const TYPED_IN_ROVARA: ReadonlySet<string> = new Set(["send_back", "remembered", "close_reason"]);
/** Kinds Rovara derives from the task's inputs: they add nothing of their own, and are only as visible as the inputs they were made from. */
const DERIVED_KINDS: ReadonlySet<string> = new Set(["plan", "review_finding", "ci_failure"]);

type Placed = { place: string } | { block: RepoBlockCode };

/** The ONE repository place a span came from and whether that repository's readers are its audience. Anything else is a block, with the reason. */
function placeOfSpan(span: RepoInputSpan): Placed {
  const scopes = span.scopes;
  if (scopes === undefined || scopes.length === 0) return { block: "missing_place" };
  if (!scopes.every(isRepoPlace)) return { block: "other_place" };
  const places = new Set(scopes);
  if (places.size > 1) return { block: "other_repo" };
  const place = [...places][0]!;
  const audience = span.audience;
  if (audience === undefined) return { block: "audience_not_repo" };
  if (audience.kind === "project") return { place };
  // Restricted: exactly the readers of this one repository (the code-host row shape: no principals, no groups, the scope is the repository's place).
  const readers = repoOnlyScopes({ provenance: { audience } });
  return readers !== undefined && readers.every((reader) => reader === place) ? { place } : { block: "audience_not_repo" };
}

/**
 * The prompt header (`Repositories:`, `Links you may cite:`) names repositories and pull requests, and the reflector reads them: they are inputs. Without a proof it may name nothing (a facts subject); with one it must name exactly the one
 * repository the place stands for and only that repository's pull requests. A proof with no repository name or URL prefix, or one the header does not match, fails closed.
 */
/** The registered address without a trailing slash or `.git`, lower-cased (a host's names are case-insensitive). */
const addressKey = (url: string): string => url.trim().replace(/\/+$/u, "").replace(/\.git$/u, "").toLowerCase();

/**
 * The proof's URL prefix must have the shape `https://<host>/<owner>/<repository>/pull/`. With the registered repository address it must be exactly that address plus `/pull/`, compared without case, so `.../api` can never
 * accept `.../api7/pull/3`. Without it the prefix's repository segment must equal the project's name exactly.
 */
function linkPrefixIsOf(proof: RepoInputsProof): boolean {
  if (proof.repository === "" || !/^[^/\s]+$/u.test(proof.repository)) return false;
  const match = /^https:\/\/[^/\s]+\/[^/\s]+\/([^/\s]+)\/pull\/$/u.exec(proof.linkPrefix);
  if (match === null) return false;
  if (proof.repositoryUrl !== undefined) return /^https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+$/u.test(addressKey(proof.repositoryUrl)) && `${addressKey(proof.repositoryUrl)}/pull/` === proof.linkPrefix.toLowerCase();
  return match[1] === proof.repository;
}

function headerStaysIn(subject: RepoInputSubject): boolean {
  const repositories = subject.repositories ?? [];
  const links = subject.links ?? [];
  const proof = subject.repoInputs;
  if (proof === undefined) return repositories.length === 0 && links.length === 0;
  if (!linkPrefixIsOf(proof)) return false;
  return repositories.length === 1 && repositories[0] === proof.repository && links.every((link) => link.startsWith(proof.linkPrefix) && /^\d+$/u.test(link.slice(proof.linkPrefix.length)));
}

/** Whether every code citation is in the proved repository and every pull request citation is one of its pull requests. Without a proof only record and task citations may stand. Pure. */
export function citationsStayIn(proof: RepoInputsProof | undefined, citations: readonly LessonCitation[]): boolean {
  return citations.every((citation) => {
    if (citation.kind === "record" || citation.kind === "task") return true;
    if (proof === undefined || !linkPrefixIsOf(proof)) return false;
    if (citation.kind === "code") return citation.repo === proof.repository;
    return citation.kind === "pr" && citation.url.startsWith(proof.linkPrefix);
  });
}

export interface RepoVisibility {
  /** Set exactly when every input is visible to the readers of this one repository. */
  repoOnly?: { place: string };
  /** The fixed codes of what blocked it, in `REPO_BLOCK_CODES` order. Empty exactly when `repoOnly` is set. */
  blocked: RepoBlockCode[];
}

const inCodeOrder = (codes: ReadonlySet<RepoBlockCode>): RepoBlockCode[] => REPO_BLOCK_CODES.filter((code) => codes.has(code));

/**
 * Whether every input of a reflection was readable by the readers of one repository. `spans` is EVERY span the reflector was given (cited or not): the model cannot launder a span by choosing its evidence. Unknown is blocked:
 * a task whose own start and steering are not proved (`subject.repoInputs`), a span of a kind or place this build does not know, a lesson loaded into the task (`inheritedTasks`, and a `loaded_lesson` span), and a reflection
 * with no input from a repository at all. Pure; calls no model.
 */
export function repoVisibilityOf(subject: RepoInputSubject, spans: Iterable<RepoInputSpan>): RepoVisibility {
  const blocked = new Set<RepoBlockCode>();
  const places = new Set<string>();
  let fromRepository = 0;
  if (subject.kind === "task") {
    if (subject.repoInputs === undefined || !isRepoPlace(subject.repoInputs.place)) blocked.add("task_inputs_unproved");
    else places.add(subject.repoInputs.place);
  } else if (subject.kind !== "facts") blocked.add("unknown_input");
  if ((subject.inheritedTasks ?? []).length > 0) blocked.add("loaded_lesson");
  // A task with no proof is already blocked above, and says only that; the header is judged when there is a proof to judge it by (and always for a facts subject).
  if ((subject.kind !== "task" || subject.repoInputs !== undefined) && !headerStaysIn(subject)) blocked.add("other_repo");
  for (const span of spans) {
    const personAuthored = span.authorId !== undefined || (span.authorIds?.length ?? 0) > 0 || span.trust === "member";
    if (!KNOWN_KINDS.has(span.kind)) { blocked.add("unknown_input"); continue; }
    if (span.kind === "loaded_lesson") { blocked.add("loaded_lesson"); continue; }
    if (TYPED_IN_ROVARA.has(span.kind)) { blocked.add("typed_in_rovara"); continue; }
    if (span.kind === "intent") {
      const placed = placeOfSpan(span);
      if ("place" in placed) places.add(placed.place);
      else blocked.add(placed.block === "missing_place" || placed.block === "other_place" ? "intent_not_repo" : placed.block);
      continue;
    }
    // A derived kind (written by Rovara) holds no person's words: a person's name on one is text typed in Rovara, whatever place it carries. The same for a fact or an outcome: the repository's code and host state have no author.
    if ((DERIVED_KINDS.has(span.kind) || span.kind === "fact" || span.kind === "outcome") && personAuthored) { blocked.add(span.kind === "ci_failure" ? "ci_author" : "typed_in_rovara"); continue; }
    // A derived kind with no place of its own is as visible as the task's inputs, which only a task has (proved by `repoInputs`). For any other subject its origin is unknown.
    const hasPlace = span.scopes !== undefined && span.scopes.length > 0;
    if (DERIVED_KINDS.has(span.kind) && !hasPlace) {
      if (subject.kind !== "task") blocked.add("unknown_input");
      continue;
    }
    if (REPOSITORY_KINDS.has(span.kind) || DERIVED_KINDS.has(span.kind)) {
      const placed = placeOfSpan(span);
      if ("place" in placed) { places.add(placed.place); fromRepository += 1; } else blocked.add(placed.block);
      continue;
    }
    blocked.add("unknown_input");
  }
  if (places.size > 1) blocked.add("other_repo");
  if (fromRepository === 0) blocked.add("no_repo_evidence");
  const codes = inCodeOrder(blocked);
  return codes.length === 0 && places.size === 1 ? { repoOnly: { place: [...places][0]! }, blocked: [] } : { blocked: codes.length === 0 ? ["unknown_input"] : codes };
}

/** What the provenance fields say, for a merge: a side that is not repository-only carries its recorded codes; a side that recorded none (learned before the field) is `predates_field`. */
function blockedOf(side: Pick<LessonProvenance, "repoOnly" | "repoBlockCodes">): RepoBlockCode[] {
  if (side.repoOnly !== undefined) return [];
  return side.repoBlockCodes === undefined || side.repoBlockCodes.length === 0 ? ["predates_field"] : [...side.repoBlockCodes];
}

/**
 * The repository-visibility fields after two lessons merge (`curate.ts#mergeInto`; a person's "Merge into the existing lesson" is the same fold): the AND of the sides. `repoOnly` is kept only when BOTH sides carry it for the
 * SAME repository; anything else clears it, and `repoBlockCodes` is the union of what blocked each side (two different repositories: `other_repo`). An unset side reads as false. Pure.
 */
export function mergedRepoVisibility(target: Pick<LessonProvenance, "repoOnly" | "repoBlockCodes">, draft: Pick<LessonProvenance, "repoOnly" | "repoBlockCodes">): Pick<LessonProvenance, "repoOnly" | "repoBlockCodes"> {
  if (target.repoOnly !== undefined && draft.repoOnly !== undefined && target.repoOnly.place === draft.repoOnly.place) return { repoOnly: target.repoOnly };
  const codes = new Set<RepoBlockCode>([...blockedOf(target), ...blockedOf(draft)]);
  if (target.repoOnly !== undefined && draft.repoOnly !== undefined) codes.add("other_repo");
  return { repoBlockCodes: inCodeOrder(codes) };
}

/** The tier reason read-back (`repo-file-readback.ts`) puts on a lesson whose text is the team's own, merged into the repository's file. */
export const TEAM_FILE_TEXT = "team_file_text";

/** The approvals a PERSON gave (not the trial's or the automatic path's): the lessons that count as "person-approved". */
const PERSON_APPROVAL_MODES: ReadonlySet<string> = new Set(["one", "second_person", "sole_owner_exception"]);

/** Whether a PERSON approved the lesson (a lesson counts as "person-approved" only then: not the trial, not the automatic path). The Regulated preset proposes only these. */
export const hasPersonApproval = (lesson: Pick<Lesson, "approvals">): boolean => lesson.approvals.some((approval) => PERSON_APPROVAL_MODES.has(approval.mode));

export type RepoFileBlocker =
  | "repo_unknown" | "not_repo_only" | "other_repo" | "not_active" | "on_trial" | "not_stable_or_approved" | "restricted_audience" | "names_a_person" | "needs_review";

/**
 * Everything that keeps a lesson out of repository `repo`'s file now (empty: eligible). `repo` is its place (`<source>:repo/<id>`); `names` are the display names of the people the lesson could name, REQUIRED as for
 * `isPublishable` (an empty list is a statement that the caller found none; an @handle or an e-mail address always counts). Pure; every doubt is a blocker.
 */
export function repoFileBlockers(lesson: RepoEligibilityLesson, repo: string, names: readonly string[]): RepoFileBlocker[] {
  const blockers: RepoFileBlocker[] = [];
  if (!isRepoPlace(repo)) return ["repo_unknown"];
  const only = lesson.provenance.repoOnly;
  if (only === undefined) blockers.push("not_repo_only");
  else if (only.place !== repo) blockers.push("other_repo");
  if (lesson.status !== "active") blockers.push("not_active");
  // Stable after trial, or approved by a person. A lesson still on trial, or one that went live without any person, waits.
  const stable = lesson.trial?.state === "stable";
  const onTrial = lesson.trial?.state === "trial";
  const approvedByPerson = lesson.trial === undefined && lesson.approvals.some((approval) => PERSON_APPROVAL_MODES.has(approval.mode));
  if (onTrial) blockers.push("on_trial");
  else if (!stable && !approvedByPerson) blockers.push("not_stable_or_approved");
  // No restriction except "the readers of this very repository".
  const audience = lesson.provenance.audience;
  const readers = repoOnlyScopes(lesson);
  if (audience.kind !== "project" && !(readers !== undefined && readers.every((reader) => reader === repo))) blockers.push("restricted_audience");
  if (namesAPerson([lesson.title, lesson.description, lesson.body].join("\n"), names)) blockers.push("names_a_person");
  // The same soundness `isPublishable` asks of a lesson that leaves Rovara's store.
  // Tier 2 (words about tests, checks, security...) asks for two people before Rovara PROPOSES a lesson. Text the team itself merged into the file (read back from the file) is not Rovara's proposal: its tier never takes the team's own block out.
  if ((lesson.tier >= 2 && !(lesson.tierReasons ?? []).includes(TEAM_FILE_TEXT)) || lesson.reviewRequired === true || lesson.retireProposedAt !== undefined || lesson.counters.harmful > 0 || hasStaleCitation(lesson)) blockers.push("needs_review");
  return blockers;
}

/** Whether the lesson may go into repository `repo`'s `.rovara/lessons.md`. Pure; see `repoFileBlockers` for the reasons. */
export const isRepoFileEligible = (lesson: RepoEligibilityLesson, repo: string, names: readonly string[]): boolean => repoFileBlockers(lesson, repo, names).length === 0;

/**
 * A person's edit-and-approve (`approve.ts`) is text typed in Rovara: an input that the readers of the repository cannot see ("text typed in Rovara: never"). The edited lesson is no longer repository-only,
 * whatever its inputs were; hand edits come into a repository's file through the read-back, which is repository-visible by construction. Pure.
 */
export function afterPersonEdit<P extends Pick<LessonProvenance, "repoOnly" | "repoBlockCodes">>(provenance: P): P {
  const { repoOnly: _only, repoBlockCodes: earlier, ...rest } = provenance;
  void _only;
  return { ...rest, repoBlockCodes: inCodeOrder(new Set<RepoBlockCode>([...(earlier ?? []), "typed_in_rovara"])) } as P;
}

/**
 * Whether a draft may merge into `target` without costing a repo-only lesson its mark: the merge must KEEP `repoOnly` (both sides repo-only for the same repository) or neither side may have it.
 * Across that line the draft stays its own lesson and the pair is linked both ways as possible duplicates, whatever state the target is in (on trial, retired or live: a repo-only lesson on trial is just as easily cleared). Pure.
 */
export function mergeKeepsRepoOnly(target: { provenance: Pick<LessonProvenance, "repoOnly"> }, draft: { provenance: Pick<LessonProvenance, "repoOnly"> }): boolean {
  const mine = target.provenance.repoOnly;
  const theirs = draft.provenance.repoOnly;
  if (mine === undefined && theirs === undefined) return true;
  return mine !== undefined && theirs !== undefined && mine.place === theirs.place;
}

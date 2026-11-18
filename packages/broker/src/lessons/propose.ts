// Team suggestions (L4-AK3, owner decision 2026-11-17 / DEC 254zzz7): an AI tool outside Rovara (the MCP `team_propose` tool) and Rovara's own agents (the worker's `knowledge_propose` tool) may only PROPOSE a lesson.
// A proposal is a SUGGESTED lesson from a weak source, and nothing in this file can make a lesson live:
//   - it is built as a lesson draft with the lowest trust a lesson can have and still be kept (`system`), no member signal, no member correction, no supported claims and no measured outcome, so the trial rules
//     (`trialBlockers`) and the tier-0 auto-apply cannot take it, and it is settled with `noAutoApply` (its `reviewRequired` mark stays on it for good, through merges);
//   - it carries a fixed source key (`proposed:tool` or `proposed:agent`, `proposal-mark.ts`), and waits as a candidate until a SECOND, INDEPENDENT sighting (two tasks, two people, or one of each: `earnedAttention`);
//     only then is it in front of the people who decide, in the weekly review, with its source on the card; a person still decides it, as for any lesson;
//   - its text is treated as untrusted: cleaned as every lesson text is, and refused (a fixed code, nothing echoed) if it asks for a change to tools, access, checks, approvals, models or limits, or holds a literal
//     address, script, shell syntax or encoded text (`hasLiteralExecutable`; ordinary advice that says "run" or "install" is fine, and the tier rules still send it to two people), so those never even reach a person's card; a tool can say nothing the reflector's own drafts could not say;
//   - it is company and project scoped (the key is the caller's checked company and project), rate limited before anything is written (a tool: 10 a person a UTC day; an agent: 3 a task), and audited BEFORE it is
//     stored (no record, no suggestion): who proposed (tool or agent) and the lesson's type, never its text;
//   - it makes NO model call: no judge, no embedder (`noJudge`; the ordered word test decides a copy alone), nothing is reflected.
// What a caller is told never says whether the suggestion was new, merged into another or is waiting for a second sighting.
import {
  KNOWLEDGE_PROPOSE_MESSAGES, KNOWLEDGE_PROPOSE_RECEIVED_MESSAGE, KnowledgeProposalSchema,
  type KnowledgeProposal, type KnowledgeProposeRefusal, type KnowledgeProposeResponse, type KnowledgeProposer,
} from "@agentx/contracts";
import { curateDraft } from "./curate.js";
import { cleanForLearning, hasEncodedBlob, hasLiteralExecutable, requestsCapabilityChange } from "./guards.js";
import { learnedLessonsSwitchOn, modeAllows, requireAudit, resolveLearning } from "./policy.js";
import { PROPOSED_SOURCE } from "./proposal-mark.js";
import { settleLesson, settleOptionsOf, type ProcessDeps } from "./process.js";
import type { LessonDraft } from "./reflect.js";
import type { ScopeKey } from "./store.js";
import type { LessonScope } from "./types.js";

/** The limits are counted by the caller's store (fail closed: a counter that cannot be read refuses the suggestion). */
export interface ProposeLimits {
  /** Counts one suggestion for the person's UTC day and answers whether it is within `KNOWLEDGE_PROPOSALS_PER_PERSON_DAY_MAX`. Throws on a store fault. */
  takePersonDay(companyId: string, personId: string): Promise<boolean>;
  /** Counts one suggestion for the task and answers whether it is within `KNOWLEDGE_PROPOSALS_PER_TASK_MAX`. Throws on a store fault. */
  takeTask(companyId: string, taskId: string): Promise<boolean>;
}

export type Proposer = { kind: "tool"; personId: string } | { kind: "agent"; taskId: string };
export interface ProposeInput {
  companyId: string; project: string; proposer: Proposer;
  /** What the caller sent, unchecked: the schema runs here again (the route, the MCP tool and the worker's tool each check, and none is trusted). */
  proposal: unknown;
  /** The project repository a tool named (already proved to be the project's by the caller): the suggestion is scoped to it. */
  repo?: { name: string } | undefined;
}
export interface ProposeDeps { process: ProcessDeps; limits: ProposeLimits }

const refused = (reason: KnowledgeProposeRefusal): KnowledgeProposeResponse => ({ status: "refused", reason, message: KNOWLEDGE_PROPOSE_MESSAGES[reason] });
export const PROPOSE_RECEIVED: KnowledgeProposeResponse = { status: "received", message: KNOWLEDGE_PROPOSE_RECEIVED_MESSAGE };
const STAGES: LessonDraft["stages"] = ["PLAN", "IMPLEMENT"];

/** Glob characters and path characters only; no `..` and no leading slash (a suggestion's scope stays inside a repository). A path that is not safe refuses the whole suggestion (never a silent cut). */
const SAFE_PATH = /^[\w@+\-.,/*?{}[\]]{1,200}$/u;
const safePath = (path: string): boolean => SAFE_PATH.test(path) && !path.startsWith("/") && !path.split("/").includes("..");

/** The lesson text a proposal makes: the advice is the title, the reason the description, and the body reads "When <when>: <advice>" (the soft wording rule of `lesson-wording`). */
function textOf(proposal: KnowledgeProposal): { title: string; description: string; body: string } | undefined {
  const title = cleanForLearning(proposal.advice, 80);
  const description = cleanForLearning(proposal.why ?? "", 160);
  const when = cleanForLearning(proposal.when ?? "", 200);
  if (title === "") return undefined;
  const body = cleanForLearning(`When ${when === "" ? "working in this part of the code" : when}: ${title}${description === "" ? "" : ` Why: ${description}`}`, 600);
  return { title, description, body };
}

/** The draft: the weakest lesson that can be kept, with its source key and nothing that vouches for it. */
function draftOf(input: ProposeInput, proposal: KnowledgeProposal, text: { title: string; description: string; body: string }): LessonDraft {
  const { proposer } = input;
  const paths = proposal.paths ?? [];
  const scope: LessonScope = { ...(input.repo === undefined ? {} : { repos: [input.repo.name] }), ...(paths.length === 0 ? {} : { paths: [...new Set(paths)] }) };
  const sources = proposer.kind === "tool" ? [PROPOSED_SOURCE.tool, `member:${proposer.personId}`] : [PROPOSED_SOURCE.agent];
  return {
    type: proposal.type ?? "convention", ...text, scope, stages: [...STAGES], citations: [],
    provenance: {
      sourceEvents: [], sourceKinds: [],
      // A tool's person is the author (independence is counted in people; the author rule keeps them from approving it alone; erasing them deletes it). An agent has no author: its task is its sighting.
      authors: proposer.kind === "tool" ? [proposer.personId] : [], ...(proposer.kind === "tool" ? { readFrom: [proposer.personId] } : {}),
      supportTasks: proposer.kind === "agent" ? [proposer.taskId] : [], sources, inputSources: sources, measured: false,
      minTrust: "system", audience: { kind: "project" }, reflectorRun: "proposal", model: "none",
      memberSignal: false, repoBlockCodes: ["no_repo_evidence"],
    },
  };
}

/**
 * Takes one suggestion. Order: shape, learning on, the words' guards, the limit (so a refused word-shape costs nothing, and a flood stops before it writes), the audit record, then curate and settle with no judge and no
 * auto-apply. Never throws for a fault of the store: it answers the fixed `unavailable` refusal (nothing half-written is left as a live lesson).
 */
export async function proposeKnowledge(deps: ProposeDeps, input: ProposeInput): Promise<KnowledgeProposeResponse> {
  const checked = KnowledgeProposalSchema.safeParse(input.proposal);
  if (!checked.success || !(checked.data.paths ?? []).every(safePath)) return refused("not_valid");
  const proposal = checked.data;
  const key: ScopeKey = { workspaceId: input.companyId, project: input.project };
  let learning: Awaited<ReturnType<typeof resolveLearning>>;
  try { learning = await resolveLearning(deps.process.settings, key.workspaceId, key.project); } catch { return refused("unavailable"); }
  if (!learnedLessonsSwitchOn() || !modeAllows(learning.mode, "reflect")) return refused("learning_off");
  const text = textOf(proposal);
  if (text === undefined) return refused("not_valid");
  // The guards run on the CLEANED text (the words that would be stored) and on the scope: advice in words only.
  if (requestsCapabilityChange(text.title, text.description, text.body)) return refused("asks_for_change");
  if (hasLiteralExecutable(text.title, text.description, text.body) || hasEncodedBlob(text.title, text.description, text.body)) return refused("has_command_or_link");
  const { proposer } = input;
  try {
    const within = proposer.kind === "tool" ? await deps.limits.takePersonDay(input.companyId, proposer.personId) : await deps.limits.takeTask(input.companyId, proposer.taskId);
    if (!within) return refused(proposer.kind === "tool" ? "day_limit" : "task_limit");
  } catch { return refused("unavailable"); }
  const by: KnowledgeProposer = proposer.kind;
  const draft = draftOf(input, proposal, text);
  // No record, no suggestion: the audit is written before anything is stored.
  if (!await requireAudit(deps.process.audit, { action: "lesson.knowledge_proposed", workspaceId: key.workspaceId, project: key.project, ...(proposer.kind === "tool" ? { actor: proposer.personId } : {}), facts: { by, type: draft.type } })) return refused("unavailable");
  try {
    // No judge and no embedder: a suggestion makes no model call. The ordered word test alone decides whether it is a copy of something.
    const curateDeps: ProcessDeps = { ...deps.process, noJudge: true, embedder: undefined };
    const outcome = await curateDraft(curateDeps, key, draft);
    if (outcome.outcome === "dropped") return PROPOSE_RECEIVED;
    // Never applied by itself, whatever the settings say: a person decides (and a suggestion folded into an existing lesson keeps that lesson's own state).
    await settleLesson(curateDeps, key, outcome.lesson.id, { ...settleOptionsOf(outcome), noAutoApply: true });
  } catch { return refused("unavailable"); }
  return PROPOSE_RECEIVED;
}

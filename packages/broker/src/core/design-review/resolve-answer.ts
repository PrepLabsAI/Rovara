// Design review stage (security S13, B2): what the planner's answer to a round's findings does to the workflow. The planner (a model that read the reviewers' words and the design) answers each finding fixed, contested,
// asked or declined, with evidence. Its words are DATA: they are read by the strict block reader, every citation is checked against what the round's reviewers were really given and against the BROKER's pins
// (`checkPlannerEvidence`), a contest left with nothing but source citations is refused, and only then do the workflow's own moves run (`askDesignQuestions`, `resolveDesignReview`), which hold every other rule. An answer that is
// unreadable, refused or not allowed by a move is the planner's revision failing: the design goes to the person as reviewed, with the findings unresolved.
//
// The planner's run itself (the prompt, the revised design's storage) is not here: this takes the answer and the stored revised design and decides what they mean.
import {
  DESIGN_REVIEW_ROUNDS_MAX, WorkflowTransitionError, askDesignQuestions, closeDesignReview, readDesignResolve, resolutionOf, resolveDesignReview,
  type CitablePacketItem, type PinnedCommits, type ReviewerRole, type WorkflowArtifact, type WorkflowSnapshot,
} from "@agentx/contracts";
import { checkPlannerEvidence } from "./citations.js";

export interface PlannerResolveInput {
  /** PLAN/RUNNING with the review "resolving". */
  workflow: WorkflowSnapshot;
  /** The planner's answer text: the revised design and, last, the `rovara-design-resolve` block. */
  answer: string;
  /** The revised design as the broker stored it (a new document, never the planner's claim of one). Absent when the answer left the design as it was. */
  revisedDesign?: WorkflowArtifact | undefined;
  /** The pinned commits the round read, which are the broker's. */
  pins: PinnedCommits;
  now: string;
}

/** Every item any reviewer of the last round was given, from the runs the broker recorded (not from the worker, and not from the planner). */
function roundItemsOf(workflow: WorkflowSnapshot): Map<ReviewerRole, readonly CitablePacketItem[]> {
  const round = workflow.designReview?.rounds.at(-1);
  return new Map((round?.reviewers ?? []).filter((run) => run.verified).map((run) => [run.role, run.packet] as const));
}

/** The workflow after the planner's answer: the question card, the resolutions (and round 2, or the person), or the design as reviewed when the answer cannot be used. */
export function applyPlannerResolve(input: PlannerResolveInput): WorkflowSnapshot {
  const { workflow } = input;
  const expectedRevision = workflow.revision;
  const round = workflow.designReview?.rounds.at(-1);
  const unusable = (): WorkflowSnapshot => closeDesignReview(workflow, { expectedRevision, outcome: "finished", now: input.now });
  if (round === undefined) return unusable();
  const open = round.findings.filter((finding) => resolutionOf(round, finding.id) === undefined).map((finding) => finding.id);
  const read = readDesignResolve(input.answer, open);
  if (!read.ok) return unusable();
  const checked = checkPlannerEvidence({ resolutions: read.resolutions, questions: read.questions, packets: roundItemsOf(workflow), pins: input.pins });
  if (!checked.ok) return unusable();
  // the last round does not ask, and only fixes or contests. The prompt says so (`designResolvePrompt`); a planner that asks anyway (or declines) does not lose its fixes and contests: those findings stay open,
  // listed for the person as unresolved, and its questions are not put to anyone.
  const lastRound = (workflow.designReview?.rounds.length ?? 0) >= DESIGN_REVIEW_ROUNDS_MAX;
  const leaveOpen = lastRound ? checked.resolutions.filter((resolution) => resolution.action === "asked" || resolution.action === "declined").map((resolution) => resolution.findingId) : [];
  try {
    // A question card first when the planner needs a person and this round has not asked: the resolutions wait for the answers, and the planner answers again with them.
    if (!lastRound && checked.questions.length > 0 && round.questions === undefined) return askDesignQuestions(workflow, { expectedRevision, questions: checked.questions, now: input.now });
    return resolveDesignReview(workflow, {
      expectedRevision, now: input.now, ...(input.revisedDesign === undefined ? {} : { artifact: input.revisedDesign }), ...(leaveOpen.length === 0 ? {} : { leaveOpen }),
      // `settled` is set by code in the move; the planner's value would be ignored.
      resolutions: checked.resolutions.filter((resolution) => !leaveOpen.includes(resolution.findingId)).map((resolution) => ({ ...resolution, settled: false })),
    });
  } catch (error) {
    if (error instanceof WorkflowTransitionError) return unusable();
    throw error;
  }
}

// Design review stage: does this task get its design checked before a person approves it?
// Pure. Code decides ON or OFF, who decided it, and whether the task is forced onto the Full path. Understand's `design` field is a reading of the request, never a decision: model
// words are shown to people as inert text (through `plainLine`) and never set the tier, the approver, the cost or the mode.
import {
  DESIGN_REVIEW_HIGH_RISK_REASONS, designReasonPhrase, skipRefusalText, skipVerdict,
  type DesignReason, type IntentAssessment, type SkipVerdict, type WorkflowSnapshot,
} from "@agentx/contracts";
import { plainLine } from "../decisions/text.js";
import { inertLine } from "../proof/inert-text.js";
import { DESIGN_REVIEW_FAIL_CLOSED_SETTING, isEffectiveSetting, type EffectiveDesignReviewSetting } from "./effective-setting.js";

export type DesignDecidedBy = "auto" | "always" | "person" | "person_skip" | "never";

export type DesignModeInput = {
  /**
   * The setting the task runs with: `readEffectiveDesignReview(...).setting`, the project's value held to the company's lock. The type is branded, so a raw playbook setting does not compile, and at run
   * time one that got here anyway is read as Off with no skipping (and logged), never as itself.
   */
  setting: EffectiveDesignReviewSetting;
  /** What Understand returned. Undefined until it has returned. */
  assessment: IntentAssessment | undefined;
  /** The person typed `design first:` or pressed Design first. Works even when the setting is `never`. */
  designFirst?: boolean;
  /** The person pressed Skip design review. */
  skip?: boolean;
  /** Whether the person who skipped is the project's high-risk approver. Only they may skip a high-risk design. */
  isHighRiskApprover?: boolean;
  /** The person typed `quick:` or pressed Quick (an explicit path of QUICK). */
  quick?: boolean;
};

export { skipVerdict, skipRefusalText, designReasonPhrase, type SkipVerdict };

export type DesignOffBecause = "setting_never" | "not_needed" | "quick_chosen" | "person_skip";

export type DesignModeDecision =
  | { decided: false; why: "not_returned" | "questions" | "answer" }
  | {
    decided: true;
    on: boolean;
    decidedBy: DesignDecidedBy;
    /** The fixed reason codes Understand gave (at most 4); empty for an older worker. */
    reasons: readonly DesignReason[];
    /** Understand's one-line note, already flattened by `plainLine`. */
    note?: string;
    /** ON forces the Full path. */
    forceFull: boolean;
    /** The person typed `quick:` and review is ON: the task tells them and runs Full. */
    quickOverridden: boolean;
    /** Only when OFF. */
    offBecause?: DesignOffBecause;
    /** Whether the person asked to skip and was refused (the review stays ON). */
    skipRefused?: Extract<SkipVerdict, { allowed: false }>;
    /** Whether Skip may be used on this design; the UI shows the button or the "ask the approver" hint from it. */
    skip: SkipVerdict;
  };

/**
 * The resolution of the mode, in the order the table gives it. Understand must have returned `ready` first: `answer` (a Just-answer) and `questions` are not decided, so a task that was
 * answered never gets a design review, and `design first:` waits for Understand to be ready like everything else.
 *
 * Ready, then in order:
 * 1. the person asked for design first: ON, decidedBy `person`;
 * 2. the person pressed Skip and the skip rules allow it: OFF, decidedBy `person_skip` (a refused Skip is ignored and recorded in `skipRefused`);
 * 3. setting `never`: OFF;
 * 4. setting `always`: ON for every ready task;
 * 5. setting `auto`: ON when `design.needed`; else OFF. An explicit `quick:` turns it OFF here, with its reason.
 * `quick:` under `always`, or beside design first, runs Full and says so.
 */
export function resolveDesignMode(input: DesignModeInput): DesignModeDecision {
  const assessment = input.assessment;
  if (assessment === undefined) return { decided: false, why: "not_returned" };
  if (assessment.kind !== "ready") return { decided: false, why: assessment.kind };
  if (!isEffectiveSetting(input.setting)) console.log(JSON.stringify({ component: "broker", event: "design_review.setting_not_effective" }));
  const setting = isEffectiveSetting(input.setting) ? input.setting : DESIGN_REVIEW_FAIL_CLOSED_SETTING;
  const design = assessment.design;
  const reasons: readonly DesignReason[] = design?.reasons ?? [];
  const note = design === undefined ? undefined : plainLine(design.note, 200);
  const skip = skipVerdict(setting, reasons, input.isHighRiskApprover === true);
  const base = { decided: true as const, reasons, ...(note === undefined || note === "" ? {} : { note }), skip };
  const quick = input.quick === true;
  const on = (decidedBy: DesignDecidedBy): DesignModeDecision => ({ ...base, on: true, decidedBy, forceFull: true, quickOverridden: quick });
  const off = (decidedBy: DesignDecidedBy, offBecause: DesignOffBecause): DesignModeDecision => ({
    ...base, on: false, decidedBy, forceFull: false, quickOverridden: false, offBecause,
  });

  // Design first and Skip together: the first row of the table wins, so the request for more care stands.
  if (input.designFirst === true) return on("person");
  if (input.skip === true) {
    if (skip.allowed) return off("person_skip", "person_skip");
    // A refused Skip is ignored: the rest of the table decides, and the refusal is recorded beside the result.
    const rest = resolveDesignMode({ ...input, skip: false });
    return rest.decided ? { ...rest, skipRefused: skip } : rest;
  }
  if (setting.mode === "never") return off("never", "setting_never");
  if (setting.mode === "always") return on("always");
  if (design?.needed === true) return quick ? off("auto", "quick_chosen") : on("auto");
  return off("auto", "not_needed");
}

const reasonText = (reasons: readonly DesignReason[]): string => reasons.map((reason) => designReasonPhrase(reason)).join("; ");

/**
 * The classification line people see after Understand: one plain sentence or two. `undefined` when nothing is decided yet, and for an answered task, which has no design
 * review. The reason codes become fixed phrases; the model's note goes through `plainLine` and is labelled as Rovara's reading.
 */
export function designClassificationLine(decision: DesignModeDecision): string | undefined {
  if (!decision.decided) return undefined;
  const reasons = reasonText(decision.reasons);
  // The note is model text read from the request, and the line is posted in Slack and Linear threads: it is made inert first (no mention, link, image or tag survives; `&` and `<` are entities, and `>` too), so
  // `<!channel>`, `<https://x|label>` and `<@U1>` are words, never a notification or a link .
  const reading = decision.note === undefined ? "" : ` Note from Rovara: ${inertLine(decision.note, 300).replaceAll(">", "&gt;")}`;
  if (decision.on) {
    const quickNote = decision.quickOverridden ? " You asked for quick, so this task runs the full path to make room for the design." : "";
    switch (decision.decidedBy) {
      case "person": return plainLine(`Design review: on, because you asked for design first.${reasons === "" ? "" : ` Reason: ${reasons}.`}${quickNote}`, 600);
      case "always": return plainLine(`Design review: on, because this project reviews the design of every code change.${reasons === "" ? "" : ` Reason: ${reasons}.`}${quickNote}`, 600);
      default: return plainLine(`Design review: needed. Reason: ${reasons === "" ? "Rovara's reading of the request" : `${reasons} (Rovara's reading of the request)`}.${reading}`, 600);
    }
  }
  switch (decision.offBecause) {
    case "setting_never": return "Design review: off for this project. Type design first to add it.";
    case "person_skip": return "Design review: skipped.";
    case "quick_chosen": return plainLine(`Design review: off, because you chose quick. Rovara would have reviewed the design${reasons === "" ? "" : ` (${reasons})`}. Type design first to add it.${reading}`, 600);
    default: return plainLine(`Design review: not needed.${reasons === "" ? "" : ` Reason: ${reasons}.`}${reading} Design first is available.`, 600);
  }
}

/** The high-risk reason codes, for the approver chip: the same list the contracts use. */
export const highRiskReasonsOf = (reasons: readonly DesignReason[]): readonly DesignReason[] =>
  reasons.filter((reason) => DESIGN_REVIEW_HIGH_RISK_REASONS.includes(reason));

/**
 * The classification line for a task whose design review is ON, from what its review recorded (decidedBy, reasons, Understand's note): the sentence Slack and Linear threads get when the mode resolves. Only for the first
 * card of the task (the requirements or the Quick plan waiting for approval); `undefined` for a task with no design review (nothing is said) and for every later step. Plain text.
 */
export function designClassificationNoteOf(workflow: Pick<WorkflowSnapshot, "designReview" | "stage" | "state" | "reviewPhase" | "decisions">): string | undefined {
  const review = workflow.designReview;
  if (review === undefined || workflow.stage !== "PLAN_REVIEW" || workflow.state !== "WAITING" || workflow.decisions.length > 0) return undefined;
  if (review.decidedBy !== "auto" && review.decidedBy !== "always" && review.decidedBy !== "person") return undefined;
  return designClassificationLine({
    decided: true, on: true, decidedBy: review.decidedBy, reasons: review.reasons, ...(review.note === undefined ? {} : { note: review.note }), forceFull: true, quickOverridden: false, skip: { allowed: true },
  });
}

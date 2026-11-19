// Design review stage: what a client may read of one task's review (the CLI, an assistant's tool). Pure: a workflow in, a view out. It is made from the same stored review the owner's page shows, in the same fixed words, and
// carries no approval offer, no proof and no form: the owner's acts (a cost choice, the answers, picking a paused review up) are made on the page. Model words (findings, questions) are data.
import { designWaitOf, type DesignReviewStateRead, type WorkflowSnapshot } from "@agentx/contracts";
import { designChoiceLabel, designChoicesOf } from "./choice-subject.js";
import { designPanelOf, designQuestionsOf } from "./panel.js";

export function designReviewStateOf(taskId: string, workflow: WorkflowSnapshot, options: { allowSkip: boolean; unpricedNote?: string }): DesignReviewStateRead | undefined {
  if (workflow.designReview === undefined) return undefined;
  const panel = designPanelOf(workflow, { allowSkip: options.allowSkip, ...(options.unpricedNote === undefined ? {} : { unpricedNote: options.unpricedNote }), holdOffer: { requestId: "unused", revision: workflow.revision, artifactDigest: "unused" } });
  if (panel === undefined) return undefined;
  const questions = designQuestionsOf(workflow);
  const choices = designChoicesOf(workflow, { allowSkip: options.allowSkip });
  return {
    taskId, status: panel.status === "" ? "The design review is under way." : panel.status, facts: panel.facts.slice(0, 8),
    findings: panel.findings.slice(0, 60).map((finding) => ({ severity: finding.severity, section: finding.section, text: finding.text, from: finding.from, open: finding.open, ...(finding.resolution === undefined ? {} : { resolution: finding.resolution }) })),
    ...(choices.length === 0 ? {} : { hold: { why: panel.hold?.why ?? (workflow.designReview.estimateUsd === undefined ? "The price of the model is not known" : "The review is over its cost limit"), ...(panel.hold?.note === undefined ? {} : { note: panel.hold.note }), choices: choices.map((choice) => designChoiceLabel(choice)) } }),
    ...(questions === undefined ? {} : { questions }),
    parked: designWaitOf(workflow)?.parkedAt !== undefined,
    blockerReasonNeeded: panel.blockerReasonNeeded === true,
  };
}

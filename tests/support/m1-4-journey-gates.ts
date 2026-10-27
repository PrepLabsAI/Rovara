import { workflowSendBackOffered, type E2EApplicationExecutionAdmission } from "@agentx/contracts";
import type { E2EVerdict } from "../../packages/broker/src/e2e/verdict.js";

// JOURNEY46: what the broker does with a round's verdict, for the M1.4 journeys. They stop at `verifyApplicationE2EEvidence` (no task, no workflow), so these two helpers state the two
// gates that follow it, in the broker's own terms, from the verdict and the admission the journey already holds:
//  - Publication: the CHECKS callback fences the runtime rows a PASS rests on (one condition per admitted runtime row, broker.ts `workflowE2EPublicationChecks`); with no fences publication
//    is STALE. A round that is not a PASS qualifies nothing, so it has none.
//  - Send back: a FAILED round is recorded as the workflow's `failedRound` (broker.ts, the verification step of the CHECKS callback), and `workflowSendBackOffered` is the contracts' own
//    rule over that blocked workflow. Any other verdict records no `failedRound`.

/** The runtime rows publication would fence for a round with this verdict: the admitted rows for a PASS, none otherwise. */
export function publicationFencesOf(admission: Pick<E2EApplicationExecutionAdmission, "runtimeBindings">, verdict: E2EVerdict): string[] {
  return verdict === "PASS" ? admission.runtimeBindings.map((row) => row.key) : [];
}

/** Whether Slack offers Send back to coding for the workflow the broker would leave after a CHECKS round with this verdict and these references. */
export function sendBackOfferedAfter(round: { verdict: E2EVerdict; candidateDigest: string; roundId: string; groupRunIds: readonly string[]; admissionSha256: string; evidenceSha256: string }): boolean {
  const failedRound = round.verdict === "FAILED"
    ? { status: "FAILED", candidateDigest: round.candidateDigest, roundId: round.roundId, groupRunIds: [...round.groupRunIds], admissionSha256: round.admissionSha256, evidenceSha256: round.evidenceSha256 }
    : undefined;
  return workflowSendBackOffered({
    stage: "VERIFY", state: "BLOCKED", blockReason: round.verdict === "FAILED" ? "one or more admitted E2E groups failed" : "admitted E2E evidence is incomplete or unknown",
    candidate: { digest: round.candidateDigest },
    e2e: { required: true, currentRoundId: round.roundId, currentGroupRunIds: [...round.groupRunIds], ...(failedRound === undefined ? {} : { failedRound }) },
  });
}

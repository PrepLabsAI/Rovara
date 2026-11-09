// The local pages' approval proofs, wired into the Approvers seam (lane L6b; the controller's required item after the L8 review). A page does not hand the task flow its session secret: it hands a proof signed over
// the exact request, revision and digest on the page (`LocalPageSessions.issueProof`). This turns that check into the `verifySession` of `createLocalOwnerApprovers`, so:
//   - a proof for request A at revision R is refused for request B, and for revision R+1 or another digest (the request the gate asks about is built from the STORED state, so the revision and digest are the
//     current ones, never the caller's);
//   - the raw page-session secret and the owner's sign-in secret are refused as proofs (neither has the `p1.` shape, and `registerCodeDefaults` no longer falls back to the sign-in check).
import type { ApprovalRequest } from "@agentx/contracts";
import type { LocalPageSessions } from "../local-pages/guard.js";
import { decisionRequestIdOf } from "./approval-gate.js";

/** `verifySession` for `createLocalOwnerApprovers` / `registerCodeDefaults({ approvers: { verifySession } })`, over the pages' sessions. */
export function localSessionProofVerifier(sessions: Pick<LocalPageSessions, "verifyProof">): (token: string, request: ApprovalRequest) => boolean {
  return (token, request) => sessions.verifyProof(token, { requestId: decisionRequestIdOf(request.requestId), revision: request.revision, artifactDigest: request.artifactDigest });
}

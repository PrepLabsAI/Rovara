// TE-H1 browser evidence: the screenshots go into the evidence store, through the same content-addressed writer as every other artifact (`storeEvidenceArtifacts`): under the task,
// `private/<owner>/<workspace>/evidence/<task>/<sha256>`, in the company's partition of the blob store (the document adapter's key is `companyScoped(companyId, ...)`), as `jpeg` with the
// standard retention, and read back only through `readEvidenceArtifact` (sign-in on every request, and only what the task's current pack names). No new key is made here.
// A screenshot the store does not keep turns its route into "Not run: it could not be stored": the pack never names an object that is not there.
import { browserEvidenceCheck, type ArtifactRef, type BrowserEvidenceCaptured, type BrowserEvidenceOutcome, type BrowserEvidenceRouteResult } from "@agentx/contracts";
import { storeEvidenceArtifacts, type EvidenceArtifactStore, type EvidenceOwner } from "./evidence-artifacts.js";

/** Stores one screenshot; its ref, or undefined when the store did not keep it (not a JPEG, the wrong digest, over the cap, the store failing). Never throws for one screenshot. */
async function storeShot(store: EvidenceArtifactStore, owner: EvidenceOwner, shot: { sha256: string; bytes: Uint8Array }): Promise<ArtifactRef | undefined> {
  try {
    const stored = await storeEvidenceArtifacts(store, owner, [{ kind: "jpeg", bytes: shot.bytes, sha256: shot.sha256 }]);
    const ref = stored.get(shot.sha256);
    return ref?.kind === "jpeg" ? ref : undefined;
  } catch { return undefined; }
}

/** Stores the run's screenshots and gives the outcome the pack and the pull request are written from (`addBrowserEvidenceToPack`, `browserEvidenceLines`). The outcome is checked before it is returned. */
export async function storeBrowserEvidence(store: EvidenceArtifactStore, owner: EvidenceOwner, captured: BrowserEvidenceCaptured): Promise<BrowserEvidenceOutcome> {
  const routes: Array<BrowserEvidenceRouteResult<ArtifactRef>> = [];
  for (const row of captured.routes) {
    if (row.status !== "shown") { routes.push({ route: row.route, status: "not_run", reason: row.reason }); continue; }
    const before = await storeShot(store, owner, row.before);
    const after = await storeShot(store, owner, row.after);
    routes.push(before === undefined || after === undefined
      ? { route: row.route, status: "not_run", reason: "not_stored" }
      : { route: row.route, status: "shown", before, after, consoleErrors: { before: row.consoleErrors.before, after: row.consoleErrors.after } });
  }
  const outcome: BrowserEvidenceOutcome = {
    isolation: captured.isolation, durationMs: captured.durationMs, routes, notShown: captured.notShown.map((row) => ({ ...row })), moreNotShown: captured.moreNotShown,
    ...(captured.notRun === undefined ? {} : { notRun: captured.notRun }),
  };
  browserEvidenceCheck(outcome);
  return outcome;
}

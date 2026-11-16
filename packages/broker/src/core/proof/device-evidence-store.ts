// Device testing slice 1 (DEC 244): device-evidence screenshots go into the evidence store, through the same content-addressed writer as every other artifact (`storeEvidenceArtifacts`):
// under the task, `private/<owner>/<workspace>/evidence/<task>/<sha256>`, in the company's partition of the blob store (the document adapter's key is `companyScoped(companyId, ...)`), as `jpeg`
// with the standard retention, and read back only through `readEvidenceArtifact` (sign-in on every request, and only what the task's current pack names). No new key is made here.
// A screenshot the store does not keep turns its step into "Not run: it could not be stored": the pack never names an object that is not there.
import { checkedDeviceEvidenceCaptured, deviceEvidenceCheck, type ArtifactRef, type DeviceEvidenceCaptured, type DeviceEvidenceOutcome, type DeviceEvidenceStepResult } from "@agentx/contracts";
import { deleteEvidenceArtifacts, storeEvidenceArtifacts, type EvidenceArtifactStore, type EvidenceOwner } from "./evidence-artifacts.js";

/** Stores one screenshot; its ref, or undefined when the store did not keep it (not a JPEG, the wrong digest, over the cap, the store failing). Never throws for one screenshot. */
async function storeShot(store: EvidenceArtifactStore, owner: EvidenceOwner, shot: { sha256: string; bytes: Uint8Array }): Promise<ArtifactRef | undefined> {
  try {
    const stored = await storeEvidenceArtifacts(store, owner, [{ kind: "jpeg", bytes: shot.bytes, sha256: shot.sha256 }]);
    const ref = stored.get(shot.sha256);
    return ref?.kind === "jpeg" ? ref : undefined;
  } catch { return undefined; }
}

/**
 * Stores the run's screenshots and gives the outcome the pack and the pull request are written from (`addDeviceEvidenceToPack`, `deviceEvidenceLines`). The run is checked WHOLE before the first
 * write (its shape, every shot within the screenshot cap, all of them within the run's budget): a run it refuses stores nothing. When only one side of a pair is stored, that side is deleted
 * again (`onDeleteFailed` gets what could not be, for the caller's retry queue), so no object is left that no pack names.
 */
export async function storeDeviceEvidence(store: EvidenceArtifactStore, owner: EvidenceOwner, input: DeviceEvidenceCaptured, onDeleteFailed?: (failure: { key: string; sha256: string }) => void): Promise<DeviceEvidenceOutcome> {
  const captured = checkedDeviceEvidenceCaptured(input);
  const steps: Array<DeviceEvidenceStepResult<ArtifactRef>> = [];
  const halves: ArtifactRef[] = [];
  for (const row of captured.steps) {
    if (row.status !== "shown") { steps.push({ flow: row.flow, step: row.step, status: "not_run", reason: row.reason }); continue; }
    const before = await storeShot(store, owner, row.before);
    const after = await storeShot(store, owner, row.after);
    if (before === undefined || after === undefined) {
      for (const ref of [before, after]) if (ref !== undefined) halves.push(ref);
      steps.push({ flow: row.flow, step: row.step, status: "not_run", reason: "not_stored" });
      continue;
    }
    steps.push({ flow: row.flow, step: row.step, status: "shown", before, after });
  }
  // Content addressed under the task: a digest a kept step names (the same picture on two steps) stays.
  const named = new Set(steps.flatMap((row) => (row.status === "shown" ? [row.before.sha256, row.after.sha256] : [])));
  const orphans = halves.filter((ref) => !named.has(ref.sha256));
  if (orphans.length > 0) await deleteEvidenceArtifacts(store, owner, orphans, onDeleteFailed);
  // A step that could not be stored is no longer a shown step: the count of unmasked steps never passes the shown ones.
  const shownNow = new Set(steps.filter((row) => row.status === "shown").map((row) => `${row.flow}/${row.step}`));
  const unmasked = Math.min(captured.unmasked, shownNow.size);
  const outcome: DeviceEvidenceOutcome = {
    device: captured.device, isolation: captured.isolation, durationMs: captured.durationMs, steps, notShown: captured.notShown.map((row) => ({ ...row })), moreNotShown: captured.moreNotShown, unmasked,
    ...(captured.notRun === undefined ? {} : { notRun: captured.notRun }),
  };
  deviceEvidenceCheck(outcome);
  return outcome;
}

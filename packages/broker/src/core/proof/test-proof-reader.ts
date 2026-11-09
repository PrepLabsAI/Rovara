// Playbook P1: the test proof (does a new test fail on the original code?) for the Proof table. Cloud's worker writes test-proof.json at the end of a CHECKS run, bound to the candidate digest; this
// reads it exactly as the synced publication hook does (`loadTestProofLines` in developer/test-proof-lines.ts): the newest 10 task operations, the artifact named TEST_PROOF_ARTIFACT, only an object under the task's
// own key prefix, only a proof that parses and is bound to the current candidate digest. It returns the proof itself (the hook returns only the lines), because the table needs the per-check verdicts to mark a row
// "proven". Informational: any fault gives no proof, and the pull request is published without it.
import { TEST_PROOF_ARTIFACT, TestProofSchema, type TestProof } from "@agentx/contracts";
import type { TestProofActions } from "../../developer/test-proof-lines.js";
import { byCreated, type OperationFacts } from "../../developer/task-records.js";

const OPERATIONS_READ = 10;
const PROOF_READ_BYTES = 256 * 1024;

/**
 * The newest test proof among the task's latest operations that is bound to `candidateDigest`; undefined when there is none, it does not parse, or storage fails. `operations`: the task's operations when the
 * caller has already read them (the task view and the description update hold them), so they are not read again. The newest operations' artifact listings are independent, so they are read together; the
 * newest operation that has a valid proof still wins.
 */
export async function loadTestProof(
  actions: TestProofActions, task: { ownerKey: string; workspaceId: string }, candidateDigest: string | undefined, operations?: readonly OperationFacts[],
): Promise<TestProof | undefined> {
  if (candidateDigest === undefined) return undefined;
  try {
    const newest = [...(operations ?? await actions.operations(task.workspaceId))].filter((operation) => operation.kind === "task").sort(byCreated).reverse().slice(0, OPERATIONS_READ);
    const listings = await Promise.all(newest.map(async (operation) => ({ operation, artifacts: await actions.artifacts(task.workspaceId, operation.id) })));
    for (const { operation, artifacts } of listings) {
      const artifact = artifacts.find((entry) => entry.name === TEST_PROOF_ARTIFACT);
      const prefix = `private/${task.ownerKey}/${task.workspaceId}/${operation.id}/`;
      if (artifact === undefined || !artifact.objectKey.startsWith(prefix)) continue;
      const parsed = TestProofSchema.safeParse(JSON.parse(await actions.readArtifact(artifact.objectKey, PROOF_READ_BYTES)) as unknown);
      if (parsed.success && parsed.data.candidateDigest === candidateDigest) return parsed.data;
    }
  } catch {
    // The proof is a courtesy to the reader: a storage or parse fault only leaves it out.
  }
  return undefined;
}

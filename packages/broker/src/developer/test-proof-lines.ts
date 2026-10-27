// TESTPROOF: the pull request's one or two lines about whether the change's new tests really fail on the original code. The worker writes
// test-proof.json at the end of a CHECKS run, bound to the candidate digest; this reads it at publication. Informational only: no line
// here ever blocks a pull request. A proof bound to any other candidate, one that does not parse, and one from another workspace's
// key are ignored. Quoted labels are redacted and made inert by the caller's `inert` (developer-tasks.ts passes inertPlanLine).
import { TEST_PROOF_ARTIFACT, TestProofSchema, redactText, type TestProof } from "@agentx/contracts";
import { byCreated, type OperationFacts } from "./task-records.js";

const OPERATIONS_READ = 10;
const PROOF_READ_BYTES = 256 * 1024;
const NAMES_LISTED = 3;
const NAME_MAX = 100;

export interface TestProofActions {
  operations(workspaceId: string): Promise<readonly OperationFacts[]>;
  artifacts(workspaceId: string, operationId: string): Promise<ReadonlyArray<{ name: string; objectKey: string }>>;
  readArtifact(objectKey: string, maxBytes: number): Promise<string>;
}

/** The proof when it parses and is bound to `candidateDigest`; otherwise nothing. */
function boundProof(value: unknown, candidateDigest: string | undefined): TestProof | undefined {
  if (candidateDigest === undefined) return undefined;
  const parsed = TestProofSchema.safeParse(value);
  return parsed.success && parsed.data.candidateDigest === candidateDigest ? parsed.data : undefined;
}

/** The lines for a proof bound to `candidateDigest`; none for any other, for a proof that did not run, and when nothing is worth saying. */
export function testProofPullRequestLines(proof: unknown, candidateDigest: string | undefined, inert: (line: string) => string): string[] {
  const bound = boundProof(proof, candidateDigest);
  if (bound === undefined || bound.status !== "checked") return [];
  const count = (verdict: TestProof["items"][number]["verdict"]) => bound.items.filter((item) => item.verdict === verdict).length;
  const proves = count("proves_change");
  const noRun = count("could_not_run_on_old");
  const notChecked = count("not_checked");
  const doesNot = bound.items.filter((item) => item.verdict === "does_not_prove");
  const noun = (n: number) => `${bound.items.every((item) => item.granularity === "test") ? "test" : "check"}${n === 1 ? "" : "s"}`;
  const parts = [
    ...(proves > 0 ? [`${proves} ${noun(proves)} fail${proves === 1 ? "s" : ""} on the original code and pass${proves === 1 ? "es" : ""} now`] : []),
    ...(noRun > 0 ? [`${noRun} could not run on the original code`] : []),
    ...(notChecked > 0 ? [`${notChecked} not checked`] : []),
  ];
  const quoted = (text: string) => inert(redactText(text).replace(/\s+/gu, " ")).slice(0, NAME_MAX);
  const names = doesNot.map((item) => quoted(item.test === undefined ? item.label : `${item.label}: ${item.test}`));
  return [
    ...(parts.length > 0 ? [`Test proof: ${parts.join("; ")}`] : []),
    ...(doesNot.length > 0
      ? [`Warning: ${doesNot.length} ${noun(doesNot.length)} also pass${doesNot.length === 1 ? "es" : ""} on the original code, so ${doesNot.length === 1 ? "it does" : "they do"} not prove the change (${names.slice(0, NAMES_LISTED).join(", ")}${names.length > NAMES_LISTED ? `, and ${names.length - NAMES_LISTED} more` : ""})`]
      : []),
  ];
}

/**
 * The lines from the newest test-proof.json, among the task's latest operations, that is bound to `candidateDigest`. Only an object under
 * the task's own key prefix is read. Any fault reading it gives no lines: the pull request is published without them.
 */
export async function loadTestProofLines(
  actions: TestProofActions,
  task: { ownerKey: string; workspaceId: string },
  candidateDigest: string | undefined,
  inert: (line: string) => string,
): Promise<string[]> {
  if (candidateDigest === undefined) return [];
  try {
    const newest = (await actions.operations(task.workspaceId)).filter((operation) => operation.kind === "task").sort(byCreated).reverse().slice(0, OPERATIONS_READ);
    for (const operation of newest) {
      const artifact = (await actions.artifacts(task.workspaceId, operation.id)).find((entry) => entry.name === TEST_PROOF_ARTIFACT);
      const prefix = `private/${task.ownerKey}/${task.workspaceId}/${operation.id}/`;
      if (artifact === undefined || !artifact.objectKey.startsWith(prefix)) continue;
      const parsed = JSON.parse(await actions.readArtifact(artifact.objectKey, PROOF_READ_BYTES)) as unknown;
      if (boundProof(parsed, candidateDigest) !== undefined) return testProofPullRequestLines(parsed, candidateDigest, inert);
    }
  } catch {
    // The proof is a courtesy to the reader: a storage or parse fault only leaves it out.
  }
  return [];
}

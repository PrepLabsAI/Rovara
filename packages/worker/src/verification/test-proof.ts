// TESTPROOF (stub for the RED commit): the real module follows in the next commit.
import type { CheckEntry, TestProof } from "@agentx/contracts";
import type { CheckPlan, CheckRunners } from "./checks.js";
import type { OriginalCode, OriginalCodeRepository } from "./original-code.js";

export const TEST_PROOF_CAP_MS = 10 * 60_000;

export interface TestProofRepository { repositoryId: string; directory: string; startCommit: string; candidateTreeSha: string }
export interface RunTestProofOptions {
  plan: CheckPlan;
  newEntries: readonly CheckEntry[];
  runners: CheckRunners;
  repositories: readonly TestProofRepository[];
  candidateDigest: string;
  rootPath: string;
  signal: AbortSignal;
  budgetMs: number;
  capMs?: number;
  originalCode?: (repositories: OriginalCodeRepository[]) => OriginalCode;
}

export async function runTestProof(_options: RunTestProofOptions): Promise<TestProof> {
  throw new Error("not implemented");
}

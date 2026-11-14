// Task-scoped, bounded reads. Unknown prior spend never becomes zero and permits another run.
import { EVAL_ROUND_ARTIFACT, EVAL_ROUND_ARTIFACT_MAX_BYTES, EvalRequestSchema, readEvalRoundArtifact, type EvalRoundArtifact, type EvalRequest, type WorkflowSnapshot } from "@agentx/contracts";
import type { TestProofActions } from "../../developer/test-proof-lines.js";
import { byCreated, type OperationFacts } from "../../developer/task-records.js";
import { withinTime, PROOF_READ_MAX_MS } from "./proof-keep.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import type { TaskRecord } from "../task-flow/records.js";
const OPERATIONS_READ = 10;
const OPERATIONS_INPUT_MAX = 10_000;
const LISTINGS_TOTAL_MAX = 1_000;
const component = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/u.test(value);
const array = (value: unknown): boolean => Array.isArray(value);
export interface EvalRoundsSoFar { done: number; calls: number; costMicros: number }

async function readRounds(actions: TestProofActions, task: { ownerKey: string; workspaceId: string }, operations: readonly OperationFacts[] | undefined, digest?: string): Promise<EvalRoundArtifact[] | undefined> {
  if (task === null || typeof task !== "object" || !component(task.ownerKey) || !component(task.workspaceId)) return undefined;
  let active = true;
  try {
    const result = await withinTime(PROOF_READ_MAX_MS, async () => {
      const input = operations ?? await actions.operations(task.workspaceId);
      if (!active || !array(input) || input.length > OPERATIONS_INPUT_MAX) return undefined;
      if (input.some(op => typeof op !== "object" || op === null || !component(op.id) || typeof op.kind !== "string" || op.kind.length > 32 || typeof op.createdAt !== "string" || op.createdAt.length > 64 || !Number.isFinite(Date.parse(op.createdAt)) || (op.fence !== undefined && (!Number.isSafeInteger(op.fence) || op.fence < 0)))) return undefined;
      const taskOperations = input.filter(op => op.kind === "task");
      // Rendering may inspect a recent window; authorizing spend requires complete accounting.
      if (digest === undefined && taskOperations.length > OPERATIONS_READ) return undefined;
      const newest = taskOperations.sort(byCreated).reverse().slice(0, OPERATIONS_READ);
      const rounds: EvalRoundArtifact[] = []; let bytesLeft = EVAL_ROUND_ARTIFACT_MAX_BYTES; let itemsLeft = LISTINGS_TOTAL_MAX;
      for (const operation of newest) {
        if (!active) return undefined;
        const listing = await actions.artifacts(task.workspaceId, operation.id);
        if (!active || !array(listing) || listing.length > itemsLeft) return undefined;
        itemsLeft -= listing.length;
        if (listing.some(item => typeof item !== "object" || item === null || typeof item.name !== "string" || typeof item.objectKey !== "string" || item.name.length > 256 || item.objectKey.length > 2000)) return undefined;
        const matches = listing.filter(item => item.name === EVAL_ROUND_ARTIFACT);
        if (matches.length > 1) return undefined;
        const artifact = matches[0]; if (artifact === undefined) continue;
        const prefix = `private/${task.ownerKey}/${task.workspaceId}/${operation.id}/`;
        if (!artifact.objectKey.startsWith(prefix) || artifact.objectKey.split("/").some(part => part === "." || part === "..")) return undefined;
        if (bytesLeft <= 0) return undefined;
        const text = await actions.readArtifact(artifact.objectKey, bytesLeft);
        if (!active || typeof text !== "string" || text.length > bytesLeft) return undefined;
        const bytes = Buffer.byteLength(text); if (bytes > bytesLeft) return undefined;
        bytesLeft -= bytes;
        const parsed = readEvalRoundArtifact(JSON.parse(text) as unknown);
        if (parsed === undefined) return undefined;
        rounds.push(parsed);
        if (digest !== undefined && parsed.candidateDigest === digest) return rounds;
      }
      return rounds;
    });
    return result.done ? result.value : undefined;
  } finally { active = false; }
}
/** Newest matching artifact wins. A fault anywhere in the inspected input refuses the whole read. */
export async function loadEvalRound(actions: TestProofActions, task: { ownerKey: string; workspaceId: string }, candidateDigest: string | undefined, operations?: readonly OperationFacts[]): Promise<EvalRoundArtifact | undefined> {
  if (typeof candidateDigest !== "string" || !/^[a-f0-9]{64}$/u.test(candidateDigest)) return undefined;
  const rounds = await readRounds(actions, task, operations, candidateDigest);
  return rounds?.find(a => a.candidateDigest === candidateDigest);
}
/** Failed attempts consume budget too. Private or unreadable accounting cannot authorize another pass. */
export async function evalRoundsSoFar(actions: TestProofActions, task: { ownerKey: string; workspaceId: string }, operations?: readonly OperationFacts[]): Promise<EvalRoundsSoFar | undefined> {
  const rounds = await readRounds(actions, task, operations); if (rounds === undefined) return undefined;
  let done = 0; let calls = 0; let costMicros = 0; let completedFirst = false; let completedSecond = false;
  for (const round of rounds) {
    if (round.usage?.costMicros === undefined) return undefined;
    if (round.outcome === "done") { if (round.evalPass === 1) completedFirst = true; else completedSecond = true; }
    done += Number(round.outcome === "done"); calls += round.usage.calls; costMicros += round.usage.costMicros;
    if (!Number.isSafeInteger(calls) || !Number.isSafeInteger(costMicros)) return undefined;
  }
  return completedSecond && !completedFirst ? undefined : { done, calls, costMicros };
}
export function evalRequestFor(workflow: WorkflowSnapshot, soFar: EvalRoundsSoFar | undefined): EvalRequest | undefined {
  const reasons = workflow?.flow?.tier?.reasons;
  if (!Array.isArray(reasons) || reasons.length > 1000 || !reasons.some(reason => reason?.code === "eval_hint")) return undefined;
  if (soFar === undefined || soFar === null || !Number.isSafeInteger(soFar.done) || soFar.done < 0 || soFar.done >= 2) return undefined;
  const parsed = EvalRequestSchema.safeParse({ aiChange: true, reason: "eval_hint", evalPass: 1 + soFar.done, callsAlreadyUsed: soFar.calls, costAlreadyUsedMicros: soFar.costMicros });
  return parsed.success ? parsed.data : undefined;
}

/** The core dispatcher reads through its existing company-scoped store and artifact capability. */
export async function evalRequestForChecks(
  deps: Pick<TaskFlowDeps, "companyId" | "store" | "artifacts">,
  task: TaskRecord, workflow: WorkflowSnapshot,
): Promise<EvalRequest | undefined> {
  if (task.companyId !== deps.companyId || evalRequestFor(workflow, { done: 0, calls: 0, costMicros: 0 }) === undefined || deps.artifacts === undefined) return undefined;
  const artifacts = deps.artifacts;
  const requested = new Set<string>();
  const deadline = Date.now() + PROOF_READ_MAX_MS;
  const actions: TestProofActions = {
    async operations(workspaceId) {
      const found: OperationFacts[] = []; let cursor: string | undefined; let pages = 0;
      do {
        if (++pages > 100 || Date.now() >= deadline) throw new Error("eval evidence unavailable");
        const page = await deps.store.query({ pk: `WORKSPACE#${workspaceId}`, sk: { op: "beginsWith", prefix: "OPERATION#" }, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
        if (page.items.length > 100 || found.length + page.items.length > OPERATIONS_INPUT_MAX) throw new Error("eval evidence unavailable");
        for (const row of page.items) {
          const dispatch = row["dispatch"];
          const payload = typeof dispatch === "object" && dispatch !== null && !Array.isArray(dispatch) ? dispatch["payload"] : undefined;
          if (typeof payload === "object" && payload !== null && !Array.isArray(payload) && payload["evalRequest"] !== undefined && typeof row["id"] === "string") requested.add(row["id"]);
          found.push({ id: row["id"], kind: row["kind"], status: row["status"], createdAt: row["createdAt"], fence: row["fence"] } as OperationFacts);
        }
        cursor = page.cursor;
        if (cursor !== undefined && found.length >= OPERATIONS_INPUT_MAX) throw new Error("eval evidence unavailable");
      } while (cursor !== undefined);
      return found;
    },
    async artifacts(workspaceId, operationId) {
      const row = await deps.store.get({ pk: `WORKSPACE#${workspaceId}`, sk: `ARTIFACT#${operationId}#${EVAL_ROUND_ARTIFACT}` });
      if (row === undefined) {
        if (requested.has(operationId)) throw new Error("eval evidence unavailable");
        return [];
      }
      if (typeof row["objectKey"] !== "string") throw new Error("eval evidence unavailable");
      return [{ name: EVAL_ROUND_ARTIFACT, objectKey: row["objectKey"] }];
    },
    async readArtifact(objectKey, maxBytes) {
      const bytes = await artifacts.get(objectKey, maxBytes);
      if (bytes === undefined || bytes.length > maxBytes) throw new Error("eval evidence unavailable");
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    },
  };
  return evalRequestFor(workflow, await evalRoundsSoFar(actions, task));
}

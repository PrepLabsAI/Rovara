// The existing CODEBUILD records and worker callback wire, over the check-runner port.
import { createHash } from "node:crypto";
import { agentXError, change, when, type DocumentKey, type Check, type CodeBuildCheckResult, type CodeBuildGateDefinition, type StoredDocument } from "@agentx/contracts";
import { checkRunnerForKind } from "../../plugins/routing.js";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { workspaceKeys } from "../task-flow/workspace-location.js";
import type { OperationRecord } from "../task-flow/records.js";
import { iso } from "../task-flow/support.js";

const keyOf = async (deps: TaskFlowDeps, op: OperationRecord, gate: string) => ({ pk: (await workspaceKeys(deps, op.workspaceId)).workspaceKey.pk, sk: `CODEBUILD#${op.id}#${gate}` });
const forbidden = () => agentXError("CALLBACK_FORBIDDEN", "CodeBuild evidence is outside the publication scope or has not passed for this commit");
function assertBound(row: StoredDocument, op: OperationRecord, gate: CodeBuildGateDefinition, commit: string): void {
  if (row["workspaceId"] !== op.workspaceId || row["operationId"] !== op.id || row["fence"] !== op.fence || row["repository"] !== op.publication?.repository || row["gate"] !== gate.name || row["projectName"] !== gate.projectName || row["requestedSourceVersion"] !== commit) throw forbidden();
}
const statusOf = (check: Check): CodeBuildCheckResult["status"] => check.state !== "completed" ? "IN_PROGRESS" : check.conclusion === "success" ? "SUCCEEDED" : "FAILED";

export async function publicationGateCallback(deps: TaskFlowDeps, op: OperationRecord, value: unknown): Promise<CodeBuildCheckResult> {
  const input = value as Record<string, unknown> | null;
  const expected = op.publication;
  if (op.kind !== "publish" || expected === undefined || input === null || typeof input !== "object" || Array.isArray(input)) throw forbidden();
  if (Object.keys(input).some(key => !["action", "repository", "gate", "projectName", "commit", "buildId"].includes(key))) throw agentXError("CONFIG_INVALID", "CodeBuild callback contains unknown fields");
  const gate = expected.codeBuildGates?.find(entry => entry.name === input["gate"] && entry.projectName === input["projectName"]);
  const commit = input["commit"];
  if (gate === undefined || input["repository"] !== expected.repository || typeof commit !== "string" || !/^[a-f0-9]{40,64}$/u.test(commit) || !["start", "status"].includes(String(input["action"]))) throw forbidden();
  const location = await workspaceKeys(deps, op.workspaceId);
  const bound = await deps.store.update({ key: location.operationKey(op.id), ops: [change.set("candidateCommit", commit)], condition: when.and(when.eq("fence", op.fence), when.or(when.notExists("candidateCommit"), when.eq("candidateCommit", commit))) });
  if (!bound.applied) throw forbidden();
  const key = await keyOf(deps, op, gate.name);
  const existing = await deps.store.get(key);
  const cached = cachedGateEvidence(existing, op, gate, commit, input);
  if (cached !== undefined) return cached;
  if (deps.codeHosts === undefined) throw forbidden();
  const runner = checkRunnerForKind(deps.codeHosts, "codebuild", { allowedRepositories: [expected.repositoryUrl] });
  const idempotencyToken = createHash("sha256").update(`${op.id}:${gate.name}:${commit}`).digest("hex");
  const scope = { orgId: deps.companyId };
  const started = existing === undefined ? await runner.start?.({ repository: { url: expected.repositoryUrl }, revision: commit, gate: gate.name, project: gate.projectName, timeoutMinutes: gate.timeoutMinutes, idempotencyKey: idempotencyToken }, scope) : undefined;
  const buildId = started?.run.id ?? existing?.["buildId"];
  if (typeof buildId !== "string") throw forbidden();
  const target = { kind: "run" as const, repository: { url: expected.repositoryUrl }, revision: commit, gate: gate.name, project: gate.projectName, run: { runner: "codebuild", id: buildId } };
  const check = started?.check ?? await runner.getRun?.(target, scope);
  if (check === undefined || check.runId !== buildId || check.name !== gate.name || check.source !== gate.projectName) throw forbidden();
  const facts = await runner.runFacts?.(target, check, scope);
  const evidence: CodeBuildCheckResult = { gate: gate.name, projectName: gate.projectName, buildId, status: statusOf(check), requestedSourceVersion: commit, ...(facts?.resolvedRevision === undefined ? {} : { resolvedSourceVersion: facts.resolvedRevision }) };
  return saveGateEvidence(deps, op, gate, commit, { key, existing, buildId, idempotencyToken, evidence });
}

function cachedGateEvidence(existing: StoredDocument | undefined, op: OperationRecord, gate: CodeBuildGateDefinition, commit: string, input: Record<string, unknown>): CodeBuildCheckResult | undefined {
  if (existing !== undefined) {
    assertBound(existing, op, gate, commit);
    if (input["action"] === "start") return existing["evidence"] as unknown as CodeBuildCheckResult;
    if (input["buildId"] !== existing["buildId"]) throw forbidden();
  } else if (input["action"] !== "start" || input["buildId"] !== undefined) throw forbidden();
  return undefined;
}

async function saveGateEvidence(deps: TaskFlowDeps, op: OperationRecord, gate: CodeBuildGateDefinition, commit: string, input: { key: DocumentKey; existing: StoredDocument | undefined; buildId: string; idempotencyToken: string; evidence: CodeBuildCheckResult }): Promise<CodeBuildCheckResult> {
  const { key, existing, buildId, idempotencyToken, evidence } = input;
  const expected = op.publication!;
  const now = iso(deps);
  const item = JSON.parse(JSON.stringify({ ...key, entityType: "CODEBUILD", workspaceId: op.workspaceId, operationId: op.id, fence: op.fence, repository: expected.repository, gate: gate.name, projectName: gate.projectName, requestedSourceVersion: commit, idempotencyToken, buildId, evidence, createdAt: existing?.["createdAt"] ?? now, updatedAt: now })) as StoredDocument;
  const saved = await deps.store.put({ item, condition: existing === undefined ? when.absent() : when.and(when.eq("buildId", buildId), when.eq("fence", op.fence)) });
  if (!saved.applied) { const prior = await deps.store.get(key); if (prior === undefined) throw forbidden(); assertBound(prior, op, gate, commit); return prior["evidence"] as unknown as CodeBuildCheckResult; }
  return evidence;
}

export async function assertPublicationGates(deps: TaskFlowDeps, op: OperationRecord, commit: string): Promise<void> {
  for (const gate of op.publication?.codeBuildGates ?? []) {
    const row = await deps.store.get(await keyOf(deps, op, gate.name));
    if (row === undefined) throw forbidden();
    assertBound(row, op, gate, commit);
    const evidence = row["evidence"] as unknown as CodeBuildCheckResult | undefined;
    if (evidence?.status !== "SUCCEEDED" || evidence.buildId !== row["buildId"] || evidence.gate !== gate.name || evidence.projectName !== gate.projectName || evidence.requestedSourceVersion !== commit || evidence.resolvedSourceVersion !== commit) throw forbidden();
  }
}

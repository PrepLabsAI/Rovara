import { textField } from "../support/close-recovery-harness.js";
import type { CloseInspectionProvider } from "../../packages/broker/src/core/task-flow/close-inspection.js";
import { execFile } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { CLOSE_RETENTION_FEATURE, SessionCloseDestroySchema, change, workspaceSessionKey, type SessionCloseDestroy } from "@agentx/contracts";
import { createDispatcherCoreHost, refusingCodeHost } from "../../packages/broker/src/aws/worker-machines/dispatcher-core.js";
import { createBrokerCoreRoot } from "../../packages/broker/src/aws/core-engine-root.js";
import { sessionMachineId, sessionWorkerPing } from "../../packages/broker/src/aws/worker-machines/session-worker-machines.js";
import { withCloseVerification } from "../../packages/broker/src/aws/worker-machines/close-retention.js";
import { SessionManager } from "../../packages/broker/src/aws/sessions.js";
import { OperationJournal } from "../../packages/worker/src/journal.js";
import { CloseRetentionExecutor } from "../../packages/worker/src/close-retention.js";
import { inspectWorkspaceForClose } from "../../packages/worker/src/close-workspace.js";
import { createWorkerServerState, handleWorkerRequest } from "../../packages/worker/src/server.js";
import { createHarness } from "../support/task-flow-harness.js";
import { createFakeWorld } from "../support/core-host-fakes.js";
import { FakeDynamoDb as DocumentFake } from "../support/fake-dynamodb.js";
import { FakeDynamoDb } from "../support/ports/dynamodb-fake.js";
import { FakeSqs } from "../support/ports/sqs-fake.js";
import { FakeS3 } from "../support/ports/aws-fakes.js";
import { operationKey, taskKey, taskPointerKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const exec = promisify(execFile);
async function dataFixture() {
  const root = await mkdtemp(join(tmpdir(), "close-retention-dec347-hosted-")); roots.push(root);
  const checkout = join(root, "repo/demo"); await mkdir(checkout, { recursive: true });
  const git = async (...args: string[]) => (await exec("git", ["-C", checkout, ...args])).stdout.trim();
  await git("init", "-b", "main"); await writeFile(join(checkout, "README.md"), "base\n");
  await git("add", "README.md"); await git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "fixture");
  const commit = await git("rev-parse", "HEAD"); await git("update-ref", "refs/remotes/origin/main", commit);
  await mkdir(join(root, ".agentx")); const now = new Date().toISOString();
  await writeFile(join(root, ".agentx/preparation-manifest.json"), JSON.stringify({ schemaVersion: 2, projectName: "payments", projectRevision: 1, repositories: [{ name: "demo", path: "repo/demo", defaultBranch: "main", resolvedCommit: commit, resolvedAt: now, completedAt: now }], completedSetupSteps: [], readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: now }));
  await writeFile(join(checkout, "unsaved.txt"), "retained content\n");
  return root;
}

it("production roots prepare, verify after restart, accept the preview and receipt exact destruction through the real worker and Git inspector", async () => {
  const root = await dataFixture(), h = createHarness(); await h.registerProject();
  const { task } = await h.flow.start(h.owner, { requestId: randomUUID(), project: "payments", instructions: "hosted retention" });
  const wk = workspaceKey(h.deps.companyId, task.workspaceId), sk = workspaceSessionKey(task.workspaceId);
  const workspace = (await h.store.get(wk))!, runId = textField(workspace, "activeOperationId"), runKey = operationKey(h.deps.companyId, task.workspaceId, runId);
  await h.store.update({ key: runKey, ops: [change.set("kind", "task")] });
  await h.store.update({ key: taskPointerKey(h.deps.companyId, task.workspaceId), ops: [change.remove("pendingPrompt")] });
  await h.store.update({ key: wk, ops: [change.set("machine", { machineId: sessionMachineId(task.workspaceId), machineKey: task.workspaceId })] });
  const generation = { sessionGeneration: 1, instanceId: "i-0123456789abcdef0", volumeId: "vol-0123456789abcdef0", dataGeneration: randomUUID() };
  const signer = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  let sealed = false, workerGone = false;
  const inspect = vi.fn(() => inspectWorkspaceForClose(root));
  const storage = { identity: async () => generation, withOwnership: async <T>(_mode: "read" | "write", work: () => Promise<T>) => work(), seal: async () => { sealed = true; return { filesystemId: randomUUID(), backingId: "1:1", deviceId: "7:1" }; }, verify: async () => sealed };
  let worker = makeWorker();
  function makeWorker() {
    const journal = new OperationJournal(root, join(root, "control")), executor = new CloseRetentionExecutor(journal, storage, inspect, () => false);
    return createWorkerServerState(journal, { execute: async () => {}, retention: invocation => executor.answer(invocation), workspaceDataIdentity: generation, invocationFeatures: [CLOSE_RETENTION_FEATURE] }, undefined, { publicKey: signer.publicKey, workspaceId: task.workspaceId, generation: 1 });
  }
  const documentFake = new DocumentFake(); const executions: Array<{ input: string }> = [];
  const sessions = new SessionManager({ tableName: "State", documentClient: { send: async (command: unknown) => {
    const row = await h.store.get(sk); if (row !== undefined) documentFake.set(row);
    const result = await documentFake.send(command as Parameters<DocumentFake["send"]>[0]);
    if ((command as { constructor: { name: string } }).constructor.name !== "GetCommand") {
      const changed = documentFake.get(sk.pk, sk.sk); if (changed !== undefined) await h.store.put({ item: changed as never });
    }
    return result;
  } } as never, executions: { provisionerArn: "arn:aws:states:us-east-1:111122223333:stateMachine:p", deleterArn: "arn:aws:states:us-east-1:111122223333:stateMachine:d", start: async input => { executions.push(input); return "arn:aws:states:us-east-1:111122223333:execution:d:x"; } } });
  const at = new Date().toISOString();
  await h.store.put({ item: { ...sk, entityType: "SESSION", workspaceId: task.workspaceId, state: "READY", generation: 1, instanceId: generation.instanceId, volumeId: generation.volumeId, privateIp: "10.0.0.1", subnetId: "subnet-0123456789abcdef0", availabilityZone: "us-east-1a", launchedAt: at, readyAt: at, lastActivityAt: at, workerFeatures: [CLOSE_RETENTION_FEATURE], workspaceDataIdentity: generation } });
  const wire = new FakeDynamoDb({ tableName: "State" }), sqs = new FakeSqs(), s3 = new FakeS3({ bucket: "artifacts" });
  const cloudRead = { send: async () => ({ Item: { companyId: h.deps.companyId, orgId: h.deps.companyId } }) };
  const machines = { sessions, stopInstance: async () => ({ gone: false }), sign: async (bytes: Uint8Array) => sign("sha256", bytes, signer.privateKey),
    post: async (_url: string, init: { authorization: string; body: string }) => {
      if (workerGone) throw new Error("worker gone");
      const response = await handleWorkerRequest(new Request("http://worker/invocations", { method: "POST", headers: { authorization: init.authorization }, body: init.body }), worker);
      return { status: response.status, body: await response.text() };
    }, ping: async () => sessionWorkerPing(await (await handleWorkerRequest(new Request("http://worker/ping"), worker)).json()) };
  const env = { STATE_TABLE_NAME: "State", ARTIFACT_BUCKET_NAME: "artifacts", CORE_DISPATCH_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/111122223333/dispatch", CORE_DISPATCH_DEAD_LETTER_URL: "https://sqs.us-east-1.amazonaws.com/111122223333/dead", EC2_WORKER_SUBNETS: "us-east-1a=subnet-0123456789abcdef0", EC2_WORKER_LAUNCH_TEMPLATE_ID: "lt-0123456789abcdef0" };
  const owed = new Set(["admission", "metering", "identity", "approvers", "audit-sink", "model-keys"]);
  const dispatcher = () => createDispatcherCoreHost({ env, callbackSigningKey: "k".repeat(32), documentClient: cloudRead as never, clients: { dynamo: wire, sqs, s3 }, machines, changeVisibility: async () => {}, flow: { standingInstructions: null, modelAccess: null, learned: null }, extraModules: createFakeWorld().modules.filter(module => owed.has(module.point)), wrapStorage: () => h.store, log: () => {} });
  let dispatcherProvider = requiredProvider((await dispatcher().app.runtimeFor(h.deps.companyId)).flow.deps.closeInspection);
  expect(dispatcherProvider).toBeDefined();
  h.deps.closeInspection = dispatcherProvider;
  await h.flow.recordResult({ workspaceId: task.workspaceId, operationId: runId, fence: Number(workspace.fence), status: "SUCCEEDED" });
  await h.flow.relayOnce(); await h.flow.dispatchOnce({ maxMessages: 10 });
  const held = (await h.store.get(wk))!, preflightId = textField(held, "activeOperationId");
  expect(await h.store.get(operationKey(h.deps.companyId, task.workspaceId, preflightId))).toMatchObject({ closePreflight: { schemaVersion: 1 }, status: "SUCCEEDED" });
  expect(inspect).toHaveBeenCalledTimes(1);
  worker = makeWorker(); dispatcherProvider = requiredProvider((await dispatcher().app.runtimeFor(h.deps.companyId)).flow.deps.closeInspection);
  const queue = vi.fn(async () => ({ batchItemFailures: [] }));
  const relay = withCloseVerification(queue, event => dispatcherProvider.retained({ workspaceId: event.workspaceId, operationId: event.retention.inspectionOperationId, fence: event.retention.inspectionFence, retentionId: event.retention.retentionId, contentDigest: event.retention.contentDigest, retentionProof: { schemaVersion: 1, generation: event.retention.generation } }));
  const refusing = refusingCodeHost();
  const broker = createBrokerCoreRoot({ env: {}, stateTableName: "State", signInTableName: undefined, documentClient: cloudRead, callbackSigningKey: "k".repeat(32), repositoryGrantKey: Buffer.alloc(32), repositoryCredential: async () => { throw new Error("unused"); }, origin: () => "https://example.test", wrapStorage: () => h.store, codeModules: () => ({ tableName: "State", dynamo: wire, queue: { settings: { queues: { "task-dispatch": { url: env.CORE_DISPATCH_QUEUE_URL, deadLetterUrl: env.CORE_DISPATCH_DEAD_LETTER_URL } } }, client: sqs }, objects: { client: s3, bucket: "artifacts" }, secrets: { namePrefix: "", clientFor: () => ({ send: async () => { throw new Error("unused"); } }) }, codeHost: { provider: refusing, options: { credentialRef: "unused" } }, checkRunner: { githubActions: refusing } }), extraModules: () => createFakeWorld().modules.filter(module => module.point === "model-keys" || module.point === "worker-machines"), services: () => Object.fromEntries(["merge-tracking", "session-sweep", "notify-deliver"].map(name => [name, { pass: async () => ({}) }])), ciReporting: { honest: true, ciMode: () => "their_ci_watch" }, closeVerification: async event => (await relay(event) as { verified: boolean }).verified, log: () => {} });
  h.deps.closeInspection = requiredProvider((await broker.app.runtimeFor(h.deps.companyId)).flow.deps.closeInspection);
  const mutations = [vi.spyOn(h.store, "put"), vi.spyOn(h.store, "update"), vi.spyOn(h.store, "delete"), vi.spyOn(h.store, "transact")];
  const preview = await h.flow.previewClose(h.owner, task.taskId, "discard");
  expect(preview.preview).toMatchObject({ unpublished: [{ repository: "demo", reasons: ["untracked_files"] }] });
  for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
  expect(queue).not.toHaveBeenCalled(); expect(inspect).toHaveBeenCalledTimes(1);
  sealed = false;
  expect((await h.flow.previewClose(h.owner, task.taskId, "discard")).preview).toBeNull();
  for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
  expect(inspect).toHaveBeenCalledTimes(1);
  sealed = true;
  await expect(h.flow.close(h.owner, task.taskId, { requestId: randomUUID(), expectedPreviewDigest: "b".repeat(64), discard_unpublished: true })).rejects.toMatchObject({ code: "CHANGE_STALE" });
  for (const mutation of mutations) { expect(mutation).not.toHaveBeenCalled(); mutation.mockRestore(); }
  await h.flow.close(h.owner, task.taskId, { requestId: randomUUID(), expectedPreviewDigest: preview.preview!.digest, discard_unpublished: true });
  const acceptedId = textField((await h.store.get(taskKey(task.taskId)))!, "closeOperationId");
  h.deps.closeInspection = dispatcherProvider;
  await h.flow.relayOnce(); await h.flow.dispatchOnce({ maxMessages: 10 });
  expect(executions).toHaveLength(1);
  const target = SessionCloseDestroySchema.parse((JSON.parse(executions[0]!.input) as { closeDestroy: SessionCloseDestroy }).closeDestroy);
  expect(target.retention.generation).toEqual(generation);
  expect((await h.store.get(taskKey(task.taskId)))?.closedAt).toBeUndefined();
  await sessions.validateDeletion(task.workspaceId, target); await sessions.markDeleted(task.workspaceId, target);
  workerGone = true;
  h.deps.closeInspection = requiredProvider((await dispatcher().app.runtimeFor(h.deps.companyId)).flow.deps.closeInspection);
  h.clock.advance(31); await h.flow.dispatchOnce({ maxMessages: 10 });
  expect(await h.store.get(operationKey(h.deps.companyId, task.workspaceId, acceptedId))).toMatchObject({ closeAcceptance: { phase: "complete" } });
  expect(executions).toHaveLength(1); expect(inspect).toHaveBeenCalledTimes(1);
});

function requiredProvider(provider: CloseInspectionProvider | undefined): CloseInspectionProvider {
  expect(provider).toBeDefined();
  if (provider === undefined) throw new Error("production provider is missing");
  return provider;
}

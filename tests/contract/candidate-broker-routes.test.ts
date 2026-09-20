import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { candidateArtifactId, type Operation, type WorkerInvocation } from "@agentx/contracts";
import { RepositoryGrantService } from "../../packages/broker/src/repository-access.js";
import { createWorkerCallbackSinks } from "../../packages/worker/src/callback-client.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import type { HttpApiV2Event } from "../../packages/broker/src/aws/lambda.js";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const issuer = "https://identity.example.test";
const ownerKey = sha(`${issuer}\0alice`);
type Row = Record<string, unknown>;

async function fixture() {
  Object.assign(process.env, { AWS_REGION: "us-east-1", STATE_TABLE_NAME: "unused", ARTIFACT_BUCKET_NAME: "unused", OIDC_ISSUER: issuer,
    CALLBACK_SIGNING_KEY: "c".repeat(64), GITHUB_APP_PRIVATE_KEY_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:111122223333:secret:test",
    GITHUB_APP_CREDENTIAL_REF: "github-app", GITHUB_APP_ACCOUNT: "example", GITHUB_APP_ID: "123", GITHUB_APP_INSTALLATION_ID: "456" });
  const { createAwsBrokerHandler } = await import("../../packages/broker/src/aws/broker.js");
  const workspaceId = randomUUID(); const conversationId = randomUUID();
  const now = new Date().toISOString();
  const rows = new Map<string, Row>(); const objects = new Map<string, string>();
  const faults = { failNextRead: false };
  const key = (value: Row) => {
    if (typeof value.pk !== "string" || typeof value.sk !== "string") throw new Error("invalid fixture key");
    return `${value.pk}\0${value.sk}`;
  };
  const put = (row: Row) => rows.set(key(row), structuredClone(row));
  const workspace: Row = { pk: `WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE", id: workspaceId, ownerKey,
    projectName: "demo", projectRevision: 1, environmentDigest: `example.test/worker@sha256:${"a".repeat(64)}`,
    runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agentx", endpointQualifier: "DEFAULT",
    runtimeSessionId: randomUUID(), deploymentMode: "demo-microvm", rootPath: "/mnt/workspace", status: "READY", fence: 1,
    activeOperationId: null, createdAt: now, updatedAt: now };
  put(workspace);
  put({ pk: `MEMBER#${ownerKey}`, sk: "PROJECT#demo", ownerKey, projectName: "demo", role: "developer" });
  put({ pk: `WORKSPACE#${workspaceId}`, sk: `CONVERSATION#${conversationId}` });
  const project = { schemaVersion: 2, name: "demo", revision: 1, controlPlaneUrl: "https://agentx.example.test",
    auth: { issuer, clientId: "agentx", audience: "agentx" }, environment: { image: workspace.environmentDigest },
    repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
    setup: [], readiness: [], orchestratorInstructions: "Delegate" };
  put({ pk: "PROJECT#demo", sk: "REV#000000000001", definition: project });
  const conditional = () => Object.assign(new Error("conditional write failed"), { name: "ConditionalCheckFailedException" });
  const write = (input: Row) => {
    const item = input.Item as Row;
    if (input.ConditionExpression && rows.has(key(item))) throw conditional();
    put(item);
  };
  const update = (input: Row) => {
    const current = rows.get(key(input.Key as Row))!;
    const values = input.ExpressionAttributeValues as Row;
    const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>;
    const expression = input.UpdateExpression as string;
    const condition = input.ConditionExpression as string | undefined;
    if (condition?.includes("fence = :fence") && current.fence !== values[":fence"]) throw conditional();
    if (condition?.includes("activeOperationId = :operation") && current.activeOperationId !== values[":operation"]) throw conditional();
    for (const status of [":cancelled", ":cancelRequested", ":succeeded", ":failed", ":interrupted"]) {
      if (condition?.includes(`#status <> ${status}`) && current.status === values[status]) throw conditional();
    }
    const [sets, removes] = expression.replace(/^SET /, "").split(" REMOVE ");
    for (const assignment of sets!.split(",")) {
      const [field, value] = assignment.trim().split(/\s*=\s*/);
      current[names[field!] ?? field!] = values[value!];
    }
    for (const field of removes?.split(",") ?? []) delete current[field.trim()];
  };
  const documentClient = { send: async (command: { constructor: { name: string }; input: Row }) => {
    if (command.constructor.name === "GetCommand") return { Item: structuredClone(rows.get(key(command.input.Key as Row))) };
    if (command.constructor.name === "PutCommand") { write(command.input); return {}; }
    if (command.constructor.name === "TransactWriteCommand") {
      for (const item of command.input.TransactItems as Array<{ Put?: Row; Update?: Row; ConditionCheck?: Row }>) {
        if (item.ConditionCheck) {
          const row = rows.get(key(item.ConditionCheck.Key as Row));
          const values = item.ConditionCheck.ExpressionAttributeValues as Row;
          if (row?.activeOperationId !== values[":operation"] || row?.fence !== values[":fence"]) throw conditional();
        }
        if (item.Put) write(item.Put); if (item.Update) update(item.Update);
      }
      return {};
    }
    throw new Error(`unexpected ${command.constructor.name}`);
  } };
  const s3 = { send: async (command: { constructor: { name: string }; input: Row }) => {
    const objectKey = command.input.Key as string;
    if (command.constructor.name === "PutObjectCommand") {
      if (command.input.IfNoneMatch === "*" && objects.has(objectKey)) throw Object.assign(new Error("exists"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
      objects.set(objectKey, command.input.Body as string); return {};
    }
    if (faults.failNextRead) { faults.failNextRead = false; throw new Error("interrupted readback"); }
    if (!objects.has(objectKey)) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
    return { Body: { transformToString: async () => objects.get(objectKey)! } };
  } };
  const github = vi.fn(async () => { throw new Error("publication must not run"); });
  const handler = createAwsBrokerHandler({ documentClient: documentClient as never, s3: s3 as never,
    stopRuntimeSession: async () => {}, tableName: "state", artifactBucketName: "artifacts", issuer, adminClaim: "groups", adminValues: ["admins"],
    callbackSigningKey: "c".repeat(64), repositoryGrants: new RepositoryGrantService(Buffer.alloc(32, 1), async () => ({})),
    githubPullRequests: { reconcilePullRequest: github, getPullRequest: github, updatePullRequest: github } });
  async function request(path: string, body?: unknown, headers: Record<string, string> = {}, subject = "alice") {
    const event: HttpApiV2Event = { version: "2.0", rawPath: path, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      requestContext: { requestId: randomUUID(), http: { method: body === undefined ? "GET" : "POST" }, authorizer: { jwt: { claims: { iss: issuer, sub: subject } } } } };
    const response = await handler(event);
    return { status: response.statusCode, body: JSON.parse(response.body) as { operation?: Operation; duplicate?: boolean; artifact?: { content: string }; error?: unknown } };
  }
  const task = { requestId: randomUUID(), conversationId, prompt: "Edit safely", candidate: { jobId: randomUUID(), attempt: 1, repository: "demo", baseCommit: "a".repeat(40) } };
  const taskPath = `/v1/workspaces/${workspaceId}/tasks`;
  async function admit() {
    const response = await request(taskPath, task); expect(response.status).toBe(202);
    const invocation = [...rows.values()].find((row) => row.entityType === "OUTBOX")!.invocation as Extract<WorkerInvocation, { kind: "task" }>;
    const callbacks = createWorkerCallbackSinks({ controlPlaneUrl: "https://agentx.example.test", invocation,
      fetchImplementation: async (url, init) => {
        const address = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        const response = await request(new URL(address).pathname, JSON.parse(init!.body as string) as unknown, init!.headers as Record<string, string>);
        return Response.json(response.body, { status: response.status });
      } });
    return { response, invocation, callbacks };
  }
  return { rows, objects, workspace, project, task, taskPath, workspaceId, request, admit, github, faults };
}

function chunkAndCandidate(f: Awaited<ReturnType<typeof fixture>>, invocation: Extract<WorkerInvocation, { kind: "task" }>) {
  const bytes = Buffer.from("retained bundle fixture");
  const name = `candidate-${invocation.operationId}-0000.bundle.base64`;
  const id = candidateArtifactId(invocation.operationId, name);
  const artifact = { id, name, mediaType: "application/vnd.agentx.git-bundle-chunk.base64", content: bytes.toString("base64") };
  const candidate = { schemaVersion: 1, candidateId: invocation.operationId, ...f.task.candidate, operationId: invocation.operationId,
    workspaceId: f.workspaceId, projectRevision: 1, repositoryUrl: "https://github.com/example/demo.git", commit: "b".repeat(40), tree: "c".repeat(40),
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), producer: "agentx-worker", qualification: "claimed",
    retrieval: { kind: "agentx-artifacts", format: "git-bundle", sha256: sha(bytes), sizeBytes: bytes.length,
      chunks: [{ artifactId: id, name, sha256: sha(bytes), sizeBytes: bytes.length }] } };
  return { artifact, candidate };
}

describe("live broker candidate routes", () => {
  it("runs the real task freezer through authenticated broker callbacks and reconstructs the returned source", async () => {
    const f = await fixture();
    const root = await mkdtemp(join(tmpdir(), "agentx-broker-worker-"));
    const repo = join(root, "repo/demo"); const run = promisify(execFile);
    const git = async (...args: string[]) => (await run("git", ["-C", repo, ...args])).stdout.trim();
    try {
      await mkdir(repo, { recursive: true }); await git("init", "--initial-branch=main");
      await writeFile(join(repo, "value.txt"), "base\n"); await git("add", ".");
      await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "base");
      await git("remote", "add", "origin", "https://github.com/example/demo.git");
      f.task.candidate.baseCommit = await git("rev-parse", "HEAD");
      await mkdir(join(root, ".agentx"));
      await writeFile(join(root, ".agentx/preparation-manifest.json"), JSON.stringify({ complete: true, projectRevision: 1, repositories: [{ name: "demo", path: "repo/demo" }] }));
      const { invocation, callbacks } = await f.admit();
      const result = await runTaskInvocation(invocation, { rootPath: root, model: { provider: "fixture", modelId: "fixture" }, ...callbacks,
        piAdapter: { create: async ({ sessionDirectory }) => ({ conversationId: f.task.conversationId, sessionFile: join(sessionDirectory, "fixture.jsonl"),
          prompt: async () => { await writeFile(join(repo, "value.txt"), "changed by fixture executor\n"); await writeFile(join(repo, "new.txt"), "new file\n"); },
          abort: async () => {}, subscribe: () => () => {}, dispose: () => {} }) } });
      await callbacks.terminalSink({ operationId: invocation.operationId, status: "SUCCEEDED", result });
      const status = await f.request(`/v1/workspaces/${f.workspaceId}/operations/${invocation.operationId}`);
      expect(status.body.operation!.result).toMatchObject({ candidate: result.candidate });
      const chunks = await Promise.all(result.candidate!.retrieval.chunks.map(async (chunk) => {
        const response = await f.request(`/v1/workspaces/${f.workspaceId}/artifacts/${chunk.artifactId}`);
        return Buffer.from(response.body.artifact!.content, "base64");
      }));
      const bundle = join(root, "candidate.bundle"); await writeFile(bundle, Buffer.concat(chunks));
      const consumer = join(root, "consumer"); await run("git", ["clone", bundle, consumer]);
      expect(await readFile(join(consumer, "new.txt"), "utf8")).toBe("new file\n");
      expect((await run("git", ["-C", consumer, "rev-parse", "HEAD"])).stdout.trim()).toBe(result.candidate!.commit);
      expect(f.github).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("reconciles interrupted upload readback without overwriting retained bytes", async () => {
    const f = await fixture(); const { invocation, callbacks } = await f.admit();
    const { artifact } = chunkAndCandidate(f, invocation);
    f.faults.failNextRead = true;
    await expect(callbacks.artifactSink(artifact)).rejects.toThrow();
    expect([...f.rows.values()].filter((row) => row.entityType === "ARTIFACT")).toHaveLength(0);
    expect(f.objects.size).toBe(1);
    expect(await callbacks.artifactSink(artifact)).toMatchObject({ artifactId: artifact.id, sha256: sha(artifact.content) });
    expect(f.objects.size).toBe(1);
  });
  it("pins trusted project and full candidate binding in the durable task and replay hash", async () => {
    const f = await fixture(); const { response, invocation } = await f.admit();
    expect(invocation.payload.candidate).toEqual(f.task.candidate);
    expect(invocation.payload.project).toEqual(f.project);
    expect(response.body.operation!.payloadHash).toBe(sha(JSON.stringify({ conversationId: f.task.conversationId, prompt: f.task.prompt, candidate: f.task.candidate })));
    expect((await f.request(f.taskPath, f.task)).body.duplicate).toBe(true);
    expect((await f.request(f.taskPath, { ...f.task, candidate: { ...f.task.candidate, baseCommit: "b".repeat(40) } })).status).toBe(409);
  });

  it("returns immutable readback receipts and makes the complete candidate retrievable from operation state", async () => {
    const f = await fixture(); const { invocation, callbacks } = await f.admit();
    const { artifact, candidate } = chunkAndCandidate(f, invocation);
    const receipt = await callbacks.artifactSink(artifact);
    expect(receipt).toEqual({ artifactId: artifact.id, sha256: sha(artifact.content), sizeBytes: Buffer.byteLength(artifact.content) });
    expect(await callbacks.artifactSink(artifact)).toEqual(receipt);
    expect(f.objects.size).toBe(1);
    await expect(callbacks.artifactSink({ ...artifact, content: Buffer.from("different").toString("base64") })).rejects.toThrow();
    const result = { conversationId: f.task.conversationId, sessionFile: "agent-sessions/task.jsonl", candidate };
    await callbacks.terminalSink({ operationId: invocation.operationId, status: "SUCCEEDED", result });
    await callbacks.terminalSink({ operationId: invocation.operationId, status: "SUCCEEDED", result });
    const status = await f.request(`/v1/workspaces/${f.workspaceId}/operations/${invocation.operationId}`);
    expect(status.body.operation!.result).toEqual(result);
    const fetched = await f.request(`/v1/workspaces/${f.workspaceId}/artifacts/${artifact.id}`);
    expect(fetched.body.artifact!.content).toBe(artifact.content);
    expect((await f.request(`/v1/workspaces/${f.workspaceId}/artifacts/${artifact.id}`, undefined, {}, "other-owner")).status).toBe(404);
    await expect(callbacks.terminalSink({ operationId: invocation.operationId, status: "SUCCEEDED", result: { ...result, candidate: { ...candidate, commit: "e".repeat(40) } } })).rejects.toThrow();
  });

  it("rejects missing, corrupted, expired or wrong-job candidate claims", async () => {
    const f = await fixture(); const { invocation, callbacks } = await f.admit();
    const { artifact, candidate } = chunkAndCandidate(f, invocation);
    const finish = (value: unknown) => callbacks.terminalSink({ operationId: invocation.operationId, status: "SUCCEEDED", result: { candidate: value } });
    await expect(finish(candidate)).rejects.toThrow();
    await callbacks.artifactSink(artifact);
    for (const change of [{ jobId: randomUUID() }, { baseCommit: "d".repeat(40) }, { expiresAt: "2000-01-01T00:00:00Z" }, { qualification: "verified" }]) await expect(finish({ ...candidate, ...change })).rejects.toThrow();
    const objectKey = [...f.objects.keys()][0]!; f.objects.set(objectKey, "altered storage");
    await expect(finish(candidate)).rejects.toThrow();
    f.objects.set(objectKey, artifact.content);
    await expect(finish({ ...candidate, retrieval: { ...candidate.retrieval, sha256: "0".repeat(64) } })).rejects.toThrow();
    const operation = [...f.rows.values()].find((row) => row.entityType === "OPERATION")!;
    operation.status = "CANCEL_REQUESTED";
    await expect(finish(candidate)).rejects.toThrow();
    expect(operation.status).toBe("CANCEL_REQUESTED");
    expect(operation.result).toBeUndefined();
  });

  it("rejects unknown repositories, oversized/noncanonical chunks, stale fences and legacy publication bypass", async () => {
    const f = await fixture();
    expect((await f.request(f.taskPath, { ...f.task, candidate: { ...f.task.candidate, repository: "other" } })).status).toBe(400);
    const { invocation, callbacks } = await f.admit(); const { artifact } = chunkAndCandidate(f, invocation);
    await expect(callbacks.artifactSink({ ...artifact, content: "!not-base64!" })).rejects.toThrow();
    await expect(callbacks.artifactSink({ ...artifact, content: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64") })).rejects.toThrow();
    const ws = [...f.rows.values()].find((row) => row.entityType === "WORKSPACE")!;
    ws.fence = 100;
    await expect(callbacks.artifactSink(artifact)).rejects.toThrow();
    ws.status = "READY"; delete ws.activeOperationId;
    for (const extra of [{}, { candidateOperationId: invocation.operationId }]) {
      expect((await f.request(`/v1/workspaces/${f.workspaceId}/pull-requests`, { requestId: randomUUID(), repository: "demo", title: "Publish", ...extra })).status).toBe(403);
    }
    expect((await f.request(`/v1/workspaces/${f.workspaceId}/pull-request-actions`, { requestId: randomUUID(), repository: "demo", pullRequestNumber: 1, action: "append" })).status).toBe(403);
    expect(f.github).not.toHaveBeenCalled();
  });
});

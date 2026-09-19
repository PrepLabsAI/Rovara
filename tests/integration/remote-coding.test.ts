import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ProjectDefinition, WorkerInvocation } from "@agentx/contracts";
import {
  InMemoryRegistry,
  OperationStore,
  OwnerScopedOutputStore,
  type AuthenticatedIdentity,
} from "../../packages/broker/src/index.js";
import { prepareWorkspace } from "../../packages/worker/src/prepare.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import type { PiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

describe("remote coding delegation", () => {
  it("changes and tests only the worker workspace, returns private evidence, and does not commit", async () => {
    const source = await createSourceRepository();
    const rootPath = await mkdtemp(join(tmpdir(), "agentx-remote-worker-"));
    const project = projectDefinition(source.commit);
    await prepareWorkspace({
      rootPath,
      project,
      materializer: async (_repository, destination) => {
        await run("git", ["clone", "--quiet", source.directory, destination]);
      },
    });
    const owner = identity("a".repeat(64));
    const registry = new InMemoryRegistry();
    const now = new Date().toISOString();
    const workspace = await registry.createDefault({
      id: randomUUID(),
      ownerKey: owner.ownerKey,
      projectName: project.name,
      projectRevision: project.revision,
      environmentDigest: project.environment.image,
      runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agentx",
      endpointQualifier: "DEFAULT",
      runtimeSessionId: randomUUID(),
      deploymentMode: "instances-ebs",
      capacityProviderArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:capacity-provider/agentx",
      rootPath: "/mnt/workspace",
      status: "READY",
      preparationManifest: ".agentx/preparation-manifest.json",
      activeOperationId: null,
      fence: 1,
      createdAt: now,
      updatedAt: now,
    });
    const operations = new OperationStore(registry);
    const request = { requestId: randomUUID(), conversationId: randomUUID(), prompt: "Set value to 2 and test it" };
    const first = await operations.acceptTask(workspace.id, owner.ownerKey, request);
    const duplicate = await operations.acceptTask(workspace.id, owner.ownerKey, request);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.operation.id).toBe(first.operation.id);

    const output = new OwnerScopedOutputStore(registry);
    const artifactIds: string[] = [];
    let workerExecutions = 0;
    const invocation: WorkerInvocation = {
      protocolVersion: 1,
      kind: "task",
      operationId: first.operation.id,
      workspaceId: workspace.id,
      fence: first.operation.fence,
      projectRevision: 1,
      callbackCapability: "c".repeat(64),
      payload: { conversationId: request.conversationId, prompt: request.prompt },
    };

    await runTaskInvocation(invocation, {
      rootPath,
      model: { provider: "fixture", modelId: "fixture" },
      piAdapter: fixturePiAdapter(rootPath, request.conversationId, () => {
        workerExecutions += 1;
      }),
      eventSink: async (events) => {
        output.appendEvents(
          first.operation.id,
          workspace.id,
          events.map(({ type, timestamp, payload }) => ({ type, timestamp, payload })),
        );
      },
      artifactSink: async (artifact) => {
        const stored = await output.putArtifact({
          ownerKey: owner.ownerKey,
          workspaceId: workspace.id,
          operationId: first.operation.id,
          ...artifact,
        });
        artifactIds.push(stored.id);
      },
    });
    operations.transition(first.operation.id, "SUCCEEDED", { result: { artifactIds } });
    await registry.releaseWriter(workspace.id, first.operation.id);

    expect(workerExecutions).toBe(1);
    await expect(readFile(join(rootPath, "repo/app/value.txt"), "utf8")).resolves.toBe("2\n");
    await expect(readFile(join(source.directory, "value.txt"), "utf8")).resolves.toBe("1\n");
    const { stdout: commits } = await run("git", ["-C", join(rootPath, "repo/app"), "rev-list", "--count", "HEAD"]);
    expect(commits.trim()).toBe("1");
    const artifacts = await Promise.all(
      artifactIds.map(async (id) => output.getArtifact(owner, workspace.id, id)),
    );
    expect(artifacts.find(({ name }) => name === "workspace.diff")?.content).toContain("+2");
    expect(artifacts.find(({ name }) => name === "test-and-tool-evidence.json")?.content).toContain(
      "tests passed",
    );
    await expect(output.getArtifact(identity("b".repeat(64)), workspace.id, artifactIds[0]!)).rejects.toThrow(
      /not found/i,
    );
    const page = await output.pageEvents(owner, workspace.id, first.operation.id, { limit: 2 });
    expect(page.events.map(({ sequence }) => sequence)).toEqual([1, 2]);
    expect(page.cursor).toBeDefined();
  });
});

function fixturePiAdapter(rootPath: string, conversationId: string, onRun: () => void): PiSessionAdapter {
  return {
    async create({ sessionDirectory }) {
      await mkdir(sessionDirectory, { recursive: true });
      const sessionFile = join(sessionDirectory, `${conversationId}.jsonl`);
      await writeFile(sessionFile, "", { flag: "wx" });
      let listener: (event: unknown) => void = () => undefined;
      return {
        conversationId,
        sessionFile,
        async prompt() {
          onRun();
          listener({ type: "tool_execution_start", toolName: "edit" });
          await writeFile(join(rootPath, "repo/app/value.txt"), "2\n");
          const { stdout } = await run("node", ["test.mjs"], { cwd: join(rootPath, "repo/app") });
          listener({ type: "tool_execution_end", toolName: "bash", result: stdout.trim() });
        },
        async abort() {},
        subscribe(next) {
          listener = next;
          return () => {
            listener = () => undefined;
          };
        },
        dispose() {},
      };
    },
  };
}

async function createSourceRepository(): Promise<{ directory: string; commit: string }> {
  const directory = await mkdtemp(join(tmpdir(), "agentx-remote-source-"));
  await run("git", ["init", "--quiet", directory]);
  await writeFile(join(directory, "value.txt"), "1\n");
  await writeFile(
    join(directory, "test.mjs"),
    "import { readFile } from 'node:fs/promises';\nif (await readFile('value.txt', 'utf8') !== '2\\n') process.exit(1);\nconsole.log('tests passed');\n",
  );
  await run("git", ["-C", directory, "add", "."]);
  await run("git", ["-C", directory, "-c", "user.name=AgentX", "-c", "user.email=agentx@example.test", "commit", "--quiet", "-m", "fixture"]);
  const { stdout } = await run("git", ["-C", directory, "rev-parse", "HEAD"]);
  return { directory, commit: stdout.trim() };
}

function projectDefinition(commit: string): ProjectDefinition {
  return {
    schemaVersion: 1,
    name: "payments",
    revision: 1,
    controlPlaneUrl: "http://127.0.0.1:8787",
    auth: { issuer: "http://127.0.0.1:9000", clientId: "agentx", audience: "agentx" },
    environment: { image: `registry.example.test/worker@sha256:${"a".repeat(64)}` },
    repositories: [
      {
        name: "app",
        url: "http://127.0.0.1/app.git",
        path: "repo/app",
        initialCommit: commit,
        credentialRef: "app-readwrite",
      },
    ],
    setup: [],
    readiness: [],
    orchestratorInstructions: "Delegate remotely.",
  };
}

function identity(ownerKey: string): AuthenticatedIdentity {
  return {
    issuer: "https://identity.example.test",
    subject: ownerKey,
    ownerKey,
    isAdministrator: false,
    claims: {},
  };
}

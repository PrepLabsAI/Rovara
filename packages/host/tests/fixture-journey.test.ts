import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthenticatedIdentity } from "@agentx/broker";
import type { CandidateResult, Operation } from "@agentx/contracts";
import { prepareWorkspace } from "@agentx/worker";
import { openHostDatabase } from "../src/store/database.js";
import { SqliteRegistry } from "../src/store/sqlite-registry.js";
import { SqliteOperationStore } from "../src/store/sqlite-operations.js";
import { createLocalBrokerHandler } from "../src/routes.js";
import { createFixtureWorkerTransport, createOutboxDispatcher } from "../src/dispatcher.js";
import { createFixtureSessionAdapter, runTrustedCheckPlan, type FixtureMode } from "../src/fixture-worker.js";
import { recoverHost } from "../src/recover.js";

const run = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const git = async (cwd: string, ...args: string[]) => (await run("git", ["-C", cwd, ...args])).stdout.trim();

/** The one trusted check plan. Both arms are measured against exactly these expectations. */
const CHECK_PLAN = [
  { name: "filter-preserves-pagination", path: "src/filter.txt", mustEqual: "all|open|done+pagination\n" },
  { name: "team-isolation-retained", path: "src/isolation.txt", mustEqual: "team-scoped\n" },
];

const EDITS = [
  {
    path: "src/filter.txt",
    correct: "all|open|done+pagination\n",
    // The defect is real source, not a flag: filtering drops pagination.
    defective: "all|open|done\n",
  },
  { path: "src/isolation.txt", correct: "team-scoped\n", defective: "team-scoped\n" },
];

const identity: AuthenticatedIdentity = {
  issuer: "https://identity.example.test",
  subject: "alice",
  ownerKey: "alice".padEnd(64, "0"),
  isAdministrator: true,
  claims: {},
};

const memberships = [{ ownerKey: identity.ownerKey, project: "payments", role: "administrator" as const }];

function projectDefinition(image: string) {
  return {
    schemaVersion: 2 as const,
    name: "payments",
    revision: 1,
    controlPlaneUrl: "https://agentx.example.test",
    auth: { issuer: "https://identity.example.test", clientId: "agentx", audience: "agentx" },
    environment: { image },
    repositories: [{
      name: "app", url: "https://github.com/example/app.git", path: "repo/app",
      defaultBranch: "main", credentialRef: "github-app",
    }],
    setup: [], readiness: [], orchestratorInstructions: "Delegate",
  };
}

/**
 * A host with a really prepared workspace and a fixture worker.
 *
 * The workspace is materialized by the real `prepareWorkspace` from a real Git source,
 * so the candidate base, clean-tree and remote checks all run against actual repository
 * state rather than a stub.
 */
async function journey(options: { mode: FixtureMode; dropTerminalReply?: () => boolean } ) {
  const source = await scratch("agentx-host-source-");
  await git(source, "init", "--quiet", "--initial-branch=main");
  await mkdir(join(source, "src"), { recursive: true });
  await writeFile(join(source, "src/filter.txt"), "none\n");
  await writeFile(join(source, "src/isolation.txt"), "team-scoped\n");
  await git(source, "add", ".");
  await git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "base");

  const rootPath = await scratch("agentx-host-workspace-");
  const image = `registry.example.test/worker@sha256:${"a".repeat(64)}`;
  await prepareWorkspace({
    rootPath,
    project: projectDefinition(image),
    materializer: async (_repository, destination) => {
      await run("git", ["clone", "--quiet", source, destination]);
      await run("git", ["-C", destination, "remote", "set-url", "origin", "https://github.com/example/app.git"]);
    },
  });
  const repositoryPath = join(rootPath, "repo/app");
  const baseCommit = await git(repositoryPath, "rev-parse", "HEAD");

  const stateRoot = await scratch("agentx-host-state-");
  const databaseFile = join(stateRoot, "host.sqlite");
  const callbackSigningKey = randomBytes(32);

  const open = () => {
    const database = openHostDatabase(databaseFile);
    const registry = new SqliteRegistry(database);
    const operations = new SqliteOperationStore(database, registry);
    const handler = createLocalBrokerHandler({
      registry, operations, memberships, callbackSigningKey,
      resolveIdentity: async () => identity,
    });
    const transport = createFixtureWorkerTransport({
      rootPath, handler,
      sessionAdapter: createFixtureSessionAdapter({ mode: options.mode, edits: EDITS, repositoryPath }),
      ...(options.dropTerminalReply === undefined ? {} : { dropTerminalReply: options.dropTerminalReply }),
    });
    const dispatcher = createOutboxDispatcher({ operations, transport });
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await handler({
        method, path, headers: {},
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
    };
    return { database, registry, operations, handler, transport, dispatcher, call };
  };

  const first = open();
  first.registry.registerProject(identity, projectDefinition(image), memberships);
  const timestamp = new Date().toISOString();
  const workspace = await first.registry.createDefault({
    id: randomUUID(), ownerKey: identity.ownerKey, projectName: "payments", projectRevision: 1,
    environmentDigest: image,
    runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agentx",
    endpointQualifier: "DEFAULT", runtimeSessionId: randomUUID(), deploymentMode: "demo-microvm",
    rootPath: "/mnt/workspace", status: "READY", activeOperationId: null, fence: 1,
    createdAt: timestamp, updatedAt: timestamp,
  });
  const conversationId = first.registry.createConversation(workspace.id, randomUUID());

  return { source, rootPath, repositoryPath, baseCommit, databaseFile, workspace, conversationId, open, first };
}

/** Rebuild the candidate source from the artifacts the real freezer uploaded. */
async function reconstruct(
  host: Awaited<ReturnType<typeof journey>>,
  session: ReturnType<Awaited<ReturnType<typeof journey>>["open"]>,
  candidate: CandidateResult,
): Promise<string> {
  const chunks = candidate.retrieval.chunks.map((chunk) => {
    const stored = session.operations.getArtifact(host.workspace.id, chunk.artifactId);
    expect(stored).toBeDefined();
    return Buffer.from(stored!.content, "base64");
  });
  const workspaceRoot = await scratch("agentx-host-verify-");
  const bundle = join(workspaceRoot, "candidate.bundle");
  await writeFile(bundle, Buffer.concat(chunks));
  const consumer = join(workspaceRoot, "consumer");
  await run("git", ["clone", "--quiet", bundle, consumer]);
  expect(await git(consumer, "rev-parse", "HEAD")).toBe(candidate.commit);
  return consumer;
}

async function submit(
  host: Awaited<ReturnType<typeof journey>>,
  session: ReturnType<Awaited<ReturnType<typeof journey>>["open"]>,
  requestId = randomUUID(),
) {
  const response = await session.call("POST", `/v1/workspaces/${host.workspace.id}/tasks`, {
    requestId,
    conversationId: host.conversationId,
    prompt: "Add All / Open / Done filtering. Preserve pagination and team isolation.",
    candidate: { jobId: randomUUID(), attempt: 1, repository: "app", baseCommit: host.baseCommit },
  });
  expect(response.status).toBe(202);
  return { requestId, operation: (response.body as { operation: Operation }).operation };
}

describe("fixture worker journey", () => {
  it.each([
    ["correct", true],
    ["defective", false],
  ] as const)("freezes a real %s candidate that the one trusted plan judges", async (mode, shouldPass) => {
    const host = await journey({ mode });
    const session = host.first;
    const { requestId, operation } = await submit(host, session);

    const delivered = await session.dispatcher.drainOnce();
    expect(delivered).toEqual([expect.objectContaining({ delivered: true })]);

    const settled = session.operations.get(operation.id)!;
    expect(settled.status).toBe("SUCCEEDED");
    const candidate = (settled.result as { candidate: CandidateResult }).candidate;

    // The freezer produced this, not the test: it is a real commit on the declared base.
    expect(candidate.baseCommit).toBe(host.baseCommit);
    expect(candidate.commit).not.toBe(host.baseCommit);
    expect(candidate.producer).toBe("agentx-worker");
    expect(candidate.qualification).toBe("claimed");

    const consumer = await reconstruct(host, session, candidate);
    const results = await runTrustedCheckPlan(consumer, CHECK_PLAN);

    expect(results.every((result) => result.passed)).toBe(shouldPass);
    if (!shouldPass) {
      expect(results.find((result) => !result.passed)?.name).toBe("filter-preserves-pagination");
    }

    // Recovery still answers for this exact request, and nothing was queued twice.
    const recovered = await session.call("GET", `/v1/workspaces/${host.workspace.id}/requests/${requestId}`);
    expect(recovered.status).toBe(200);
    expect((recovered.body as { operation: Operation }).operation.id).toBe(operation.id);
    expect(session.operations.countOperations()).toBe(1);
    session.database.close();
  });

  it("does not run a redelivered invocation twice", async () => {
    const host = await journey({ mode: "correct" });
    const session = host.first;
    const { operation } = await submit(host, session);

    await session.dispatcher.drainOnce();
    const afterFirst = session.operations.get(operation.id)!;
    const candidate = (afterFirst.result as { candidate: CandidateResult }).candidate;

    // Deliver the identical invocation again, as an at-least-once transport would.
    const record = { ...afterFirst };
    await session.transport.deliver({
      protocolVersion: 1, kind: "task", operationId: operation.id, workspaceId: host.workspace.id,
      fence: operation.fence, projectRevision: 1,
      callbackCapability: "unused-because-the-journal-recognises-the-duplicate",
      payload: { conversationId: host.conversationId, prompt: "Add All / Open / Done filtering. Preserve pagination and team isolation." },
    } as never).catch(() => undefined);

    const afterSecond = session.operations.get(operation.id)!;
    expect(afterSecond.status).toBe(record.status);
    expect((afterSecond.result as { candidate: CandidateResult }).candidate.commit).toBe(candidate.commit);
    expect(session.operations.countOperations()).toBe(1);
    session.database.close();
  });

  it("survives a lost terminal reply and a restart without rerunning the work", async () => {
    let drop = true;
    const host = await journey({ mode: "correct", dropTerminalReply: () => drop });
    const first = host.first;
    const { requestId, operation } = await submit(host, first);

    await first.dispatcher.drainOnce();

    // The worker finished and uploaded artifacts, but the host never heard the result.
    expect(first.operations.get(operation.id)?.status).toBe("ACCEPTED");
    expect(first.operations.listArtifacts(operation.id).length).toBeGreaterThan(0);
    first.database.close();

    // Restart both services against the same durable state.
    drop = false;
    const second = host.open();
    const report = await recoverHost({
      registry: second.registry,
      operations: second.operations,
      dispatcher: second.dispatcher,
      journal: second.transport.journal,
    });

    // The work is not rerun: the journal already holds its terminal record, so the
    // redelivered invocation is recognised as a duplicate.
    expect(report.interrupted).toHaveLength(0);
    expect(second.operations.countOperations()).toBe(1);

    // Recovery by request identity still finds the original operation, and the record,
    // its artifacts and the request index all survived the reopen.
    const recovered = await second.call("GET", `/v1/workspaces/${host.workspace.id}/requests/${requestId}`);
    expect(recovered.status).toBe(200);
    expect((recovered.body as { operation: Operation }).operation.id).toBe(operation.id);
    expect(second.operations.listArtifacts(operation.id).length).toBeGreaterThan(0);
    second.database.close();
  });

  it("marks an interrupted unknown worker rather than rerunning it", async () => {
    const host = await journey({ mode: "correct" });
    const first = host.first;
    const { operation } = await submit(host, first);

    // A worker that accepted the invocation and then vanished mid-run: journal says
    // RUNNING, the host has no result, and nobody can say what it did to the workspace.
    await first.transport.journal.accept({
      protocolVersion: 1, kind: "task", operationId: operation.id, workspaceId: host.workspace.id,
      fence: operation.fence, projectRevision: 1, callbackCapability: "c".repeat(64),
      payload: { conversationId: host.conversationId, prompt: "interrupted" },
    } as never).catch(() => undefined);
    await first.transport.journal.transition(operation.id, "RUNNING");
    first.database.close();

    const second = host.open();
    const report = await recoverHost({
      registry: second.registry,
      operations: second.operations,
      dispatcher: { drainOnce: async () => [] },
      journal: second.transport.journal,
    });

    expect(report.interrupted.map((entry) => entry.id)).toEqual([operation.id]);
    const settled = second.operations.get(operation.id)!;
    expect(settled.status).toBe("FAILED");
    expect(settled.error).toMatch(/not replayed/);
    expect(second.operations.countOperations()).toBe(1);
    second.database.close();
  });

  it("releases a writer lease held by an operation that already finished", async () => {
    const host = await journey({ mode: "correct" });
    const first = host.first;
    const { operation } = await submit(host, first);
    await first.dispatcher.drainOnce();
    // Simulate a crash after the terminal write but before the lease was released.
    await first.registry.acquireWriter(host.workspace.id, host.workspace.ownerKey, operation.id)
      .catch(() => undefined);
    first.database.close();

    const second = host.open();
    const workspaceBefore = await second.registry.get(host.workspace.id);
    if (workspaceBefore?.activeOperationId) {
      const report = await recoverHost({
        registry: second.registry,
        operations: second.operations,
        dispatcher: { drainOnce: async () => [] },
      });
      expect(report.releasedWriters).toContain(host.workspace.id);
    }
    expect((await second.registry.get(host.workspace.id))?.activeOperationId).toBeNull();
    second.database.close();
  });

  it("keeps the frozen source reconstructable after both services reopen", async () => {
    const host = await journey({ mode: "correct" });
    const first = host.first;
    const { operation } = await submit(host, first);
    await first.dispatcher.drainOnce();
    const candidate = (first.operations.get(operation.id)!.result as { candidate: CandidateResult }).candidate;
    first.database.close();

    const second = host.open();
    const consumer = await reconstruct(host, second, candidate);
    expect(await readFile(join(consumer, "src/filter.txt"), "utf8")).toBe("all|open|done+pagination\n");
    expect((await runTrustedCheckPlan(consumer, CHECK_PLAN)).every((result) => result.passed)).toBe(true);
    second.database.close();
  });
});

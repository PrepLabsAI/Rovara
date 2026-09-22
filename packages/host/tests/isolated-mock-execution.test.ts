import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AuthenticatedIdentity } from "@agentx/broker";
import type { CandidateResult, Operation } from "@agentx/contracts";
import { prepareWorkspace } from "@agentx/worker";
import { openHostDatabase } from "../src/store/database.js";
import { SqliteRegistry } from "../src/store/sqlite-registry.js";
import { SqliteOperationStore } from "../src/store/sqlite-operations.js";
import { createLocalBrokerHandler } from "../src/routes.js";
import { mintCallbackCapability } from "../src/capability.js";
import { runTrustedCheckPlan } from "../src/fixture-worker.js";
import { IsolatedFixtureRuntime, resolveIsolatedRuntimeConfig } from "../src/isolated/runtime.js";
import { ingestIsolatedRun } from "../src/isolated/ingest.js";
import { MockModelRoute, MockModelRouteError } from "../src/isolated/mock-model-route.js";

const run = promisify(execFile);
const roots: string[] = [];

/**
 * Under this flag a missing prerequisite is a failure, never a skip.
 *
 * A green run that quietly skipped the container cases would be exactly the
 * "component evidence mistaken for isolation evidence" this package exists to close.
 */
const REQUIRED = process.env.CHARTERARC_REQUIRE_ISOLATED_MOCK === "1";
const describeRuntime = REQUIRED ? describe : describe.skip;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const git = async (cwd: string, ...args: string[]) => (await run("git", ["-C", cwd, ...args])).stdout.trim();

const CHECK_PLAN = [
  { name: "filter-preserves-pagination", path: "src/filter.txt", mustEqual: "all|open|done+pagination\n" },
  { name: "team-isolation-retained", path: "src/isolation.txt", mustEqual: "team-scoped\n" },
];

const identity: AuthenticatedIdentity = {
  issuer: "https://identity.example.test",
  subject: "alice",
  ownerKey: "alice".padEnd(64, "0"),
  isAdministrator: true,
  claims: {},
};
const memberships = [{ ownerKey: identity.ownerKey, project: "payments", role: "administrator" as const }];
const IMAGE_DIGEST = `registry.example.test/worker@sha256:${"a".repeat(64)}`;

function projectDefinition() {
  return {
    schemaVersion: 2 as const, name: "payments", revision: 1,
    controlPlaneUrl: "https://agentx.example.test",
    auth: { issuer: "https://identity.example.test", clientId: "agentx", audience: "agentx" },
    environment: { image: IMAGE_DIGEST },
    repositories: [{
      name: "app", url: "https://github.com/example/app.git", path: "repo/app",
      defaultBranch: "main", credentialRef: "github-app",
    }],
    setup: [], readiness: [], orchestratorInstructions: "Delegate",
  };
}

/** A durable host plus a really prepared workspace, ready for isolated execution. */
async function bench() {
  const source = await scratch("agentx-iso-source-");
  await git(source, "init", "--quiet", "--initial-branch=main");
  await mkdir(join(source, "src"), { recursive: true });
  await writeFile(join(source, "src/filter.txt"), "none\n");
  await writeFile(join(source, "src/isolation.txt"), "team-scoped\n");
  await git(source, "add", ".");
  await git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "base");

  const rootPath = await scratch("agentx-iso-workspace-");
  await prepareWorkspace({
    rootPath, project: projectDefinition(),
    materializer: async (_repository, destination) => {
      await run("git", ["clone", "--quiet", source, destination]);
      await run("git", ["-C", destination, "remote", "set-url", "origin", "https://github.com/example/app.git"]);
    },
  });
  const baseCommit = await git(join(rootPath, "repo/app"), "rev-parse", "HEAD");

  const stateRoot = await scratch("agentx-iso-state-");
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
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const response = await handler({
        method, path, headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
    };
    return { database, registry, operations, handler, call };
  };

  const first = open();
  first.registry.registerProject(identity, projectDefinition(), memberships);
  const timestamp = new Date().toISOString();
  const workspace = await first.registry.createDefault({
    id: randomUUID(), ownerKey: identity.ownerKey, projectName: "payments", projectRevision: 1,
    environmentDigest: IMAGE_DIGEST,
    runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agentx",
    endpointQualifier: "DEFAULT", runtimeSessionId: randomUUID(), deploymentMode: "demo-microvm",
    rootPath: "/mnt/workspace", status: "READY", activeOperationId: null, fence: 1,
    createdAt: timestamp, updatedAt: timestamp,
  });
  const conversationId = first.registry.createConversation(workspace.id, randomUUID());

  return { rootPath, baseCommit, workspace, conversationId, open, first, callbackSigningKey };
}

async function submit(
  b: Awaited<ReturnType<typeof bench>>,
  session: ReturnType<Awaited<ReturnType<typeof bench>>["open"]>,
  requestId = randomUUID(),
) {
  const response = await session.call("POST", `/v1/workspaces/${b.workspace.id}/tasks`, {
    requestId, conversationId: b.conversationId,
    prompt: "Add All / Open / Done filtering. Preserve pagination and team isolation.",
    candidate: { jobId: randomUUID(), attempt: 1, repository: "app", baseCommit: b.baseCommit },
  });
  expect(response.status).toBe(202);
  return { requestId, operation: (response.body as { operation: Operation }).operation };
}

// ---------------------------------------------------------------------------
// Mock-only model route. No container and no credential, so these always run.
// ---------------------------------------------------------------------------

describe("mock-only model route", () => {
  const route = () =>
    new MockModelRoute({
      routeVersion: "mock-fixture@v1",
      policyDigest: `sha256:${"b".repeat(64)}`,
      dataClass: "synthetic-fixture",
      modelAllowlist: ["mock/deterministic-v1"],
      priceVersion: "fixture-prices@2026-09-22",
      microunitsPerInputByte: 2,
      microunitsPerOutputByte: 8,
      outputCapBytes: 1_024,
    });

  function token(subject: Partial<Parameters<MockModelRoute["mint"]>[0]> = {}) {
    return {
      operationId: randomUUID(), caseId: "case-1", attemptNumber: 1,
      maxMicrounits: 100_000, maxCalls: 3,
      notAfter: new Date(Date.now() + 60_000).toISOString(),
      ...subject,
    };
  }

  it("refuses a model that is not on the route allowlist", () => {
    const r = route();
    const minted = r.mint(token());
    expect(() => r.reserve({ token: minted, modelId: "vendor/real-model", inputBytes: 10 }))
      .toThrow(MockModelRouteError);
    expect(r.ledger()).toHaveLength(0);
    expect(r.receipts()).toHaveLength(0);
  });

  it("reserves a conservative upper bound from the request and the output cap", () => {
    const r = route();
    const minted = r.mint(token());
    const reservation = r.reserve({ token: minted, modelId: "mock/deterministic-v1", inputBytes: 100 });

    // 100 input bytes x 2 + the full 1024-byte output cap x 8. The cap is charged in
    // full before dispatch because the response length is not knowable in advance.
    expect(reservation.reservedMicrounits).toBe(100 * 2 + 1_024 * 8);
    expect(reservation.priceVersion).toBe("fixture-prices@2026-09-22");
    expect(reservation.state).toBe("reserved");
  });

  it("refuses the call that would exceed the authorized budget, before dispatch", () => {
    const r = route();
    // The conservative reservation for this request is 100*2 + 1024*8 = 8392, so a
    // budget below it must refuse before anything is dispatched.
    const minted = r.mint(token({ maxMicrounits: 8_000 }));
    expect(() => r.reserve({ token: minted, modelId: "mock/deterministic-v1", inputBytes: 100 }))
      .toThrow(/budget/i);
    expect(r.ledger()).toHaveLength(0);
  });

  it("keeps the reservation when usage is unknown and writes no success receipt", () => {
    const r = route();
    const minted = r.mint(token());
    const reservation = r.reserve({ token: minted, modelId: "mock/deterministic-v1", inputBytes: 100 });

    r.settleUnknown(reservation.reservationId, "transport gave no observable outcome");

    const entry = r.ledger()[0]!;
    expect(entry.state).toBe("unknown");
    expect(entry.reservedMicrounits).toBe(reservation.reservedMicrounits);
    expect(entry.observedMicrounits).toBeUndefined();
    expect(r.spentMicrounits(minted)).toBe(reservation.reservedMicrounits);

    const receipt = r.receipts()[0]!;
    expect(receipt.outcome).toBe("unknown");
    expect(r.receipts().some((value) => value.outcome === "succeeded")).toBe(false);
  });

  it("never refunds an observed failure and counts every attempt", () => {
    const r = route();
    const minted = r.mint(token({ maxCalls: 2 }));
    const first = r.reserve({ token: minted, modelId: "mock/deterministic-v1", inputBytes: 10 });
    r.settleObserved(first.reservationId, { outcome: "provider_error", observedMicrounits: 0 });
    const second = r.reserve({ token: minted, modelId: "mock/deterministic-v1", inputBytes: 10 });
    r.settleObserved(second.reservationId, { outcome: "succeeded", observedMicrounits: 12 });

    expect(r.spentMicrounits(minted)).toBe(first.reservedMicrounits + second.reservedMicrounits);
    expect(() => r.reserve({ token: minted, modelId: "mock/deterministic-v1", inputBytes: 10 }))
      .toThrow(/call limit/i);
  });

  it("refuses an expired token and an unapproved attempt", () => {
    const r = route();
    const expired = r.mint(token({ notAfter: new Date(Date.now() - 1_000).toISOString() }));
    expect(() => r.reserve({ token: expired, modelId: "mock/deterministic-v1", inputBytes: 1 }))
      .toThrow(/expired/i);
    expect(() => r.mint(token({ attemptNumber: 0 }))).toThrow(MockModelRouteError);
  });

  it("holds no credential and produces receipts only the route can write", () => {
    const r = route();
    const minted = r.mint(token());
    expect(JSON.stringify(minted)).not.toMatch(/key|secret|credential|password/i);
    expect(r.isMockOnly()).toBe(true);

    // An executor cannot hand the route a finished receipt; settling requires a
    // reservation this route made, so a claimed outcome has nothing to attach to.
    expect(() => r.settleObserved("not-a-reservation", { outcome: "succeeded", observedMicrounits: 1 }))
      .toThrow(MockModelRouteError);
  });
});

// ---------------------------------------------------------------------------
// Truthful scope: what this boundary cannot contain, it refuses.
// ---------------------------------------------------------------------------

describe("truthful scope enforcement", () => {
  it("rejects a request that requires path containment instead of pretending", async () => {
    const b = await bench();
    const session = b.first;
    const response = await session.call("POST", `/v1/workspaces/${b.workspace.id}/tasks`, {
      requestId: randomUUID(), conversationId: b.conversationId, prompt: "Edit only backend/tasks.py",
      candidate: { jobId: randomUUID(), attempt: 1, repository: "app", baseCommit: b.baseCommit },
      requiredCapabilities: ["enforced_scope"],
    });
    // The field is not part of the frozen wire, so it is refused as an unknown field
    // rather than silently accepted and ignored.
    expect(response.status).toBe(400);
    expect(session.operations.countOperations()).toBe(0);
    session.database.close();
  });

  it("reports enforced_scope as false and says why", async () => {
    const { isolatedCapabilities } = await import("../src/isolated/runtime.js");
    const capabilities = isolatedCapabilities();
    expect(capabilities.enforcedScope).toBe(false);
    expect(capabilities.enforcedScopeGap).toMatch(/containment/i);
    // Neither this package nor the mock route may assert a ManagedSDLC capability.
    expect(Object.values(capabilities).some((value) => value === true && typeof value === "boolean"))
      .toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Real runtime. Gated, and under the flag a missing prerequisite fails.
// ---------------------------------------------------------------------------

describeRuntime("isolated fixture worker", () => {
  let runtime: IsolatedFixtureRuntime;

  beforeAll(async () => {
    const config = resolveIsolatedRuntimeConfig(process.env);
    const probe = await IsolatedFixtureRuntime.probe(config);
    expect(probe.available, `isolated runtime prerequisite missing: ${probe.reason ?? ""}`).toBe(true);
    runtime = new IsolatedFixtureRuntime(config);
  }, 120_000);

  it("freezes a correct candidate inside the container and admits it through the host", async () => {
    const b = await bench();
    const session = b.first;
    const { requestId, operation } = await submit(b, session);

    const result = await runtime.runTask({
      invocation: session.operations.pendingOutbox()[0]!.invocation,
      workspacePath: b.rootPath,
      mode: "correct",
    });
    expect(result.outcome).toBe("completed");
    expect(result.exitCode).toBe(0);

    const admitted = await ingestIsolatedRun({ handler: session.handler, result });
    expect(admitted.status).toBe("SUCCEEDED");

    const settled = session.operations.get(operation.id)!;
    const candidate = (settled.result as { candidate: CandidateResult }).candidate;
    expect(candidate.baseCommit).toBe(b.baseCommit);
    expect(candidate.commit).not.toBe(b.baseCommit);
    expect(candidate.qualification).toBe("claimed");

    const consumer = await reconstruct(b, session, candidate);
    const checks = await runTrustedCheckPlan(consumer, CHECK_PLAN);
    expect(checks).toHaveLength(CHECK_PLAN.length);
    expect(checks.every((check) => check.passed)).toBe(true);

    const recovered = await session.call("GET", `/v1/workspaces/${b.workspace.id}/requests/${requestId}`);
    expect(recovered.status).toBe(200);
    session.database.close();
  }, 600_000);

  it("freezes a defective candidate that the identical plan fails", async () => {
    const b = await bench();
    const session = b.first;
    const { operation } = await submit(b, session);

    const result = await runtime.runTask({
      invocation: session.operations.pendingOutbox()[0]!.invocation,
      workspacePath: b.rootPath,
      mode: "defective",
    });
    expect(result.outcome).toBe("completed");
    await ingestIsolatedRun({ handler: session.handler, result });

    const candidate = (session.operations.get(operation.id)!.result as { candidate: CandidateResult }).candidate;
    const consumer = await reconstruct(b, session, candidate);
    const checks = await runTrustedCheckPlan(consumer, CHECK_PLAN);

    expect(checks).toHaveLength(CHECK_PLAN.length);
    expect(checks.every((check) => check.passed)).toBe(false);
    expect(checks.find((check) => !check.passed)?.name).toBe("filter-preserves-pagination");
    session.database.close();
  }, 600_000);

  it("denies the external network, the host gateway and the runtime socket", async () => {
    const denials = await runtime.probeDenials();
    expect(denials.externalNetwork).toBe("denied");
    expect(denials.hostGateway).toBe("denied");
    expect(denials.runtimeSocket).toBe("denied");
    expect(denials.otherRunNetwork).toBe("denied");
  }, 300_000);

  it("terminates the container and its children when the deadline passes", async () => {
    const outcome = await runtime.runUntilDeadline({ sleepSeconds: 120, deadlineMs: 5_000 });
    expect(outcome.outcome).toBe("timed_out");
    expect(outcome.terminated).toBe(true);
    // Termination is observed from the runtime's own record of the container, by id.
    expect(outcome.observedRunning).toBe(false);
    expect(outcome.cid).toMatch(/^[0-9a-f]{12,64}$/);
  }, 300_000);

  it("reports uncertain cleanup as unknown rather than success", async () => {
    const uncertain = await runtime.cleanupOutcomeFor("0".repeat(64));
    expect(uncertain).toBe("unknown");
  }, 120_000);

  it("refuses a callback bound to another operation or a stale fence", async () => {
    const b = await bench();
    const session = b.first;
    const { operation } = await submit(b, session);
    const events = `/v1/internal/workspaces/${b.workspace.id}/operations/${operation.id}/events`;

    for (const capability of [
      mintCallbackCapability({
        key: b.callbackSigningKey, workspaceId: b.workspace.id, operationId: randomUUID(),
        fence: operation.fence, expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      mintCallbackCapability({
        key: b.callbackSigningKey, workspaceId: b.workspace.id, operationId: operation.id,
        fence: operation.fence + 1, expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ]) {
      const refused = await session.call("POST", events, { events: [{ type: "progress", payload: {} }] },
        { "x-agentx-callback-capability": capability });
      expect(refused.status).toBe(409);
      expect((refused.body as { error: { code: string } }).error.code).toBe("CALLBACK_FORBIDDEN");
    }
    expect(session.operations.listEvents(operation.id)).toHaveLength(0);
    session.database.close();
  }, 120_000);

  it("recovers a duplicate run and a lost reply across reopened stores without rerunning", async () => {
    const b = await bench();
    const first = b.first;
    const { requestId, operation } = await submit(b, first);
    const invocation = first.operations.pendingOutbox()[0]!.invocation;

    const result = await runtime.runTask({ invocation, workspacePath: b.rootPath, mode: "correct" });
    // The reply is lost: the host never learns the outcome from this run.
    expect(result.outcome).toBe("completed");
    expect(first.operations.get(operation.id)?.status).toBe("ACCEPTED");
    first.database.close();

    const second = b.open();
    const admitted = await ingestIsolatedRun({ handler: second.handler, result });
    expect(admitted.status).toBe("SUCCEEDED");
    // Admitting the identical retained result again is not a second candidate.
    const again = await ingestIsolatedRun({ handler: second.handler, result });
    expect(again.status).toBe("SUCCEEDED");

    expect(second.operations.countOperations()).toBe(1);
    const recovered = await second.call("GET", `/v1/workspaces/${b.workspace.id}/requests/${requestId}`);
    expect(recovered.status).toBe(200);
    expect((recovered.body as { operation: Operation }).operation.id).toBe(operation.id);
    second.database.close();
  }, 600_000);

  it("keeps an interrupted unknown run unknown instead of rerunning it", async () => {
    const b = await bench();
    const session = b.first;
    const { operation } = await submit(b, session);

    // A run whose outcome the host cannot observe leaves the operation untouched:
    // no terminal row, no second dispatch, and nothing that claims the checks failed.
    const unknown = await runtime.recordUnobservedRun(operation.id);
    expect(unknown.outcome).toBe("unknown");

    expect(session.operations.get(operation.id)?.status).toBe("ACCEPTED");
    expect(session.operations.get(operation.id)?.result).toBeUndefined();
    expect(session.operations.countOperations()).toBe(1);
    expect(session.operations.pendingOutbox()).toHaveLength(1);
    session.database.close();
  }, 120_000);
});

/** Rebuild candidate source from the artifacts the real freezer produced in the container. */
async function reconstruct(
  b: Awaited<ReturnType<typeof bench>>,
  session: ReturnType<Awaited<ReturnType<typeof bench>>["open"]>,
  candidate: CandidateResult,
): Promise<string> {
  const chunks = candidate.retrieval.chunks.map((chunk) => {
    const stored = session.operations.getArtifact(b.workspace.id, chunk.artifactId);
    expect(stored).toBeDefined();
    return Buffer.from(stored!.content, "base64");
  });
  const workspaceRoot = await scratch("agentx-iso-verify-");
  const bundle = join(workspaceRoot, "candidate.bundle");
  await writeFile(bundle, Buffer.concat(chunks));
  const consumer = join(workspaceRoot, "consumer");
  await run("git", ["clone", "--quiet", bundle, consumer]);
  expect(await git(consumer, "rev-parse", "HEAD")).toBe(candidate.commit);
  expect(await readFile(join(consumer, "src/isolation.txt"), "utf8")).toBe("team-scoped\n");
  return consumer;
}

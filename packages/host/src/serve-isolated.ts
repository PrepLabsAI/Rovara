import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { agentXError } from "@agentx/contracts";
import type { AuthenticatedIdentity, BrokerRequest } from "@agentx/broker";
import { prepareWorkspace } from "@agentx/worker";
import { createOutboxDispatcher } from "./dispatcher.js";
import type { FixtureEdit, FixtureMode } from "./fixture-worker.js";
import { startLoopbackListener, type LoopbackListener } from "./listener.js";
import { createLocalBrokerHandler } from "./routes.js";
import { openHostDatabase } from "./store/database.js";
import { SqliteOperationStore } from "./store/sqlite-operations.js";
import { SqliteRegistry } from "./store/sqlite-registry.js";
import { createIsolatedExecutionTransport } from "./isolated/bridge.js";
import { MockModelRoute, type MockModelRouteConfig } from "./isolated/mock-model-route.js";
import {
  IsolatedFixtureRuntime,
  resolveIsolatedRuntimeConfig,
  type IsolatedRuntimeConfig,
} from "./isolated/runtime.js";

const run = promisify(execFile);

/**
 * Trusted startup configuration for one local isolated AgentX host.
 *
 * Every field comes from the operator's closed configuration file, never from a request:
 * the repository, the fixture session, the route and the runtime are fixed at startup,
 * so a caller can name approved work but cannot choose where or how it runs.
 */
export interface IsolatedHostConfig {
  /** Durable host state: database, bearer, loopback TLS, prepared workspace. */
  stateDirectory: string;
  /** Local path of the trusted synthetic source repository, cloned once at startup. */
  sourceRepository: string;
  project: {
    name: string;
    repositoryName: string;
    repositoryUrl: string;
    defaultBranch: string;
  };
  workspaceId: string;
  conversationId: string;
  /** Deterministic session: no model is called. Which arm runs is operator configuration. */
  fixture: { mode: FixtureMode; edits: FixtureEdit[] };
  route: MockModelRouteConfig;
  budget: { maxMicrounits: number; maxCalls: number; ttlMs: number };
  runtime?: Partial<IsolatedRuntimeConfig>;
  port?: number;
}

export interface IsolatedHost {
  url: string;
  certificatePath: string;
  bearerPath: string;
  workspaceId: string;
  conversationId: string;
  baseCommit: string;
  listener: LoopbackListener;
  operations: SqliteOperationStore;
  drainOnce(): Promise<unknown[]>;
  close(): Promise<void>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Process-scoped loopback trust material, generated once per state directory.
 *
 * The client is pointed at this certificate explicitly. Nothing here reads, writes or
 * alters the system trust store, and the key never leaves the state directory.
 */
async function loopbackTls(directory: string): Promise<{ cert: string; key: string; certPath: string }> {
  const certPath = join(directory, "loopback-cert.pem");
  const keyPath = join(directory, "loopback-key.pem");
  if (!(await exists(certPath)) || !(await exists(keyPath))) {
    await run("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath,
      "-days", "2", "-nodes", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
    ]);
    await chmod(keyPath, 0o600);
  }
  return { cert: await readFile(certPath, "utf8"), key: await readFile(keyPath, "utf8"), certPath };
}

/** One random bearer for this host's single trusted client; stored 0600, never logged. */
async function hostBearer(directory: string): Promise<{ value: string; path: string }> {
  const path = join(directory, "bearer");
  if (!(await exists(path))) {
    await writeFile(path, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  }
  return { value: (await readFile(path, "utf8")).trim(), path };
}

function sameSecret(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Start the durable host over loopback HTTPS with isolated execution behind its outbox.
 *
 * The ordinary dispatcher delivers accepted tasks to the isolated bridge, which runs the
 * real worker in an invocation-owned container and admits its bytes through this host's
 * own authenticated routes. Restarting with the same state directory reopens the same
 * database, bearer, certificate and prepared workspace; nothing is re-registered.
 */
export async function startIsolatedHost(config: IsolatedHostConfig): Promise<IsolatedHost> {
  const state = resolve(config.stateDirectory);
  await mkdir(state, { recursive: true, mode: 0o700 });
  const tls = await loopbackTls(state);
  const bearer = await hostBearer(state);

  const identity: AuthenticatedIdentity = {
    issuer: "local-isolated-host",
    subject: "charterarc-control-plane",
    ownerKey: "charterarc-control-plane".padEnd(64, "0"),
    isAdministrator: false,
    claims: {},
  };
  const memberships = [
    { ownerKey: identity.ownerKey, project: config.project.name, role: "administrator" as const },
  ];
  const resolveIdentity = async (request: BrokerRequest): Promise<AuthenticatedIdentity> => {
    const header = request.headers?.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!presented || !sameSecret(presented, bearer.value)) {
      throw agentXError("AUTH_REQUIRED", "a valid bearer is required");
    }
    return identity;
  };

  const runtimeConfig = { ...resolveIsolatedRuntimeConfig(process.env), ...(config.runtime ?? {}) };
  const environmentDigest = `local/agentx-fixture-worker@sha256:${"0".repeat(64)}`;

  const database = openHostDatabase(join(state, "host.sqlite"));
  const registry = new SqliteRegistry(database);
  const operations = new SqliteOperationStore(database, registry);
  const callbackKeyPath = join(state, "callback-key");
  if (!(await exists(callbackKeyPath))) {
    await writeFile(callbackKeyPath, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  }
  const callbackSigningKey = Buffer.from((await readFile(callbackKeyPath, "utf8")).trim(), "hex");
  const handler = createLocalBrokerHandler({
    registry, operations, memberships, callbackSigningKey, resolveIdentity,
  });

  const project = {
    schemaVersion: 2 as const,
    name: config.project.name,
    revision: 1,
    controlPlaneUrl: "https://local-isolated-host.invalid",
    auth: { issuer: "https://local-isolated-host.invalid", clientId: "charterarc", audience: "agentx" },
    environment: { image: environmentDigest },
    repositories: [{
      name: config.project.repositoryName,
      url: config.project.repositoryUrl,
      path: `repo/${config.project.repositoryName}`,
      defaultBranch: config.project.defaultBranch,
      credentialRef: "none-local-fixture",
    }],
    setup: [],
    readiness: [],
    orchestratorInstructions: "Deterministic fixture session; no model is called.",
  };

  // One prepared workspace at the configured base. The runtime streams a copy of it into
  // each container, so no run can change what the next one starts from.
  const workspacePath = join(state, "workspace");
  const repositoryPath = join(workspacePath, "repo", config.project.repositoryName);
  if (!(await exists(repositoryPath))) {
    await prepareWorkspace({
      rootPath: workspacePath,
      project,
      materializer: async (_repository, destination) => {
        await run("git", ["clone", "--quiet", "--no-hardlinks", config.sourceRepository, destination]);
        await run("git", ["-C", destination, "remote", "set-url", "origin", config.project.repositoryUrl]);
      },
    });
  }
  const baseCommit = (await run("git", ["-C", repositoryPath, "rev-parse", "HEAD"])).stdout.trim();

  if (!registry.getProject(config.project.name, 1)) {
    // Registration is the operator's startup act, not the client's: the bearer the
    // control plane presents carries no administrator claim.
    registry.registerProject({ ...identity, isAdministrator: true }, project, memberships);
  }
  const timestamp = new Date().toISOString();
  const workspace = await registry.createDefault({
    id: config.workspaceId,
    ownerKey: identity.ownerKey,
    projectName: config.project.name,
    projectRevision: 1,
    environmentDigest,
    // Registry schema placeholders: this local host uses no AWS runtime of any kind.
    runtimeArn: "arn:aws:bedrock-agentcore:local:000000000000:runtime/none",
    endpointQualifier: "LOCAL",
    runtimeSessionId: randomUUID(),
    deploymentMode: "demo-microvm",
    rootPath: "/mnt/workspace",
    status: "READY",
    activeOperationId: null,
    fence: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  if (workspace.id !== config.workspaceId) {
    throw agentXError("CONFIG_INVALID", "the state directory already holds another workspace");
  }
  try {
    registry.createConversation(workspace.id, config.conversationId as `${string}-${string}-${string}-${string}-${string}`);
  } catch (error) {
    if (!(error instanceof Error && /already exists/.test(error.message))) throw error;
  }

  const route = new MockModelRoute(config.route, operations);
  const transport = createIsolatedExecutionTransport({
    runtime: new IsolatedFixtureRuntime(runtimeConfig),
    handler,
    store: operations,
    workspacePath,
    mode: config.fixture.mode,
    edits: config.fixture.edits,
    route,
    // The wire carries the request, not the control plane's case: receipts are bound to
    // the exact request identity, which the control plane maps to its own case.
    caseId: (invocation) => `request:${operations.get(invocation.operationId)?.requestId ?? "unobserved"}`,
    budget: config.budget,
  });
  const dispatcher = createOutboxDispatcher({ operations, transport });
  const listener = await startLoopbackListener({
    handler,
    tls: { cert: tls.cert, key: tls.key },
    ...(config.port === undefined ? {} : { port: config.port }),
  });

  return {
    url: listener.url,
    certificatePath: tls.certPath,
    bearerPath: bearer.path,
    workspaceId: workspace.id,
    conversationId: config.conversationId,
    baseCommit,
    listener,
    operations,
    drainOnce: () => dispatcher.drainOnce(),
    async close() {
      await listener.close();
      database.close();
    },
  };
}

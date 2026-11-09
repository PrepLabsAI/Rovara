// Port lane L4: `rovara up`'s runtime. One local Node process: an HTTP server on 127.0.0.1 over the W0 registry.
//
// Order (it matters, and `docs/local.md` says why): the state folder is checked; the plug-in config is read from there; Code's
// defaults and the built-in adapters are registered; the config's adapters are loaded (a configured storage or queue replaces the
// in-memory default); the registry is sealed; then the server starts. Nothing in the registry changes after that except channels.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { open, readFile, realpath, rm, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { IMPLICIT_COMPANY_ID, INDEX_EXPIRY_ATTRIBUTE, PLUGIN_POINTS, agentXError, type AdapterRegistry, type ModelKeyStore, type PluginConfig, type PluginPoint } from "@agentx/contracts";
import { createBrokerHandler, type BrokerRequest, type BrokerResponse } from "../handler.js";
import { InMemoryProjectRegistry } from "../projects.js";
import { InMemoryRegistry } from "../registry.js";
import { OperationStore } from "../operations.js";
import {
  createAdapterRegistry,
  createEnvironmentModelKeyStore,
  createFileModelKeyStore,
  createLayeredModelKeyStore,
  createModuleImporter,
  type ModuleImporter,
  loadAdapters,
  parsePluginConfig,
  registerCodeDefaults,
} from "../ports/index.js";
import { MemoryDocumentStore } from "../ports/memory-document-store.js";
import { createDocumentObjectStorage } from "../core/proof/evidence-blob-store.js";
import { MemoryQueueService } from "../ports/memory-queue.js";
import { SqliteDocumentStore, SqliteQueueService } from "@agentx/local-adapters";
import type { WorkerMachines } from "@agentx/contracts";
import { TASK_FLOW_INDEXES } from "../core/task-flow/flow.js";
import type { BrowserOpener } from "./open-browser.js";
import { createLocalApp, type LocalApp } from "./app/app.js";
import { configurationAnswer } from "./app/routes.js";
import { LocalPageSessions } from "../core/local-pages/guard.js";
import { localSessionProofVerifier } from "../core/decisions/local-session.js";
import { startCallbackServer, type CallbackServer } from "./callback-server.js";
import { createDockerRunner, type DockerRunner } from "./docker-runner.js";
import { DockerWorkerMachines } from "./docker-worker-machines.js";
import { assertGithubCloneAccess, resolveGithubAccess, type GhRunner } from "./github-access.js";
import { startLocalHttpServer, type LocalHttpServer } from "./http-server.js";
import { loadInvokeSigner } from "./invoke-signer.js";
import { createLocalModelProxy, type LocalModelProxy, type ModelGrantSource, type ProviderEndpoints } from "./model-proxy/index.js";
import { modelProxyWorkerUrl } from "./docker-worker-machines.js";
import {
  KEYS_FILE_NAME,
  SERVER_FILE_NAME,
  STATE_LOCK_FILE_NAME,
  LocalStateError,
  SESSION_TOKEN_FILE_NAME,
  STATE_DB_FILE_NAME,
  WORKSPACES_DIRECTORY_NAME,
  isInside,
  ensureStateDirectory,
  readConfigText,
  resolveConfigLocation,
  writeOwnerFile,
} from "./state-directory.js";
import { THIS_MACHINE_ADAPTER_NAME, ThisMachineWorkerMachines } from "./this-machine-worker-machines.js";

/** The model providers whose keys `rovara up` looks for (the environment variable is `<PROVIDER>_API_KEY`). */
export const LOCAL_MODEL_PROVIDERS = ["anthropic", "openai", "openrouter"] as const;
/** Where Code's model keys come from: the environment first, then `<state folder>/keys.json` (refused unless only the owner can read it). */
export function createLocalModelKeyStore(stateDirectory: string, environment: NodeJS.ProcessEnv): ModelKeyStore {
  return createLayeredModelKeyStore([
    createEnvironmentModelKeyStore(environment, LOCAL_MODEL_PROVIDERS),
    createFileModelKeyStore(join(stateDirectory, KEYS_FILE_NAME)),
  ]);
}

/**
 * W0's importer, plus the local rules: a module is a file only its owner can write, and never one under `workspaces/`, where tasks
 * write. (A package name goes through Node's resolution as before.)
 */
export function createLocalModuleImporter(stateDirectory: string, configDirectory: string): ModuleImporter {
  const inner = createModuleImporter(configDirectory);
  const workspaces = join(stateDirectory, WORKSPACES_DIRECTORY_NAME);
  return async (specifier) => {
    if (specifier.startsWith("./")) {
      const target = await realpath(resolve(await realpath(configDirectory), specifier));
      if (isInside(await realpath(workspaces).catch(() => workspaces), target)) throw new Error("a plug-in module must not lie in a task workspace");
      const details = await stat(target);
      const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
      if (process.platform !== "win32" && ((uid !== undefined && details.uid !== uid) || (details.mode & 0o022) !== 0)) throw new Error("a plug-in module must belong to you and not be writable by others");
    }
    return inner(specifier);
  };
}

/** Where the GitHub token may be stored: the key file only (the environment store would let an unrelated `GITHUB_API_KEY` win). */
export function createLocalGithubKeyStore(stateDirectory: string): ModelKeyStore {
  return createFileModelKeyStore(join(stateDirectory, KEYS_FILE_NAME));
}

/** Parses the config file's text. The errors say what is wrong, never what the file holds. */
export function parsePluginConfigText(text: string): PluginConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("the plug-in config is not valid JSON");
  }
  return parsePluginConfig(value);
}

/** The name under which the local Docker adapter is registered on the `worker-machines` point. */
export const DOCKER_ADAPTER_NAME = "docker";
/** The name of a worker-machines adapter handed in through `LocalRuntimeOptions.machines`. */
export const INJECTED_ADAPTER_NAME = "injected";

export interface LocalRuntimeOptions {
  stateDirectory: string;
  /** A config path the owner typed; absent: `<stateDirectory>/config.json`, made on first run. */
  configPath?: string | undefined;
  /** The folder the owner is standing in. A config inside it is refused. */
  cwd: string;
  environment: NodeJS.ProcessEnv;
  /** 0 or absent: a random free port. */
  port?: number | undefined;
  workerImage: string;
  /** Allow the (unbuilt) this-machine adapter to be named. Default false. */
  thisMachine?: boolean | undefined;
  docker?: DockerRunner;
  version: string;
  /** Websites workers and their sandboxes may reach beyond the default list (docs/local.md, "What a worker can reach"). */
  allowedDomains?: readonly string[] | undefined;
  /** Stop the running workers when the runtime stops. Default true. */
  stopWorkersOnClose?: boolean;
  /** Where the task flow's records live. `sqlite` (default): `<state folder>/state.db`; `memory`: gone when the process ends (tests). A configured `storage` plug-in replaces either. */
  storage?: "sqlite" | "memory";
  /** Use this worker-machines adapter instead of Docker (tests; a later this-machine adapter). */
  machines?: WorkerMachines;
  /** Called with the registry after Code's defaults and before the config's adapters, to register more (an embedding product, tests). */
  registerAdapters?: (registry: AdapterRegistry) => void;
  /** Opens a review page in the owner's browser (default: the system browser). A test gives a recorder, which stands for the browser. */
  openBrowser?: BrowserOpener;
  /** How `gh` is run to find the owner's GitHub token (tests give a stub, so a real login on the machine is never used). */
  gh?: GhRunner;
  /** The fetch the Docker adapter uses to reach its workers (tests give the simulated Docker's). */
  workerFetch?: typeof fetch;
  /** Run the dispatch, sweep and session timers. Default true; tests call `runtime.tick()`. */
  timers?: boolean;
  /**
   * Lane L9a (K1): what a worker's callback capability entitles it to in the model proxy. The task flow supplies it (`capabilityModelGrants`); until
   * it is wired nothing is granted, and a worker asking for model access is refused.
   */
  modelGrants?: ModelGrantSource | undefined;
  /** Where the model proxy calls each provider (tests point these at a fake). Absent: the providers' own addresses. */
  modelProviderEndpoints?: Partial<ProviderEndpoints> | undefined;
}

export interface LocalRuntime {
  readonly url: string;
  readonly port: number;
  /** The loopback port of the listener a worker's callbacks arrive on (its Host is `host.docker.internal:<port>`). */
  readonly callbackPort: number;
  readonly registry: AdapterRegistry;
  readonly config: PluginConfig;
  readonly configPath: string;
  readonly sessionTokenPath: string;
  /** The local review pages' sessions: pass them to `createLocalPagesServer({ sessions })` so the proofs the pages sign are the ones the approvers accept. */
  readonly pageSessions: LocalPageSessions;
  /** The review pages' address: `http://127.0.0.1:<port>` (a page link carries a session that can approve: it stays in this process and reaches a browser only through `POST /v1/local/pages/open`). */
  readonly pagesUrl: string;
  /** The address of a review page in the owner's session. It can approve: for the code that embeds the runtime, never to be sent to a client, a file or a log. */
  pageLink(path?: string): string;
  /** The wired task flow, sessions, decisions and pages (lane L9-wire). */
  readonly app: LocalApp;
  /** One pass of what the timers do (tests). */
  tick(): Promise<void>;
  /** Lane L9a (K1): the model proxy workers call. Its `tokens` end a finished operation's tokens (`revokeOperation`). */
  readonly modelProxy: LocalModelProxy;
  /** The adapters registered at each plug-in point, by name. */
  wiring(): Record<string, string[]>;
  stop(): Promise<void>;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

/** The machine owner's login name, the identity of the one implicit company's owner (decision 45.3). */
function ownerName(): string {
  try {
    return userInfo().username || "Local owner";
  } catch {
    return "Local owner";
  }
}

/**
 * The surface the request came from, for the session's origin and the answer's source: the MCP tools and the CLI name themselves. The header is self-declared by whoever holds the
 * session token, so it is a LABEL only. Nothing may decide who is allowed to do what from it.
 */
function clientOf(request: BrokerRequest): string {
  const named = request.headers["x-agentx-client"];
  return named === "mcp" || named === "cli" ? named : "app";
}

function json(statusCode: number, value: unknown): BrokerResponse {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
}

/**
 * One `rovara up` per state folder. A second would rewrite the session token and the server file, and either one's Ctrl-C would stop the other's workers. The lock is a file made with
 * O_EXCL holding the pid; a lock whose process is gone is taken over.
 */
async function acquireStateLock(stateDirectory: string): Promise<() => Promise<void>> {
  const path = join(stateDirectory, STATE_LOCK_FILE_NAME);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      const mine = `${String(process.pid)}:${randomBytes(8).toString("hex")}`;
      await handle.writeFile(`${mine}\n`);
      await handle.close();
      let released = false;
      return async () => {
        // Only our own lock is removed, and only once (a second runtime in this process has a lock of its own).
        if (released) return;
        released = true;
        const held = await readFile(path, "utf8").catch(() => undefined);
        if (held?.trim() === mine) await rm(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number((await readFile(path, "utf8").catch(() => "")).trim().split(":")[0]);
      let alive = false;
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); alive = true; } catch (killError) { alive = (killError as NodeJS.ErrnoException).code === "EPERM"; }
      }
      if (alive) throw new LocalStateError(`another rovara up (process ${String(pid)}) is using ${stateDirectory}; stop it first, or use another --state-dir`);
      await rm(path, { force: true });
    }
  }
  throw new LocalStateError(`could not take the lock on ${stateDirectory}`);
}

export async function startLocalRuntime(options: LocalRuntimeOptions): Promise<LocalRuntime> {
  const stateDirectory = await ensureStateDirectory(options.stateDirectory, { cwd: options.cwd });
  const release = await acquireStateLock(stateDirectory);
  try {
    const runtime = await startLocked(options, stateDirectory);
    const stop = runtime.stop.bind(runtime);
    return Object.assign(runtime, { async stop() { await stop(); await release(); } });
  } catch (error) {
    await release();
    throw error;
  }
}

async function startLocked(options: LocalRuntimeOptions, stateDirectory: string): Promise<LocalRuntime> {
  const location = resolveConfigLocation({ stateDirectory, configPath: options.configPath, cwd: options.cwd });
  let configText: string;
  try {
    configText = await readConfigText(location);
  } catch (error) {
    throw error instanceof Error ? error : new Error("the plug-in config could not be read");
  }
  const config = parsePluginConfigText(configText);

  const sessionToken = randomBytes(32).toString("base64url");
  const sessionTokenPath = join(stateDirectory, SESSION_TOKEN_FILE_NAME);
  await writeOwnerFile(sessionTokenPath, `${sessionToken}\n`);

  // The sessions of the local review pages: the pages server is given these, and the approvers check the proofs they sign.
  const pageSessions = new LocalPageSessions();
  const registry = createAdapterRegistry();
  const modelKeys = createLocalModelKeyStore(stateDirectory, options.environment);
  registerCodeDefaults(registry, {
    ...(config.companyId === undefined ? {} : { companyId: config.companyId }),
    displayName: ownerName(),
    isValidSession: (value) => constantTimeEqual(value, sessionToken),
    // An approval is proved by a token the local pages sign over one request, revision and digest; the sign-in secret above is never an approval proof.
    approvers: { verifySession: localSessionProofVerifier(pageSessions) },
    modelKeys,
    // Nothing is priced until a price table is configured: usage is recorded as "unknown", never guessed.
    priceTable: { currency: "USD", models: {} },
  });

  // Storage and queue: one SQLite file in the state folder (lane L3's adapters), unless the config names its own. The store keeps the indexes the task flow needs.
  const closers: Array<() => Promise<void> | void> = [];
  const configured = (point: PluginPoint): boolean => config.plugins.some((entry) => entry.point === point);
  if (options.storage === "memory") {
    registry.register("storage", "memory", new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES }), { isDefault: true });
    registry.register("queue", "memory", new MemoryQueueService(), { isDefault: true });
  } else {
    const databasePath = join(stateDirectory, STATE_DB_FILE_NAME);
    if (!configured("storage")) {
      const store = SqliteDocumentStore.open({ path: databasePath, indexes: TASK_FLOW_INDEXES, ttlAttribute: INDEX_EXPIRY_ATTRIBUTE, migrate: true });
      closers.push(() => store.close());
      registry.register("storage", "sqlite", store, { isDefault: true });
    }
    if (!configured("queue")) {
      const queue = SqliteQueueService.open({ path: databasePath });
      closers.push(() => queue.close());
      registry.register("queue", "sqlite", queue, { isDefault: true });
    }
  }

  // Worker machines. The callback listener's port is not known until the handler exists, so it is read when a machine starts.
  const callbackServer: { current?: CallbackServer } = {};
  const docker = new DockerWorkerMachines({
    image: options.workerImage,
    stateDirectory,
    callback: () => {
      if (callbackServer.current === undefined) throw new Error("the callback listener is not running yet");
      return { tcpPort: callbackServer.current.tcpPort, socketDirectory: callbackServer.current.socketDirectory };
    },
    ...(options.allowedDomains === undefined ? {} : { allowedDomains: options.allowedDomains }),
    modelProxy: true,
    signer: await loadInvokeSigner(stateDirectory),
    docker: options.docker ?? createDockerRunner(options.environment),
    ...(options.workerFetch === undefined ? {} : { fetch: options.workerFetch }),
  });
  registry.register("worker-machines", DOCKER_ADAPTER_NAME, docker);
  if (options.machines !== undefined) registry.register("worker-machines", INJECTED_ADAPTER_NAME, options.machines);
  registry.register("worker-machines", THIS_MACHINE_ADAPTER_NAME, new ThisMachineWorkerMachines({ enabled: options.thisMachine === true }));

  options.registerAdapters?.(registry);
  await loadAdapters(config, { registry, importModule: createLocalModuleImporter(stateDirectory, dirname(location.path)) });
  // Lane L9a (S1): objects are kept as documents unless a plug-in names another object storage (the folder adapter).
  if (registry.names("object-storage").length === 0) {
    registry.register("object-storage", "document", createDocumentObjectStorage(registry.require("storage"), { companyId: config.companyId ?? IMPLICIT_COMPANY_ID }), { isDefault: true });
  }
  registry.seal();

  const identity = registry.require("identity");
  const githubKeys = createLocalGithubKeyStore(stateDirectory);
  const serverUrl = { current: "http://127.0.0.1" };
  const modelProxyHolder: { current?: LocalModelProxy } = {};
  const app = await createLocalApp({
    origin: () => serverUrl.current,
    ...(options.openBrowser === undefined ? {} : { openBrowser: options.openBrowser }),
    // The model proxy is made after the servers (it is served on the callback listener); the app asks it, late, to forget an operation that ended.
    operationEnded: (operationId) => modelProxyHolder.current?.operationEnded(operationId),
    registry, stateDirectory, pageSessions, version: options.version, ...(config.companyId === undefined ? {} : { companyId: config.companyId }),
    machinesName: options.machines === undefined ? DOCKER_ADAPTER_NAME : INJECTED_ADAPTER_NAME,
    resolveRepositoryCredential: async (_credentialRef, repositoryUrl, accessKind) => {
      assertGithubCloneAccess(repositoryUrl, accessKind);
      const access = await resolveGithubAccess({ companyId: config.companyId ?? IMPLICIT_COMPANY_ID, keyFile: githubKeys, environment: options.environment, ...(options.gh === undefined ? {} : { gh: options.gh }) });
      if (access === undefined) throw new Error("no GitHub access is set up: run `gh auth login`, set GH_TOKEN, or put a github token in keys.json");
      return { token: access.token.reveal() };
    },
    ...(options.timers === undefined ? {} : { timers: options.timers }),
  });

  const workspaces = new InMemoryRegistry();
  const brokerHandler = createBrokerHandler({
    authenticator: {
      async authenticate(token) {
        const result = await identity.authenticate({ scheme: "local-session", value: token, remoteAddress: "127.0.0.1" });
        if (!result.ok) throw agentXError("AUTH_REQUIRED", "the local session token is not valid");
        return {
          issuer: "rovara-local",
          subject: result.principal.personId,
          ownerKey: createHash("sha256").update(result.principal.companyId).update("\0").update(result.principal.personId).digest("hex"),
          isAdministrator: true,
          claims: {},
        };
      },
    },
    memberships: [],
    registry: workspaces,
    operations: new OperationStore(workspaces),
    projects: new InMemoryProjectRegistry(),
  });

  const wiring = (): Record<string, string[]> => {
    const result: Record<string, string[]> = {};
    for (const point of PLUGIN_POINTS satisfies readonly PluginPoint[]) {
      const names = registry.names(point);
      if (names.length > 0) result[point] = names;
    }
    return result;
  };
  const handler = async (request: BrokerRequest): Promise<BrokerResponse> => {
    const path = request.path.split("?")[0];
    if (request.method === "GET" && path === "/healthz") return json(200, { status: "ok", version: options.version });
    if (request.method === "GET" && path === "/v1/auth/.well-known/agentx-configuration") return configurationAnswer(options.version);
    const bearer = request.headers.authorization;
    const authenticated = bearer?.startsWith("Bearer ") === true
      ? await identity.authenticate({ scheme: "local-session", value: bearer.slice(7), remoteAddress: "127.0.0.1" })
      : ({ ok: false } as const);
    if (request.method === "GET" && path === "/v1/local/status") {
      if (!authenticated.ok) return json(401, { error: { code: "AUTH_REQUIRED", message: "the local session token is required" } });
      return json(200, { version: options.version, company: authenticated.principal.companyId, owner: authenticated.principal.displayName, wiring: wiring(), pages: app.pages.origin });
    }
    if (authenticated.ok) {
      const answer = await app.routes(request, { principal: authenticated.principal, client: clientOf(request) });
      if (answer !== undefined) return answer;
    } else if (path?.startsWith("/v1/dev/") === true || path?.startsWith("/v1/local/") === true) {
      return json(401, { error: { code: "AUTH_REQUIRED", message: "the local session token is required" } });
    }
    return brokerHandler(request);
  };
  // A worker's callbacks never reach the owner's routes; they have the listener of their own (callback-server.ts) and these handlers only.
  const callbackHandler = (request: BrokerRequest): Promise<BrokerResponse> => app.callbacks(request);

  const server: LocalHttpServer = await startLocalHttpServer({ handler, ...(options.port === undefined ? {} : { port: options.port }) });
  serverUrl.current = server.url;
  // Tells `rovara open` where to find this process. The file holds no secret: the session token is in its own file.
  const serverFile = join(stateDirectory, SERVER_FILE_NAME);
  await writeOwnerFile(serverFile, `${JSON.stringify({ url: server.url, pid: process.pid })}\n`).catch(() => undefined);
  // Workers call back on a listener of their own, not on the owner's server (callback-server.ts).
  // Lane L9a (K1): the model proxy is served on that same listener, so a worker reaches it only through its own egress gateway.
  const modelProxy = createLocalModelProxy({
    keys: registry.require("model-keys"),
    metering: registry.require("metering"),
    companyId: config.companyId ?? IMPLICIT_COMPANY_ID,
    // What a worker may call is the task flow's decision (the grants over the flow's operations); a caller's own source (tests) replaces it.
    grants: options.modelGrants ?? app.modelGrants,
    workerUrl: modelProxyWorkerUrl(),
    ...(options.modelProviderEndpoints === undefined ? {} : { endpoints: options.modelProviderEndpoints }),
  });
  modelProxyHolder.current = modelProxy;
  callbackServer.current = await startCallbackServer({ handler: callbackHandler, stateDirectory, modelProxy }).catch(async (error: unknown) => {
    await server.close();
    await app.stop();
    for (const close of closers) await close();
    throw error;
  });

  let stopped = false;
  return {
    url: server.url,
    port: server.port,
    callbackPort: callbackServer.current.tcpPort,
    registry,
    config,
    configPath: location.path,
    sessionTokenPath,
    pageSessions,
    pagesUrl: app.pages.origin,
    pageLink: (path) => app.pages.link(path, { label: "terminal" }),
    app,
    tick: () => app.tick(),
    modelProxy,
    wiring,
    async stop() {
      if (stopped) return;
      stopped = true;
      await rm(serverFile, { force: true }).catch(() => undefined);
      await server.close();
      await callbackServer.current?.close();
      await app.stop();
      if (options.stopWorkersOnClose !== false) await docker.stopAll().catch(() => 0);
      for (const close of closers) await close();
    },
  };
}

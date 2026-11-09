// Port lane L4: `rovara up`'s runtime. One local Node process: an HTTP server on 127.0.0.1 over the W0 registry.
//
// Order (it matters, and `docs/local.md` says why): the state folder is checked; the plug-in config is read from there; Code's
// defaults and the built-in adapters are registered; the config's adapters are loaded (a configured storage or queue replaces the
// in-memory default); the registry is sealed; then the server starts. Nothing in the registry changes after that except channels.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { PLUGIN_POINTS, agentXError, type AdapterRegistry, type ModelKeyStore, type PluginConfig, type PluginPoint } from "@agentx/contracts";
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
  loadAdapters,
  parsePluginConfig,
  registerCodeDefaults,
} from "../ports/index.js";
import { MemoryDocumentStore } from "../ports/memory-document-store.js";
import { MemoryQueueService } from "../ports/memory-queue.js";
import { OUTBOX_PENDING_INDEX } from "@agentx/contracts";
import { createDockerRunner, type DockerRunner } from "./docker-runner.js";
import { DockerWorkerMachines } from "./docker-worker-machines.js";
import { startLocalHttpServer, type LocalHttpServer } from "./http-server.js";
import { loadInvokeSigner } from "./invoke-signer.js";
import {
  KEYS_FILE_NAME,
  SESSION_TOKEN_FILE_NAME,
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
  /** Stop the running workers when the runtime stops. Default true. */
  stopWorkersOnClose?: boolean;
}

export interface LocalRuntime {
  readonly url: string;
  readonly port: number;
  readonly registry: AdapterRegistry;
  readonly config: PluginConfig;
  readonly configPath: string;
  readonly sessionTokenPath: string;
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

function json(statusCode: number, value: unknown): BrokerResponse {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
}

export async function startLocalRuntime(options: LocalRuntimeOptions): Promise<LocalRuntime> {
  const stateDirectory = await ensureStateDirectory(options.stateDirectory);
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

  const registry = createAdapterRegistry();
  const modelKeys = createLocalModelKeyStore(stateDirectory, options.environment);
  registerCodeDefaults(registry, {
    ...(config.companyId === undefined ? {} : { companyId: config.companyId }),
    displayName: ownerName(),
    isValidSession: (value) => constantTimeEqual(value, sessionToken),
    modelKeys,
    // Nothing is priced until a price table is configured: usage is recorded as "unknown", never guessed.
    priceTable: { currency: "USD", models: {} },
  });

  // Storage and queue: in-memory fakes for now. A configured `storage`/`queue` plug-in (the SQLite lane) replaces them.
  registry.register("storage", "memory", new MemoryDocumentStore({ indexes: [OUTBOX_PENDING_INDEX] }), { isDefault: true });
  registry.register("queue", "memory", new MemoryQueueService(), { isDefault: true });

  // Worker machines. The port number is not known until the server listens, so the callback address is read when a machine starts.
  let listeningPort = 0;
  const docker = new DockerWorkerMachines({
    image: options.workerImage,
    stateDirectory,
    controlPlaneUrl: () => `http://host.docker.internal:${listeningPort}`,
    signer: await loadInvokeSigner(stateDirectory),
    docker: options.docker ?? createDockerRunner(options.environment),
  });
  registry.register("worker-machines", DOCKER_ADAPTER_NAME, docker);
  registry.register("worker-machines", THIS_MACHINE_ADAPTER_NAME, new ThisMachineWorkerMachines({ enabled: options.thisMachine === true }));

  await loadAdapters(config, { registry, importModule: createModuleImporter(dirname(location.path)) });
  registry.seal();

  const identity = registry.require("identity");
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
    if (request.method === "GET" && path === "/v1/local/status") {
      const bearer = request.headers.authorization;
      const result = bearer?.startsWith("Bearer ") === true
        ? await identity.authenticate({ scheme: "local-session", value: bearer.slice(7), remoteAddress: "127.0.0.1" })
        : ({ ok: false } as const);
      if (!result.ok) return json(401, { error: { code: "AUTH_REQUIRED", message: "the local session token is required" } });
      return json(200, { version: options.version, company: result.principal.companyId, owner: result.principal.displayName, wiring: wiring() });
    }
    return brokerHandler(request);
  };

  const server: LocalHttpServer = await startLocalHttpServer({ handler, ...(options.port === undefined ? {} : { port: options.port }) });
  listeningPort = server.port;

  let stopped = false;
  return {
    url: server.url,
    port: server.port,
    registry,
    config,
    configPath: location.path,
    sessionTokenPath,
    wiring,
    async stop() {
      if (stopped) return;
      stopped = true;
      await server.close();
      if (options.stopWorkersOnClose !== false) await docker.stopAll().catch(() => 0);
    },
  };
}

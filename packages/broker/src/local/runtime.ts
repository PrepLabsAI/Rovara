// Port lane L4: `rovara up`'s runtime. One local Node process: an HTTP server on 127.0.0.1 over the W0 registry.
//
// Order (it matters, and `docs/local.md` says why): the state folder is checked; the plug-in config is read from there; Code's
// defaults and the built-in adapters are registered; the config's adapters are loaded (a configured storage or queue replaces the
// in-memory default); the registry is sealed; then the server starts. Nothing in the registry changes after that except channels.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { link, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { COMPANY_INSTRUCTIONS_FILE_NAME, IMPLICIT_COMPANY_ID, INDEX_EXPIRY_ATTRIBUTE, OrgIdSchema, PLUGIN_POINTS, agentXError, assertModelProvider, modelPriceRows, type AdapterRegistry, type ModelKeyStore, type PluginConfig, type PluginPoint, type SecretRef, type SecretStore } from "@agentx/contracts";
import { createBrokerHandler, type BrokerRequest, type BrokerResponse } from "../handler.js";
import { InMemoryProjectRegistry } from "../projects.js";
import { InMemoryRegistry } from "../registry.js";
import { OperationStore } from "../operations.js";
import {
  collectBuildSystemProfiles,
  createAdapterRegistry,
  createFileModelKeyStore,
  asSecretValue,
  createLocalSecretStore,
  createModuleImporter,
  createRegistrySecretStore,
  createSecretModelKeyStore,
  secretsPluginWords,
  modelKeyVariable,
  type ModuleImporter,
  loadAdapters,
  parsePluginConfig,
  registerCodeDefaults,
} from "../ports/index.js";
import { MemoryDocumentStore } from "../ports/memory-document-store.js";
import { registerNativeMonitoring } from "../monitoring/native-adapters.js";
import { registryModelPrices } from "./model-prices.js";
import { catalogPriceOf } from "../core/cost/price-table.js";
import { listPricesPerMillion } from "@agentx/model-runtime/catalog";
import { createDocumentObjectStorage } from "../core/proof/evidence-blob-store.js";
import { MemoryQueueService } from "../ports/memory-queue.js";
import { learningAdapterFromEnvironment } from "../lessons/local-embedder.js";
import { localLessonsEnabled } from "../lessons/switch.js";
import { DocumentAuditSink, FileCompanyInstructions, createIntervalScheduler, SqliteAuditLog, SqliteDocumentStore, SqliteQueueService, startAuditCopy, startAuditCopyFromPrimary } from "@agentx/local-adapters";
import type { WorkerMachines } from "@agentx/contracts";
import { TASK_FLOW_INDEXES } from "../core/task-flow/flow.js";
import type { AutomationSwitch } from "../core/automation/switch.js";
import type { BrowserOpener } from "./open-browser.js";
import { createLocalApp, type LocalApp } from "./app/app.js";
import { localAllowedDomains } from "./isolation/allow-list.js";
import { devcontainerRegistriesForInstall } from "./isolation/stack.js";
import type { LocalComments } from "./app/comments.js";
import { configurationAnswer } from "./app/routes.js";
import { usableWorkerCredential } from "./app/push-credential.js";
import { LocalPageSessions } from "../core/local-pages/guard.js";
import { localSessionProofVerifier } from "../core/decisions/local-session.js";
import { scriptTokensEnabled } from "../core/script-tokens/switch.js";
import { isScriptTokenHeader } from "../core/script-tokens/token-format.js";
import { startCallbackServer, type CallbackServer } from "./callback-server.js";
import { createLocalCodeHosts } from "./github-code-host.js";
import { createLocalTrackers } from "./trackers.js";
import { listProjects } from "./app/projects.js";
import { createStoreProjectSource } from "../core/task-flow/project-source.js";
import { codeHostForRepositoryAddress } from "../plugins/routing.js";
import { createDockerRunner, type DockerRunner } from "./docker-runner.js";
import { DockerWorkerMachines, ownerWantsPiMcp } from "./docker-worker-machines.js";
import { assertGithubRepositoryAddress, type GhRunner } from "./github-access.js";
import { startLocalHttpServer, type LocalHttpServer } from "./http-server.js";
import { loadInvokeSigner } from "./invoke-signer.js";
import { assertBuiltinIdsKept, registerBuiltinModelProviders } from "../plugins/model-provider/builtin.js";
import { createLocalModelProxy, registryModelProviderBook, type LocalModelProxy, type ModelGrantSource, type ProviderEndpoints } from "./model-proxy/index.js";
import { modelProxyWorkerUrl } from "./docker-worker-machines.js";
import {
  AUDIT_DB_FILE_NAME,
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
import { prepareLocalTestServices } from "./test-services-install.js";
import { createOwnerImageService, createOwnerImageStore } from "./test-services-owner-list.js";
import { createDockerImageRegistry } from "./docker-image-registry.js";
import { savedEnvEnabled } from "../core/test-env/saved-env-switch.js";

/** The model providers whose keys `rovara up` looks for (the environment variable is `<PROVIDER>_API_KEY`). */
export const LOCAL_MODEL_PROVIDERS = ["anthropic", "openai", "openrouter"] as const;
/** Where a model key may be, in order: the environment (the built-ins' long-standing names, `ROVARA_MODEL_<ID>_API_KEY` for any other provider), then the owner's key file. */
export function modelKeyRefs(provider: string): SecretRef[] {
  return [{ env: modelKeyVariable(provider) }, { key: provider }];
}

/**
 * Where Code's model keys come from: the environment first, then `<state folder>/keys.json` (refused unless only the owner can read it). The keys are READ through the `secrets` socket (owner
 * decision 60: `modelKeyRefs`); `secrets` is Code's own adapter unless the caller hands another (`rovara up` hands the registry's, so a configured `secrets` plug-in is the source of truth). Which
 * providers have a key is the same store's answer for each of `LOCAL_MODEL_PROVIDERS`, so a plug-in that has no key for a provider lists none, whatever `keys.json` holds.
 */
export function createLocalModelKeyStore(stateDirectory: string, environment: NodeJS.ProcessEnv, secrets?: SecretStore, providers: readonly string[] = LOCAL_MODEL_PROVIDERS): ModelKeyStore {
  const keyFile = createFileModelKeyStore(join(stateDirectory, KEYS_FILE_NAME));
  return createSecretModelKeyStore({
    secrets: secrets ?? createLocalSecretStore({ environment, keyFile }),
    refs: modelKeyRefs,
    providers,
  });
}

/** Which kind of source answered for each model provider that has a key (`env`, `key`, or a plug-in's own kind). Never the keys. For `rovara up --check`. */
export async function modelKeySources(secrets: SecretStore, companyId: string): Promise<Array<{ provider: string; kind: string }>> {
  const found: Array<{ provider: string; kind: string }> = [];
  for (const provider of LOCAL_MODEL_PROVIDERS) {
    for (const ref of modelKeyRefs(provider)) {
      if (asSecretValue(await secrets.read(companyId, ref)) !== undefined) {
        found.push({ provider, kind: Object.keys(ref)[0]! });
        break;
      }
    }
  }
  return found;
}

/** Code's `secrets` adapter for this laptop: `{ env }`, `{ file }` and `{ key }` (an entry of `<state folder>/keys.json`, the key file alone). */
export function createLocalSecrets(stateDirectory: string, environment: NodeJS.ProcessEnv): SecretStore {
  return createLocalSecretStore({ environment, keyFile: createFileModelKeyStore(join(stateDirectory, KEYS_FILE_NAME)) });
}

/**
 * The secrets store `rovara up` will use for this config, for the doctor (`rovara up --check`) which starts nothing else: Code's own, or the `secrets` plug-in the config names (loaded the way `rovara up` loads it,
 * into a registry of its own). `plugin` is the plug-in's name when one is configured. A plug-in that cannot be loaded throws the registry's fixed sentence.
 */
export async function loadConfiguredSecrets(input: { stateDirectory: string; configPath: string; config: PluginConfig; environment: NodeJS.ProcessEnv }): Promise<{ store: SecretStore; plugin?: string; dispose?: () => Promise<void> }> {
  const entries = input.config.plugins.filter((entry) => entry.enabled && entry.point === "secrets");
  if (entries.length === 0) return { store: createLocalSecrets(input.stateDirectory, input.environment) };
  // The doctor starts nothing, so the plug-in gets a registry with only itself in it: a `secrets` plug-in that needs another plug-in (a storage, say) cannot be created here and is checked when `rovara up` starts.
  const registry = createAdapterRegistry();
  await loadAdapters({ ...input.config, plugins: entries }, { registry, importModule: createLocalModuleImporter(input.stateDirectory, dirname(input.configPath)) });
  const adapter = registry.require("secrets");
  // Whatever the plug-in holds (a connection, a timer) is let go after the check, or the command would not exit.
  return { store: createRegistrySecretStore(registry), plugin: registry.names("secrets")[0]!, dispose: async () => { await adapter.close?.(); } };
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
  /** Port lane L11: the fetch the GitHub code host uses (tests give a recorder). */
  fetch?: typeof fetch | undefined;
  /** The fetch the Docker adapter uses to reach its workers (tests give the simulated Docker's). */
  workerFetch?: typeof fetch;
  /** The most threads one comment poll reads (default 20). */
  commentThreadsPerPoll?: number;
  /** For tests: the fetch under a connection's check, the check that refuses an address that must not be called, and the transport under a source's server. */
  connectionsFetch?: typeof fetch;
  connectionsCheckEndpoint?: (url: string) => Promise<void>;
  connectionsServerPort?: NonNullable<Parameters<typeof createLocalApp>[0]["connectionsServerPort"]>;
  /** The document a planning run is asked to write: a structured plan (the default) or the Markdown plan an older worker takes. */
  planFormat?: "structured" | "markdown";
  /** The app's clock (the flow's records, the sessions and the tracking timer's schedule). Default: the real time. A test moves it. */
  now?: () => Date;
  /** Run the dispatch, sweep and session timers. Default true; tests call `runtime.tick()`. */
  timers?: boolean;
  /**
   * Switch on automation (chains, triggers, automatic runs, custom agents), which starts paid work with no person present. Default: off, unless the environment of the process that runs `rovara up` says
   * `ROVARA_AUTOMATION=on`. Only this process's own owner reaches it: no route, token or page changes it.
   */
  automation?: boolean | AutomationSwitch | undefined;
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
 * One `rovara up` per state folder. A second would rewrite the session token and the server file, and either one's Ctrl-C would stop the other's workers. The lock is a file holding
 * `<pid>:<nonce>`, put in place whole and at once (written under another name, then `link()`ed: a reader never sees it empty). A lock whose process is gone is taken over by an atomic
 * `rename`, after which what was moved is read again: if it is not the stale lock that was judged, it is put back and the start is refused.
 */
const LOCK_YOUNG_MS = 5_000;
async function acquireStateLock(stateDirectory: string): Promise<() => Promise<void>> {
  const path = join(stateDirectory, STATE_LOCK_FILE_NAME);
  const mine = `${String(process.pid)}:${randomBytes(8).toString("hex")}`;
  const held = (pid: number | string) => new LocalStateError(`another rovara up (process ${String(pid)}) holds ${path} for ${stateDirectory}; stop it first, or use another --state-dir (if no rovara up is running, delete ${path})`);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const staged = `${path}.${randomBytes(6).toString("hex")}`;
    await writeFile(staged, `${mine}\n`, { flag: "wx", mode: 0o600 });
    try {
      await link(staged, path);
      let released = false;
      return async () => {
        // Only our own lock is removed, and only once (a second runtime in this process has a lock of its own).
        if (released) return;
        released = true;
        const text = await readFile(path, "utf8").catch(() => undefined);
        if (text?.trim() === mine) await rm(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await rm(staged, { force: true });
    }
    // Someone holds it. Is that holder alive?
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text === undefined) continue; // released between our link and our read
    const pid = Number(text.trim().split(":")[0]);
    const age = Date.now() - ((await stat(path).catch(() => undefined))?.mtimeMs ?? 0);
    // An empty or unreadable lock that is young is a holder still writing; it is never judged stale.
    if (!Number.isInteger(pid) || pid <= 0) {
      if (age < LOCK_YOUNG_MS) throw held("?");
    } else {
      let alive: boolean;
      try { process.kill(pid, 0); alive = true; } catch (killError) { alive = (killError as NodeJS.ErrnoException).code === "EPERM"; }
      if (alive) throw held(pid);
    }
    // Stale: move it aside atomically, and check that what was moved is the lock that was judged.
    const aside = `${path}.stale.${randomBytes(6).toString("hex")}`;
    try { await rename(path, aside); } catch { continue; }
    const moved = await readFile(aside, "utf8").catch(() => undefined);
    if (moved !== text) {
      // Another starter put a fresh lock there between our read and our rename: give it back (if the name is free) and refuse.
      await link(aside, path).catch(() => undefined);
      await rm(aside, { force: true });
      throw held("another process");
    }
    await rm(aside, { force: true });
  }
  throw new LocalStateError(`could not take the lock ${path}`);
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
  // The comment reads of the approvers (a comment proves an approval only after Rovara's own checks, `core/pr-commands/comment-checks.ts`) need the app, which is made after the registry is sealed.
  const comments: { current?: Pick<LocalComments, "fetchComment" | "contextOf" | "available"> } = {};
  // Owner decision 60 (R2): secrets are read through the `secrets` point. The model keys and the GitHub token ask the registry each time, so a configured `secrets` plug-in replaces Code's.
  const registrySecrets = createRegistrySecretStore(registry);
  const closers: Array<() => Promise<void> | void> = [];
  const configured = (point: PluginPoint): boolean => config.plugins.some((entry) => entry.point === point);
  // The providers whose key is looked for (item K2): the built-ins, then each `model-provider` plug-in once the config is loaded (below). The array is read at each call.
  const keyedProviders: string[] = [...LOCAL_MODEL_PROVIDERS];
  const modelKeys = createLocalModelKeyStore(stateDirectory, options.environment, registrySecrets, keyedProviders);
  // What a model costs: the provider's own table (the `prices` of its `model-provider` plug-in), then the catalog's list price (`core/cost/price-table.ts`). The providers are loaded after the config,
  // so the lookup reads the registry at each call; a model neither table knows is unpriced, never free.
  const modelPrices = registryModelPrices(registry);
  registerCodeDefaults(registry, {
    // Port lane P6 (item L2): the audit record commits with the change, as a row in the same store; a configured `audit-sink` plug-in replaces it.
    ...(configured("audit-sink") ? {} : { auditSink: { name: "document", sink: new DocumentAuditSink({ store: () => registry.require("storage") }) } }),
    secrets: createLocalSecrets(stateDirectory, options.environment),
    ...(config.companyId === undefined ? {} : { companyId: config.companyId }),
    // The outside accounts that are the owner's own (config `linkedAccounts`): a ticket asks for work as the owner only when its tracker says one of these made the act.
    ...(config.linkedAccounts === undefined ? {} : { linkedAccounts: config.linkedAccounts }),
    displayName: ownerName(),
    isValidSession: (value) => constantTimeEqual(value, sessionToken),
    // An approval is proved by a token the local pages sign over one request, revision and digest; the sign-in secret above is never an approval proof.
    approvers: {
      verifySession: localSessionProofVerifier(pageSessions),
      fetchComment: async (commentId, request) => comments.current?.fetchComment(commentId, request),
      commentContext: async (request) => comments.current?.contextOf(request),
      commentsOn: () => comments.current?.available() === true,
    },
    modelKeys,
    // A model with no price in its provider's table or the catalog is recorded as "unknown", never guessed.
    priceTable: { currency: "USD", models: {} },
    prices: modelPrices,
  });
  // The learning point: how lessons are compared. Code's own compares on keywords and cited paths; `ROVARA_LESSONS_EMBEDDER=local` adds the small embedder that runs in this process, and a loopback address
  // (`http://127.0.0.1:<port>/v1` with `ROVARA_LESSONS_EMBEDDER_MODEL`) a small open model served on this machine (decision 23). A configured `learning` plug-in is used instead.
  registry.register("learning", "local", learningAdapterFromEnvironment(options.environment), { isDefault: true });
  // Item K2: the model providers. The three Code has always known are rows; a configured `model-provider` plug-in of the same name replaces one.
  registerBuiltinModelProviders(registry);

  // Storage and queue: one SQLite file in the state folder (lane L3's adapters), unless the config names its own. The store keeps the indexes the task flow needs.
  if (options.storage === "memory") {
    registry.register("storage", "memory", new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, ttlAttribute: INDEX_EXPIRY_ATTRIBUTE }), { isDefault: true });
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

  const runner = options.docker ?? createDockerRunner(options.environment);
  // Saved environments (off unless `ROVARA_SAVED_ENVIRONMENTS=1`): the image registry is one labelled container on the owner's Docker, published on the loopback address only, started when first used. A configured
  // `image-registry` plug-in replaces it. The worker's socket guard does not yet allow an image to be built, pushed or pulled, so the adapter says the worker cannot, and no image is queued or named to one.
  if (savedEnvEnabled(options.environment) && !configured("image-registry")) {
    const images = createDockerImageRegistry({ docker: runner, stateDirectory });
    closers.push(async () => { await images.stop(); });
    registry.unregister("image-registry", "none");
    registry.register("image-registry", "docker", images, { isDefault: true });
  }
  // Test services (off unless `ROVARA_TEST_SERVICES=1`): the catalog's images are pulled on the host and the worker is told what it may start. Anything missing leaves the worker offering none.
  // Code has no catalog signing key, so the owner's own approved image list stands where the signed catalog would: the built-in starter images, what the owner approved on the test environment page, and `ROVARA_TEST_SERVICE_IMAGES`.
  // The store and the audit sink are read late (a storage or audit plug-in registers after this); a store that is not there yet counts as holding no approvals.
  const ownerCompany = OrgIdSchema.parse(config.companyId ?? IMPLICIT_COMPANY_ID);
  const ownerImageStore = createOwnerImageStore({ store: () => registry.require("storage"), companyId: ownerCompany });
  const ownerImages = createOwnerImageService({
    store: ownerImageStore, docker: runner, now: () => Date.now(), companyId: ownerCompany,
    audit: { stage: (event) => registry.require("audit-sink").stage(event), record: (event) => registry.require("audit-sink").record(event) },
    log: (entry) => console.log(JSON.stringify(entry)),
  });
  const testServices = await prepareLocalTestServices({ environment: options.environment, stateDirectory, docker: runner, ownerImages, log: (entry) => console.log(JSON.stringify(entry)) });
  // Worker machines. The callback listener's port is not known until the handler exists, so it is read when a machine starts.
  const callbackServer: { current?: CallbackServer } = {};
  // The hosts the owner approved for a setup run: read at each machine start (the app is made after the machines, so it is read late).
  const approvedHosts: { current?: (project: string | undefined) => Promise<string[]> } = {};
  const docker = new DockerWorkerMachines({
    image: options.workerImage,
    stateDirectory,
    callback: () => {
      if (callbackServer.current === undefined) throw new Error("the callback listener is not running yet");
      return { tcpPort: callbackServer.current.tcpPort, socketDirectory: callbackServer.current.socketDirectory };
    },
    ...(options.allowedDomains === undefined ? {} : { allowedDomains: options.allowedDomains }),
    extraAllowedDomains: async (project) => (await approvedHosts.current?.(project)) ?? [],
    // The registries a project's dev container may pull from: the owner's `ROVARA_DEVCONTAINER_REGISTRIES` (`0` turns dev containers off); with none said, the default list on a Docker that runs in a virtual machine and none on a host where root in a container is root.
    devcontainerRegistries: await devcontainerRegistriesForInstall(options.environment, options.docker ?? createDockerRunner(options.environment)),
    modelProxy: true,
    // The stage's sources through Pi's own MCP client (the gateway's one server); any owner ROVARA_PI_MCP but unset or "1" flips back to the worker's own tools for one release.
    piMcp: ownerWantsPiMcp(options.environment),
    // Port lane P6 (item B1): what the registered build-system adapters supply (extra detectors, setup programs) goes to the worker's start-up environment; read late, because the config's adapters load after this.
    buildSystems: () => collectBuildSystemProfiles(registry),
    signer: await loadInvokeSigner(stateDirectory),
    docker: runner,
    ...(testServices.services === undefined ? {} : { testServices: testServices.services }),
    ...(options.workerFetch === undefined ? {} : { fetch: options.workerFetch }),
  });
  registry.register("worker-machines", DOCKER_ADAPTER_NAME, docker);
  if (options.machines !== undefined) registry.register("worker-machines", INJECTED_ADAPTER_NAME, options.machines);
  registry.register("worker-machines", THIS_MACHINE_ADAPTER_NAME, new ThisMachineWorkerMachines({ enabled: options.thisMachine === true }));

  // Port lane L11: each code host the owner has a sign-in for (a GitHub token from the secrets adapter, GH_TOKEN or the GitHub CLI) is registered under its own kind (below, after the plug-ins load); a configured `code-host` plug-in of that name
  // is used instead. The repositories a host may be used for are the registered projects' (the store the app registers them in, read when asked, so a plug-in storage works too).
  const companyOrg = OrgIdSchema.parse(config.companyId ?? IMPLICIT_COMPANY_ID);
  /** The registered projects' repositories (not archived), as their records state them: the address and the code host connection the record names, if any. */
  const registeredRepositoryRecords = async (): Promise<Array<{ url: string; host?: { kind: string } | undefined }>> => {
    const store = registry.require("storage");
    const source = createStoreProjectSource(store, companyOrg);
    const latest = await Promise.all((await listProjects(store, companyOrg)).map((project) => source.latest(project.name)));
    return latest.flatMap((revision) => (revision === undefined || revision.archived === true ? [] : revision.definition.repositories.map((repository) => ({ url: repository.url, host: repository.host }))));
  };
  const registeredRepositories = async (): Promise<string[]> => (await registeredRepositoryRecords()).map((repository) => repository.url);
  // Port lane P6 (item L1): the company's standing rules come from `<state folder>/company-instructions.md` (read fresh at every step); a configured `company-instructions` plug-in replaces it.
  registry.register("company-instructions", "file", new FileCompanyInstructions({ path: join(stateDirectory, COMPANY_INSTRUCTIONS_FILE_NAME) }), { isDefault: true });

  options.registerAdapters?.(registry);
  await loadAdapters(config, { registry, stateDirectory, importModule: createLocalModuleImporter(stateDirectory, dirname(location.path)) });
  // The scheduler (the nightly test run): a timer inside this process, its schedules kept in the same store so a restart keeps them. A configured `scheduler` plug-in replaces it. Made after the config's adapters are loaded, because it keeps its schedules in the storage adapter that may be one of them. Nothing fires until a
  // handler subscribes, which the app does at start-up (and not at all with the timers off).
  if (!configured("scheduler")) {
    const scheduler = createIntervalScheduler({ store: registry.require("storage"), ...(options.now === undefined ? {} : { now: () => (options.now as () => Date)().getTime() }) });
    closers.push(async () => { await scheduler.close?.(); });
    registry.unregister("scheduler", "none");
    registry.register("scheduler", "interval", scheduler, { isDefault: true });
  }

  // Item K2: each provider is checked as a whole (an address that is not https, a header the proxy owns, a vertex variant on the wrong format), then its prices join the metering table.
  const providerRows = registry.names("model-provider").map((name) => registry.require("model-provider", name));
  for (const provider of providerRows) {
    try {
      assertModelProvider(provider);
      assertBuiltinIdsKept(provider);
    } catch (error) {
      throw new LocalStateError(`${error instanceof Error ? error.message : "a model provider is not valid"}`);
    }
    if (!keyedProviders.includes(provider.kind)) keyedProviders.push(provider.kind);
  }
  // The providers' tables must agree on one currency (a task budget is in one); the lookup above reads the rows themselves.
  modelPriceRows(providerRows);
  // A plug-in may not call a model free that the catalog prices: `free` is for a model nobody lists a price for, and a slip here would let a paid model run under every budget as if it cost nothing.
  for (const provider of providerRows) {
    for (const [modelId, row] of Object.entries(provider.prices?.models ?? {})) {
      if (row.free === true && catalogPriceOf(listPricesPerMillion({ provider: provider.kind, modelId })) !== undefined) {
        throw new LocalStateError(`model provider ${provider.kind.slice(0, 40)}: the model ${modelId.slice(0, 80)} is marked free, but the catalog lists a price for it; remove "free" or its row`);
      }
    }
  }
  // Owner decision 60 (M1): a configured `secrets` plug-in is the source of truth, so this runs AFTER the config's adapters are loaded: a host is registered when the registry's `secrets` adapter (the plug-in, else
  // Code's) says there is a sign-in, and a host a plug-in or `registerAdapters` already registered under that kind is left alone.
  for (const host of createLocalCodeHosts({ stateDirectory, environment: options.environment, secrets: registrySecrets, companyId: config.companyId, gh: options.gh, fetch: options.fetch, registeredRepositories, allowBroadTokenForWorker: config.allowBroadTokenForWorker })) {
    if (registry.get("code-host", host.kind) !== undefined) continue;
    if ((await host.resolveCredentials?.())?.found === true) registry.register("code-host", host.kind, host, { isDefault: true });
  }
  // The trackers the owner has signed in to (a Linear key, a Jira site and token), each under its own kind; a configured `tracker` plug-in of that name is used instead.
  for (const tracker of await createLocalTrackers({ environment: options.environment, secrets: registrySecrets, companyId: config.companyId, fetch: options.fetch })) {
    if (registry.get("tracker", tracker.kind) === undefined) registry.register("tracker", tracker.kind, tracker, { isDefault: true });
  }
  // Every record the core writes expires by `indexExpiresAt`. A store that sweeps another attribute (the SQLite plug-in's own default is `expiresAt`) would keep them for ever without a word,
  // so such a store is refused here, saying what to set.
  const storeTtl = registry.require("storage").ttlAttribute;
  if (storeTtl !== INDEX_EXPIRY_ATTRIBUTE) {
    throw new LocalStateError(`the storage plug-in expires records by ${storeTtl === undefined ? "nothing" : `"${storeTtl}"`}, and Rovara's records expire by "${INDEX_EXPIRY_ATTRIBUTE}"; set "ttlAttribute": "${INDEX_EXPIRY_ATTRIBUTE}" in its settings`);
  }
  // Lane L9a (S1): objects are kept as documents unless a plug-in names another object storage (the folder adapter).
  if (registry.names("object-storage").length === 0) {
    registry.register("object-storage", "document", createDocumentObjectStorage(registry.require("storage"), { companyId: config.companyId ?? IMPLICIT_COMPANY_ID }), { isDefault: true });
  }
  // The monitoring adapters Code ships (Sentry, Datadog, Grafana, PagerDuty, Vercel); a plug-in's own adapter for a kind, loaded above, is left in place. CloudWatch needs AWS access: it is
  // registered by whoever gives this install that access (`cloudwatchMonitoringAdapter`).
  registerNativeMonitoring(registry);
  registry.seal();
  // Port lane P6 (item L2): an append-only, hash-chained copy of the committed audit rows (audit.db), fed through the store's change feed. It is never the primary record. Its chain and anchor are checked now.
  if (options.storage !== "memory" && !configured("audit-sink")) {
    const copy = SqliteAuditLog.open({ path: join(stateDirectory, AUDIT_DB_FILE_NAME) });
    const store = registry.require("storage");
    const copyCompany = config.companyId ?? IMPLICIT_COMPANY_ID;
    const started = await startAuditCopyFromPrimary({ store, log: copy, companyId: copyCompany });
    if (started.backfilled > 0 || started.verification.anchor === "behind") console.error(JSON.stringify({ component: "broker", event: "audit-copy.backfilled", rows: started.backfilled }));
    else if (!started.verification.ok) console.error(JSON.stringify({ component: "broker", event: "audit-copy.verify_failed", ...started.verification }));
    const feeding = await startAuditCopy({ store, log: copy, companyId: copyCompany, onError: (error) => { console.error(JSON.stringify({ component: "broker", event: "audit-copy.append_failed", error: error instanceof Error ? error.name : "error" })); } });
    // The feed stops first, then the copy closes, both before the store does.
    closers.unshift(() => copy.close());
    if (feeding !== undefined) closers.unshift(() => feeding.stop());
  }
  // A `secrets` plug-in lets go of what it holds when the process stops.
  closers.push(() => registry.require("secrets").close?.());

  const identity = registry.require("identity");
  const serverUrl = { current: "http://127.0.0.1" };
  const modelProxyHolder: { current?: LocalModelProxy } = {};
  const app = await createLocalApp({
    origin: () => serverUrl.current,
    ...(options.openBrowser === undefined ? {} : { openBrowser: options.openBrowser }),
    // The model proxy is made after the servers (it is served on the callback listener); the app asks it, late, to forget an operation that ended.
    operationEnded: (operationId) => modelProxyHolder.current?.operationEnded(operationId),
    operationSpend: (operationId) => modelProxyHolder.current?.tokens.spentBy(operationId),
    scriptTokensEnabled: () => scriptTokensEnabled(options.environment),
    ...(testServices.catalogSource === undefined ? {} : { serviceCatalog: testServices.catalogSource }),
    ...(testServices.mode === "owner" && testServices.ownerImages !== undefined ? { testServiceImages: testServices.ownerImages } : {}),
    modelCalls: (operationId) => modelProxyHolder.current?.tokens.calledAliases(operationId),
    slotKeys: () => modelProxyHolder.current?.slotKeys,
    // A diagnosis calls its model through the proxy over the listener's loopback port (both are made after the app).
    modelProxy: () => (modelProxyHolder.current === undefined || callbackServer.current === undefined ? undefined : { tokens: modelProxyHolder.current.tokens, port: callbackServer.current.tcpPort }),
    environment: options.environment ?? process.env,
    registry, stateDirectory, pageSessions, version: options.version, ...(config.companyId === undefined ? {} : { companyId: config.companyId }),
    machinesName: options.machines === undefined ? DOCKER_ADAPTER_NAME : INJECTED_ADAPTER_NAME,
    // Lane L13: the owner's model setting, read from the owner's own config only.
    ...(config.model === undefined ? {} : { modelSetting: config.model }),
    // A worker's clone or push credential comes from the registered code host's own `issueGitCredential`, so its rules always apply: only registered projects' repositories, a push only where the token can push,
    // and a token that reaches every repository its owner can only when the config allows it. The address rules below (github.com, plain characters) run first.
    resolveRepositoryCredential: async (_credentialRef, repositoryUrl, accessKind) => {
      assertGithubRepositoryAddress(repositoryUrl);
      // The credential comes from the connection the repository's record resolves to (`codeHostForRecord`, the one its pull request and merge calls use), never from a different default (lane P2, review M1).
      const host = codeHostForRepositoryAddress(registry, repositoryUrl, await registeredRepositoryRecords());
      const credential = await host.issueGitCredential({ url: repositoryUrl }, accessKind, { orgId: companyOrg });
      // Expiring, and a shape the worker takes (a token, or the password of a basic credential); a push is the same call with `push`, so the adapter's push checks apply (lane L10, review H1).
      return usableWorkerCredential(host, credential);
    },
    ...(options.timers === undefined ? {} : { timers: options.timers }),
    automation: options.automation ?? options.environment["ROVARA_AUTOMATION"] === "on",
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.commentThreadsPerPoll === undefined ? {} : { commentThreadsPerPoll: options.commentThreadsPerPoll }),
    ...(options.connectionsFetch === undefined ? {} : { connectionsFetch: options.connectionsFetch }),
    ...(options.connectionsCheckEndpoint === undefined ? {} : { connectionsCheckEndpoint: options.connectionsCheckEndpoint }),
    ...(options.connectionsServerPort === undefined ? {} : { connectionsServerPort: options.connectionsServerPort }),
    ...(options.planFormat === undefined ? {} : { planFormat: options.planFormat }),
    ...(options.modelProviderEndpoints === undefined ? {} : { modelProviderEndpoints: options.modelProviderEndpoints }),
    // The flip-back settings of the session features (`0` turns one off; anything else leaves it on).
    liveSteer: options.environment["ROVARA_LIVE_STEER"] !== "0", stepNotes: options.environment["ROVARA_STEP_NOTES"] !== "0", ask: options.environment["ROVARA_ASK"] !== "0", lessonsEnabled: () => localLessonsEnabled(options.environment), runLimit: options.environment["ROVARA_RUN_LIMIT"] !== "0",
    diagnosis: options.environment["ROVARA_DIAGNOSIS"] !== "0",
    // The setup agent (`ROVARA_SETUP_AGENT=0` turns it off): a run that sets a project up by running its commands in a sandbox.
    setupAgent: options.environment["ROVARA_SETUP_AGENT"] !== "0",
    installDomains: () => localAllowedDomains(options.allowedDomains),
  });
  approvedHosts.current = (project) => app.setupAgent.approvedHosts(project);

  comments.current = app.comments;
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
    // a script token is checked before anything else and reaches only its closed list of routes; it never falls through to the owner's routes or to the older broker handler.
    if (isScriptTokenHeader(bearer)) return app.scriptTokens.serve(request, (routed, caller) => app.routes(routed, caller));
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
    ...(secretsPluginWords(registry) === undefined ? {} : { keySource: secretsPluginWords(registry) }),
    // Through the app's meter: what a worker's call costs is kept in the task's cost ledger (the limit, the page and the next estimate read it there).
    metering: app.meter,
    companyId: config.companyId ?? IMPLICIT_COMPANY_ID,
    providers: registryModelProviderBook(registry),
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

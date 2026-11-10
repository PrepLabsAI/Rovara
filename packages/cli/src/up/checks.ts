// Port lane L4: `rovara up --check`, the doctor for the local runtime. It checks what a first run needs (Docker and the worker image,
// a model key, GitHub access, the port) and, for each problem, says the fix in plain words. It starts nothing and writes nothing.
import { createServer } from "node:net";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { IMPLICIT_COMPANY_ID, PluginRegistryError, type ModelKeyStore, type SecretStore } from "@agentx/contracts";
import {
  KEYS_FILE_NAME,
  LOCAL_MODEL_PROVIDERS,
  chooseLocalModel,
  LOCAL_WORKER_IMAGE_BUILD_HINT,
  LOCAL_HOST,
  assertStateDirectoryLocation,
  createLocalCodeHosts,
  createLocalSecrets,
  createLocalModelKeyStore,
  describeBedrockSettings,
  loadConfiguredSecrets,
  modelKeySources,
  parsePluginConfigText,
  readOwnerFile,
  resolveConfigLocation,
  type DockerRunner,
  type GhRunner,
} from "@agentx/broker/local";

export type UpCheckStatus = "ok" | "warn" | "fail";

export interface UpCheck {
  id: "docker" | "worker-image" | "model-key" | "github" | "port" | "config";
  status: UpCheckStatus;
  summary: string;
  /** What to do, in plain words. Present for every warn and fail. */
  fix?: string;
}

export interface UpCheckServices {
  docker: DockerRunner;
  environment: NodeJS.ProcessEnv;
  stateDirectory: string;
  /** Where the config is (the owner's `--config`, or the default in the state folder). */
  configPath?: string | undefined;
  workerImage: string;
  /** The port asked for with `--port`; 0 or absent: a free one is picked at start. */
  port?: number | undefined;
  gh?: GhRunner;
  fetch: typeof fetch;
  /** Ask GitHub whether the token works. Off for the quick check that `rovara up` runs before it starts. */
  verifyGithub: boolean;
  /** Is this port free on 127.0.0.1? Injectable for tests. */
  portIsFree?: (port: number) => Promise<boolean>;
  keys?: ModelKeyStore;
  /** The folder the owner is standing in; a state folder or config inside it is refused, as `up` refuses it. */
  cwd?: string;
  home?: string;
}

const lastLine = (text: string): string => text.trim().split("\n").filter((line) => line.trim() !== "").slice(-1)[0]?.slice(0, 200) ?? "no detail";

export function defaultPortIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: LOCAL_HOST, port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function checkDocker(services: UpCheckServices): Promise<UpCheck[]> {
  const server = await services.docker.run(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 15_000 });
  if (server.exitCode !== 0) {
    const missing = /not installed/i.test(server.stderr);
    return [{
      id: "docker",
      status: "fail",
      summary: missing ? "Docker is not installed." : `Docker is not running (${lastLine(server.stderr)}).`,
      fix: missing
        ? "Install Docker Desktop (https://docs.docker.com/get-docker/), or on a Mac install Colima (brew install colima docker) and run `colima start`."
        : "Start Docker Desktop, or run `colima start`. If Docker runs somewhere unusual, set DOCKER_HOST to its socket.",
    }];
  }
  const checks: UpCheck[] = [{ id: "docker", status: "ok", summary: `Docker ${server.stdout.trim()} is running.` }];
  const image = await services.docker.run(["image", "inspect", "--format", "{{.Id}}", services.workerImage], { timeoutMs: 15_000 });
  checks.push(image.exitCode === 0
    ? { id: "worker-image", status: "ok", summary: `The worker image ${services.workerImage} is on this machine.` }
    : { id: "worker-image", status: "fail", summary: `The worker image ${services.workerImage} is not on this machine.`, fix: `Tasks cannot start without it. ${LOCAL_WORKER_IMAGE_BUILD_HINT} (or name another image with --worker-image).` });
  return checks;
}

/** The owner's config, read without writing anything; a config that cannot be read is `undefined` (the config check says why). */
async function readOwnerConfig(services: UpCheckServices): Promise<ReturnType<typeof parsePluginConfigText> | undefined> {
  try {
    const location = resolveConfigLocation({ stateDirectory: services.stateDirectory, configPath: services.configPath, cwd: services.cwd ?? process.cwd() });
    const file = await readOwnerFile(location.path, { private: false, label: "plug-in config" });
    return file === undefined ? undefined : parsePluginConfigText(file.text);
  } catch {
    return undefined;
  }
}

/** The secrets store the install will use: Code's own, or the `secrets` plug-in the config names. Loaded once per check run. A plug-in that cannot be loaded is reported, not thrown. */
const secretsCache = new WeakMap<UpCheckServices, Promise<{ store: SecretStore; plugin?: string; dispose?: () => Promise<void> } | { error: string }>>();
function secretsFor(services: UpCheckServices): Promise<{ store: SecretStore; plugin?: string; dispose?: () => Promise<void> } | { error: string }> {
  let held = secretsCache.get(services);
  if (held === undefined) {
    held = (async () => {
      const config = await readOwnerConfig(services);
      if (config === undefined) return { store: createLocalSecrets(services.stateDirectory, services.environment) };
      const location = resolveConfigLocation({ stateDirectory: services.stateDirectory, configPath: services.configPath, cwd: services.cwd ?? process.cwd() });
      try {
        return await loadConfiguredSecrets({ stateDirectory: services.stateDirectory, configPath: location.path, config, environment: services.environment });
      } catch (error) {
        const needsMore = error instanceof PluginRegistryError && error.code === "create_failed" ? " A secrets plug-in that needs other plug-ins (a storage, say) is only fully checked when `rovara up` starts." : "";
        return { error: `${error instanceof PluginRegistryError ? error.message : "the secrets plug-in could not be loaded"}.${needsMore}`.replace(/\.\.$/u, ".") };
      }
    })();
    secretsCache.set(services, held);
  }
  return held;
}

const SOURCE_KIND_WORDS: Record<string, string> = { env: "the environment", key: "the key file", file: "a secret file" };
const sourceWords = (kind: string, plugin: string | undefined): string => (plugin === undefined ? SOURCE_KIND_WORDS[kind] ?? kind : `the "${plugin}" secrets plug-in (${kind})`);

async function checkModelKey(services: UpCheckServices): Promise<UpCheck> {
  const keyFile = join(services.stateDirectory, KEYS_FILE_NAME);
  let keys: ModelKeyStore;
  let plugin: string | undefined;
  let store: SecretStore | undefined;
  if (services.keys !== undefined) {
    keys = services.keys;
  } else {
    const secrets = await secretsFor(services);
    if ("error" in secrets) return { id: "model-key", status: "fail", summary: secrets.error, fix: "Fix the secrets plug-in entry in your config, or remove it to use the environment and keys.json." };
    plugin = secrets.plugin;
    store = secrets.store;
    keys = createLocalModelKeyStore(services.stateDirectory, services.environment, secrets.store);
  }
  let found: string[];
  try {
    found = (await keys.providers(IMPLICIT_COMPANY_ID)).filter((provider) => (LOCAL_MODEL_PROVIDERS as readonly string[]).includes(provider));
  } catch (error) {
    // Code's own readers never quote the file; they say what is wrong with it. A plug-in's text is not shown.
    if (plugin !== undefined || !(error instanceof Error)) return { id: "model-key", status: "fail", summary: "The model key could not be read from the secrets plug-in.", fix: "Check the secrets plug-in in your config: it must answer the { \"env\": \"<PROVIDER>_API_KEY\" } and { \"key\": \"<provider>\" } references." };
    return { id: "model-key", status: "fail", summary: error.message, fix: `Fix the file's permissions with \`chmod 600 ${keyFile}\`, or keep the key in the ANTHROPIC_API_KEY environment variable instead.` };
  }
  // Lane L13: the same rule the task flow uses (the config's `model` setting, else Anthropic, OpenAI, OpenRouter), so this says what a task step will call.
  const config = await readOwnerConfig(services);
  const setting = config?.model;
  // Item K2: a `model-provider` plug-in named in the config is not loaded by this check (naming a module runs its code); `rovara up` loads it and says what is wrong with its sign-in.
  const entry = setting === undefined || LOCAL_MODEL_PROVIDERS.includes(setting.provider as (typeof LOCAL_MODEL_PROVIDERS)[number])
    ? undefined : config?.plugins.find((candidate) => candidate.enabled && candidate.point === "model-provider" && candidate.name === setting.provider);
  if (setting !== undefined && entry !== undefined) {
    // Bedrock signs with an AWS identity the owner must name (review M1): say which, and that its models are unpriced unless prices are set.
    if (entry.name === "amazon-bedrock") {
      const described = describeBedrockSettings(entry.settings);
      if (!described.ok) return { id: "model-key", status: "fail", summary: `The amazon-bedrock settings in your config are not valid: ${described.problem}.`, fix: 'Name one AWS identity in the amazon-bedrock settings: "profile": "<an AWS profile>", "roleArn": "<a role>", or "allowAmbientAwsCredentials": true.' };
      return { id: "model-key", status: "ok", summary: `Task steps will use amazon-bedrock ${setting.id} (the "model" setting in your config). Bedrock will sign with ${described.identity}.${described.priced ? "" : " Bedrock models are unpriced until you set prices, so a task with a budget is refused."} The sign-in itself is checked when rovara up starts.` };
    }
    return { id: "model-key", status: "ok", summary: `Task steps will use ${setting.provider} ${setting.id} (the "model" setting in your config). ${setting.provider} is a model-provider plug-in: its sign-in is checked when rovara up starts.` };
  }
  const picked = chooseLocalModel(found, setting);
  if (picked.ok) {
    const why = picked.source === "setting" ? "the \"model\" setting in your config" : `the default for ${found.length === 1 ? "the only key found" : "the first key found"}`;
    // Which source answered, for each provider (never the key).
    const sources = store === undefined ? [] : await modelKeySources(store, IMPLICIT_COMPANY_ID).catch(() => []);
    const named = found.map((provider) => { const entry = sources.find((candidate) => candidate.provider === provider); return entry === undefined ? provider : `${provider} (from ${sourceWords(entry.kind, plugin)})`; });
    return { id: "model-key", status: "ok", summary: `A model key is set for ${named.join(", ")}. Task steps will use ${picked.provider} ${picked.model} (${why}).` };
  }
  if (picked.problem !== "no-key") return { id: "model-key", status: "fail", summary: picked.summary, fix: picked.fix };
  const where = plugin === undefined ? `A key file goes at ${keyFile} as {"anthropic": "<your key>"} (or "openai", "openrouter"); then run \`chmod 600 ${keyFile}\`.` : `Your secrets plug-in "${plugin}" has no key for them.`;
  return { id: "model-key", status: "fail", summary: "No model key was found.", fix: `${picked.fix} ${where}` };
}

/**
 * "Find my sign-in" and "test my connection" are the code host's own (`resolveCredentials`, `checkAccess`; port lane L11, item C3). GitHub is the one code host a laptop can sign in to today; a
 * second one is another entry in this list. The quick check only looks for the sign-in; `--check` also tests it.
 */
/** The owner's `allowBroadTokenForWorker` setting, read without writing anything; a config that cannot be read means "not allowed" (the config check says why). */
async function broadTokenAllowed(services: UpCheckServices): Promise<boolean> {
  return (await readOwnerConfig(services))?.allowBroadTokenForWorker === true;
}

async function checkGithub(services: UpCheckServices): Promise<UpCheck> {
  // The same secrets store `rovara up` uses (a configured `secrets` plug-in, else Code's), unless a test hands a key store of its own.
  const secrets = services.keys === undefined ? await secretsFor(services) : undefined;
  if (secrets !== undefined && "error" in secrets) return { id: "github", status: "fail", summary: secrets.error, fix: "Fix the secrets plug-in entry in your config, or remove it to use the environment and keys.json." };
  const hosts = createLocalCodeHosts({
    allowBroadTokenForWorker: await broadTokenAllowed(services), stateDirectory: services.stateDirectory, environment: services.environment, fetch: services.fetch,
    ...(services.keys === undefined ? {} : { keyFile: services.keys }),
    ...(secrets === undefined || "error" in secrets ? {} : { secrets: secrets.store, ...(secrets.plugin === undefined ? {} : { secretsWords: `the "${secrets.plugin}" secrets plug-in` }) }),
    ...(services.gh === undefined ? {} : { gh: services.gh }),
  });
  const results: UpCheck[] = [];
  for (const host of hosts) {
    if (services.verifyGithub && host.checkAccess !== undefined) {
      const access = await host.checkAccess();
      results.push({ id: "github", status: access.status, summary: access.summary, ...(access.fix === undefined ? {} : { fix: access.fix }) });
    } else if (host.resolveCredentials !== undefined) {
      const found = await host.resolveCredentials();
      results.push(found.found ? { id: "github", status: "ok", summary: found.summary } : { id: "github", status: "fail", summary: found.summary, ...(found.fix === undefined ? {} : { fix: found.fix }) });
    }
  }
  return results[0] ?? { id: "github", status: "fail", summary: "No code host is set up.", fix: "Run `gh auth login`." };
}

async function checkPort(services: UpCheckServices): Promise<UpCheck> {
  if (services.port === undefined || services.port === 0) return { id: "port", status: "ok", summary: "A free port on 127.0.0.1 is picked at start." };
  const free = await (services.portIsFree ?? defaultPortIsFree)(services.port);
  return free
    ? { id: "port", status: "ok", summary: `Port ${services.port} is free on 127.0.0.1.` }
    : { id: "port", status: "fail", summary: `Port ${services.port} is already in use on 127.0.0.1.`, fix: "Stop whatever uses it, or leave out --port so a free port is picked." };
}

async function checkConfig(services: UpCheckServices): Promise<UpCheck> {
  const cwd = services.cwd ?? process.cwd();
  try {
    await assertStateDirectoryLocation(resolve(services.stateDirectory), { cwd, ...(services.home === undefined ? {} : { home: services.home }) });
    const state = await lstat(services.stateDirectory).catch(() => undefined);
    if (state !== undefined && process.platform !== "win32" && (state.mode & 0o077) !== 0) throw new Error(`${services.stateDirectory} must be private to you (chmod 700 ${services.stateDirectory})`);
    const location = resolveConfigLocation({ stateDirectory: services.stateDirectory, configPath: services.configPath, cwd });
    const file = await readOwnerFile(location.path, { private: false, label: "plug-in config" });
    if (file === undefined) return location.isDefault
      ? { id: "config", status: "ok", summary: `No config yet; ${location.path} is created on the first run with the built-in storage and queue.` }
      : { id: "config", status: "fail", summary: `The config ${location.path} does not exist.`, fix: "Check the --config path." };
    const config = parsePluginConfigText(file.text);
    return { id: "config", status: "ok", summary: `The config ${location.path} names ${config.plugins.filter((entry) => entry.enabled).length} plug-in(s).` };
  } catch (error) {
    return { id: "config", status: "fail", summary: error instanceof Error ? error.message : "the config could not be read", fix: "Keep the state folder and the config in your own ~/.rovara (mode 700 and 600), never inside a repository." };
  }
}

export async function runUpChecks(services: UpCheckServices): Promise<UpCheck[]> {
  try {
    const [docker, key, github, port, config] = await Promise.all([checkDocker(services), checkModelKey(services), checkGithub(services), checkPort(services), checkConfig(services)]);
    return [...docker, key, github, port, config];
  } finally {
    // A configured secrets plug-in was loaded for the check: let go of what it holds, or the command would not exit.
    const loaded = await secretsCache.get(services);
    if (loaded !== undefined && "dispose" in loaded) await loaded.dispose?.().catch(() => undefined);
  }
}

const LABEL: Record<UpCheckStatus, string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };

export function upChecksText(checks: readonly UpCheck[]): string {
  const lines = checks.map((check) => `${LABEL[check.status]}  ${check.id.padEnd(12)} ${check.summary}${check.fix === undefined ? "" : `\n      fix: ${check.fix}`}`);
  const failed = checks.filter((check) => check.status === "fail").length;
  lines.push("", failed === 0 ? "Everything `rovara up` needs is ready." : `${failed} ${failed === 1 ? "check" : "checks"} failed; fix ${failed === 1 ? "it" : "them"}, then run \`rovara up --check\` again.`);
  return `${lines.join("\n")}\n`;
}

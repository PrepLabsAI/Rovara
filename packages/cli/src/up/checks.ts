// Port lane L4: `rovara up --check`, the doctor for the local runtime. It checks what a first run needs (Docker and the worker image,
// a model key, GitHub access, the port) and, for each problem, says the fix in plain words. It starts nothing and writes nothing.
import { createServer } from "node:net";
import { join } from "node:path";
import { IMPLICIT_COMPANY_ID, type ModelKeyStore } from "@agentx/contracts";
import {
  CONFIG_FILE_NAME,
  KEYS_FILE_NAME,
  LOCAL_MODEL_PROVIDERS,
  LOCAL_WORKER_IMAGE_BUILD_HINT,
  LOCAL_HOST,
  createLocalModelKeyStore,
  parsePluginConfigText,
  readOwnerFile,
  resolveGithubAccess,
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

async function checkModelKey(services: UpCheckServices): Promise<UpCheck> {
  const keys = services.keys ?? createLocalModelKeyStore(services.stateDirectory, services.environment);
  const keyFile = join(services.stateDirectory, KEYS_FILE_NAME);
  try {
    const found = (await keys.providers(IMPLICIT_COMPANY_ID)).filter((provider) => (LOCAL_MODEL_PROVIDERS as readonly string[]).includes(provider));
    if (found.length > 0) return { id: "model-key", status: "ok", summary: `A model key is set for ${found.join(", ")}.` };
  } catch (error) {
    // The key store's messages never quote the file; they say what is wrong with it.
    return { id: "model-key", status: "fail", summary: error instanceof Error ? error.message : "the model key file could not be read", fix: `Fix the file's permissions with \`chmod 600 ${keyFile}\`, or keep the key in the ANTHROPIC_API_KEY environment variable instead.` };
  }
  return {
    id: "model-key",
    status: "fail",
    summary: "No model key was found.",
    fix: `Set ANTHROPIC_API_KEY (or OPENAI_API_KEY, OPENROUTER_API_KEY) in your environment, or put {"anthropic": "<your key>"} in ${keyFile} and run \`chmod 600 ${keyFile}\`.`,
  };
}

async function checkGithub(services: UpCheckServices): Promise<UpCheck> {
  const keys = services.keys ?? createLocalModelKeyStore(services.stateDirectory, services.environment);
  let access;
  try {
    access = await resolveGithubAccess({ companyId: IMPLICIT_COMPANY_ID, keys, environment: services.environment, ...(services.gh === undefined ? {} : { gh: services.gh }) });
  } catch (error) {
    return { id: "github", status: "fail", summary: error instanceof Error ? error.message : "the key file could not be read", fix: `Fix the file's permissions with \`chmod 600 ${join(services.stateDirectory, KEYS_FILE_NAME)}\`.` };
  }
  if (access === undefined) {
    return { id: "github", status: "fail", summary: "No GitHub access was found.", fix: 'Run `gh auth login` (https://cli.github.com), or put a personal access token in GH_TOKEN, or in keys.json as {"github": "<token>"}.' };
  }
  const where = access.source === "gh-cli" ? "the GitHub CLI" : access.source === "environment" ? "the environment" : "the key file";
  if (!services.verifyGithub) return { id: "github", status: "ok", summary: `A GitHub token is available from ${where}.` };
  try {
    const response = await services.fetch("https://api.github.com/user", {
      headers: { authorization: `Bearer ${access.token.reveal()}`, accept: "application/vnd.github+json", "user-agent": "rovara-up-check" },
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 401) {
      return { id: "github", status: "fail", summary: `GitHub rejected the token from ${where}.`, fix: access.source === "gh-cli" ? "Run `gh auth login` again." : "Make a new personal access token with the `repo` scope and replace the old one." };
    }
    if (!response.ok) return { id: "github", status: "warn", summary: `GitHub answered HTTP ${response.status} when the token was checked.`, fix: "Try again in a minute." };
    const body = (await response.json().catch(() => ({}))) as { login?: unknown };
    return { id: "github", status: "ok", summary: `GitHub access works${typeof body.login === "string" && /^[A-Za-z0-9-]{1,39}$/.test(body.login) ? ` as ${body.login}` : ""} (token from ${where}).` };
  } catch {
    return { id: "github", status: "warn", summary: "GitHub could not be reached to check the token.", fix: "Check your internet connection. Rovara needs GitHub only when a task starts." };
  }
}

async function checkPort(services: UpCheckServices): Promise<UpCheck> {
  if (services.port === undefined || services.port === 0) return { id: "port", status: "ok", summary: "A free port on 127.0.0.1 is picked at start." };
  const free = await (services.portIsFree ?? defaultPortIsFree)(services.port);
  return free
    ? { id: "port", status: "ok", summary: `Port ${services.port} is free on 127.0.0.1.` }
    : { id: "port", status: "fail", summary: `Port ${services.port} is already in use on 127.0.0.1.`, fix: "Stop whatever uses it, or leave out --port so a free port is picked." };
}

async function checkConfig(services: UpCheckServices): Promise<UpCheck> {
  const path = services.configPath ?? join(services.stateDirectory, CONFIG_FILE_NAME);
  try {
    const file = await readOwnerFile(path, { private: false, label: "plug-in config" });
    if (file === undefined) return services.configPath === undefined
      ? { id: "config", status: "ok", summary: `No config yet; ${path} is created on the first run with the built-in storage and queue.` }
      : { id: "config", status: "fail", summary: `The config ${path} does not exist.`, fix: "Check the --config path." };
    const config = parsePluginConfigText(file.text);
    return { id: "config", status: "ok", summary: `The config ${path} names ${config.plugins.filter((entry) => entry.enabled).length} plug-in(s).` };
  } catch (error) {
    return { id: "config", status: "fail", summary: error instanceof Error ? error.message : "the config could not be read", fix: `Edit ${path}; it must belong to you and not be writable by others (chmod 600).` };
  }
}

export async function runUpChecks(services: UpCheckServices): Promise<UpCheck[]> {
  const [docker, key, github, port, config] = await Promise.all([checkDocker(services), checkModelKey(services), checkGithub(services), checkPort(services), checkConfig(services)]);
  return [...docker, key, github, port, config];
}

const LABEL: Record<UpCheckStatus, string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };

export function upChecksText(checks: readonly UpCheck[]): string {
  const lines = checks.map((check) => `${LABEL[check.status]}  ${check.id.padEnd(12)} ${check.summary}${check.fix === undefined ? "" : `\n      fix: ${check.fix}`}`);
  const failed = checks.filter((check) => check.status === "fail").length;
  lines.push("", failed === 0 ? "Everything `rovara up` needs is ready." : `${failed} ${failed === 1 ? "check" : "checks"} failed; fix ${failed === 1 ? "it" : "them"}, then run \`rovara up --check\` again.`);
  return `${lines.join("\n")}\n`;
}

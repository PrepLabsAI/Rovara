// L4-E12 (E2, DEC 254zzz55 N6): the FREE dry run of an eval, at setup. The eval command runs ONCE on main in the sealed eval box (eval-bridged-exec.ts `dryRun`): the model helper serves scripted replies and nothing is bridged, so no
// model call can be made and none can cost money; the box has no database, no stand-in and no secret, so whatever the eval needs shows up as a refused connection, a failed name lookup or a missing variable. This module reads
// what the run left behind and makes the dependency list (contracts `EvalDependencyList`): databases by port, outside hosts by name (with the port when it was seen), variables by name. Three sources, all fixed-shape:
//   1. the sealed name server's record: every UNKNOWN name the eval asked for (the sinkhole answered it and counted it);
//   2. the eval's own error lines (the closed list of shapes TH1 reads: `findAllReaches`), for the databases and the ports;
//   3. a missing variable (`KeyError: 'DATABASE_URL'` after `os.environ`, "Missing required environment variable X", ...).
// Nothing of the output is kept: the list holds ports, host names that passed the strict shape and variable names in upper-case word shape, never a line, a value, a path or a credential. A dry run never throws: a run that could not
// start gives no list (the caller says nothing rather than "nothing found").
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVAL_BLOCKED_HOST, EVAL_DEPENDENCY_DATABASES_MAX, EVAL_DEPENDENCY_ENV_NAME, EVAL_DEPENDENCY_ENV_VARS_MAX, EVAL_DEPENDENCY_HOSTS_MAX, EVAL_PINNED_IMAGE, EvalDependencyListSchema, type EvalDependencyList, type SetupEvalDiscoveryReport } from "@agentx/contracts";
import type { DockerCli } from "../swebench/containers.js";
import { createFreshEvalSandbox, type EvalDryRunObservation, type FreshEvalSandbox, type FreshEvalSandboxConfig } from "./eval-bridged-exec.js";
import { diagnoseEvalFailure, findAllReaches, isModelRoute } from "./eval-run-diagnostic.js";
import { EVAL_WORKER_IMAGE_VARIABLE } from "./eval-wiring.js";

/** The longest the free dry run may take, in milliseconds: a few machine minutes inside the setup run. */
export const EVAL_DRY_RUN_MAX_MS = 10 * 60_000;

/** Ports of the common databases and caches, and the engine each one belongs to. */
const ENGINE_OF_PORT: ReadonlyMap<number, EvalDependencyList["databases"][number]["engine"]> = new Map([
  [5432, "postgres"], [5433, "postgres"], [5439, "postgres"], [3306, "mysql"], [3307, "mysql"], [6379, "redis"], [27017, "mongodb"],
]);

/** Variables the sealed box sets itself: never "missing". */
const BOX_VARIABLES: ReadonlySet<string> = new Set(["HOME", "PATH", "PYTHONUSERBASE", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL", "GOOGLE_VERTEX_BASE_URL", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GCE_METADATA_HOST", "GCE_METADATA_IP", "ROVARA_EVAL_SIDE", "ROVARA_EVAL_RUNS", "ROVARA_EVAL_IDS", "USER", "PWD", "SHELL", "TMPDIR", "LANG"]);

const NAME = "([A-Z][A-Z0-9_]{1,63})";
/**
 * The closed list of shapes that name a variable the eval read and did not find. Each captures ONLY the name. The Python `KeyError` shape is read only beside an `environ` lookup in the same traceback (a `KeyError` on some
 * other dictionary is not a variable).
 */
const ENV_PATTERNS: readonly RegExp[] = [
  new RegExp(`environ(?:\\.get)?\\[['"]${NAME}['"]\\][^\\n]*\\n(?:[^\\n]*\\n){0,3}?KeyError: ['"]\\1['"]`, "gu"),
  new RegExp(`(?:Missing|Required|Undefined|Unset)(?: required)?(?: environment)? (?:variable|env var|env variable)[:=]? ['"\`]?${NAME}`, "giu"),
  new RegExp(`(?:environment )?variable ['"\`]?${NAME}['"\`]? (?:is |was )?(?:not set|not defined|missing|undefined|required|not found)`, "giu"),
  new RegExp(`${NAME} (?:environment variable )?(?:is |was )?(?:not set|not defined|is required|must be set|is missing)`, "gu"),
  new RegExp(`(?:Set|Please set|You must set) the ${NAME} (?:environment )?variable`, "gu"),
  new RegExp(`process\\.env\\.${NAME} (?:is|was) undefined`, "gu"),
];

/** Every variable name the output says was missing, in the order it says them, each once. Names only; never a value. */
export function findMissingEnvVars(text: string, secrets: readonly string[] = []): string[] {
  const found: Array<{ at: number; name: string }> = [];
  try {
    for (const pattern of ENV_PATTERNS) {
      pattern.lastIndex = 0;
      for (const m of text.matchAll(pattern)) {
        const raw = m[1];
        // The pattern is case-insensitive in places; the NAME itself must still be upper-case words.
        if (raw === undefined || !EVAL_DEPENDENCY_ENV_NAME.test(raw) || BOX_VARIABLES.has(raw) || /^(?:ROVARA|AGENTX)_/u.test(raw)) continue;
        if (secrets.some(secret => secret.length >= 8 && raw.includes(secret))) continue;
        found.push({ at: m.index ?? 0, name: raw });
        if (found.length >= 100) break;
      }
    }
  } catch { return []; }
  found.sort((a, b) => a.at - b.at);
  return [...new Set(found.map(item => item.name))].slice(0, EVAL_DEPENDENCY_ENV_VARS_MAX);
}

/** The ports a connection to the sinkhole asked for (the eval resolved an unknown name, got the sinkhole's address and was refused there). */
function sinkholePorts(text: string, sinkholeIp: string): number[] {
  if (typeof sinkholeIp !== "string" || !/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(sinkholeIp)) return [];
  const ip = sinkholeIp.replace(/\./gu, "\\.");
  const ports = new Set<number>();
  for (const pattern of [new RegExp(`${ip}\\]?:(\\d{1,5})\\b`, "gu"), new RegExp(`${ip}'?\\)?,\\s*(?:port\\s*)?(\\d{1,5})\\b`, "gu")]) {
    for (const m of text.matchAll(pattern)) {
      const port = Number(m[1]);
      if (Number.isInteger(port) && port >= 1 && port <= 65_535) ports.add(port);
    }
  }
  return [...ports];
}

/** The dependency list a dry run's observation shows. Pure; never throws (an unreadable observation gives an empty list). */
export function dependencyListFrom(observation: EvalDryRunObservation, options: { servicesOff?: boolean } = {}): EvalDependencyList {
  const output = typeof observation.output === "string" ? observation.output : "";
  const route = observation.modelRoute;
  const secrets: readonly string[] = Array.isArray(observation.secrets) ? (observation.secrets as readonly string[]) : [];
  const reaches = findAllReaches(output, secrets, route);
  const databases = reaches.databases.slice(0, EVAL_DEPENDENCY_DATABASES_MAX).map(database => ({ ...(database.port === undefined ? {} : { port: database.port }), engine: (database.port === undefined ? undefined : ENGINE_OF_PORT.get(database.port)) ?? "other" as const }));
  const own = new Set(reaches.databaseHosts);
  const hosts: Array<{ name: string; port?: number }> = reaches.hosts.map(host => ({ name: host.name, ...(host.port === undefined ? {} : { port: host.port }) }));
  // The name server's record: an unknown name that is not a database's own host, not this machine's and not the model's is an outside name the eval looked up.
  for (const entry of observation.dns?.unknown ?? []) {
    const name = typeof entry?.name === "string" ? entry.name.toLowerCase().replace(/\.$/u, "") : "";
    if (!EVAL_BLOCKED_HOST.test(name) || own.has(name) || isModelRoute(name, route) || name === "localhost" || name.endsWith(".localhost") || secrets.some(secret => secret.length >= 8 && name.includes(secret.toLowerCase()))) continue;
    if (!hosts.some(host => host.name === name)) hosts.push({ name });
  }
  // The port of a name the eval looked up and was refused at: when exactly one name has no port and exactly one port was refused at the sinkhole, they belong together (more than one of either is ambiguous and is left unnamed).
  const refused = sinkholePorts(output, observation.sinkholeIp).filter(port => !ENGINE_OF_PORT.has(port));
  const unported = hosts.filter(host => host.port === undefined);
  if (unported.length === 1 && refused.length === 1) unported[0]!.port = refused[0]!;
  const diagnostic = diagnoseEvalFailure({ phase: "run", exitCode: observation.code, timedOut: observation.timedOut, output, secrets, modelRoute: route });
  const stoppedEarly = diagnostic.code === "missing_package" || diagnostic.code === "missing_file" || diagnostic.code === "command_not_found" || diagnostic.code === "run_timed_out" ? diagnostic.code : undefined;
  const candidate = {
    version: 1 as const, databases, hosts: hosts.slice(0, EVAL_DEPENDENCY_HOSTS_MAX), envVars: findMissingEnvVars(output, secrets), modelCalls: 0 as const,
    ended: observation.timedOut ? "timed_out" as const : observation.code === 0 ? "finished" as const : "failed" as const,
    ...(stoppedEarly === undefined ? {} : { stoppedEarly }), ...(options.servicesOff === true ? { servicesOff: true } : {}),
  };
  const checked = EvalDependencyListSchema.safeParse(candidate);
  return checked.success ? checked.data : { version: 1, databases: [], hosts: [], envVars: [], modelCalls: 0, ended: candidate.ended };
}

export interface EvalDryRunInput {
  /** The sealed eval sandbox, configured with main as its base commit and the eval's confirmed-or-drafted command. Without a `dryRun` it gives nothing. */
  readonly sandbox: Pick<FreshEvalSandbox, "available" | "dryRun">;
  /** The eval's question ids (the same ones the command is told). */
  readonly ids: readonly string[];
  readonly signal: AbortSignal;
  /** The install has no test services (the list says so). */
  readonly servicesOff?: boolean;
}

/**
 * Runs the free dry run and returns the dependency list, or undefined when the run could not happen (no fresh sandbox, a start that failed, a stop): the caller then says nothing, never "found nothing". Never throws, and
 * never calls a model: the sandbox's dry run has no bridge.
 */
export async function runEvalDryRun(input: EvalDryRunInput): Promise<EvalDependencyList | undefined> {
  try {
    if (typeof input.sandbox?.dryRun !== "function" || input.sandbox.available() !== true || input.signal.aborted) return undefined;
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    input.signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, EVAL_DRY_RUN_MAX_MS);
    try {
      const observation = await input.sandbox.dryRun({ ids: input.ids, signal: controller.signal });
      return dependencyListFrom(observation, { ...(input.servicesOff === true ? { servicesOff: true } : {}) });
    } finally { clearTimeout(timer); input.signal.removeEventListener("abort", stop); }
  } catch { return undefined; }
}

// ---- the setup run's own dry run

export interface SetupDryRunHost {
  readonly docker: DockerCli;
  readonly environment: NodeJS.ProcessEnv;
  /** The setup run's operation id (only ever hashed into the round network's name). */
  readonly taskId: string;
  /** `setupWorkspaceKey(root)`. */
  readonly workspaceKey: () => Promise<string>;
  /** The run's repositories: each name and its checkout on the worker. */
  readonly repositories: ReadonlyArray<{ readonly name: string; readonly directory: string }>;
  /** The commits the broker recorded for those repositories (the invocation's `setupAgent.commits`): main. */
  readonly commits: ReadonlyArray<{ readonly repository: string; readonly commit: string }> | undefined;
  /** Whether this worker offers test services (false: the list says so). */
  readonly servicesOff: boolean;
  /** Test seam; default `createFreshEvalSandbox`. */
  readonly make?: (config: FreshEvalSandboxConfig) => FreshEvalSandbox;
  /** Test seam: where a run's scratch folders go. Default: the machine's temp folder. */
  readonly scratchParent?: string;
  readonly signal?: AbortSignal;
}

const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/**
 * The setup run's free dry run: for each suite of the discovery report (the eval the setup agent drafted), one run of the suite's own command on main in the sealed box with scripted model replies, then the union of what they
 * reached. Returns undefined when nothing could run (no pinned image, no fresh sandbox, a suite that names no repository the run read). Total time is bounded by `EVAL_DRY_RUN_MAX_MS`; a suite after the deadline is skipped. Never throws and
 * never spends: the sandbox's dry run has no bridge, no token and no gateway.
 */
export async function runSetupEvalDryRun(host: SetupDryRunHost, report: SetupEvalDiscoveryReport): Promise<EvalDependencyList | undefined> {
  try {
    const image = host.environment[EVAL_WORKER_IMAGE_VARIABLE]?.trim();
    if (image === undefined || image === "" || !EVAL_PINNED_IMAGE.test(image)) return undefined;
    const signal = host.signal ?? new AbortController().signal;
    const workspace = await host.workspaceKey();
    const deadline = Date.now() + EVAL_DRY_RUN_MAX_MS;
    const lists: EvalDependencyList[] = [];
    const scratchParent = host.scratchParent ?? tmpdir();
    for (const suite of report.suites) {
      if (Date.now() >= deadline || signal.aborted) break;
      const repository = suite.repository === undefined ? (host.repositories.length === 1 ? host.repositories[0] : undefined) : host.repositories.find((candidate) => candidate.name === suite.repository);
      const commit = (suite.repository === undefined ? (host.commits?.length === 1 ? host.commits[0] : undefined) : host.commits?.find((candidate) => candidate.repository === suite.repository))?.commit;
      if (repository === undefined || commit === undefined || !COMMIT.test(commit)) continue;
      const scratch = await mkdtemp(join(scratchParent, "eval-dry-"));
      try {
        const config: FreshEvalSandboxConfig = {
          docker: host.docker, image, workspace, taskId: host.taskId, roundBudgetMs: Math.max(1, deadline - Date.now()),
          repository: { directory: repository.directory, baseCommit: commit, candidateCommit: commit },
          command: suite.command, report: suite.report, rowId: suite.catalogRowId, scratchDir: scratch, workingSandbox: null, environment: host.environment, sealedDns: true,
        };
        const sandbox = (host.make ?? createFreshEvalSandbox)(config);
        const list = await runEvalDryRun({ sandbox, ids: suite.questions.map((question) => question.id), signal, ...(host.servicesOff ? { servicesOff: true } : {}) });
        if (list !== undefined) lists.push(list);
      } finally { await rm(scratch, { recursive: true, force: true }).catch(() => undefined); }
    }
    return lists.length === 0 ? undefined : mergeDependencyLists(lists);
  } catch { return undefined; }
}

/** The union of several lists, each name once, within the contract's limits. */
export function mergeDependencyLists(lists: readonly EvalDependencyList[]): EvalDependencyList {
  const databases = new Map<string, EvalDependencyList["databases"][number]>();
  const hosts = new Map<string, EvalDependencyList["hosts"][number]>();
  const envVars = new Set<string>();
  for (const list of lists) {
    for (const database of list.databases) databases.set(String(database.port ?? "none"), database);
    for (const host of list.hosts) if (!hosts.has(host.name) || hosts.get(host.name)?.port === undefined) hosts.set(host.name, host);
    for (const name of list.envVars) envVars.add(name);
  }
  const stoppedEarly = lists.find((list) => list.stoppedEarly !== undefined)?.stoppedEarly;
  const ended = lists.some((list) => list.ended === "timed_out") ? "timed_out" as const : lists.some((list) => list.ended === "failed") ? "failed" as const : "finished" as const;
  return EvalDependencyListSchema.parse({
    version: 1, databases: [...databases.values()].slice(0, EVAL_DEPENDENCY_DATABASES_MAX), hosts: [...hosts.values()].slice(0, EVAL_DEPENDENCY_HOSTS_MAX), envVars: [...envVars].slice(0, EVAL_DEPENDENCY_ENV_VARS_MAX), modelCalls: 0, ended,
    ...(stoppedEarly === undefined ? {} : { stoppedEarly }), ...(lists.some((list) => list.servicesOff === true) ? { servicesOff: true } : {}),
  });
}

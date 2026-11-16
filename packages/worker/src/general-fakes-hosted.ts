// General fakes, slice 2b (owner decision 252a; plan briefs/general-fakes-plan.md): the HOSTED home of a fake. When checks run in a task sandbox (a container), the worker's loopback server cannot answer them, so each check
// round gets a fake-helper CONTAINER from the worker's own image on a run network of its own (run-network.ts: an internal `rvi` bridge the boot firewall already walls), with the working sandbox joined to that network
// for the round. DEPLOYMENT CODE: nothing here has been run against Docker by its author (no Docker is started on a build machine); the first real proof is `tests/linux/general-fakes-helper.test.ts` in CI's `linux-runtime`
// job, and the worker offers the helper only when its operator turns it on (`AGENTX_GENERAL_FAKES_HELPER=1`, a run directory, the worker's own pinned image and the boot walls) on top of the project's own setting (off by default). The model helper's launcher (model-helper-launch.ts,
// model-helper-network.ts) is the pattern; this module keeps its rules.
//
// What the helper may and may not do (each rule is checked when the arguments are built AND by `generalFakesArgProblems`, which reads them back against an allow-list):
//   - ONE network, the round's own (`rvi` bridge, `--internal`: no route out, other `rvi` bridges and the host are dropped by the boot walls). No egress network, no published port, no `--add-host`, no `--env`, no DNS upstream
//     (`--dns 127.0.0.1`: the embedded resolver has nothing to forward to), no `--privileged`, no capability (`--cap-drop ALL`), `no-new-privileges`, a non-root user, a READ-ONLY root, no Docker socket.
//   - ONE bind mount, read-only: the run's directory, holding only the set file (the fakes built from the customer's descriptions, bound to this company and task and pinned by a digest). ONE tmpfs for its own summary.
//   - bounded: memory (swap equal), CPUs, pids, a 1 MiB summary tmpfs, no log driver; the program itself limits a request's body, the connections and every counter.
//   - it listens on its own address (.16 of the run's slot) and serves ONE sandbox address (.3, the working sandbox); a connection from any other address is closed unread and counted.
//   - ALL four labels of the run network are on the container (the sweep and `stop()` find it only by them; run-network.ts rule 1).
// What reaches a docker argument: numbers, ids matched against UUID shapes, hashes and the pinned image. No repository string is ever one: the customer's descriptions are read by the WORKER (general-fakes-round.ts) and only
// reach the helper as the serialized set file, which the helper's program judges again.
// Company and task binding: the set, the helper's arguments and the summary all carry the workspace (the company) and the operation (the task); a summary for any other pair, or for another digest, is not believed.
// Cleanup: `stop()` takes the sandbox off the network, removes the helper and the network and deletes the run's files, on every path of a round (`endRound` always runs). A killed worker leaves labelled objects only: the next
// network this module (or any run network) allocates sweeps the due ones, and the worker-start sweep removes all of this workspace's.
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import {
  GENERAL_FAKES_HELPER_PORT, GENERAL_FAKES_LEDGER_DIR, GENERAL_FAKES_MAX_SERVICES, GENERAL_FAKES_RUN_DIR, GENERAL_FAKES_SET_PATH, GENERAL_FAKES_SUMMARY_MAX_BYTES, agentXError, buildGeneralFakesSetBytes,
  parseGeneralFakesSummaryText, type GeneralFakeServiceFake, type TrustedGeneralFakesSummary,
} from "@agentx/contracts";
import { DOCKER_CALL_TIMEOUT_MS, setupWorkspaceKey } from "./setup-network.js";
import { RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_LABEL, RUN_NETWORK_WORKSPACE_LABEL, startServicesNetwork, type ServicesNetwork } from "./run-network.js";
import { TEST_SERVICES_BOOT_FACTS_ENVIRONMENT, parseBootFacts } from "./test-services-report.js";
import { TEST_SERVICES_RUN_DIR_ENVIRONMENT, notPulledRepositories } from "./test-services-run.js";
import type { HostedFakeCalls, HostedFakesLauncher, StartedHostedFakes } from "./general-fakes-round.js";
import type { DockerCli } from "./swebench/containers.js";

/** The operator's switch for the hosted helper. Absent or anything but "1": off, and a task sandbox runs checks exactly as without general fakes. */
export const GENERAL_FAKES_HELPER_ENVIRONMENT = "AGENTX_GENERAL_FAKES_HELPER";
/** The worker's own image, pinned by digest (the same variable the sealed round's resolver guard reads). */
export const GENERAL_FAKES_IMAGE_ENVIRONMENT = "AGENTX_WORKER_IMAGE";
/** Where the worker image keeps the helper's program (environments/base/Dockerfile builds the worker's dist). */
export const GENERAL_FAKES_HELPER_ENTRY = "/opt/agentx/packages/worker/dist/general-fakes-helper.js";
/** The one sentence every start failure gives: Docker's own words are never repeated. */
export const GENERAL_FAKES_HOSTED_FAILURE_SENTENCE = "AgentX could not start the fake helper for this check round";
const NODE = "/usr/local/bin/node";
const HELPER_USER = "1000:1000";
/** The helper's only DNS server is its own loopback, where nothing listens. */
const NO_UPSTREAM_DNS = "127.0.0.1";
const MEMORY = "192m";
const CPUS = "0.5";
const PIDS = "64";
const LEDGER_TMPFS = `${GENERAL_FAKES_LEDGER_DIR}:rw,noexec,nosuid,nodev,size=1m,uid=1000,gid=1000`;
const START_TIMEOUT_MS = 60_000;
const SUMMARY_TIMEOUT_MS = 5_000;
const READY_ATTEMPTS = 20;
const READY_DELAY_MS = 250;
const NETWORK_NAME = /^rovara-svc-[0-9a-f]{12}$/u;
const IMAGE_REFERENCE = /^(?:[a-z0-9][a-z0-9._/:-]{0,199}@sha256:[a-f0-9]{64}|sha256:[a-f0-9]{64})$/u;
const RUN_DIR_PATH = /^\/[A-Za-z0-9_./-]{1,500}\/fakes$/u;
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const WORKSPACE_KEY = /^[0-9a-f]{16}$/u;
const WORD = /^[\x21-\x7e]{1,256}$/u;
const LABEL_KEYS: readonly string[] = [RUN_NETWORK_LABEL, RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_WORKSPACE_LABEL];

// ---- the gate

export type GeneralFakesHostedOffer =
  | { readonly offered: true; readonly image: string; readonly runDirectoryParent: string }
  | { readonly offered: false; readonly reason: "not_enabled" | "no_image" | "no_run_dir" | "no_boot_facts" | "boot_facts_unreadable" | "walls_missing" | "ipv6_drops_missing" | "worker_withheld" };

/**
 * Whether this worker offers the hosted fake helper: the operator turned it on, the worker's own image is known and pinned, and the boot facts (root's) say the run-network walls AND the IPv6 drops are in place (the same
 * gate as the model helper's). Fail closed on anything else: nothing is started and the task's checks run exactly as without general fakes.
 */
export function generalFakesHostedOffer(environment: NodeJS.ProcessEnv = process.env): GeneralFakesHostedOffer {
  if (environment[GENERAL_FAKES_HELPER_ENVIRONMENT] !== "1") return { offered: false, reason: "not_enabled" };
  const image = environment[GENERAL_FAKES_IMAGE_ENVIRONMENT];
  if (typeof image !== "string" || !IMAGE_REFERENCE.test(image)) return { offered: false, reason: "no_image" };
  // The run directory parent is the one the test services use (a folder on a tmpfs the host's Docker sees at the same path); the helper's one file goes in a folder of its own under it.
  const runDirectoryParent = environment[TEST_SERVICES_RUN_DIR_ENVIRONMENT];
  if (typeof runDirectoryParent !== "string" || !/^\/[A-Za-z0-9_./-]{1,400}$/u.test(runDirectoryParent) || runDirectoryParent.split("/").includes("..")) return { offered: false, reason: "no_run_dir" };
  // The same gate as the model helper's (read here, not imported: that module is the model helper's own): the withheld note, then root's boot facts.
  if (notPulledRepositories(environment) === "all") return { offered: false, reason: "worker_withheld" };
  const facts = parseBootFacts(environment[TEST_SERVICES_BOOT_FACTS_ENVIRONMENT]);
  if (facts === "absent") return { offered: false, reason: "no_boot_facts" };
  if (facts === "unreadable") return { offered: false, reason: "boot_facts_unreadable" };
  if (!facts.runWalls) return { offered: false, reason: "walls_missing" };
  if (!facts.ipv6Drops) return { offered: false, reason: "ipv6_drops_missing" };
  return { offered: true, image, runDirectoryParent };
}

// ---- the launch arguments

export type GeneralFakesLaunchNetwork = Pick<ServicesNetwork, "name" | "slot" | "workingSandboxIp" | "labelArgs" | "helperIp">;

export interface GeneralFakesLaunchInput {
  net: GeneralFakesLaunchNetwork;
  /** The worker's own image (it carries `dist/general-fakes-helper.js`), pinned by digest. */
  image: string;
  /** The worker's directory for the helper's one file: an absolute plain path whose last segment is `fakes`. */
  runDir: string;
  /** The set's digest, and the company and task it is bound to. */
  digest: string;
  workspaceId: string;
  operationId: string;
}

/** The helper container's name: the network's own name and `-fakes`. */
export const generalFakesContainerName = (net: Pick<ServicesNetwork, "name">): string => `${net.name}-fakes`;

function assertInput(input: GeneralFakesLaunchInput): void {
  const bad = (what: string): never => { throw agentXError("CONFIG_INVALID", `not ${what} for the fake helper`); };
  if (!NETWORK_NAME.test(input.net.name)) bad("a run network");
  if (!IMAGE_REFERENCE.test(input.image)) bad("a pinned image");
  if (!RUN_DIR_PATH.test(input.runDir) || input.runDir.split("/").includes("..")) bad("a run directory");
  if (!DIGEST.test(input.digest)) bad("a digest");
  if (!UUID.test(input.workspaceId) || !UUID.test(input.operationId)) bad("a company and task");
}

/** The `docker run` arguments of the fake helper on the run's network. Throws (a fixed sentence) for an input that is not plain, or arguments that read back unsound. */
export function generalFakesRunArgs(input: GeneralFakesLaunchInput): string[] {
  assertInput(input);
  const { net } = input;
  const helperIp = net.helperIp(0);
  const args = [
    "run", "--detach", "--pull=never", "--name", generalFakesContainerName(net), "--stop-timeout", "1", ...net.labelArgs(),
    "--network", net.name, "--ip", helperIp, "--dns", NO_UPSTREAM_DNS,
    "--user", HELPER_USER, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
    "--memory", MEMORY, "--memory-swap", MEMORY, "--cpus", CPUS, "--pids-limit", PIDS, "--log-driver", "none",
    "--volume", `${input.runDir}:${GENERAL_FAKES_RUN_DIR}:ro`,
    "--tmpfs", LEDGER_TMPFS,
    "--entrypoint", NODE,
    input.image, GENERAL_FAKES_HELPER_ENTRY,
    "--listen", helperIp, "--caller", net.workingSandboxIp, "--digest", input.digest, "--workspace", input.workspaceId, "--operation", input.operationId,
  ];
  const problems = generalFakesArgProblems(args, net, { digest: input.digest, workspaceId: input.workspaceId, operationId: input.operationId, runDir: input.runDir });
  if (problems.length > 0) throw agentXError("CONFIG_INVALID", `the fake helper's arguments are unsound: ${problems.join("; ")}`);
  return args;
}

const VALUE_FLAGS: ReadonlySet<string> = new Set(["--name", "--label", "--network", "--ip", "--dns", "--user", "--cap-drop", "--security-opt", "--memory", "--memory-swap", "--cpus", "--pids-limit", "--log-driver", "--volume", "--tmpfs", "--entrypoint", "--stop-timeout"]);
const SINGLE_FLAGS: ReadonlySet<string> = new Set(["--detach", "--pull=never", "--read-only"]);

function valuesOf(args: readonly string[], name: string): string[] {
  const values: string[] = [];
  args.forEach((arg, at) => { if (arg === name && at + 1 < args.length) values.push(args[at + 1]!); });
  return values;
}

/**
 * Reads a fake helper's `docker run` arguments back and names every way they are unsound, in fixed words (no value is repeated). An empty list is a sound set. Allow-list: a flag that is not one the helper takes is a problem,
 * so a new way to reach a network, the host, a capability, a second mount or an environment variable cannot be added by accident.
 */
export function generalFakesArgProblems(args: readonly string[], net: GeneralFakesLaunchNetwork, expected: { digest: string; workspaceId: string; operationId: string; runDir?: string }): string[] {
  const problems: string[] = [];
  const flags = new Map<string, string[]>();
  let at = 0;
  if (args[at] !== "run") problems.push("it is not a docker run");
  else at += 1;
  let image: string | undefined;
  while (at < args.length) {
    const token = args[at]!;
    if (SINGLE_FLAGS.has(token)) { flags.set(token, [...(flags.get(token) ?? []), ""]); at += 1; continue; }
    if (VALUE_FLAGS.has(token)) {
      const value = args[at + 1];
      if (value === undefined || value.startsWith("-")) { problems.push("a flag has no value"); at += 1; continue; }
      flags.set(token, [...(flags.get(token) ?? []), value]);
      at += 2;
      continue;
    }
    if (token.startsWith("-")) { problems.push("a flag the fake helper does not take"); at += 1; continue; }
    image = token;
    at += 1;
    break;
  }
  const only = (flag: string, wanted: string): boolean => (flags.get(flag) ?? []).length === 1 && flags.get(flag)![0] === wanted;
  const helperIp = net.helperIp(0);
  if (image === undefined || !IMAGE_REFERENCE.test(image)) problems.push("there is no pinned image");
  if (!only("--network", net.name)) problems.push("the helper must be on the run network and on no other network");
  if (!only("--dns", NO_UPSTREAM_DNS)) problems.push("the helper's only DNS server must be its own loopback (no upstream)");
  if (!only("--ip", helperIp)) problems.push("the helper must have the run's helper address");
  if (!only("--cap-drop", "ALL")) problems.push("the helper must drop every capability");
  if (!flags.has("--read-only")) problems.push("the helper's root must be read-only");
  if (!only("--security-opt", "no-new-privileges")) problems.push("the helper must have no-new-privileges and no other security option");
  if (!only("--user", HELPER_USER)) problems.push("the helper must run as the non-root user");
  if (!only("--entrypoint", NODE)) problems.push("the helper must start the worker's node");
  if (!only("--tmpfs", LEDGER_TMPFS)) problems.push("the helper has one tmpfs, the summary's");
  if (!only("--memory", MEMORY) || !only("--memory-swap", MEMORY)) problems.push("the helper's memory must be bounded, with swap equal");
  if (!only("--cpus", CPUS)) problems.push("the helper's cpus must be bounded");
  if (!only("--pids-limit", PIDS)) problems.push("the helper's processes must be bounded");
  if (!only("--log-driver", "none")) problems.push("the helper keeps no log");
  const volumes = flags.get("--volume") ?? [];
  if (volumes.length !== 1 || !volumes[0]!.endsWith(`:${GENERAL_FAKES_RUN_DIR}:ro`) || (expected.runDir !== undefined && volumes[0] !== `${expected.runDir}:${GENERAL_FAKES_RUN_DIR}:ro`)) problems.push("the helper has exactly one mount, the run directory, mounted read-only");
  if (!only("--name", generalFakesContainerName(net))) problems.push("the helper must carry the run network's own container name");
  const labelKeys = (flags.get("--label") ?? []).map((label) => label.split("=")[0]!);
  if (LABEL_KEYS.some((key) => labelKeys.filter((candidate) => candidate === key).length !== 1) || labelKeys.length !== LABEL_KEYS.length) problems.push("the helper must carry all four labels of the run network, once each");
  const rest = image === undefined ? [] : args.slice(at);
  if (rest[0] !== GENERAL_FAKES_HELPER_ENTRY) problems.push("the helper must run the fake helper program");
  const program = rest.slice(1);
  const one = (name: string): string | undefined => { const values = valuesOf(program, name); return values.length === 1 ? values[0] : undefined; };
  if (one("--listen") !== helperIp || isIP(helperIp) !== 4) problems.push("the program must listen on the helper's own address and nothing else");
  if (one("--caller") !== net.workingSandboxIp) problems.push("the program must serve exactly the working sandbox's address");
  if (one("--digest") !== expected.digest) problems.push("the program must be pinned to the set's digest");
  if (one("--workspace") !== expected.workspaceId || one("--operation") !== expected.operationId) problems.push("the program must be bound to this company and task");
  const names = program.filter((arg) => arg.startsWith("--"));
  if (names.length !== 5 || program.length !== 10) problems.push("the program takes exactly its five flags");
  if (!program.every((arg) => WORD.test(arg))) problems.push("a program argument is not a plain word");
  return problems;
}

// ---- the run files

export interface GeneralFakesRunFiles { readonly dir: string; readonly runDir: string; readonly digest: string }

/**
 * Writes the set into a worker-owned directory (`<scratch>/gf-XXXX/fakes`, the parent 0700) that the launch mounts read-only into the helper. The folder `fakes` is 0755 and the file 0644 so the helper's user (uid 1000) can read
 * them whoever owns them; the set holds only the synthetic answers and templates built from the customer's description, never a secret, and the sandbox never sees this directory. Undefined for fakes that cannot be stored.
 */
export async function writeGeneralFakesRunFiles(input: { parent: string; workspaceId: string; operationId: string; fakes: readonly GeneralFakeServiceFake[] }): Promise<GeneralFakesRunFiles | undefined> {
  const set = buildGeneralFakesSetBytes({ workspaceId: input.workspaceId, operationId: input.operationId, fakes: input.fakes });
  if (set === undefined) return undefined;
  await mkdir(input.parent, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(input.parent, "gf-"));
  try {
    await chmod(dir, 0o700);
    const runDir = join(dir, "fakes");
    await mkdir(runDir, { mode: 0o755 });
    await chmod(runDir, 0o755);
    const file = join(runDir, GENERAL_FAKES_SET_PATH.slice(GENERAL_FAKES_RUN_DIR.length + 1));
    await writeFile(file, set.bytes, { mode: 0o644 });
    await chmod(file, 0o644);
    return { dir, runDir, digest: set.digest };
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

// ---- the start

type Call = (args: string[], timeoutMs?: number) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
const dockerCall = (docker: DockerCli): Call => (args, timeoutMs = DOCKER_CALL_TIMEOUT_MS) => docker.run(args, { timeoutMs }).catch((error: unknown) => ({ exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));

/** The networks of a container with the address on each, from one `docker inspect`; undefined when the look failed or could not be read (a look that cannot be read is never "fine"). */
function parseNetworks(text: string | undefined): Map<string, string> | undefined {
  if (text === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const found = new Map<string, string>();
  for (const [name, entry] of Object.entries(parsed)) {
    const address = typeof entry === "object" && entry !== null ? (entry as { IPAddress?: unknown }).IPAddress : undefined;
    found.set(name, typeof address === "string" ? address : "");
  }
  return found;
}
async function networksOf(call: Call, container: string): Promise<Map<string, string> | undefined> {
  const inspected = await call(["inspect", "--format", "{{json .NetworkSettings.Networks}}", container]);
  return parseNetworks(inspected.exitCode === 0 ? inspected.stdout.trim() : undefined);
}

export interface StartGeneralFakesHelperInput {
  docker: DockerCli;
  /** The worker's own image, pinned (`generalFakesHostedOffer(...).image`). */
  image: string;
  /** `setupWorkspaceKey(rootPath)`. */
  workspaceKey: string;
  /** The company (the invocation's workspace) and the task (its operation) the set is bound to. */
  workspaceId: string;
  operationId: string;
  /** Which round of this task: a number, so every round has a network, a helper and a set of its own. */
  round: number;
  /** The task sandbox that runs the round's commands (`TaskSandbox.name`): it joins the network at .3 and leaves it when the helper stops. */
  sandboxName: string;
  fakes: readonly GeneralFakeServiceFake[];
  /** One base-URL variable per fake, in order. */
  variables: readonly string[];
  /** The worker's own scratch folder (worker-scratch.ts), where the run files go. */
  scratchParent: string;
  /** This round's maximum lifetime: its objects count as left behind from creation + this + 15 minutes. */
  roundBudgetMs: number;
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The run id of a round's network: a hash, so it is plain whatever the ids are, and a round never shares a network with another round or task. */
export function generalFakesRunId(operationId: string, round: number): string {
  if (!UUID.test(operationId) || !Number.isSafeInteger(round) || round < 0) throw agentXError("CONFIG_INVALID", "not a fake helper network id");
  return `gf-${createHash("sha256").update(["general-fakes", operationId, String(round)].join("\0")).digest("hex").slice(0, 32)}`;
}

const ZERO = { served: 0, no_spec: 0, spec_unreadable: 0, spec_ambiguous: 0, operation_unknown: 0, operation_unsupported: 0, foreign: 0, unrouted: 0, refused: 0 } as const;
export type Cumulative = { -readonly [Key in keyof typeof ZERO]: number };
export const cumulativeOf = (summary: TrustedGeneralFakesSummary): Cumulative => ({ served: summary.served, ...summary.cannotAnswer, foreign: summary.foreign, unrouted: summary.unrouted, refused: summary.refused });

/** The calls between two cumulative readings, or undefined when a counter went DOWN (the record is not one helper's own, or was reset): never a guess. */
export function hostedCallsBetween(previous: Cumulative | undefined, next: Cumulative): HostedFakeCalls | undefined {
  const before = previous ?? { ...ZERO };
  const diff = {} as Cumulative;
  for (const key of Object.keys(ZERO) as (keyof Cumulative)[]) {
    if (next[key] < before[key]) return undefined;
    diff[key] = next[key] - before[key];
  }
  return {
    served: diff.served, foreign: diff.foreign, unrouted: diff.unrouted, refused: diff.refused,
    cannotAnswer: { no_spec: diff.no_spec, spec_unreadable: diff.spec_unreadable, spec_ambiguous: diff.spec_ambiguous, operation_unknown: diff.operation_unknown, operation_unsupported: diff.operation_unsupported },
  };
}

/**
 * Starts the fake helper for one round: the gate, the set, the network (on the first free slot, `tx` off), the helper container on it, a readiness check (running, on exactly the run network at its address, and its first
 * summary readable and bound to this company, task and digest), then the sandbox joins at .3 and the network's members are looked at (the helper and the sandbox, nothing else). Any failure removes what was made and gives
 * one fixed sentence (the round's commands become "Not run: Rovara could not start its fakes for this round").
 */
export async function startGeneralFakesHelper(input: StartGeneralFakesHelperInput): Promise<StartedHostedFakes> {
  const fail = (): never => { throw agentXError("RUNTIME_UNAVAILABLE", GENERAL_FAKES_HOSTED_FAILURE_SENTENCE); };
  if (!generalFakesHostedOffer(input.environment ?? process.env).offered) throw agentXError("RUNTIME_UNAVAILABLE", "This worker does not offer the fake helper");
  if (!WORKSPACE_KEY.test(input.workspaceKey) || !UUID.test(input.workspaceId) || !UUID.test(input.operationId) || !CONTAINER_NAME.test(input.sandboxName) || !IMAGE_REFERENCE.test(input.image)) throw agentXError("CONFIG_INVALID", "not an input for the fake helper");
  if (input.fakes.length < 1 || input.fakes.length > GENERAL_FAKES_MAX_SERVICES || input.fakes.length !== input.variables.length) throw agentXError("CONFIG_INVALID", "not a set of fakes for the fake helper");
  const call = dockerCall(input.docker);
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const files = await writeGeneralFakesRunFiles({ parent: input.scratchParent, workspaceId: input.workspaceId, operationId: input.operationId, fakes: input.fakes }).catch(() => undefined);
  if (files === undefined) return fail();
  let net: ServicesNetwork | undefined;
  let attached = false;
  const cleanup = async (): Promise<void> => {
    if (attached && net !== undefined) {
      // The sandbox must be off the network before the network can go (and before a later round can join): look, and retry a few times, never assume.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await call(["network", "disconnect", "--force", net.name, input.sandboxName]);
        const left = await networksOf(call, input.sandboxName);
        if (left !== undefined && !left.has(net.name)) break;
      }
    }
    attached = false;
    await net?.stop();
    await rm(files.dir, { recursive: true, force: true }).catch(() => undefined);
  };
  let helperName = "";
  let helperIp = "";
  try {
    net = await startServicesNetwork(input.docker, { runId: generalFakesRunId(input.operationId, input.round), workspace: input.workspaceKey, roundBudgetMs: input.roundBudgetMs, ...(input.now === undefined ? {} : { now: input.now }) });
    helperName = generalFakesContainerName(net);
    helperIp = net.helperIp(0);
    const args = generalFakesRunArgs({ net, image: input.image, runDir: files.runDir, digest: files.digest, workspaceId: input.workspaceId, operationId: input.operationId });
    const started = await input.docker.run(args, { timeoutMs: START_TIMEOUT_MS }).catch(() => undefined);
    if (started === undefined || started.exitCode !== 0) throw new Error("run");
    await waitForHelper(call, helperName, net, helperIp, sleep, { digest: files.digest, workspaceId: input.workspaceId, operationId: input.operationId });
    // Before the connect: a sandbox that is already on ANOTHER run network (test services, the model helper) is never joined to this one. A look that cannot be read refuses too.
    const before = await networksOf(call, input.sandboxName);
    if (before === undefined || [...before.keys()].some((name) => NETWORK_NAME.test(name))) throw new Error("sandbox networks");
    attached = true;
    await call(["network", "connect", "--ip", net.workingSandboxIp, net.name, input.sandboxName]);
    // The connect's own exit code does not decide: a look at the sandbox's networks does.
    const networks = await networksOf(call, input.sandboxName);
    if (networks === undefined || networks.get(net.name) !== net.workingSandboxIp) throw new Error("not attached");
    await assertMembers(call, net, helperName, helperIp, input.sandboxName);
  } catch {
    await cleanup();
    return fail();
  }
  const expected = { digest: files.digest, workspaceId: input.workspaceId, operationId: input.operationId };
  let previous: Cumulative | undefined;
  let stopped: Promise<void> | undefined;
  const environment = Object.fromEntries(input.variables.map((variable, index) => [variable, `http://${helperIp}:${String(GENERAL_FAKES_HELPER_PORT)}/s/${String(index)}`]));
  return {
    environment,
    async drain() {
      const summary = await readSummary(call, helperName, expected);
      if (summary === undefined || summary.saturated) return undefined;
      const next = cumulativeOf(summary);
      const calls = hostedCallsBetween(previous, next);
      if (calls !== undefined) previous = next;
      return calls;
    },
    stop: () => (stopped ??= cleanup()),
  };
}

/** The helper's summary by `docker exec`, or undefined: unreadable, too big, untrusted, or for another company, task or digest. Never "no calls". */
async function readSummary(call: Call, helperName: string, expected: { digest: string; workspaceId: string; operationId: string }): Promise<TrustedGeneralFakesSummary | undefined> {
  const result = await call(["exec", helperName, NODE, GENERAL_FAKES_HELPER_ENTRY, "--summarize"], SUMMARY_TIMEOUT_MS);
  if (result.exitCode !== 0 || result.stdout.length > GENERAL_FAKES_SUMMARY_MAX_BYTES) return undefined;
  const summary = parseGeneralFakesSummaryText(result.stdout);
  if (summary === undefined || !summary.trusted) return undefined;
  if (summary.digest !== expected.digest || summary.workspaceId !== expected.workspaceId || summary.operationId !== expected.operationId) return undefined;
  return summary;
}

async function waitForHelper(call: Call, helperName: string, net: ServicesNetwork, helperIp: string, sleep: (ms: number) => Promise<void>, expected: { digest: string; workspaceId: string; operationId: string }): Promise<void> {
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
    const inspected = await call(["inspect", "--format", "{{.State.Running}}|{{json .NetworkSettings.Networks}}", helperName]);
    if (inspected.exitCode === 0) {
      const [running, networksText] = inspected.stdout.trim().split(/\|(.*)/su);
      const networks = parseNetworks(networksText);
      if (running === "true" && networks !== undefined) {
        // Exactly the run network, at its address: a daemon that put the helper anywhere else gives it a route the walls do not cover.
        if (networks.size !== 1 || networks.get(net.name) !== helperIp) throw new Error("networks");
        // The helper writes its first summary before it listens: a summary bound to this company, task and digest means the set was accepted.
        if (await readSummary(call, helperName, expected) !== undefined) return;
      }
    }
    await sleep(READY_DELAY_MS);
  }
  throw new Error("not ready");
}

/** One member of a Docker network as `docker network inspect --format '{{json .Containers}}'` lists it. */
interface NetworkMember { Name?: unknown; IPv4Address?: unknown }
/** The run network holds the helper at its address and the sandbox at .3, and nothing else. */
async function assertMembers(call: Call, net: ServicesNetwork, helperName: string, helperIp: string, sandboxName: string): Promise<void> {
  const inspected = await call(["network", "inspect", "--format", "{{json .Containers}}", net.name]);
  if (inspected.exitCode !== 0) throw new Error("members");
  let parsed: unknown;
  try { parsed = JSON.parse(inspected.stdout.trim()); } catch { throw new Error("members"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("members");
  const seen = new Map<string, string>();
  for (const member of Object.values(parsed as Record<string, NetworkMember>)) {
    const name = typeof member?.Name === "string" ? member.Name : undefined;
    const address = typeof member?.IPv4Address === "string" ? member.IPv4Address.split("/")[0] : undefined;
    if (name === undefined || address === undefined) throw new Error("members");
    seen.set(name, address);
  }
  if (seen.size !== 2 || seen.get(helperName) !== helperIp || seen.get(sandboxName) !== net.workingSandboxIp) throw new Error("members");
}

// ---- the launcher the round uses

export interface HostedFakesLauncherInput {
  docker: DockerCli;
  image: string;
  rootPath: string;
  workspaceId: string;
  operationId: string;
  /** The task sandbox the round's commands run in. */
  sandboxName: string;
  scratchParent: string;
  /** The check round's budget (a function: it is read when a round starts). */
  roundBudgetMs(): number;
  environment?: NodeJS.ProcessEnv;
}

/** The launcher a CHECKS round or the coding run's verification gets: one helper and one network per round (a counter keeps a round's network apart from the last one's). */
export function hostedFakesLauncher(input: HostedFakesLauncherInput): HostedFakesLauncher {
  let round = 0;
  return {
    async start({ fakes, variables }) {
      const workspaceKey = await setupWorkspaceKey(input.rootPath);
      round += 1;
      return startGeneralFakesHelper({
        docker: input.docker, image: input.image, workspaceKey, workspaceId: input.workspaceId.toLowerCase(), operationId: input.operationId.toLowerCase(), round, sandboxName: input.sandboxName,
        fakes, variables, scratchParent: input.scratchParent, roundBudgetMs: input.roundBudgetMs(), ...(input.environment === undefined ? {} : { environment: input.environment }),
      });
    },
  };
}

export interface HostedFakesWiring {
  /** The task's working sandbox, or undefined (local shell, dev container). */
  readonly sandbox: { readonly name: string } | undefined;
  /** True when the task has test services: their run network and sealed check sandbox are another home for checks, and the fake helper never joins it (the checks then say so). */
  readonly testServices: boolean;
  readonly devcontainer: boolean;
  /** True when the broker sent the `generalFakes` payload (the project's setting is on). */
  readonly requested: boolean;
  readonly docker: DockerCli;
  readonly rootPath: string;
  readonly workspaceId: string;
  readonly operationId: string;
  /** The longest a check round of this task can last (its own lifetime for the network's expiry). */
  readonly roundBudgetMs: () => number;
  readonly environment?: NodeJS.ProcessEnv;
}

/** The launcher for this task's checks, or undefined: not asked for, not a plain task sandbox, test services on, or the worker does not offer it. Undefined changes nothing. */
export function hostedFakesLauncherFor(wiring: HostedFakesWiring): HostedFakesLauncher | undefined {
  if (!wiring.requested || wiring.sandbox === undefined || wiring.testServices || wiring.devcontainer) return undefined;
  const offer = generalFakesHostedOffer(wiring.environment ?? process.env);
  if (!offer.offered) return undefined;
  return hostedFakesLauncher({
    docker: wiring.docker, image: offer.image, rootPath: wiring.rootPath, workspaceId: wiring.workspaceId, operationId: wiring.operationId, sandboxName: wiring.sandbox.name,
    scratchParent: offer.runDirectoryParent, roundBudgetMs: wiring.roundBudgetMs, ...(wiring.environment === undefined ? {} : { environment: wiring.environment }),
  });
}

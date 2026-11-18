// The HOSTED home of the eval stand-in (L4-E56, rows E5 and E6). The sealed eval box (verification/eval-bridged-exec.ts) runs on a round network of its own with the model helper at .9; when the round has outside HTTP hosts to stand in
// for, a stand-in helper CONTAINER from the worker's own image joins THAT network at the first service-helper address (.16) and answers every outside name the box asks for. DEPLOYMENT CODE: nothing here has been run against Docker
// by its author (no Docker is started on a build machine); the first real proof is a Linux check beside the eval sandbox's own. The pattern is general-fakes-hosted.ts; this module keeps its rules.
//
// What the helper may and may not do (each rule is checked when the arguments are built AND by `evalStandInArgProblems`, which reads them back against an allow-list):
//   - ONE network, the round's own (the `rvi` internal bridge: no route out, other `rvi` bridges and the host are dropped by the boot walls). No egress network, no published port, no `--add-host`, no `--env`, no DNS upstream
//     (`--dns 127.0.0.1`), no `--privileged`, no capability (`--cap-drop ALL`), `no-new-privileges`, a non-root user, a READ-ONLY root, no Docker socket. ONE namespaced sysctl, `net.ipv4.ip_unprivileged_port_start=0`, so the
//     non-root helper can bind the standard ports 80 and 443 (a vendor URL names no other) without a capability; it changes nothing outside the helper's own network namespace.
//   - ONE bind mount, read-only: the run's `standin` folder holding only the set file (the plan, the repository's recordings, the answer book so far, and the round's certificate authority). ONE tmpfs for its own summary.
//   - bounded: memory (swap equal), CPUs, pids, no log driver; the program limits a request's body, the connections and every counter.
//   - it listens on its own address (.16) and serves ONE address, the eval box (.4); a connection from any other address is closed unread and counted.
//   - ALL four labels of the run network are on the container (the network's own stop removes it by them; run-network.ts rule 1).
// The CA KEY: it is in the set file (the helper's own read-only mount) and in the worker's memory. It is never written into the box's checkout, env file or arguments: the box gets the public certificate and variable NAMES only
// (run-ca.ts `evalStandInTrustEnvironment`).
// Names: the box's host table (`--add-host name:<helper address>`, one per planned vendor host) sends each vendor name to the helper; every other name needs the sealed DNS helper's sinkhole (lane E12), whose address is this helper's
// (`catchAllAddress`): until that lands, a name nobody planned does not resolve (the client fails fast) instead of getting the catch-all answer.
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import {
  EVAL_STAND_IN_RUN_DIR, EVAL_STAND_IN_SET_PATH, EVAL_STAND_IN_SUMMARY_MAX_BYTES, agentXError, buildEvalStandInSetBytes, parseEvalStandInSummaryText,
  type EvalStandInSetContent, type TrustedEvalStandInSummary,
} from "@agentx/contracts";
import { EVAL_STAND_IN_HELPER_MAX_LIFETIME_MS, EVAL_STAND_IN_HELPER_MIN_LIFETIME_MS } from "./eval-standin-helper.js";
import { RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_LABEL, RUN_NETWORK_WORKSPACE_LABEL, type ServicesNetwork } from "./run-network.js";
import { DOCKER_CALL_TIMEOUT_MS } from "./setup-network.js";
import type { DockerCli } from "./swebench/containers.js";

/** Where the worker image keeps the helper's program (environments/base/Dockerfile builds the worker's dist). */
export const EVAL_STAND_IN_HELPER_ENTRY = "/opt/agentx/packages/worker/dist/eval-standin-helper.js";
/** The one sentence every start failure gives: Docker's own words are never repeated. */
export const EVAL_STAND_IN_FAILURE_SENTENCE = "AgentX could not start the stand-in for this eval round";
/** The operator's switch. Absent or anything but "1": off, and an eval round runs exactly as without stand-ins. */
export const EVAL_STAND_IN_ENVIRONMENT = "AGENTX_EVAL_STAND_INS";
/** How long past the round's budget the helper lives on its own before it stops itself (shorter than the run network's stale margin). */
export const EVAL_STAND_IN_GRACE_MS = 5 * 60_000;
const NODE = "/usr/local/bin/node";
const HELPER_USER = "1000:1000";
const NO_UPSTREAM_DNS = "127.0.0.1";
const SYSCTL = "net.ipv4.ip_unprivileged_port_start=0";
const MEMORY = "256m";
const CPUS = "0.5";
const PIDS = "128";
const LEDGER_TMPFS = "/rovara/ledger:rw,noexec,nosuid,nodev,size=8m,uid=1000,gid=1000";
const START_TIMEOUT_MS = 60_000;
const SUMMARY_TIMEOUT_MS = 10_000;
const READY_ATTEMPTS = 20;
const READY_DELAY_MS = 250;
const NETWORK_NAME = /^rovara-svc-[0-9a-f]{12}$/u;
const IMAGE_REFERENCE = /^(?:[a-z0-9][a-z0-9._/:-]{0,199}@sha256:[a-f0-9]{64}|sha256:[a-f0-9]{64})$/u;
const RUN_DIR_PATH = /^\/[A-Za-z0-9_./-]{1,500}\/standin$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const WORD = /^[\x21-\x7e]{1,256}$/u;
const LABEL_KEYS: readonly string[] = [RUN_NETWORK_LABEL, RUN_NETWORK_CREATED_LABEL, RUN_NETWORK_EXPIRES_LABEL, RUN_NETWORK_WORKSPACE_LABEL];

export type EvalStandInNetwork = Pick<ServicesNetwork, "name" | "checkSandboxIp" | "labelArgs" | "helperIp">;

/** The helper's container name: the network's own name and `-standin`. */
export const evalStandInContainerName = (net: Pick<ServicesNetwork, "name">): string => `${net.name}-standin`;

export interface EvalStandInLaunchInput {
  net: EvalStandInNetwork;
  /** The worker's own image (it carries `dist/eval-standin-helper.js`), pinned by digest. */
  image: string;
  /** The folder that holds the set file: an absolute plain path whose last segment is `standin`. */
  runDir: string;
  digest: string;
  workspaceId: string;
  operationId: string;
  lifetimeMs: number;
}

function assertInput(input: EvalStandInLaunchInput): void {
  const bad = (what: string): never => { throw agentXError("CONFIG_INVALID", `not ${what} for the eval stand-in`); };
  if (!NETWORK_NAME.test(input.net.name)) bad("a run network");
  if (!IMAGE_REFERENCE.test(input.image)) bad("a pinned image");
  if (!RUN_DIR_PATH.test(input.runDir) || input.runDir.split("/").includes("..")) bad("a run directory");
  if (!DIGEST.test(input.digest)) bad("a digest");
  if (!UUID.test(input.workspaceId) || !UUID.test(input.operationId)) bad("a company and task");
  if (!Number.isSafeInteger(input.lifetimeMs) || input.lifetimeMs < EVAL_STAND_IN_HELPER_MIN_LIFETIME_MS || input.lifetimeMs > EVAL_STAND_IN_HELPER_MAX_LIFETIME_MS) bad("a lifetime");
}

/** The `docker run` arguments of the stand-in helper on the round's network. Throws (a fixed sentence) for an input that is not plain, or arguments that read back unsound. */
export function evalStandInRunArgs(input: EvalStandInLaunchInput): string[] {
  assertInput(input);
  const { net } = input;
  const helperIp = net.helperIp(0);
  const args = [
    "run", "--detach", "--pull=never", "--name", evalStandInContainerName(net), "--stop-timeout", "1", ...net.labelArgs(),
    "--network", net.name, "--ip", helperIp, "--dns", NO_UPSTREAM_DNS,
    "--user", HELPER_USER, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--sysctl", SYSCTL, "--read-only",
    "--memory", MEMORY, "--memory-swap", MEMORY, "--cpus", CPUS, "--pids-limit", PIDS, "--log-driver", "none",
    "--volume", `${input.runDir}:${EVAL_STAND_IN_RUN_DIR}:ro`,
    "--tmpfs", LEDGER_TMPFS,
    "--entrypoint", NODE,
    input.image, EVAL_STAND_IN_HELPER_ENTRY,
    "--listen", helperIp, "--caller", net.checkSandboxIp, "--digest", input.digest, "--workspace", input.workspaceId, "--operation", input.operationId, "--lifetime-ms", String(input.lifetimeMs),
  ];
  const problems = evalStandInArgProblems(args, net, { digest: input.digest, workspaceId: input.workspaceId, operationId: input.operationId, runDir: input.runDir, lifetimeMs: input.lifetimeMs });
  if (problems.length > 0) throw agentXError("CONFIG_INVALID", `the eval stand-in's arguments are unsound: ${problems.join("; ")}`);
  return args;
}

const VALUE_FLAGS: ReadonlySet<string> = new Set(["--name", "--label", "--network", "--ip", "--dns", "--user", "--cap-drop", "--security-opt", "--sysctl", "--memory", "--memory-swap", "--cpus", "--pids-limit", "--log-driver", "--volume", "--tmpfs", "--entrypoint", "--stop-timeout"]);
const SINGLE_FLAGS: ReadonlySet<string> = new Set(["--detach", "--pull=never", "--read-only"]);

function valuesOf(args: readonly string[], name: string): string[] {
  const values: string[] = [];
  args.forEach((arg, at) => { if (arg === name && at + 1 < args.length) values.push(args[at + 1]!); });
  return values;
}

/**
 * Reads a stand-in helper's `docker run` arguments back and names every way they are unsound, in fixed words (no value is repeated). An empty list is a sound set. Allow-list: a flag that is not one the helper takes is a problem,
 * so a new way to reach a network, the host, a capability, a second mount, a second sysctl or an environment variable cannot be added by accident.
 */
export function evalStandInArgProblems(args: readonly string[], net: EvalStandInNetwork, expected: { digest: string; workspaceId: string; operationId: string; lifetimeMs: number; runDir?: string }): string[] {
  const problems: string[] = [];
  const flags = new Map<string, string[]>();
  let at = 0;
  if (args[at] !== "run") problems.push("it is not a docker run"); else at += 1;
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
    if (token.startsWith("-")) { problems.push("a flag the stand-in helper does not take"); at += 1; continue; }
    image = token;
    at += 1;
    break;
  }
  const only = (flag: string, wanted: string): boolean => (flags.get(flag) ?? []).length === 1 && flags.get(flag)![0] === wanted;
  const helperIp = net.helperIp(0);
  if (image === undefined || !IMAGE_REFERENCE.test(image)) problems.push("there is no pinned image");
  if (!only("--network", net.name)) problems.push("the helper must be on the round network and on no other network");
  if (!only("--dns", NO_UPSTREAM_DNS)) problems.push("the helper's only DNS server must be its own loopback (no upstream)");
  if (!only("--ip", helperIp)) problems.push("the helper must have the round's helper address");
  if (!only("--cap-drop", "ALL")) problems.push("the helper must drop every capability");
  if (!flags.has("--read-only")) problems.push("the helper's root must be read-only");
  if (!only("--security-opt", "no-new-privileges")) problems.push("the helper must have no-new-privileges and no other security option");
  if (!only("--sysctl", SYSCTL)) problems.push("the helper has one sysctl, the unprivileged port start");
  if (!only("--user", HELPER_USER)) problems.push("the helper must run as the non-root user");
  if (!only("--entrypoint", NODE)) problems.push("the helper must start the worker's node");
  if (!only("--tmpfs", LEDGER_TMPFS)) problems.push("the helper has one tmpfs, the summary's");
  if (!only("--memory", MEMORY) || !only("--memory-swap", MEMORY)) problems.push("the helper's memory must be bounded, with swap equal");
  if (!only("--cpus", CPUS)) problems.push("the helper's cpus must be bounded");
  if (!only("--pids-limit", PIDS)) problems.push("the helper's processes must be bounded");
  if (!only("--log-driver", "none")) problems.push("the helper keeps no log");
  const volumes = flags.get("--volume") ?? [];
  if (volumes.length !== 1 || !volumes[0]!.endsWith(`:${EVAL_STAND_IN_RUN_DIR}:ro`) || (expected.runDir !== undefined && volumes[0] !== `${expected.runDir}:${EVAL_STAND_IN_RUN_DIR}:ro`)) problems.push("the helper has exactly one mount, the run directory, mounted read-only");
  if (!only("--name", evalStandInContainerName(net))) problems.push("the helper must carry the round network's own container name");
  const labelKeys = (flags.get("--label") ?? []).map((label) => label.split("=")[0]!);
  if (LABEL_KEYS.some((key) => labelKeys.filter((candidate) => candidate === key).length !== 1) || labelKeys.length !== LABEL_KEYS.length) problems.push("the helper must carry all four labels of the round network, once each");
  const rest = image === undefined ? [] : args.slice(at);
  if (rest[0] !== EVAL_STAND_IN_HELPER_ENTRY) problems.push("the helper must run the stand-in helper program");
  const program = rest.slice(1);
  const one = (name: string): string | undefined => { const values = valuesOf(program, name); return values.length === 1 ? values[0] : undefined; };
  if (one("--listen") !== helperIp || isIP(helperIp) !== 4) problems.push("the program must listen on the helper's own address and nothing else");
  if (one("--caller") !== net.checkSandboxIp) problems.push("the program must serve exactly the eval box's address");
  if (one("--digest") !== expected.digest) problems.push("the program must be pinned to the set's digest");
  if (one("--workspace") !== expected.workspaceId || one("--operation") !== expected.operationId) problems.push("the program must be bound to this company and task");
  if (one("--lifetime-ms") !== String(expected.lifetimeMs)) problems.push("the program must carry the round's own deadline");
  const names = program.filter((arg) => arg.startsWith("--"));
  if (names.length !== 6 || program.length !== 12) problems.push("the program takes exactly its six flags");
  if (!program.every((arg) => WORD.test(arg))) problems.push("a program argument is not a plain word");
  return problems;
}

// ---- the run files

export interface EvalStandInRunFiles { readonly runDir: string; readonly digest: string }

/**
 * Writes the set into `<parent>/standin` (the parent is the run's own folder, mode 0700; the folder is 0755 and the file 0644 so the helper's user, uid 1000, can read them whoever owns them). The set holds the plan, the
 * repository's recordings, the answers so far and the round's CA KEY: the box never sees this folder (its one mount is the checkout, checked against the daemon after it starts). Undefined when the set cannot be stored.
 */
export async function writeEvalStandInRunFiles(input: { parent: string; content: EvalStandInSetContent }): Promise<EvalStandInRunFiles | undefined> {
  // A set past its size limit loses the repository's recordings before it loses the stand-in: the eval still runs, with made-up answers instead of recorded ones.
  const set = buildEvalStandInSetBytes(input.content) ?? (input.content.recorded.length === 0 ? undefined : buildEvalStandInSetBytes({ ...input.content, recorded: [] }));
  if (set === undefined) return undefined;
  const runDir = join(input.parent, "standin");
  await rm(runDir, { recursive: true, force: true });
  await mkdir(runDir, { recursive: true, mode: 0o755 });
  await chmod(runDir, 0o755);
  const file = join(runDir, EVAL_STAND_IN_SET_PATH.slice(EVAL_STAND_IN_RUN_DIR.length + 1));
  await writeFile(file, set.bytes, { mode: 0o644 });
  await chmod(file, 0o644);
  return { runDir, digest: set.digest };
}

// ---- the start

type Call = (args: string[], timeoutMs?: number) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
const dockerCall = (docker: DockerCli): Call => (args, timeoutMs = DOCKER_CALL_TIMEOUT_MS) => docker.run(args, { timeoutMs }).catch((error: unknown) => ({ exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));

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

export interface StartedEvalStandIns {
  /** The helper's address: where each planned vendor name resolves for the box (a host-table entry) and where the sealed DNS sinkhole should point (lane E12). */
  readonly address: string;
  /** The helper's summary by `docker exec`, or undefined: unreadable, too big, untrusted, or for another company, task or digest. Never "no calls". */
  summary(): Promise<TrustedEvalStandInSummary | undefined>;
  stop(): Promise<void>;
}

export interface StartEvalStandInsInput {
  docker: DockerCli;
  /** The worker's own image, pinned. */
  image: string;
  net: EvalStandInNetwork;
  /** The run's own folder (mode 0700), under the worker's scratch: the set goes in its `standin` folder. */
  parent: string;
  content: EvalStandInSetContent;
  /** This round's maximum lifetime: the helper stops itself this long plus the grace after it starts. */
  roundBudgetMs: number;
  helperLifetimeMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** The helper's summary by `docker exec`, bound to this company, task and digest. */
async function readSummary(call: Call, helperName: string, expected: { digest: string; workspaceId: string; operationId: string }): Promise<TrustedEvalStandInSummary | undefined> {
  const result = await call(["exec", helperName, NODE, EVAL_STAND_IN_HELPER_ENTRY, "--summarize"], SUMMARY_TIMEOUT_MS);
  if (result.exitCode !== 0 || result.stdout.length > EVAL_STAND_IN_SUMMARY_MAX_BYTES) return undefined;
  const summary = parseEvalStandInSummaryText(result.stdout);
  if (summary === undefined || !summary.trusted) return undefined;
  if (summary.digest !== expected.digest || summary.workspaceId !== expected.workspaceId || summary.operationId !== expected.operationId) return undefined;
  return summary;
}

/**
 * Starts the stand-in helper once on the round's network: the set, the container, and a readiness check (running, on exactly the round network at its address, its first summary readable and bound to this company, task and
 * digest). Any failure removes what was made and gives one fixed sentence.
 */
export async function startEvalStandInsOnce(input: StartEvalStandInsInput): Promise<StartedEvalStandIns> {
  const fail = (): never => { throw agentXError("RUNTIME_UNAVAILABLE", EVAL_STAND_IN_FAILURE_SENTENCE); };
  if (!IMAGE_REFERENCE.test(input.image)) throw agentXError("CONFIG_INVALID", "not an input for the eval stand-in");
  const call = dockerCall(input.docker);
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const files = await writeEvalStandInRunFiles({ parent: input.parent, content: input.content }).catch(() => undefined);
  if (files === undefined) return fail();
  const helperName = evalStandInContainerName(input.net);
  const helperIp = input.net.helperIp(0);
  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> => (stopped ??= (async () => {
    await call(["rm", "--force", helperName]);
    await rm(files.runDir, { recursive: true, force: true }).catch(() => undefined);
  })());
  const expected = { digest: files.digest, workspaceId: input.content.workspaceId, operationId: input.content.operationId };
  try {
    const args = evalStandInRunArgs({ net: input.net, image: input.image, runDir: files.runDir, ...expected, lifetimeMs: input.helperLifetimeMs ?? input.roundBudgetMs + EVAL_STAND_IN_GRACE_MS });
    const started = await input.docker.run(args, { timeoutMs: START_TIMEOUT_MS }).catch(() => undefined);
    if (started === undefined || started.exitCode !== 0) throw new Error("run");
    let ready = false;
    for (let attempt = 0; attempt < READY_ATTEMPTS && !ready; attempt += 1) {
      const inspected = await call(["inspect", "--format", "{{.State.Running}}|{{json .NetworkSettings.Networks}}", helperName]);
      if (inspected.exitCode === 0) {
        const [running, networksText] = inspected.stdout.trim().split(/\|(.*)/su);
        const networks = parseNetworks(networksText);
        if (running === "true" && networks !== undefined) {
          // Exactly the round network, at its address: a daemon that put the helper anywhere else gives it a route the walls do not cover.
          if (networks.size !== 1 || networks.get(input.net.name) !== helperIp) throw new Error("networks");
          // The helper writes its first summary before it listens: a summary bound to this company, task and digest means the set was accepted.
          if (await readSummary(call, helperName, expected) !== undefined) ready = true;
        }
      }
      if (!ready) await sleep(READY_DELAY_MS);
    }
    if (!ready) throw new Error("not ready");
  } catch {
    await stop();
    return fail();
  }
  return { address: helperIp, summary: () => readSummary(call, helperName, expected), stop };
}

/** One try and, when it fails, one more (a stand-in that will not start is Rovara's problem, not the customer's: the second try is the only recovery; a second failure is the caller's to report). */
export async function startEvalStandIns(input: StartEvalStandInsInput): Promise<StartedEvalStandIns> {
  try { return await startEvalStandInsOnce(input); } catch { return startEvalStandInsOnce(input); }
}

/** Whether this worker offers the stand-in: the operator turned it on and the worker's own image is known and pinned. The round network's walls are the model helper's gate (the stand-in joins its network). */
export function evalStandInsOffered(environment: NodeJS.ProcessEnv, image: string): boolean {
  return environment[EVAL_STAND_IN_ENVIRONMENT] === "1" && IMAGE_REFERENCE.test(image);
}

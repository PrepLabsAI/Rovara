// The per-run services network (test services, TS13; design test-services.md 4.0.1 and 4.0.6). DEPLOYMENT CODE: nothing here has been run against Docker (this build starts no Docker); the Linux checks
// TS-L1 to TS-L3 and TS-L6 (scripts/linux-check-test-services.sh) MUST pass on linux-runtime or a staging worker before the `tx` switch is turned on. Nothing calls this module yet.
//
// What it is: one Docker `--internal` bridge per run, on a fixed /24 of its own (172.30.<slot>.0/24), whose host interface is named `rvi<8 hex>`. That name is the whole point. The boot firewall already walls every `rvi*` bridge
// (packages/worker/ec2/boot.sh `wall_off_containers`: `DOCKER-USER -i rvi+ ! -o rvi+ -j DROP` and `INPUT -i rvi+ -j DROP`), so traffic between a sandbox and a service helper on the same bridge passes, and nothing on it can reach the
// host, a private range, the metadata address or the internet. THIS MODULE ADDS NO FIREWALL RULE and the design relies on that (tests/contract/run-network-walls.test.ts reads the boot scripts to prove it).
//
// What it reuses from setup-network.ts (the setup run's network, which it generalises): the slot hash (`setupNetworkSlot`) and slot count, the workspace key, the "this subnet or interface name is taken, try the next slot"
// rule (`isSlotCollision`), and the Docker call timeout. What differs, and why: the range (172.30 here, 172.29 there), the bridge prefix (`rvi`, internal, against `rvbs`, which has an outbound leg for the setup run's allowed
// websites), `--internal`, and the labels. The labels are this module's own (`rovara.run-network*`), not `rovara.run` (the end-to-end checker's) and not `agentx.setup-run` (the setup run's), so each of the three sweeps can only ever
// see its own objects.
//
// Addresses in a slot: gateway .1, DNS helper .2, working sandbox .3, check sandbox .4, test-account proxy .8, MODEL HELPER .9 (TE-F1b), service helpers .16 to .47 (32 of them).
// .9 is RESERVED: no service helper index reaches it (`runNetworkHelperIp` starts at .16), and the name its sandboxes know it by (`MODEL_HELPER_ALIAS`, `rovara-models`) is a reserved alias a repository's dependency can never take
// (service-helpers.ts `HELPER_RESERVED_ALIASES`, check-sandbox.ts `RESERVED_RUN_ALIASES`). The model helper is started by model-helper-network.ts on a network of its own per task or per round; this module is unchanged in how it makes one.
//
// Sweeping: a run's objects carry `rovara.run-network.expires` (its own creation time + its own round budget + 15 minutes), stamped when the network is made. The sweep of an allocation removes an object only when
// now >= its own expires, so a short run's allocation can never remove a longer run's live helpers. Only the worker-start sweep (`workerStart: true`) removes every family object of its own workspace, because a
// restarted worker's own earlier runs are all dead.
//
// RULES FOR THE HELPER LAUNCHER (TS14, deferred check TS-RN-3), which must hold or the sweep and the walls do not work:
//   1. Always pass ALL the labels of `net.labelArgs()` (family, created, expires, workspace) to `docker run`. A label given on the command line overrides one baked into the image, so the launcher's labels win, but a
//      container started without them is invisible to the sweep and to `stop()`.
//   2. Validate every dependency alias with a strict regex before `--network-alias` (for example /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/, and never one of the reserved names: the DNS helper, the proxy, the sinkhole).
//      An alias comes from the repository, so it is the one repository-controlled string that could reach a docker argument.
//   3. Run the worker-start sweep: `sweepServicesNetworks(docker, { workspace, workerStart: true })` once when the worker starts (like `removeLeftoverSetupRuns`).
//
// No repository-controlled string reaches a docker argument: the run id must be plain (letters, digits, hyphens; it is only ever hashed), the workspace must be a 16-hex key, every name and the bridge are hashes, the addresses come from a
// number, and the ids the sweep passes on must pass a plain-id check. A dependency's alias (`postgres`) is not part of this module; the helper launcher (TS14) must validate it before it uses `--network-alias`.
import { createHash } from "node:crypto";
import { agentXError } from "@agentx/contracts";
import type { DockerCli } from "./swebench/containers.js";
import { DOCKER_CALL_TIMEOUT_MS, SETUP_NETWORK_SLOTS, isSlotCollision, setupNetworkSlot } from "./setup-network.js";

/** The family label; its value is the network's name (a hash of the run id). Every container and the network of a run carry it. */
export const RUN_NETWORK_LABEL = "rovara.run-network";
/** When the run's network was made, in milliseconds since the epoch (informational). */
export const RUN_NETWORK_CREATED_LABEL = "rovara.run-network.created";
/** When the run's objects count as left behind: its own creation time + its own round budget + 15 minutes, in milliseconds since the epoch. The sweep of an allocation removes an object only from this time on. */
export const RUN_NETWORK_EXPIRES_LABEL = "rovara.run-network.expires";
/** The key of the worker's workspace, so a worker never removes another worker's objects on a shared Docker daemon. */
export const RUN_NETWORK_WORKSPACE_LABEL = "rovara.run-network.workspace";
export const RUN_NETWORK_FIRST_OCTETS = "172.30";
export const RUN_NETWORK_SLOTS = SETUP_NETWORK_SLOTS;
/** The last octet of the model helper's address in a slot (TE-F1b). Reserved: see the header. */
export const RUN_NETWORK_MODEL_HELPER_OCTET = 9;
/** The one name a sandbox knows the model helper by (`--add-host rovara-models:<.9>`). Reserved: a dependency alias can never be this. */
export const MODEL_HELPER_ALIAS = "rovara-models";
/** The host interface prefix: the boot firewall walls `rvi*` bridges. */
export const RUN_NETWORK_BRIDGE_PREFIX = "rvi";
/** How long past a round's budget a run is kept before a sweep treats it as left behind by a killed worker. */
export const RUN_NETWORK_STALE_MARGIN_MS = 15 * 60_000;
const HELPER_FIRST = 16;
const HELPER_LAST = 47;
const SLOT_ATTEMPTS = 8;
const FAILURE_SENTENCE = "AgentX could not set up the network for the test services";
const SAFE_RUN_ID = /^[A-Za-z0-9-]{1,64}$/u;
const WORKSPACE_KEY = /^[0-9a-f]{16}$/u;
const NETWORK_NAME = /^rovara-svc-[0-9a-f]{12}$/u;
const SAFE_DOCKER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

const digest = (...parts: string[]): string => createHash("sha256").update(parts.join("\0")).digest("hex");

function assertRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId)) throw agentXError("CONFIG_INVALID", "not a run id for a services network");
}
function assertWorkspace(workspace: string): void {
  if (!WORKSPACE_KEY.test(workspace)) throw agentXError("CONFIG_INVALID", "not a workspace key for a services network");
}

/** The network's Docker name: a hash of the run id, never the id itself. */
export function runNetworkName(runId: string): string {
  assertRunId(runId);
  return `rovara-svc-${digest("run-network-name", runId).slice(0, 12)}`;
}

/** The host interface name, `rvi` and 8 hex of a hash of the run id and the slot (so the next slot's attempt also gets a new name if a name was the collision). 11 of the 15 characters an interface name may have. */
export function runNetworkBridge(runId: string, slot: number): string {
  assertRunId(runId);
  assertSlot(slot);
  return `${RUN_NETWORK_BRIDGE_PREFIX}${digest("run-network-bridge", runId, String(slot)).slice(0, 8)}`;
}

function assertSlot(slot: number): void {
  if (!Number.isInteger(slot) || slot < 1 || slot > RUN_NETWORK_SLOTS) throw agentXError("CONFIG_INVALID", "not a services network slot");
}

export interface RunNetworkAddresses {
  subnet: string;
  gateway: string;
  /** The range Docker hands out dynamic addresses from: the upper half, so a dynamic address never lands on the reserved .1 to .47. */
  ipRange: string;
  dnsHelperIp: string;
  workingSandboxIp: string;
  checkSandboxIp: string;
  proxyIp: string;
}

/** The addresses of a slot. */
export function runNetworkAddresses(slot: number): RunNetworkAddresses {
  assertSlot(slot);
  const base = `${RUN_NETWORK_FIRST_OCTETS}.${String(slot)}`;
  return { subnet: `${base}.0/24`, gateway: `${base}.1`, ipRange: `${base}.128/25`, dnsHelperIp: `${base}.2`, workingSandboxIp: `${base}.3`, checkSandboxIp: `${base}.4`, proxyIp: `${base}.8` };
}

/** The model helper's address in a slot (.9, TE-F1b). Not a field of `RunNetworkAddresses`: the model helper is not part of a test-services run, and a hand-built network in another lane's tests stays whole without it. */
export function runNetworkModelHelperIp(slot: number): string {
  assertSlot(slot);
  return `${RUN_NETWORK_FIRST_OCTETS}.${String(slot)}.${String(RUN_NETWORK_MODEL_HELPER_OCTET)}`;
}

/** The address of the service helper with this index (0 to 31): .16 to .47 of the slot. */
export function runNetworkHelperIp(slot: number, index: number): string {
  assertSlot(slot);
  if (!Number.isInteger(index) || index < 0 || index > HELPER_LAST - HELPER_FIRST) throw agentXError("CONFIG_INVALID", "not a service helper index");
  return `${RUN_NETWORK_FIRST_OCTETS}.${String(slot)}.${String(HELPER_FIRST + index)}`;
}

export interface RunNetworkLabelInput {
  runId: string;
  /** `setupWorkspaceKey(rootPath)`: 16 hex. */
  workspace: string;
  /** Milliseconds since the epoch, when the network was made. */
  createdAt: number;
  /** Milliseconds since the epoch, from when the run's objects count as left behind: `createdAt + servicesNetworkStaleAfterMs(own budget)`. */
  expiresAt: number;
}

/** The four labels every object of a run carries. A helper started by the launcher (TS14) must pass them to `docker run`, or the sweep cannot find it. */
export function runNetworkLabelArgs(input: RunNetworkLabelInput): string[] {
  assertWorkspace(input.workspace);
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) throw agentXError("CONFIG_INVALID", "not a creation time");
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt < input.createdAt) throw agentXError("CONFIG_INVALID", "not an expiry time");
  return ["--label", `${RUN_NETWORK_LABEL}=${runNetworkName(input.runId)}`, "--label", `${RUN_NETWORK_CREATED_LABEL}=${String(input.createdAt)}`, "--label", `${RUN_NETWORK_EXPIRES_LABEL}=${String(input.expiresAt)}`, "--label", `${RUN_NETWORK_WORKSPACE_LABEL}=${input.workspace}`];
}

/** The `docker network create` arguments: an internal bridge on the slot's /24, with the `rvi` host interface the boot firewall walls, and the family labels. */
export function runNetworkCreateArgs(input: RunNetworkLabelInput & { slot: number }): string[] {
  const addresses = runNetworkAddresses(input.slot);
  return [
    "network", "create", "--driver", "bridge", "--internal", "--subnet", addresses.subnet, "--gateway", addresses.gateway, "--ip-range", addresses.ipRange,
    "--opt", `com.docker.network.bridge.name=${runNetworkBridge(input.runId, input.slot)}`,
    ...runNetworkLabelArgs(input), runNetworkName(input.runId),
  ];
}

/** The age after which a run's objects are stale: the round's budget plus 15 minutes. */
export function servicesNetworkStaleAfterMs(roundBudgetMs: number): number {
  if (!Number.isSafeInteger(roundBudgetMs) || roundBudgetMs <= 0) throw agentXError("CONFIG_INVALID", "not a round budget");
  return roundBudgetMs + RUN_NETWORK_STALE_MARGIN_MS;
}

const dockerCall = (docker: DockerCli) => (args: string[]) => docker.run(args, { timeoutMs: DOCKER_CALL_TIMEOUT_MS }).catch((error: unknown) => ({ exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));

const LIST_FORMAT = `{{.ID}}\t{{.Label "${RUN_NETWORK_LABEL}"}}\t{{.Label "${RUN_NETWORK_CREATED_LABEL}"}}\t{{.Label "${RUN_NETWORK_WORKSPACE_LABEL}"}}\t{{.Label "${RUN_NETWORK_EXPIRES_LABEL}"}}`;

type Call = ReturnType<typeof dockerCall>;
interface FamilyRow { id: string; family: string; created: string; workspace: string; expires: string }

/** The rows of a `LIST_FORMAT` listing that really are this workspace's family objects (plain id, family value shaped like a network name, workspace equal, and `only` when given): the filter went to Docker, but a daemon that ignores it must not widen what is touched. */
function familyRows(stdout: string, workspace: string, only?: string): FamilyRow[] {
  const rows: FamilyRow[] = [];
  for (const line of stdout.split("\n")) {
    const [id, family, created, ws, expires] = line.split("\t");
    if (id === undefined || family === undefined || created === undefined || ws === undefined || expires === undefined) continue;
    if (!SAFE_DOCKER_ID.test(id) || !NETWORK_NAME.test(family) || ws !== workspace || (only !== undefined && family !== only)) continue;
    rows.push({ id, family, created, workspace: ws, expires });
  }
  return rows;
}

async function listFamily(call: Call, list: string[], workspace: string): Promise<FamilyRow[]> {
  const listed = await call([...list, "--filter", `label=${RUN_NETWORK_LABEL}`, "--filter", `label=${RUN_NETWORK_WORKSPACE_LABEL}=${workspace}`, "--format", LIST_FORMAT]);
  return listed.exitCode === 0 ? familyRows(listed.stdout, workspace) : [];
}

export interface SweepInput {
  /** `setupWorkspaceKey(rootPath)`. */
  workspace: string;
  /** True only for the sweep at a worker's start: every family object of this workspace goes, whatever its expiry (a restarted worker's own earlier runs are all dead). Otherwise only objects whose own expiry has come. */
  workerStart?: boolean;
  now?: () => number;
}

/**
 * Removes the containers and then the networks of this workspace's runs that carry the run-network family label and are due: at an allocation, those whose OWN expiry (their creation + their own round budget + 15 minutes,
 * stamped at creation) has come, so a short run's sweep leaves a longer run's live helpers alone; at a worker's start, all of them. An object with no readable expiry is left alone by an allocation's sweep.
 * Containers go first because a network with an endpoint cannot be removed. Answers how many Docker accepted; never throws on a Docker failure.
 */
export async function sweepServicesNetworks(docker: DockerCli, input: SweepInput): Promise<{ containers: number; networks: number }> {
  assertWorkspace(input.workspace);
  const call = dockerCall(docker);
  const now = (input.now ?? Date.now)();
  const due = async (list: string[]): Promise<string[]> => (await listFamily(call, list, input.workspace))
    .filter((row) => input.workerStart === true || (/^\d{1,16}$/u.test(row.expires) && now >= Number(row.expires)))
    .map((row) => row.id);
  const containers = await due(["ps", "--all"]);
  let removedContainers = 0;
  if (containers.length > 0 && (await call(["rm", "--force", "--volumes", ...containers])).exitCode === 0) removedContainers = containers.length;
  let removedNetworks = 0;
  for (const id of await due(["network", "ls"])) if ((await call(["network", "rm", id])).exitCode === 0) removedNetworks += 1;
  return { containers: removedContainers, networks: removedNetworks };
}

/** Removes one run's containers and then its network. True when it is done (the network is gone, or Docker says it never existed), false when a Docker call failed and a retry may help. */
async function removeRun(call: Call, name: string, workspace: string): Promise<boolean> {
  const listed = await call(["ps", "--all", "--filter", `label=${RUN_NETWORK_LABEL}=${name}`, "--filter", `label=${RUN_NETWORK_WORKSPACE_LABEL}=${workspace}`, "--format", LIST_FORMAT]);
  if (listed.exitCode !== 0) return false;
  const ids = familyRows(listed.stdout, workspace, name).map((row) => row.id);
  if (ids.length > 0 && (await call(["rm", "--force", "--volumes", ...ids])).exitCode !== 0) return false;
  const removed = await call(["network", "rm", name]);
  return removed.exitCode === 0 || /no such network/iu.test(`${removed.stderr}${removed.stdout}`);
}

export interface StartServicesNetworkInput {
  /** The run's id (a task, Prove, nightly or checker round). Only ever hashed. */
  runId: string;
  /** `setupWorkspaceKey(rootPath)`. */
  workspace: string;
  /** This run's own round budget in milliseconds: its objects count as left behind from creation + this + 15 minutes, and not before. */
  roundBudgetMs: number;
  now?: () => number;
}

export interface ServicesNetwork extends RunNetworkAddresses {
  name: string;
  bridge: string;
  slot: number;
  /** The address of service helper `index` (0 to 31). */
  helperIp(index: number): string;
  /** The labels every container of this run must be started with (all of them: see the rules for the helper launcher at the top of this file). */
  labelArgs(): string[];
  /** Removes the run's containers and then the network, retrying its Docker calls a few times. Idempotent once it has succeeded; never throws. */
  stop(): Promise<void>;
}

const STOP_ATTEMPTS = 3;

/**
 * Sweeps due runs, then makes the run's network on the first free slot. Any failure is one fixed sentence (the docker error is not repeated to the person). If a network of this run's own name is already there and carries
 * this workspace's and this run's labels (a stop that failed earlier, or a killed worker), it is removed and the start tried once more; a network of that name that is not this run's is never touched.
 */
export async function startServicesNetwork(docker: DockerCli, input: StartServicesNetworkInput): Promise<ServicesNetwork> {
  assertRunId(input.runId);
  assertWorkspace(input.workspace);
  const staleAfterMs = servicesNetworkStaleAfterMs(input.roundBudgetMs);
  const now = input.now ?? Date.now;
  const call = dockerCall(docker);
  // The sweep of every allocation: what a killed worker left behind frees its slot once it is due. A failed sweep is not a failed start.
  await sweepServicesNetworks(docker, { workspace: input.workspace, now }).catch(() => undefined);
  const createdAt = now();
  const labels = { runId: input.runId, workspace: input.workspace, createdAt, expiresAt: createdAt + staleAfterMs };
  const name = runNetworkName(input.runId);
  const allocate = async (): Promise<{ slot?: number; clash: boolean }> => {
    for (let attempt = 0; attempt < SLOT_ATTEMPTS; attempt += 1) {
      const candidate = setupNetworkSlot(input.runId, attempt);
      const created = await call(runNetworkCreateArgs({ ...labels, slot: candidate }));
      if (created.exitCode === 0) return { slot: candidate, clash: false };
      const output = `${created.stderr}${created.stdout}`;
      // A subnet another network has, or a host interface name that is taken, is cured by the next slot. A network of this name (the same run twice) names no bridge and no pool, so it ends this pass, and so does any other failure.
      if (!isSlotCollision(output)) return { clash: /network with name .* already exists/iu.test(output) };
    }
    return { clash: false };
  };
  let result = await allocate();
  if (result.slot === undefined && result.clash) {
    const owner = await call(["network", "inspect", "--format", `{{index .Labels "${RUN_NETWORK_LABEL}"}}\t{{index .Labels "${RUN_NETWORK_WORKSPACE_LABEL}"}}`, name]);
    if (owner.exitCode === 0 && owner.stdout.trim() === `${name}\t${input.workspace}` && await removeRun(call, name, input.workspace)) result = await allocate();
  }
  const slot = result.slot;
  if (slot === undefined) throw agentXError("RUNTIME_UNAVAILABLE", FAILURE_SENTENCE);
  let stopped = false;
  return {
    name, bridge: runNetworkBridge(input.runId, slot), slot, ...runNetworkAddresses(slot),
    helperIp: (index: number) => runNetworkHelperIp(slot, index),
    labelArgs: () => runNetworkLabelArgs(labels),
    async stop() {
      for (let attempt = 0; attempt < STOP_ATTEMPTS && !stopped; attempt += 1) stopped = await removeRun(call, name, input.workspace);
    },
  };
}

// TE-F1b (M2, release 0.5.19; te-f1 design 2.2, 3.2 and 3.3): the model helper's NETWORK. Every task that has a model row gets a model helper on a private network of its own, and every round of the unsealed final check gets
// another, so a client in the sandbox can be redirected to the helper (an environment variable) and a client that ignores the redirect still lands on it (the by-name block, model-helper-block.ts) instead of a real model host.
//
// What this module does, and what it reuses:
//   - the network is an `rvi` bridge made by `startServicesNetwork` (run-network.ts) exactly as a test-services run's, with `tx` OFF: this is the first production use of that module (the design's "TS-L order", review H1; this
//     lane is not merged until TS-L1 to L3 have passed on staging). THIS MODULE ADDS NO FIREWALL RULE, no boot script and no DNS firewall change: the walls every named worker already has (rvi bridges are internal, other rvi bridges
//     and the host are unreachable) are the whole network story.
//   - ONE network per task (the working sandbox, dual-homed: `agentx-task` plus the helper network at .3) and ONE NEW network per round (the fresh unsealed check sandbox at .4; the working sandbox is never on it).
//   - the helper is started BEFORE any sandbox, and its network is checked (it is running, on exactly the run network, at .9) before a sandbox block exists. A sandbox that cannot join is removed, never left running with a
//     block that points nowhere.
//   - the worker-start sweep (`sweepModelHelperNetworksAtWorkerStart`) is run-network.ts's own, once at startup, so a killed worker's helper and network are gone.
//   - the gate (`modelHelperOffer`): a worker offers the helper only when its boot facts say the walls are in place AND the IPv6 drops are. A named worker without them, a non-named install, and a worker withheld
//     (`AGENTX_TEST_SERVICES_NOT_PULLED=all`, or a note that cannot be read) offer none, and the feature `task.modelHelper.v1` is not advertised.
//
// NOT here: the Cloud wiring (run-task.ts, the feature list of cloud-contracts, `scripts/linux-check-model-helper.sh`), which waits for the pin; no broker sends a model plan (the worker advertises the feature one release first).
import { createHash } from "node:crypto";
import { agentXError, type CompanyGatewayRow, type ModelCatalogRow } from "@agentx/contracts";
import { runNetworkModelHelperIp, startServicesNetwork, sweepServicesNetworks, type ServicesNetwork } from "./run-network.js";
import { DOCKER_CALL_TIMEOUT_MS } from "./setup-network.js";
import { modelHelperContainerName, modelHelperRunArgs } from "./model-helper-launch.js";
import { planModelHostBlock, type ModelHostBlock } from "./model-helper-block.js";
import { TEST_SERVICES_BOOT_FACTS_ENVIRONMENT, parseBootFacts } from "./test-services-report.js";
import { notPulledRepositories } from "./test-services-run.js";
import type { DockerCli } from "./swebench/containers.js";

/** The worker feature a worker advertises when it offers the model helper (one release before the broker sends any model plan). */
export const MODEL_HELPER_FEATURE = "task.modelHelper.v1";
/** The one sentence every start failure gives: the docker error is not repeated to the person. */
export const MODEL_HELPER_FAILURE_SENTENCE = "AgentX could not start the model helper for this task";
const START_TIMEOUT_MS = 60_000;
const READY_ATTEMPTS = 20;
const READY_DELAY_MS = 250;
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const WORKSPACE_KEY = /^[0-9a-f]{16}$/u;
const RUN_NETWORK_NAME = /^rovara-svc-[0-9a-f]{12}$/u;

// ---- the gate

export type ModelHelperOffer = { readonly offered: true } | { readonly offered: false; readonly reason: "no_boot_facts" | "boot_facts_unreadable" | "walls_missing" | "ipv6_drops_missing" | "worker_withheld" };

/** Whether this worker offers the model helper: its boot facts (root's, `AGENTX_TEST_SERVICES_BOOT_FACTS`) say the run-network walls AND the IPv6 drops are in place, and it is not withheld. Fail closed on anything else. */
export function modelHelperOffer(environment: NodeJS.ProcessEnv = process.env): ModelHelperOffer {
  if (notPulledRepositories(environment) === "all") return { offered: false, reason: "worker_withheld" };
  const facts = parseBootFacts(environment[TEST_SERVICES_BOOT_FACTS_ENVIRONMENT]);
  if (facts === "absent") return { offered: false, reason: "no_boot_facts" };
  if (facts === "unreadable") return { offered: false, reason: "boot_facts_unreadable" };
  if (!facts.runWalls) return { offered: false, reason: "walls_missing" };
  if (!facts.ipv6Drops) return { offered: false, reason: "ipv6_drops_missing" };
  return { offered: true };
}

/** The features this worker adds to /ping for the model helper: the one, or none. (Listed in Cloud's WORKER_INVOCATION_FEATURES by the Cloud half.) */
export function modelHelperAdvertisedFeatures(environment: NodeJS.ProcessEnv = process.env): readonly (typeof MODEL_HELPER_FEATURE)[] {
  return modelHelperOffer(environment).offered ? [MODEL_HELPER_FEATURE] : [];
}

// ---- one network per task, one new network per round

/** The run id of a helper network: a hash of the kind, the id and the round, so it is plain whatever the id is and a round never shares a network with the task or with another round. Only ever hashed again by run-network.ts. */
export function modelHelperRunId(kind: "task" | "round", id: string, round?: number): string {
  if (id.length === 0 || id.length > 200 || (kind === "round" && (round === undefined || !Number.isSafeInteger(round) || round < 0)) || (kind === "task" && round !== undefined)) {
    throw agentXError("CONFIG_INVALID", "not a model helper network id");
  }
  return `mh-${createHash("sha256").update(["model-helper", kind, id, kind === "round" ? String(round) : ""].join("\0")).digest("hex").slice(0, 32)}`;
}

/** What a sandbox needs to take a model block (task-sandbox.ts `TaskSandboxOptions.modelBlock`). */
export interface SandboxModelBlock {
  readonly block: ModelHostBlock;
  /** Which sandbox this block is for: the working sandbox (a task's helper network) or a round's fresh check sandbox. `TaskSandbox` is the working sandbox and refuses a `check` block. */
  readonly role?: "working" | "check";
  /** Joins the started sandbox to the helper's network at its fixed address. Absent when the block has no helper (the dropped address). */
  attach?(container: string): Promise<void>;
  /** Removes the helper and its network, after the sandbox is gone. Never throws. */
  teardown?(): Promise<void>;
}

export interface StartedModelHelper {
  readonly kind: "task" | "round";
  readonly network: ServicesNetwork;
  readonly helperName: string;
  readonly helperIp: string;
  /** Which sandbox this network serves: the working sandbox (.3) of a task, or the fresh check sandbox (.4) of a round. */
  readonly sandboxRole: "working" | "check";
  readonly sandboxIp: string;
  /** The sandbox's model block (the names at .9 and the join): the built-in catalog (`rows` only ADDS rows), the project's gateway rows and its own Azure OpenAI resource hosts when known. */
  sandboxBlock(input: { rows?: readonly ModelCatalogRow[]; gatewayRows?: readonly CompanyGatewayRow[]; azureResourceHosts?: readonly string[] }): SandboxModelBlock;
  /** `docker network connect --ip <sandbox address> <network> <container>`, then an inspect that shows the container on it. Only the role this network serves may join: the working sandbox is never on a round's network. */
  attachSandbox(container: string, role: "working" | "check"): Promise<void>;
  stop(): Promise<void>;
}

export interface StartModelHelperInput {
  /** `task`: one network for the task (working sandbox at .3). `round`: a NEW network for one round of the unsealed final check (fresh check sandbox at .4). */
  kind: "task" | "round";
  /** The task's or operation's id; only ever hashed. */
  id: string;
  /** The round's number, for `kind: "round"`. */
  round?: number;
  /** `setupWorkspaceKey(root)`. */
  workspace: string;
  /** This network's own budget in milliseconds: its objects count as left behind from creation + this + 15 minutes, and an allocation's sweep of another run may then remove them. The CALLER must pass the task's (or round's) MAXIMUM lifetime here, or a longer task loses its helper to a later sweep. */
  roundBudgetMs: number;
  /** The worker's own image. */
  image: string;
  /** The directory that holds only the helper's own files (its last segment is `models`). */
  runDir: string;
  /** The program's own arguments for these addresses (TE-F2's `modelHelperArgs`; a fake in tests until it lands). */
  helperArgs(addresses: { listen: string; caller: string }): readonly string[];
  /** Default: the process environment, for the gate. */
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Test seam for the wait between readiness looks. */
  sleep?: (ms: number) => Promise<void>;
}

type Call = (args: string[]) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
const dockerCall = (docker: DockerCli): Call => (args) => docker.run(args, { timeoutMs: DOCKER_CALL_TIMEOUT_MS }).catch((error: unknown) => ({ exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));

/** The names of the networks the container is on, with the address on each, from one `docker inspect`; undefined when the look failed or could not be read (a look that cannot be read is never "fine"). */
async function networksOf(call: Call, container: string): Promise<Map<string, string> | undefined> {
  const inspected = await call(["inspect", "--format", "{{json .NetworkSettings.Networks}}", container]);
  return parseNetworks(inspected.exitCode === 0 ? inspected.stdout.trim() : undefined);
}
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

/**
 * Starts the model helper: the gate, then the network (on the first free slot, `tx` off), then the helper container on it, then a readiness check: the helper is RUNNING, on exactly the run network and no other, at .9.
 * Any failure removes what was made and gives one fixed sentence. The sandbox is started after this returns (never before), with `sandboxBlock()`.
 */
export async function startModelHelper(docker: DockerCli, input: StartModelHelperInput): Promise<StartedModelHelper> {
  if (!modelHelperOffer(input.environment ?? process.env).offered) throw agentXError("RUNTIME_UNAVAILABLE", "This worker does not offer the model helper");
  const runId = modelHelperRunId(input.kind, input.id, input.round);
  if (!WORKSPACE_KEY.test(input.workspace)) throw agentXError("CONFIG_INVALID", "not a workspace key for a model helper");
  const call = dockerCall(docker);
  const net = await startServicesNetwork(docker, { runId, workspace: input.workspace, roundBudgetMs: input.roundBudgetMs, ...(input.now === undefined ? {} : { now: input.now }) });
  const sandboxRole = input.kind === "task" ? "working" : "check";
  const sandboxIp = sandboxRole === "working" ? net.workingSandboxIp : net.checkSandboxIp;
  const helperName = modelHelperContainerName(net);
  const helperIp = runNetworkModelHelperIp(net.slot);
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  try {
    const args = modelHelperRunArgs({ net, image: input.image, runDir: input.runDir, sandboxIp, programArgs: input.helperArgs({ listen: helperIp, caller: sandboxIp }) });
    const started = await docker.run(args, { timeoutMs: START_TIMEOUT_MS }).catch(() => undefined);
    if (started === undefined || started.exitCode !== 0) throw new Error("run");
    await waitForHelper(call, helperName, net, sleep);
  } catch {
    await net.stop();
    throw agentXError("RUNTIME_UNAVAILABLE", MODEL_HELPER_FAILURE_SENTENCE);
  }

  const attachSandbox = async (container: string, role: "working" | "check"): Promise<void> => {
    if (role !== sandboxRole) throw agentXError("CONFIG_INVALID", `the ${role} sandbox is not served by this model helper network`);
    if (!CONTAINER_NAME.test(container)) throw agentXError("CONFIG_INVALID", "not a sandbox name for the model helper network");
    // Before the connect: a container that is already on ANOTHER run network (the working sandbox on its task's network) is never joined to this one, whoever asks. A look that cannot be read refuses too.
    const before = await networksOf(call, container);
    if (before === undefined || [...before.keys()].some((name) => RUN_NETWORK_NAME.test(name) && name !== net.name)) throw agentXError("CONFIG_INVALID", "the sandbox is already on another run network or its networks could not be read");
    await call(["network", "connect", "--ip", sandboxIp, net.name, container]);
    // The connect's own exit code does not decide: a look at the container's networks does (a refusal because it is already there passes, a connect that did nothing fails).
    const networks = await networksOf(call, container);
    if (networks === undefined || networks.get(net.name) !== sandboxIp) throw agentXError("RUNTIME_UNAVAILABLE", "the sandbox could not join the model helper's network");
  };
  return {
    kind: input.kind, network: net, helperName, helperIp, sandboxRole, sandboxIp,
    sandboxBlock: (blockInput) => ({
      role: sandboxRole,
      block: planModelHostBlock({ ...(blockInput.rows === undefined ? {} : { rows: blockInput.rows }), ...(blockInput.gatewayRows === undefined ? {} : { gatewayRows: blockInput.gatewayRows }), ...(blockInput.azureResourceHosts === undefined ? {} : { azureResourceHosts: blockInput.azureResourceHosts }), hasModelRow: true, helperIp }),
      attach: (container) => attachSandbox(container, sandboxRole),
      teardown: () => net.stop(),
    }),
    attachSandbox,
    stop: () => net.stop(),
  };
}

async function waitForHelper(call: Call, helperName: string, net: ServicesNetwork, sleep: (ms: number) => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
    const inspected = await call(["inspect", "--format", "{{.State.Running}}|{{json .NetworkSettings.Networks}}", helperName]);
    if (inspected.exitCode === 0) {
      const [running, networksText] = inspected.stdout.trim().split(/\|(.*)/su);
      const networks = parseNetworks(networksText);
      if (running === "true" && networks !== undefined) {
        // Exactly the run network, at .9: a daemon that put the helper anywhere else gives it a route the walls do not cover.
        if (networks.size !== 1 || networks.get(net.name) !== runNetworkModelHelperIp(net.slot)) throw new Error("networks");
        return;
      }
    }
    await sleep(READY_DELAY_MS);
  }
  throw new Error("not running");
}

/**
 * The non-AI block (a project with no model row): the names at the dropped address, only when the company gate is on AND this worker offers the walls (`modelHelperOffer`; the dropped address is the `rvb` wall's job). Without the walls
 * there is no block, and the block says why (`noBlockReason: "walls_not_offered"`).
 */
export function planNonAiModelHostBlock(input: { nonAiGate: boolean; rows?: readonly ModelCatalogRow[]; gatewayRows?: readonly CompanyGatewayRow[]; azureResourceHosts?: readonly string[]; environment?: NodeJS.ProcessEnv }): ModelHostBlock {
  return planModelHostBlock({
    hasModelRow: false, nonAiGate: input.nonAiGate, wallsOffered: modelHelperOffer(input.environment ?? process.env).offered,
    ...(input.rows === undefined ? {} : { rows: input.rows }), ...(input.gatewayRows === undefined ? {} : { gatewayRows: input.gatewayRows }), ...(input.azureResourceHosts === undefined ? {} : { azureResourceHosts: input.azureResourceHosts }),
  });
}

/** The worker-start sweep (run-network.ts rule 3): removes every run-network container and network of this workspace, whatever its expiry (a restarted worker's own earlier runs are all dead). Run once at startup. */
export async function sweepModelHelperNetworksAtWorkerStart(docker: DockerCli, workspace: string): Promise<{ containers: number; networks: number }> {
  if (!WORKSPACE_KEY.test(workspace)) throw agentXError("CONFIG_INVALID", "not a workspace key for a model helper");
  return sweepServicesNetworks(docker, { workspace, workerStart: true });
}

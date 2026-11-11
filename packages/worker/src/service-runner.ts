// The ServiceRunner (test services, TS17; design test-services.md 4.0 and 8): the one port every place that needs a run's dependencies goes through (Prove, task check rounds, nightly, the end-to-end checker), and its
// Docker backend, which puts a run's helpers on its own services network with the helper launcher (service-helpers.ts, TS14). A team runner's process backend is a second implementation of the same port (TS33).
//
//   start    makes the run's services network, starts the helpers on it (hardened, health-waited, fixed addresses) and hands the sandboxes their place on it;
//   probe    asks one running helper the catalog's health question again;
//   usage    what the helpers use now (memory, CPU, processes), read from Docker's own counters;
//   seeded   tells a helper's hook that the run's seeds have finished (a Postgres makes its seeded template then);
//   reset    returns one helper to its seeded state with the catalog entry's reset kind (the kinds themselves are service-reset.ts, TS18; this module only calls the hook the caller gives it);
//   stop     removes the helpers, then the network. Idempotent; never throws.
//
// Rules this module keeps, each with a test:
//   - It starts nothing on its own: no caller exists until the wiring tasks (TS30, TS32), and `tx` off means no caller, so no Docker call at all.
//   - THE SANDBOX'S PLACE ON THE NETWORK IS A PORT (`SandboxAttachment`), not code here. The working sandbox (task-sandbox.ts) and the sealed check sandbox (TS16, check-sandbox.ts) each plug in what they need: this module neither
//     imports nor knows the sealed sandbox.
//   - THE WORKER-START SWEEP (TS-RN-3 rule 3, review item L5) runs here, once per process and workspace, lazily, right before the first network is allocated: `sweepServicesNetworksAtWorkerStart`. Nothing runs at import or at
//     worker boot, so a worker that never starts a service never makes the Docker call.
//   - Every failure is one of two fixed-sentence errors: `HelperStartError` (the launcher's, passed on as it is) or `ServiceRunnerError` (this module's). Docker's own words are never repeated.
//   - A start that fails at any step removes what it made (helpers, network, the sandboxes' attachment).
import { DOCKER_CALL_TIMEOUT_MS } from "./setup-network.js";
import { startServicesNetwork, type ServicesNetwork, type StartServicesNetworkInput } from "./run-network.js";
import {
  askHelperHealth, startHelpers, sweepServicesNetworksAtWorkerStart,
  type HelperFiles, type HelperRequest, type StartedHelper, type StartHelpersInput,
} from "./service-helpers.js";
import type { ProvePorts } from "./prove.js";
import type { DockerCli } from "./swebench/containers.js";
import type { TestEnvironmentBody } from "@agentx/contracts";

export type ServiceRunnerFailure = "unknown_dependency" | "attach_failed" | "reset_unsupported" | "reset_failed" | "not_answering" | "stopped";

/** The one error of this module besides the launcher's. `message` is a fixed sentence; the dependency's id never goes in it. */
export class ServiceRunnerError extends Error {
  constructor(readonly reason: ServiceRunnerFailure) {
    super(SENTENCES[reason]);
    this.name = "ServiceRunnerError";
  }
}
const SENTENCES: Record<ServiceRunnerFailure, string> = {
  unknown_dependency: "The test services have no such dependency",
  attach_failed: "The test sandbox could not join the test services' network",
  reset_unsupported: "The test services cannot be reset in this way",
  reset_failed: "A test service could not be reset",
  not_answering: "A test service is not answering",
  stopped: "The test services were stopped",
};

/** What a sandbox needs to join the run: its network and addresses, never a secret. */
export interface SandboxNetworkView {
  name: string;
  bridge: string;
  subnet: string;
  gateway: string;
  dnsHelperIp: string;
  workingSandboxIp: string;
  checkSandboxIp: string;
  proxyIp: string;
}

/**
 * Where the sandboxes join the run. The working sandbox (task-sandbox.ts) and the sealed check sandbox (check-sandbox.ts) each implement this; the runner calls `attach` once the helpers are healthy and `detach` first
 * when the run stops. `detach` must be safe to call after a failed `attach`.
 *
 * `enterCheckRound` (optional): the run is about to be put back for an official check round. A working sandbox implements it by leaving the network (ts-sealed's `withDetachedWorking`), so nothing it runs can touch a helper while
 * the helpers are reset or while the sealed checks run. The runner calls it from `ServiceSession.enterCheckRound`, which `freshHelpers` (service-reset.ts) calls FIRST: working sandbox out, helpers fresh, checks. A sandbox
 * that never leaves (a sealed check sandbox) leaves it out.
 */
export interface SandboxAttachment {
  attach(network: SandboxNetworkView, helpers: readonly StartedHelper[]): Promise<void>;
  detach(): Promise<void>;
  enterCheckRound?(): Promise<void>;
}

/** What one helper uses right now. A number Docker did not give (or gave in a form this module does not read) is null, never a guess. */
export interface ServiceUsage {
  id: string;
  container: string;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  cpuPercent: number | null;
  pids: number | null;
}

/** The part of a helper's request a reset hook may see: no password, no files, no control token (those are secrets or seed data; the control token has its own field, for `http_reset` only). */
export type ResetRequest = Pick<HelperRequest, "id" | "name" | "entry"> & { credentials?: { user?: string; database?: string } };

/** What a reset hook is told: the helper, and the means to ask it questions. `request` carries no password (assert on `JSON.stringify(context.request)`). */
export interface ResetContext {
  /** `seeded`: the seeds have just run. `reset`: put the helper back as it was after them. */
  phase: "seeded" | "reset";
  docker: DockerCli;
  network: ServicesNetwork;
  helper: StartedHelper;
  request: ResetRequest;
  /** The per-run control token of an `http_reset` helper (Rovara local AWS), and of no other kind. Never logged, never an argument: `http_reset` writes it to an env file for the one call. */
  controlToken?: string;
  /** Asks the helper's health question once, with at most `limitMs` to answer (a restart waits on this). */
  health(limitMs?: number): Promise<boolean>;
  now(): number;
  sleep(ms: number): Promise<void>;
  signal?: AbortSignal;
}
/** What a reset left: `keptSeeds` is true when the helper is back WITH its seeded data (a Postgres template copy), false when the data is gone and the seeds must run again (a flush, a restart). */
export interface ResetOutcome { keptSeeds: boolean }
export type ResetHook = (context: ResetContext) => Promise<ResetOutcome | void>;
/** One hook per catalog reset kind (`template_db`, `flush`, `http_reset`, `restart`): service-reset.ts builds them. A kind with no hook is refused, never skipped. */
export type ResetHooks = Partial<Record<HelperRequest["entry"]["reset"]["kind"], ResetHook>>;

export interface ServiceRunnerStartInput {
  /** The run's id (a task, Prove, nightly or checker round). Only ever hashed. */
  runId: string;
  /** `setupWorkspaceKey(rootPath)`. */
  workspace: string;
  /** This run's own round budget in milliseconds. */
  roundBudgetMs: number;
  registry: string;
  edition: StartHelpersInput["edition"];
  probeImage: string;
  /** Owner-approved images by `svc/<name>@sha256:<digest>` (see `StartHelpersInput.imageReferences`). Absent: the registry names them. */
  imageReferences?: ReadonlyMap<string, string> | undefined;
  maxMemMiB: number;
  helpers: readonly HelperRequest[];
  /**
   * The run's directory seam (service-env.ts `createRunDirectoryFiles`). `stop()` removes the files the helpers need (kept for a `restart` reset until then); it does NOT remove the directory: whoever created it removes it
   * with `removeRunDirectory` after `session.stop()` has returned.
   */
  files: HelperFiles;
  /** Where the sandboxes join. Optional: a caller that starts services to look at them (a probe, a test) needs none. */
  sandboxes?: SandboxAttachment;
  resetHooks?: ResetHooks;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ServiceSession {
  readonly network: SandboxNetworkView;
  readonly helpers: readonly StartedHelper[];
  /** Asks one running helper its health question again. False when it does not answer in time; throws `unknown_dependency` for an id the run does not have. */
  probe(id: string, limitMs?: number): Promise<boolean>;
  usage(): Promise<ServiceUsage[]>;
  /** Tells the helper's hook that the run's seeds have finished. A kind with no work to do on this (everything but `template_db`) needs no hook for it. */
  seeded(id: string, signal?: AbortSignal): Promise<void>;
  /** An official check round is about to start: the sandboxes' `enterCheckRound` hook runs (the working sandbox leaves the network). Nothing to do without one. */
  enterCheckRound(signal?: AbortSignal): Promise<void>;
  /** Returns one helper to its seeded state with its catalog entry's reset kind, by the hook the caller gave. Says whether the seeded data is back (`keptSeeds`) or the seeds must run again. */
  reset(id: string, signal?: AbortSignal): Promise<ResetOutcome>;
  /** Detaches the sandboxes, removes the helpers and then the network. Idempotent; never throws. */
  stop(): Promise<void>;
}

/** The port. A second backend (processes, on a team runner) implements the same two members. */
export interface ServiceRunner {
  start(input: ServiceRunnerStartInput): Promise<ServiceSession>;
}

/** The workspaces whose earlier runs this process has already swept (rule 3 of TS-RN-3: once, when the worker first needs a service). */
const sweptAtWorkerStart = new Map<string, Promise<void>>();
/** For tests only: forgets which workspaces were swept. */
export function forgetWorkerStartSweeps(): void { sweptAtWorkerStart.clear(); }

const PROBE_NUMBER_BASE = 1_000_000;

const dockerCall = (docker: DockerCli) => (args: string[], timeoutMs = DOCKER_CALL_TIMEOUT_MS) =>
  docker.run(args, { timeoutMs }).catch((error: unknown) => ({ exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false as boolean | undefined }));

const STATS_FORMAT = "{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}\t{{.PIDs}}";
const UNITS: Readonly<Record<string, number>> = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4 };

function bytesOf(text: string | undefined): number | null {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]+)$/u.exec((text ?? "").trim());
  const unit = match?.[2] === undefined ? undefined : UNITS[match[2].toLowerCase()];
  return match?.[1] === undefined || unit === undefined ? null : Math.round(Number(match[1]) * unit);
}
function numberOf(text: string | undefined, suffix = ""): number | null {
  const trimmed = (text ?? "").trim();
  if (suffix !== "" ? !trimmed.endsWith(suffix) : false) return null;
  const body = suffix === "" ? trimmed : trimmed.slice(0, -suffix.length);
  return /^[0-9]+(?:\.[0-9]+)?$/u.test(body) ? Number(body) : null;
}

/** Parses `docker stats --no-stream --format STATS_FORMAT` for the named containers. A row that is not exactly the format is dropped; a container with no row has nulls. */
export function parseServiceUsage(stdout: string, containers: ReadonlyArray<{ id: string; container: string }>): ServiceUsage[] {
  const rows = new Map<string, string[]>();
  for (const line of stdout.split("\n")) {
    const parts = line.split("\t");
    if (parts.length === 4 && parts[0] !== undefined) rows.set(parts[0], parts);
  }
  return containers.map(({ id, container }) => {
    const row = rows.get(container);
    const [used, limit] = (row?.[1] ?? "").split("/");
    return {
      id, container,
      memoryBytes: bytesOf(used), memoryLimitBytes: bytesOf(limit),
      cpuPercent: numberOf(row?.[2], "%"), pids: numberOf(row?.[3]),
    };
  });
}

/** The Docker backend. `docker` is the worker's own CLI (or a fake in tests). */
export function createDockerServiceRunner(docker: DockerCli): ServiceRunner {
  const call = dockerCall(docker);
  return {
    async start(input) {
      // Rule 3 of TS-RN-3, lazily and once: what an earlier worker of this workspace left behind goes before the first allocation. A failed sweep is not a failed start.
      // One promise per workspace, kept: a start that arrives while the sweep runs waits for it (so it never removes a sibling start's brand-new network), and a sweep is never repeated, whatever it answered.
      let sweep = sweptAtWorkerStart.get(input.workspace);
      if (sweep === undefined) {
        sweep = sweepServicesNetworksAtWorkerStart(docker, input.workspace).then(() => undefined);
        sweptAtWorkerStart.set(input.workspace, sweep);
      }
      await sweep.catch(() => undefined);
      const networkInput: StartServicesNetworkInput = { runId: input.runId, workspace: input.workspace, roundBudgetMs: input.roundBudgetMs, ...(input.now === undefined ? {} : { now: input.now }) };
      const network = await startServicesNetwork(docker, networkInput);
      let stopped = false;
      let started: Awaited<ReturnType<typeof startHelpers>> | undefined;
      const stop = async (): Promise<void> => {
        if (stopped) return;
        stopped = true;
        await input.sandboxes?.detach().catch(() => undefined);
        await started?.stop().catch(() => undefined);
        await network.stop().catch(() => undefined);
      };
      try {
        started = await startHelpers(docker, network, {
          registry: input.registry, edition: input.edition, probeImage: input.probeImage, maxMemMiB: input.maxMemMiB, helpers: input.helpers, files: input.files,
          ...(input.imageReferences === undefined ? {} : { imageReferences: input.imageReferences }),
          ...(input.signal === undefined ? {} : { signal: input.signal }), ...(input.now === undefined ? {} : { now: input.now }), ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
        });
        const view: SandboxNetworkView = {
          name: network.name, bridge: network.bridge, subnet: network.subnet, gateway: network.gateway, dnsHelperIp: network.dnsHelperIp,
          workingSandboxIp: network.workingSandboxIp, checkSandboxIp: network.checkSandboxIp, proxyIp: network.proxyIp,
        };
        if (input.sandboxes !== undefined) await input.sandboxes.attach(view, started.helpers).catch(() => { throw new ServiceRunnerError("attach_failed"); });
        const helpers = started.helpers;
        const requests = new Map(input.helpers.map((request) => [request.id, request]));
        const find = (id: string): { helper: StartedHelper; request: HelperRequest } => {
          const helper = helpers.find((candidate) => candidate.id === id);
          const request = requests.get(id);
          if (helper === undefined || request === undefined) throw new ServiceRunnerError("unknown_dependency");
          return { helper, request };
        };
        let probeNumber = PROBE_NUMBER_BASE;
        const health = (helper: StartedHelper, request: HelperRequest) => (limitMs?: number): Promise<boolean> => {
          probeNumber += 1;
          return askHelperHealth(docker, network, { probeImage: input.probeImage, entry: request.entry, id: helper.id, address: helper.address, container: helper.container, probeNumber }, limitMs);
        };
        const clock = input.now ?? Date.now;
        const wait = input.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
        const context = (phase: ResetContext["phase"], helper: StartedHelper, request: HelperRequest, signal?: AbortSignal): ResetContext => {
          const { user, database } = request.credentials ?? {};
          // The hook sees the user and database names only: never the password, the control token or the seed files.
          const visible: ResetRequest = { id: request.id, name: request.name, entry: request.entry, credentials: { ...(user === undefined ? {} : { user }), ...(database === undefined ? {} : { database }) } };
          const controlToken = request.entry.reset.kind === "http_reset" ? request.credentials?.controlToken : undefined;
          return {
            phase, docker, network, helper, request: visible, health: health(helper, request), now: clock, sleep: wait,
            ...(controlToken === undefined ? {} : { controlToken }), ...(signal === undefined ? {} : { signal }),
          };
        };
        const session: ServiceSession = {
          network: view,
          helpers,
          async probe(id, limitMs) {
            if (stopped) throw new ServiceRunnerError("stopped");
            const { helper, request } = find(id);
            return health(helper, request)(limitMs);
          },
          async usage() {
            if (stopped || helpers.length === 0) return helpers.map((helper) => ({ id: helper.id, container: helper.container, memoryBytes: null, memoryLimitBytes: null, cpuPercent: null, pids: null }));
            const result = await call(["stats", "--no-stream", "--format", STATS_FORMAT, ...helpers.map((helper) => helper.container)]);
            return parseServiceUsage(result.exitCode === 0 ? result.stdout : "", helpers);
          },
          async enterCheckRound() {
            if (stopped) throw new ServiceRunnerError("stopped");
            await input.sandboxes?.enterCheckRound?.().catch(() => { throw new ServiceRunnerError("attach_failed"); });
          },
          async seeded(id, signal) {
            if (stopped) throw new ServiceRunnerError("stopped");
            const { helper, request } = find(id);
            const hook = input.resetHooks?.[request.entry.reset.kind];
            if (hook === undefined) return;
            try {
              await hook(context("seeded", helper, request, signal));
            } catch {
              throw new ServiceRunnerError("reset_failed");
            }
          },
          async reset(id, signal) {
            if (stopped) throw new ServiceRunnerError("stopped");
            const { helper, request } = find(id);
            const hook = input.resetHooks?.[request.entry.reset.kind];
            if (hook === undefined) throw new ServiceRunnerError("reset_unsupported");
            try {
              const outcome = await hook(context("reset", helper, request, signal));
              return { keptSeeds: outcome?.keptSeeds === true };
            } catch {
              throw new ServiceRunnerError("reset_failed");
            }
          },
          stop,
        };
        return session;
      } catch (error) {
        await stop();
        throw error;
      }
    },
  };
}

// ---- Prove's ports, filled from a runner (TS17)

type ProveService = TestEnvironmentBody["services"][number];

export interface ProveServicePlan {
  /** The run's helpers and where they live; the signal is Prove's own. */
  start: Omit<ServiceRunnerStartInput, "signal">;
  /** The dependency (a helper request id in `start.helpers`) a Prove service stands for. Undefined: this runner does not serve it. */
  dependencyIdOf(service: ProveService): string | undefined;
  /** How many requests the dependency's fake answered with no recording (the fake server's ledger, TS23). Absent: none are known, so none are counted. */
  unmatchedOf?(id: string): Promise<number>;
}

/**
 * Prove's service ports from a runner. Inert until Prove is given them: a Prove run with no dependencies never calls any of them and never starts the runner, and `release` has nothing to stop.
 *   startMock      starts the run's helpers (once, on the first call) and checks the one this service stands for answers; a service the plan does not know is refused (Prove reports `boot_failed`);
 *   probePreprod   asks a running helper again; with nothing started it answers false, so an `auto` service falls back to its mock and a `preprod` one is reported unreachable (a test account has no helper here);
 *   mockUnmatched  the plan's unmatched counts for the services Prove started;
 *   release        stops the session, whatever Prove did.
 */
export function createProveServicePorts(runner: ServiceRunner, plan: ProveServicePlan): Pick<ProvePorts, "startMock" | "probePreprod" | "mockUnmatched" | "release"> {
  let starting: Promise<ServiceSession> | undefined;
  let session: ServiceSession | undefined;
  const served = new Map<string, string>();
  const ensure = (signal: AbortSignal): Promise<ServiceSession> => {
    starting ??= runner.start({ ...plan.start, signal }).then((started) => { session = started; return started; }, (error: unknown) => { starting = undefined; throw error; });
    return starting;
  };
  return {
    async startMock(service, signal) {
      const id = plan.dependencyIdOf(service);
      if (id === undefined) throw new ServiceRunnerError("unknown_dependency");
      const running = await ensure(signal);
      if (!(await running.probe(id))) throw new ServiceRunnerError("not_answering");
      served.set(id, service.name);
    },
    async probePreprod(service) {
      const id = plan.dependencyIdOf(service);
      if (id === undefined || session === undefined) return false;
      return session.probe(id).catch(() => false);
    },
    async mockUnmatched() {
      const rows: Array<{ service: string; unmatchedFailed: number }> = [];
      for (const [id, service] of served) rows.push({ service, unmatchedFailed: plan.unmatchedOf === undefined ? 0 : await plan.unmatchedOf(id) });
      return rows;
    },
    async release() {
      const pending = starting;
      starting = undefined;
      session = undefined;
      served.clear();
      if (pending !== undefined) await (await pending.catch(() => undefined))?.stop();
    },
  };
}

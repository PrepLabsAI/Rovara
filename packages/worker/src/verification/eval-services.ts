// L4-E12 (E1, DEC 254zzz55): test services for the sealed eval box. The fresh eval sandbox (eval-bridged-exec.ts) already has a round network of its own (an `rvi` internal bridge: the model helper at .9, the box at .4). This module
// starts the project's real-software services (Postgres, MySQL, Redis, MongoDB: the same catalog, images, hardening, health checks and `--network-alias` rule the Build step's test services use) as helpers on THAT network, at the
// service addresses .16 to .47, and gives the box their connection variables (`DATABASE_URL`, `PG*`, `REDIS_URL`, ...) through its env file. The box still mounts only its checkout: a service is reached over the round network, never through
// a mount, a second network or a published port.
//
// FRESH AND IDENTICAL. `start` is called once per sealed run, so the old side and the new side each get a NEW copy: new containers on a new network, the same pinned images, the same catalog user and database names, the same seed
// seam (E3 fills it in), a new random password each (the data is identical, the secret is the run's own). Nothing one side wrote can reach the other. Everything is removed by `stop`, which the sandbox calls before it removes the network.
//
// WHAT IS NOT HERE: emulators, fakes and a company's own images (`backing` other than `local`) are not served on the eval network yet (E5 to E8); they are listed as `unsupported`, the eval runs without them and the dry run's list says
// what it needed. Seeds, migrations and generated rows are E3: the `seed` seam runs after every service is healthy and before the eval command starts, and a failure there stops the run.
import { createHash } from "node:crypto";
import { CATALOG_REGISTRY_ROOT, type TaskDependencyPlan } from "@agentx/contracts";
import type { ServicesNetwork } from "../run-network.js";
import { createRunDirectoryFiles, helperSecretValues, removeRunDirectory } from "../service-env.js";
import { HelperStartError, startHelpers, type StartedHelper } from "../service-helpers.js";
import { environmentFor, materialize, requireLocalImages, resolveDependencies, type TestServicesConfig } from "../test-services-run.js";
import type { RunHostEntry } from "../check-sandbox.js";

/** The fixed words a failed start of the eval's services is told in. Never Docker's text and never a repository's. */
export const EVAL_SERVICES_FAILURE_SENTENCE = "Rovara could not start the test services for this eval";
/** The most services one eval round starts (the Build step's own per-run limit). */
export const EVAL_SERVICES_MAX = 12;
/** One retry of a start that failed (design 3, rule 4: a stand-in that will not start is Rovara's problem: retry once, then Not run). */
const START_ATTEMPTS = 2;

export interface EvalServicesStarted {
  /** Every name the box reaches a service by and the helper's address (.16 to .47 of the round's slot). */
  readonly hosts: readonly RunHostEntry[];
  /** `[NAME, value]` in the order they go into the box's env file: the connection variables of every service (`DATABASE_URL`, `PGHOST`, ...). Plain values only. */
  readonly env: ReadonlyArray<readonly [string, string]>;
  /** The values that must never show in the eval's output tail (each service's password). */
  readonly secrets: readonly string[];
  /** Which services are up, by the plan's own ids, with their address and ports. */
  readonly started: readonly Pick<StartedHelper, "id" | "address" | "ports">[];
  /** Plan ids this eval round does not serve yet (an emulator, a fake, a company image): the eval runs without them. */
  readonly unsupported: readonly string[];
  /** Removes every service container and the run's files. Idempotent; never throws. */
  stop(): Promise<void>;
}

export interface EvalServicesStarter {
  /**
   * Starts a FRESH copy of the project's services on this round's network. Resolves with nothing started (`started: []`) for a plan with no real-software service. Throws a fixed-word Error on any failure, after removing whatever
   * it made.
   */
  start(net: ServicesNetwork, signal: AbortSignal): Promise<EvalServicesStarted>;
}

export interface EvalServicesInput {
  /** The worker's test-services configuration (its Docker, catalog, registry or owner image list, limits and run-files folder). Absent: the worker offers no test services (`createEvalServicesStarter` answers undefined). */
  readonly config: TestServicesConfig | undefined;
  /** The task's dependency plan (`payload.testServices.dependencies`): the broker's own, checked here against the worker's catalog again. */
  readonly dependencies: readonly TaskDependencyPlan[] | undefined;
  /** E3's seam: loads the project's migrations and seeds into this round's services (they are healthy, the eval has not started). Absent: the services start empty. */
  readonly seed?: ((started: Omit<EvalServicesStarted, "stop">, net: ServicesNetwork, signal: AbortSignal) => Promise<void>) | undefined;
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The starter, or undefined when this worker offers no test services or the plan has nothing to start (the eval then runs exactly as it did before). */
export function createEvalServicesStarter(input: EvalServicesInput): EvalServicesStarter | undefined {
  const config = input.config;
  const dependencies = input.dependencies;
  if (config === undefined || dependencies === undefined || !dependencies.some((plan) => plan.backing === "local")) return undefined;
  return {
    async start(net, signal) {
      let lastError: unknown;
      for (let attempt = 1; attempt <= START_ATTEMPTS; attempt += 1) {
        if (signal.aborted) throw new Error("eval stage stopped");
        try { return await startOnce(config, dependencies, input.seed, net, signal); } catch (error) { lastError = error; }
      }
      void lastError;
      throw new Error(EVAL_SERVICES_FAILURE_SENTENCE);
    },
  };
}

async function startOnce(config: TestServicesConfig, dependencies: readonly TaskDependencyPlan[], seed: EvalServicesInput["seed"], net: ServicesNetwork, signal: AbortSignal): Promise<EvalServicesStarted> {
  const locals = dependencies.filter((plan) => plan.backing === "local");
  const unsupported = dependencies.filter((plan) => plan.backing !== "local").map((plan) => plan.id);
  if (locals.length === 0 || locals.length > EVAL_SERVICES_MAX) throw new Error(EVAL_SERVICES_FAILURE_SENTENCE);
  const catalog = await config.catalog();
  const bases = resolveDependencies(catalog, locals, config);
  // The worker never pulls: every digest must already be on this host (root pulled it at boot), or nothing starts.
  await requireLocalImages(config.docker, config, bases, signal);
  const resolved = bases.map((base) => materialize(base, "check", new Map()));
  const files = await createRunDirectoryFiles(config.runDirectoryParent, `evs-${sha(net.name).slice(0, 16)}`);
  let helpers: Awaited<ReturnType<typeof startHelpers>> | undefined;
  const stop = async (): Promise<void> => {
    await helpers?.stop().catch(() => undefined);
    await removeRunDirectory(files.directory).catch(() => undefined);
  };
  try {
    helpers = await startHelpers(config.docker, net, {
      registry: `${config.registry}/${CATALOG_REGISTRY_ROOT}/${config.catalogEnv}`, edition: config.edition, probeImage: config.probeImage, maxMemMiB: config.maxMemMiB,
      // The round's own fixed containers (the model helper, the name server, the box) count toward the guard's ceiling.
      ...(config.limits === undefined ? {} : { limits: { containers: Math.max(1, config.limits.containers - 1), helperMemMiB: config.limits.helperMemMiB } }),
      ...(config.imageReferences === undefined ? {} : { imageReferences: config.imageReferences }),
      helpers: resolved.map((item) => item.request), files, signal,
      ...(config.now === undefined ? {} : { now: config.now }), ...(config.sleep === undefined ? {} : { sleep: config.sleep }),
    });
    const environment = environmentFor("check", resolved);
    const started: Omit<EvalServicesStarted, "stop"> = {
      hosts: helpers.helpers.flatMap((helper) => helper.aliases.map((alias) => ({ alias, address: helper.address }))),
      env: environment.entries,
      secrets: [...new Set([...environment.secretValues, ...helperSecretValues(resolved.map((item) => item.request))])],
      started: helpers.helpers.map(({ id, address, ports }) => ({ id, address, ports })),
      unsupported,
    };
    await seed?.(started, net, signal);
    return { ...started, stop };
  } catch (error) {
    await stop();
    // The message is always the fixed sentence; the cause stays with the error and is never read into a message or a log line.
    if (error instanceof HelperStartError) throw new Error(EVAL_SERVICES_FAILURE_SENTENCE, { cause: error });
    throw error;
  }
}

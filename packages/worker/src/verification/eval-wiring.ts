// The worker's binding of the final-check eval for ONE task invocation (plan v3.2 row 20.2). main.ts calls `evalFinalCheckForTask` for a task that carries an
// `evalRequest`; the answer is the `evalFinalCheck` dependency of `runTaskInvocation`, or undefined (the request then reads "not run: not connected", zero calls,
// exactly as before this file).
//
// OFF BY DEFAULT. The eval binds only when the host's environment names the model gateway's address (`ROVARA_EVAL_GATEWAY_URL`, an https origin; on a hosted worker the broker delivers it with the eval request instead, `evalEnvironmentWithGateway`), the trusted sources
// below are present and whole, and (for a result at all) a fresh check sandbox is available. Anything less is undefined, or a round kind of "working", which reads
// "needs a fresh sandbox" before any money is held. Nothing here throws to its caller.
//
// THE ONE MODEL ROUTE. The eval's model calls go only through the gateway's product route (`createEvalGatewayAccess`, #714): a whole-stage hold, then each call once
// to `/v1/product/gemini/...` with the task token. The token is the one the control plane mints for this operation (`/v1/internal/model-access`, the operation's own
// callback capability). It is sent only to the origin it was minted for: a token whose `baseUrl` is not the configured gateway's origin (an install with no gateway,
// or a proxy key) is never sent anywhere. The token never enters the sandbox (the bridge's egress is the stage's call), a log line, an error or an artifact.
//
// THE TRUSTED SOURCES (DEC 253j(1)): the confirmed plan with its question inventory, the persisted approval and the company-scoped baseline cache are delivered from the
// control plane through the signed `eval-plan` callback (`evalPlanSourcesFor`).
//
// THE FRESH CHECK SANDBOX (DEC 253n(2), TE-B1). `plannedFreshEvalSandbox` builds `createFreshEvalSandbox` per run, from the SAME delivered plan: its confirmed command and report path (held
// to the plan's stored command hash), its model row, and, from this check's own pin (`withEvalPinnedCandidate`), the base and candidate commits, the working sandbox and the round's budget and
// scratch folder. The worker's own pinned image (AGENTX_WORKER_IMAGE) runs it, and only when its digest is the plan's image digest. The candidate commit's own tree must be the pinned candidate
// tree the plan's head hashes were read from. Anything missing or different: the run fails before anything starts, and the eval reads Not run.
import type { EvalGatewayTokenSource } from "./eval-gateway-access.js";
import { createEvalGatewayAccess } from "./eval-gateway-access.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalImageDigestOf } from "@agentx/contracts";
import { createBridgedEvalExec, createFreshEvalSandbox, freshEvalSandboxOffered, FRESH_EVAL_RUN_MAX_MS, type FreshEvalSandbox, type FreshEvalSandboxConfig } from "./eval-bridged-exec.js";
import { createProcessCandidateGit } from "../e2e-candidate-source.js";
import type { DockerCli } from "../swebench/containers.js";
import { createEvalFinalCheckPorts, type EvalHostCapabilities } from "./eval-host.js";
import type { EvalFinalCheckPorts } from "./eval-final-check.js";
import type { EvalMeterOptions } from "./eval-model-access.js";
import type { ModelEgressFrame } from "@agentx/contracts";
import { modelAccessSource } from "../model-access.js";
import { evalChangedPrompt } from "./eval-changed-prompt.js";
import { createEvalBaselines } from "./eval-baseline-refresh.js";
import { evalSourcesFromDelivery, fetchEvalPlanDelivery, type DeliveredEvalSources } from "./eval-plan-delivery.js";
import { pinnedEvalFreshCheck, pinnedEvalPlan } from "./eval-plan-source.js";

/** The host's setting that turns the eval on: the model gateway's https origin. Unset (the default), or anything else: the eval stays off. */
export const EVAL_GATEWAY_URL_VARIABLE = "ROVARA_EVAL_GATEWAY_URL";

/** The gateway's origin from the environment, or undefined: https only, an origin (a bare `/` path at most), no credentials, query or fragment, at most 512 characters. Never throws, never echoes the value. */
export function evalGatewayOriginFrom(environment: NodeJS.ProcessEnv): string | undefined {
  const raw = environment[EVAL_GATEWAY_URL_VARIABLE]?.trim();
  if (raw === undefined || raw === "" || raw.length > 512) return undefined;
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  // Exactly an origin: anything with credentials, a path, a query or a fragment makes the text differ from `origin` (or `origin/`).
  if (url.protocol !== "https:" || (raw !== url.origin && raw !== `${url.origin}/`)) return undefined;
  return url.origin;
}

/**
 * The environment the eval binding reads (`evalFinalCheckForTask`): the host's own, plus the gateway origin the broker delivered with this task's eval request (`evalGatewayUrl`, a hosted worker has no setting of its own).
 * The host's own `ROVARA_EVAL_GATEWAY_URL` always wins: when it is set at all (even to something that makes the eval stay off) nothing is added. A delivered value that is not exactly an https origin adds nothing. Nothing delivered
 * (a laptop, an older broker, an install with no gateway) returns the host's environment itself, so the eval is exactly as it was. Never throws; the host's environment is not changed.
 */
export function evalEnvironmentWithGateway(environment: NodeJS.ProcessEnv, delivered: string | undefined): NodeJS.ProcessEnv {
  try {
    if (typeof delivered !== "string") return environment;
    const own = environment[EVAL_GATEWAY_URL_VARIABLE];
    if (typeof own === "string" && own.trim() !== "") return environment;
    const origin = evalGatewayOriginFrom({ [EVAL_GATEWAY_URL_VARIABLE]: delivered });
    return origin === undefined ? environment : { ...environment, [EVAL_GATEWAY_URL_VARIABLE]: origin };
  } catch { return environment; }
}

/** The trusted capabilities of one invocation, made from this invocation's own scope only (nothing is shared across invocations or companies). */
export interface EvalHostSources {
  readonly plan: EvalHostCapabilities["plan"];
  readonly approval: EvalHostCapabilities["approval"];
  readonly cache: EvalHostCapabilities["cache"];
  readonly baselines: EvalHostCapabilities["baselines"];
  /** The check round's fresh sandbox. */
  readonly sandbox: FreshEvalSandbox;
  /** The worker's own folder for the run's socket (absolute; short enough for a Unix socket path). */
  readonly runDir: string;
  /** The worker's own "this frame carries a changed prompt". Defaults to F4/F8 over this check's pinned candidate; unknown counts as changed. */
  readonly changedPrompt?: (frame: ModelEgressFrame) => boolean;
  /** The worker's own pin of the model, from the trusted plan: true only for a frame that calls the plan's model (and judge). Required: the repository's eval code must not choose the model. */
  readonly modelAllowed: (frame: ModelEgressFrame) => boolean;
  readonly meter?: EvalMeterOptions;
}

/** The longest the one eval-plan ask may take. */
export const EVAL_PLAN_ASK_TIMEOUT_MS = 30_000;

/** The invocation fields the trusted sources are asked with: this operation's own ids and capability. */
export interface EvalSourceInvocation { readonly workspaceId: string; readonly operationId: string; readonly callbackCapability: string }

/** The check round's own pieces, from the host (TE-B1's fresh sandbox, the worker's socket folder and its model pin). */
export interface EvalCheckHost {
  readonly sandbox: FreshEvalSandbox;
  readonly runDir: string;
  readonly modelAllowed: (frame: ModelEgressFrame) => boolean;
  readonly changedPrompt?: (frame: ModelEgressFrame) => boolean;
  readonly meter?: EvalMeterOptions;
}

/**
 * DEC 253j(1): the trusted plan, approval and baseline cache of this invocation, through the signed `eval-plan` callback (one ask, made at the first read, with this operation's own
 * capability). The plan is the broker's stored plan completed with this check's own per-task hashes from the pinned candidate (`pinnedEvalPlan`, inside `withEvalPinnedCandidate`);
 * the approval and the cache are read-only views of the delivered answer. A refused or failed ask gives no plan, no grant and a cache that misses: "not connected", zero calls.
 */
export function evalPlanSourcesFor(invocation: EvalSourceInvocation, options: { readonly controlPlaneUrl: string; readonly fetch?: typeof fetch }): Pick<EvalHostSources, "plan" | "approval" | "cache" | "baselines"> & { readonly deliveredPlan: () => Promise<unknown> } {
  let delivery: Promise<DeliveredEvalSources | undefined> | undefined;
  const delivered = (): Promise<DeliveredEvalSources | undefined> => delivery ??= fetchEvalPlanDelivery({
    controlPlaneUrl: options.controlPlaneUrl, workspaceId: invocation.workspaceId, operationId: invocation.operationId, capability: invocation.callbackCapability,
    // One bounded ask: a broker that hangs is "not available" after 30 seconds, never held to the round deadline.
    signal: AbortSignal.timeout(EVAL_PLAN_ASK_TIMEOUT_MS),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  }).then(evalSourcesFromDelivery, () => undefined);
  return {
    plan: async () => { try { const found = await delivered(); return found === undefined ? undefined : await pinnedEvalPlan(await found.plan()); } catch { return undefined; } },
    approval: { read: async () => { try { return await (await delivered())?.approval.read(); } catch { return undefined; } } },
    cache: {
      read: async (parts) => { try { return await (await delivered())?.cache.read(parts); } catch { return undefined; } },
      readMeasurement: async (parts) => { try { return (await (await delivered())?.cache.readMeasurement?.(parts)) ?? "unavailable"; } catch { return "unavailable"; } },
      // Base rounds are never saved from a worker through this route.
      write: async () => "refused",
    },
    baselines: createEvalBaselines(),
    // The same one ask's plan, for the fresh check sandbox (its command, row and image).
    deliveredPlan: async () => { try { const found = await delivered(); return found === undefined ? undefined : await found.plan(); } catch { return undefined; } },
  };
}

/** The worker's own image variable: the model helper and the fresh check sandbox run it (pinned by digest). */
export const EVAL_WORKER_IMAGE_VARIABLE = "AGENTX_WORKER_IMAGE";

/** What the worker host gives the fresh check sandbox: its environment (the image and the helper's walls), its Docker and its workspace key. */
export interface EvalFreshHost {
  readonly environment: NodeJS.ProcessEnv;
  readonly docker: DockerCli;
  /** `setupWorkspaceKey(rootPath)`: the round network's labels and sweep. */
  readonly workspaceKey: () => Promise<string>;
  /** Test seam; default `createFreshEvalSandbox`. */
  readonly make?: (config: FreshEvalSandboxConfig) => FreshEvalSandbox;
  /** Test seam: the tree of a commit in a repository. Default: the safe git path (`createProcessCandidateGit(...).treeOf`). */
  readonly treeOf?: (directory: string, commit: string, signal: AbortSignal) => Promise<string>;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * DEC 253n(2): the check round's fresh sandbox and model pin, built per run from the delivered plan (`deliveredPlan`) and this check's pin. `available()` answers only what the host can know before
 * the plan is read (a pinned worker image and the model helper's walls); everything else is checked at `run`, which throws (Not run) before anything starts when it does not hold.
 */
export function plannedFreshEvalSandbox(host: EvalFreshHost, invocation: Pick<EvalSourceInvocation, "operationId">, deliveredPlan: () => Promise<unknown>): Pick<EvalCheckHost, "sandbox" | "runDir" | "modelAllowed"> {
  const image = host.environment[EVAL_WORKER_IMAGE_VARIABLE]?.trim();
  // The model the running plan pins (set when a run has read its plan): a frame for another row or model is refused before the stage.
  let pinned: { row: string; path: RegExp } | undefined;
  const sandbox: FreshEvalSandbox = {
    available(): boolean {
      try { return evalImageDigestOf(image) !== undefined && typeof host.docker?.run === "function" && freshEvalSandboxOffered(host.environment); } catch { return false; }
    },
    async run(input) {
      const check = pinnedEvalFreshCheck(await deliveredPlan());
      if (check === undefined || image === undefined) throw new Error("no fresh sandbox");
      // The image the plan was measured with is the image that runs: the worker's own, by digest.
      const digest = evalImageDigestOf(image);
      if (digest === undefined || digest !== evalImageDigestOf(check.imageDigest)) throw new Error("no fresh sandbox");
      // The new side runs the candidate COMMIT: its tree must be the pinned candidate tree the plan's head hashes came from (no uncommitted change is left out).
      const scratch = await mkdtemp(join(check.round.scratchDir, "tree-"));
      try {
        const tree = await (host.treeOf ?? ((directory, commit, signal) => createProcessCandidateGit(scratch).treeOf(directory, commit, signal)))(check.repository.directory, check.repository.candidateCommit, input.signal);
        if (tree !== check.repository.candidateTree) throw new Error("no fresh sandbox");
      } finally { await rm(scratch, { recursive: true, force: true }).catch(() => undefined); }
      const config: FreshEvalSandboxConfig = {
        docker: host.docker, image, workspace: await host.workspaceKey(), taskId: invocation.operationId,
        roundBudgetMs: Math.min(Math.max(1, Math.floor(check.round.roundBudgetMs)), FRESH_EVAL_RUN_MAX_MS),
        repository: { directory: check.repository.directory, baseCommit: check.repository.baseCommit, candidateCommit: check.repository.candidateCommit },
        command: check.command, report: check.report, rowId: check.rowId, scratchDir: check.round.scratchDir, workingSandbox: check.round.workingSandbox, environment: host.environment,
      };
      pinned = { row: check.rowId, path: new RegExp(`^/v1(?:beta)?/models/${escapeRegExp(check.model)}:(?:generateContent|streamGenerateContent)$`, "u") };
      return await (host.make ?? createFreshEvalSandbox)(config).run(input);
    },
  };
  return {
    sandbox,
    // Short and the worker's own: each run makes a private (0700) folder in it for the bridge socket and removes it.
    runDir: tmpdir(),
    modelAllowed: (frame) => pinned !== undefined && frame.row === pinned.row && pinned.path.test(frame.path),
  };
}

/**
 * The sources for this invocation, or undefined (the eval stays "not connected"). The plan, the approval and the baseline cache come from the broker (`evalPlanSourcesFor`); the check
 * round's sandbox, socket folder and model pin come from `check`, or (production) from `fresh`: the fresh sandbox built per run from the delivered plan. Without either there are no sources.
 */
export function evalHostSourcesFor(invocation: EvalSourceInvocation, host: { readonly controlPlaneUrl: string; readonly fetch?: typeof fetch; readonly check?: EvalCheckHost | undefined; readonly fresh?: EvalFreshHost | undefined }): EvalHostSources | undefined {
  try {
    if (typeof host.controlPlaneUrl !== "string" || host.controlPlaneUrl === "") return undefined;
    const { deliveredPlan, ...sources } = evalPlanSourcesFor(invocation, { controlPlaneUrl: host.controlPlaneUrl, ...(host.fetch === undefined ? {} : { fetch: host.fetch }) });
    // DEC 253n(2): without a given check host, the fresh sandbox is built per run from the same delivered plan (production).
    const fresh = host.check === undefined ? host.fresh : undefined;
    const check: EvalCheckHost | undefined = host.check ?? (fresh === undefined ? undefined : plannedFreshEvalSandbox(fresh, invocation, deliveredPlan));
    if (check === undefined) return undefined;
    // A plan this worker's fresh sandbox can never run (no confirmed command, as before 253n; another image than the worker's) is no plan: "not connected", before any hold.
    const plan: EvalHostSources["plan"] = fresh === undefined ? sources.plan : async () => {
      try {
        const found = pinnedEvalFreshCheck(await deliveredPlan());
        const image = evalImageDigestOf(fresh.environment[EVAL_WORKER_IMAGE_VARIABLE]?.trim());
        if (found === undefined || image === undefined || image !== evalImageDigestOf(found.imageDigest)) return undefined;
        return await sources.plan();
      } catch { return undefined; }
    };
    return { ...sources, plan,
      sandbox: check.sandbox, runDir: check.runDir, modelAllowed: check.modelAllowed,
      ...(check.changedPrompt === undefined ? {} : { changedPrompt: check.changedPrompt }), ...(check.meter === undefined ? {} : { meter: check.meter }) };
  } catch { return undefined; }
}

export interface EvalTaskBindingInput {
  /** The task carries an `evalRequest`. A task without one gets nothing (the CHECKS path is byte-identical to before). */
  readonly requested: boolean;
  readonly environment: NodeJS.ProcessEnv;
  readonly controlPlaneUrl: string;
  /** This operation's callback capability: the one request for the task token. */
  readonly capability: string;
  readonly sources: EvalHostSources | undefined;
  /** Test seam; default the Node built-in. */
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

/** The task token source: asks the control plane for this operation's access and returns its key only when it was minted for `origin`. A different origin, an unreadable address or any fault is a refusal (no token). */
export function evalGatewayTokenSource(input: { origin: string; controlPlaneUrl: string; capability: string; fetch?: typeof fetch; now?: () => number }): EvalGatewayTokenSource {
  const access = modelAccessSource({
    controlPlaneUrl: input.controlPlaneUrl, capability: input.capability,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.now === undefined ? {} : { now: input.now }),
  });
  return async () => {
    const granted = await access();
    let origin: string;
    try { origin = new URL(granted.baseUrl).origin; } catch { throw new Error("the task token is not for the eval gateway"); }
    if (origin !== input.origin) throw new Error("the task token is not for the eval gateway");
    return granted.apiKey;
  };
}

const isWhole = (sources: EvalHostSources | undefined): sources is EvalHostSources => typeof sources === "object" && sources !== null
  && typeof sources.sandbox === "object" && sources.sandbox !== null && typeof sources.sandbox.available === "function" && typeof sources.sandbox.run === "function"
  && typeof sources.modelAllowed === "function" && typeof sources.runDir === "string" && sources.runDir.startsWith("/");

/** The ports of the final-check eval for this task, or undefined. Never throws. */
export function evalFinalCheckForTask(input: EvalTaskBindingInput): EvalFinalCheckPorts | undefined {
  try {
    if (input.requested !== true) return undefined;
    const origin = evalGatewayOriginFrom(input.environment);
    if (origin === undefined || !isWhole(input.sources)) return undefined;
    const sources = input.sources;
    const changedPrompt = sources.changedPrompt ?? evalChangedPrompt;
    if (typeof input.controlPlaneUrl !== "string" || input.controlPlaneUrl === "" || typeof input.capability !== "string" || input.capability === "") return undefined;
    const modelAccess = createEvalGatewayAccess(origin, evalGatewayTokenSource({ origin, controlPlaneUrl: input.controlPlaneUrl, capability: input.capability, ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.now === undefined ? {} : { now: input.now }) }),
      input.fetch === undefined ? {} : { fetch: input.fetch });
    // A sandbox that cannot start a fresh round is the working round: "needs a fresh sandbox", before any hold.
    let fresh = false;
    try { fresh = sources.sandbox.available() === true; } catch { fresh = false; }
    return createEvalFinalCheckPorts({
      roundKind: fresh ? "check_unsealed" : "working",
      plan: sources.plan, approval: sources.approval, cache: sources.cache, baselines: sources.baselines,
      modelAccess,
      exec: createBridgedEvalExec({ sandbox: sources.sandbox, runDir: sources.runDir, modelAllowed: sources.modelAllowed, changedPrompt, ...(input.now === undefined ? {} : { now: input.now }) }),
      ...(sources.meter === undefined ? {} : { meter: sources.meter }),
    });
  } catch { return undefined; }
}

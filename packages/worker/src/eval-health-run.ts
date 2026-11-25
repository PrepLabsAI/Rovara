// L4-EVH (DEC 254zzz20 D5): the prepare rider of the opt-in eval HEALTH RUN. After the broker's read-only, pinned preparation of the project (main's heads, `pins`), the worker measures the project's evals three times in a
// fresh sandbox through the gateway (verification/eval-health-job.ts) and posts the one result to the broker's `eval-health-result`, under the request and claim it was made for.
//   - the pin is main itself: the "candidate" the fresh sandbox runs is the commit of each repository's own checkout (the broker's pinned head, which the preparation refused unless it resolved to the same commit), so the
//     sandbox the eval runs in is exactly main, in the project's saved environment where it has one (the same delivered plan and environment a CHECKS run's fresh sandbox is built from);
//   - the plan, the grant and the model access are the broker's, read through the run's own capability; a worker that cannot reach any of them posts "not run" and spends nothing;
//   - the whole run has its own deadline, inside the broker's window for a claim (`EVAL_HEALTH_RUN_MAX_MS`), and a stop from the broker's cancel; a result is posted even for a stopped or refused run (so the person is told why).
// Nothing here prints a body, a header, a token or a cause. The post is retried a few times within its own bounded budget; a result that was never accepted is a claim that never reports (the broker's window ends it).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVAL_HEALTH_RESULT_PATH, EVAL_HEALTH_RUN_MAX_MS, PrepareEvalHealthSchema, type EvalHealthResultBody, type WorkerInvocation } from "@agentx/contracts";
import { createProcessCandidateGit } from "./e2e-candidate-source.js";
import type { PreparationManifest } from "./prepare.js";
import { setupWorkspaceKey } from "./setup-network.js";
import type { DockerCli } from "./docker-cli.js";
import { withEvalPinnedCandidate } from "./verification/eval-plan-source.js";
import { runEvalHealthJob, type EvalHealthJobPorts } from "./verification/eval-health-job.js";
import { evalEnvironmentWithGateway, evalFinalCheckForTask, evalHostSourcesFor } from "./verification/eval-wiring.js";
import { createEvalServicesStarter } from "./verification/eval-services.js";
import { testServicesConfigFromEnvironment } from "./test-services-run.js";

/** The job's own deadline: inside the broker's window, with room to post. */
export const EVAL_HEALTH_JOB_MS = EVAL_HEALTH_RUN_MAX_MS - 10 * 60_000;
export const EVAL_HEALTH_POST_MS = 5 * 60_000;

export interface EvalHealthRiderDeps {
  rootPath: string;
  controlPlaneUrl: string;
  invocation: Extract<WorkerInvocation, { kind: "prepare" }>;
  manifest: Pick<PreparationManifest, "repositories">;
  docker: DockerCli;
  signal: AbortSignal;
  environment?: NodeJS.ProcessEnv | undefined;
  fetch?: typeof fetch | undefined;
  /** Test seam: the job's ports. Default: the production binding (the delivered plan and environment, the fresh check sandbox, the gateway's hold). */
  ports?: ((invocation: Extract<WorkerInvocation, { kind: "prepare" }>) => EvalHealthJobPorts | undefined) | undefined;
  /** Test seam: the tree of a commit in a repository. Default: the safe git path. */
  treeOf?: ((directory: string, commit: string, signal: AbortSignal) => Promise<string>) | undefined;
}

const SHA = /^[a-f0-9]{40}$/u;

/** Runs the health job of this preparation, posts its result, and returns it. Undefined: this preparation is not a health run's. Never throws. */
export async function runEvalHealthRider(deps: EvalHealthRiderDeps): Promise<EvalHealthResultBody | undefined> {
  const job = PrepareEvalHealthSchema.safeParse(deps.invocation?.payload?.evalHealth);
  if (deps.invocation === null || typeof deps.invocation !== "object" || deps.invocation.kind !== "prepare" || deps.invocation.payload?.evalHealth === undefined) return undefined;
  const fixed = (reason: "invalid_identity" | "stopped" | "unavailable" | "not_connected"): EvalHealthResultBody | undefined => job.success ? { requestId: job.data.requestId, claimId: job.data.claimId, result: { status: "not_run", reason } } : undefined;
  if (!job.success) return undefined;
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (deps.signal.aborted) stop(); else deps.signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, EVAL_HEALTH_JOB_MS);
  const startedAt = Date.now();
  let scratch: string | undefined;
  let answer: EvalHealthResultBody | undefined;
  try {
    try {
      answer = await measure(deps, job.data, controller.signal, async () => { scratch = await mkdtemp(join(tmpdir(), "eval-health-")); return scratch; }) ?? fixed("not_connected");
    } catch { answer = fixed(controller.signal.aborted ? "stopped" : "unavailable"); }
    if (answer !== undefined) await post(deps, answer, Math.max(0, Math.min(EVAL_HEALTH_POST_MS, EVAL_HEALTH_RUN_MAX_MS - (Date.now() - startedAt))));
    return answer;
  } finally {
    clearTimeout(timer); deps.signal.removeEventListener("abort", stop);
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function measure(deps: EvalHealthRiderDeps, job: { requestId: string; claimId: string }, signal: AbortSignal, makeScratch: () => Promise<string>): Promise<EvalHealthResultBody | undefined> {
  const invocation = deps.invocation;
  const pins = invocation.payload.pins;
  const repositories = deps.manifest?.repositories;
  // Main is exactly what the broker pinned: every repository of the preparation resolved to the pinned head (the preparation refuses otherwise), and nothing else is in the project.
  if (!Array.isArray(pins) || !Array.isArray(repositories) || repositories.length === 0 || repositories.length !== pins.length
    || repositories.some(repo => typeof repo?.name !== "string" || typeof repo.path !== "string" || !SHA.test(repo.resolvedCommit) || pins.find(pin => pin.repository === repo.name)?.commit !== repo.resolvedCommit)) {
    return { requestId: job.requestId, claimId: job.claimId, result: { status: "not_run", reason: "invalid_identity" } };
  }
  const environment = evalEnvironmentWithGateway(deps.environment ?? process.env, invocation.payload.evalGatewayUrl);
  const ports = deps.ports !== undefined ? deps.ports(invocation) : (() => {
    const sources = evalHostSourcesFor({ workspaceId: invocation.workspaceId, operationId: invocation.operationId, callbackCapability: invocation.callbackCapability },
      { controlPlaneUrl: deps.controlPlaneUrl, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }), fresh: { environment, docker: deps.docker, standIns: { dependencies: invocation.payload.testServices?.dependencies }, workspaceKey: () => setupWorkspaceKey(deps.rootPath),
        // L4-E12 (E1): the baseline's three runs each get their own copy of the task's services, when this worker offers them.
        services: () => createEvalServicesStarter({ config: testServicesConfigFromEnvironment(environment, deps.docker), dependencies: invocation.payload.testServices?.dependencies }) } });
    const bound = evalFinalCheckForTask({ requested: true, environment, controlPlaneUrl: deps.controlPlaneUrl, capability: invocation.callbackCapability, sources, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) });
    // Only a fresh check sandbox measures a baseline: a host that cannot start one reads "not connected", before any hold.
    return bound === undefined || bound.roundKind !== "check_unsealed" ? undefined : bound;
  })();
  if (ports === undefined) return { requestId: job.requestId, claimId: job.claimId, result: { status: "not_run", reason: "not_connected" } };
  const scratch = await makeScratch();
  const treeOf = deps.treeOf ?? ((directory: string, commit: string, abort: AbortSignal) => createProcessCandidateGit(scratch).treeOf(directory, commit, abort));
  const input = repositories.map(repo => ({ repositoryId: repo.name, directory: join(deps.rootPath, repo.path), baseCommitSha: repo.resolvedCommit }));
  const candidates = [];
  // The candidate IS main: the same commit as the base, and the tree it has.
  for (const repo of input) candidates.push({ repositoryId: repo.repositoryId, baseCommitSha: repo.baseCommitSha, commitSha: repo.baseCommitSha, treeSha: await treeOf(repo.directory, repo.baseCommitSha, signal) });
  return await withEvalPinnedCandidate(input, candidates, signal, () => runEvalHealthJob(job, ports, signal), { workingSandbox: null, roundBudgetMs: Math.max(1, EVAL_HEALTH_JOB_MS), scratchDir: scratch });
}

async function post(deps: EvalHealthRiderDeps, body: EvalHealthResultBody, budgetMs: number): Promise<boolean> {
  const send = deps.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  if (budgetMs === 0) controller.abort();
  const invocation = deps.invocation;
  try {
    for (let attempt = 0; attempt < 3 && !controller.signal.aborted; attempt += 1) {
      try {
        const response = await send(`${deps.controlPlaneUrl.replace(/\/$/u, "")}/v1/internal/workspaces/${encodeURIComponent(invocation.workspaceId)}/operations/${encodeURIComponent(invocation.operationId)}/${EVAL_HEALTH_RESULT_PATH}`, {
          method: "POST", headers: { "content-type": "application/json", "x-agentx-callback-capability": invocation.callbackCapability }, body: JSON.stringify(body), signal: controller.signal,
        });
        await response.body?.cancel().catch(() => undefined);
        if (response.ok) return true;
      } catch { /* a fixed, bounded retry; never a cause or a response */ }
    }
    return false;
  } finally { clearTimeout(timer); }
}

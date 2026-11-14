import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  PrepareSetupProveSchema, SETUP_PROVE_RESULT_PATH, WorkerInvocationSchema, inertEvidenceText, testEnvDigest,
  type TestEnvProveReport, type WorkerInvocation,
} from "@agentx/contracts";
import { WORKER_IMPLEMENTED_FEATURES } from "./implemented-features.js";
import { proveWithMachineMeasurement } from "./machine-measurement.js";
import type { PreparationManifest } from "./prepare.js";
import type { BuildSandbox } from "./saved-env/build.js";
import { liveTaskSandboxes, workspaceBuildSandbox } from "./saved-env/rebuild.js";
import { sharesWorkspace } from "./setup-agent-prove.js";
import type { DockerCli } from "./swebench/containers.js";
import { TaskSandbox } from "./task-sandbox.js";

const PROVE_MS = 40 * 60_000;
const POST_MS = 120_000;
const OUTPUT_BYTES = 4 * 1_048_576;
export type SetupProveResult = { ok: true; report: TestEnvProveReport } | { ok: false; reason: "invalid_job" | "services_need_prove" | "commits_mismatch" | "not_fresh" | "fresh_sandbox_failed" | "prove_failed" | "aborted" | "cleanup_failed" };
export interface SetupProvePorts {
  /** Makes the already pinned clone's sandbox, without starting any project process. Must join cancellation before returning. */
  makeFresh(signal: AbortSignal): Promise<BuildSandbox>;
  /** Trusted sandbox-specific source; absent in production until the cgroup visibility work lands. */
  cgroupDirectoryOf?(sandbox: BuildSandbox): string | undefined;
  realPath?(path: string): Promise<string>;
  /** Test seams only; never taken from the invocation. */
  arch?: string;
  workerFeatures?: readonly string[];
}
interface SetupProveInput {
  job: unknown;
  manifest: Pick<PreparationManifest, "repositories">;
  /** Worker-owned registry of other operations and sandboxes, never invocation data. */
  notFrom: readonly { id: string; rootPath: string }[];
  signal: AbortSignal;
  deadlineMs: number;
}
const fail = (reason: Extract<SetupProveResult, { ok: false }>["reason"]): SetupProveResult => ({ ok: false, reason });

/** One Prove of the proposal, using its separate read-only preparation. No size selection or feature advertisement. */
export async function runSetupProve(input: SetupProveInput, ports: SetupProvePorts): Promise<SetupProveResult> {
  if (input === null || typeof input !== "object" || !(input.signal instanceof AbortSignal)) return fail("invalid_job");
  const parsed = PrepareSetupProveSchema.safeParse(input.job);
  if (!parsed.success || !Number.isSafeInteger(input.deadlineMs) || input.deadlineMs <= 0 || input.deadlineMs > PROVE_MS) return fail("invalid_job");
  const job = parsed.data;
  if (testEnvDigest(job.environment) !== job.proposalDigest) return fail("invalid_job");
  if (job.environment.services.length !== 0) return fail("services_need_prove");
  const repositories = input.manifest?.repositories;
  const commits = new Map(Object.entries(job.commits));
  if (!Array.isArray(repositories) || repositories.length !== commits.size
    || repositories.some(repo => repo === null || typeof repo !== "object" || typeof repo.name !== "string" || typeof repo.resolvedCommit !== "string")
    || new Set(repositories.map(repo => repo.name)).size !== commits.size
    || repositories.some(repo => commits.get(repo.name) !== repo.resolvedCommit)) return fail("commits_mismatch");
  if (!Array.isArray(input.notFrom) || input.notFrom.length > 64) return fail("invalid_job");
  if (input.signal.aborted) return fail("aborted");

  const controller = new AbortController();
  const stop = () => controller.abort();
  input.signal.addEventListener("abort", stop, { once: true });
  const startedAt = Date.now();
  const timer = setTimeout(stop, input.deadlineMs);
  let fresh: BuildSandbox | undefined;
  let result: SetupProveResult;
  try {
    result = await (async (): Promise<SetupProveResult> => {
      try { fresh = await ports.makeFresh(controller.signal); } catch { return fail("fresh_sandbox_failed"); }
      try {
        if (fresh.hasStarted()) return fail("not_fresh");
        const real = async (path: string) => ports.realPath === undefined ? realpathSync.native(path) : ports.realPath(path);
        // Resolve once, then compare the bounded registry without repeated filesystem reads.
        const root = await real(fresh.rootPath);
        for (const other of input.notFrom) {
          const otherRoot = await real(other.rootPath);
          if (fresh.id === other.id || await sharesWorkspace(root, otherRoot, async path => path)) return fail("not_fresh");
        }
      } catch { return fail("not_fresh"); }
      if (controller.signal.aborted) return fail("aborted");
      try { await fresh.start(); } catch { return fail("fresh_sandbox_failed"); }
      if (controller.signal.aborted) return fail("aborted");
      const arch = ports.arch ?? process.arch;
      const machineChip = arch === "arm64" ? "arm64" : arch === "x64" ? "x86_64" : undefined;
      let cgroupDirectory: string | undefined;
      try { cgroupDirectory = ports.cgroupDirectoryOf?.(fresh); } catch { /* No measurement, never a guessed directory. */ }
      let outputBytes = 0;
      // The lease is not project input, but even a command that prints it cannot put it in a report.
      const lease = job.leaseToken;
      const variants = lease === undefined ? [] : [lease, encodeURIComponent(lease), encodeURIComponent(encodeURIComponent(lease)), Buffer.from(lease).toString("base64"), Buffer.from(lease).toString("base64url"), Buffer.from(lease).toString("hex")];
      const pattern = variants.length === 0 ? undefined : new RegExp([...new Set(variants)].map(value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|"), "gu");
      const scrub = (text: string) => pattern === undefined ? text : text.replace(pattern, "[redacted]");
      const commandPorts = fresh.ports;
      const report = await proveWithMachineMeasurement({
        ...commandPorts,
        async runCommand(command, signal) {
          const output = await commandPorts.runCommand(command, signal);
          outputBytes += Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr);
          if (outputBytes > OUTPUT_BYTES) throw new Error("output limit exceeded");
          return { ...output, stdout: scrub(output.stdout), stderr: scrub(output.stderr) };
        },
      }, { proposalDigest: job.proposalDigest, environment: job.environment, signal: controller.signal, deadlineMs: Math.max(0, input.deadlineMs - (Date.now() - startedAt)) }, {
        machineSize: true, workerFeatures: ports.workerFeatures ?? WORKER_IMPLEMENTED_FEATURES,
        ...(machineChip === undefined ? {} : { machineChip }), ...(cgroupDirectory === undefined ? {} : { cgroupDirectory }),
      });
      // Prove owns the report and failure words. Only the displayed, already redacted tails are made inert.
      return { ok: true, report: { ...report, steps: report.steps.map(step => step.outputTail === undefined ? step : { ...step, outputTail: inertEvidenceText(step.outputTail, 900) }) } };
    })();
  } catch { result = fail("prove_failed"); }
  finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", stop);
    try { await fresh?.dispose(); } catch { result = fail("cleanup_failed"); }
  }
  return result;
}

export interface SetupProveJobDependencies {
  rootPath: string;
  controlPlaneUrl: string;
  invocation: Extract<WorkerInvocation, { kind: "prepare" }>;
  manifest: Pick<PreparationManifest, "repositories">;
  docker: DockerCli;
  otherOperations(): Promise<ReadonlyArray<{ id: string; rootPath: string }>>;
  signal: AbortSignal;
  fetchImplementation?: typeof fetch;
  ports?: SetupProvePorts;
}

/** The prepare rider; Part B provides its lease-bound broker route and advertises the feature last. */
export async function runSetupProveJob(deps: SetupProveJobDependencies): Promise<SetupProveResult | undefined> {
  if (deps.invocation === null || typeof deps.invocation !== "object" || deps.invocation.kind !== "prepare"
    || deps.invocation.payload === null || typeof deps.invocation.payload !== "object") return fail("invalid_job");
  if (deps.invocation.payload.setupProve === undefined) return undefined;
  const parsed = WorkerInvocationSchema.safeParse(deps.invocation);
  if (!parsed.success || parsed.data.kind !== "prepare") return fail("invalid_job");
  const invocation = parsed.data;
  const job = invocation.payload.setupProve;
  if (job?.leaseToken === undefined) return fail("invalid_job");
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (deps.signal.aborted) stop(); else deps.signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, PROVE_MS + POST_MS);
  const startedAt = Date.now();
  // Every Docker call shares the overall job cancellation, including discovery and start. Cleanup has its own existing bounded Docker removal.
  const docker: DockerCli = { run: (args, options) => deps.docker.run(args, { ...options, ...(args[0] === "rm" ? {} : { signal: controller.signal }) }) };
  let result: SetupProveResult;
  try {
    try {
      const others = [...await deps.otherOperations(), ...await liveTaskSandboxes(docker, deps.rootPath, "")];
      const ports: SetupProvePorts = deps.ports ?? {
        cgroupDirectoryOf: () => undefined,
        async makeFresh() {
          const sandbox = new TaskSandbox({ rootPath: deps.rootPath, taskId: `setup-prove-${invocation.operationId}`, docker, log: () => undefined });
          const fresh = workspaceBuildSandbox({ rootPath: deps.rootPath, operationId: invocation.operationId, checkouts: [], sandbox });
          let owned = false;
          return { ...fresh, async start() { owned = true; await fresh.start(); }, async dispose() {
            // Do not delete any checkout after an unconfirmed stop. The TaskSandbox already joins an in-flight start.
            if (!await sandbox.dispose()) throw new Error("cleanup failed");
            if (!owned) return;
            for (const repo of invocation.payload.project.repositories) await rm(join(deps.rootPath, repo.path), { recursive: true, force: true });
          } };
        },
      };
      result = await runSetupProve({ job, manifest: deps.manifest, notFrom: others, signal: controller.signal, deadlineMs: Math.max(1, PROVE_MS - (Date.now() - startedAt)) }, ports);
    } catch { result = fail("fresh_sandbox_failed"); }
    const body = JSON.stringify({ jobId: job.jobId, leaseToken: job.leaseToken, result });
    // The schema bounds the report to seven 4-KiB tails and bounded metadata; no response body is read.
    const send = deps.fetchImplementation ?? fetch;
    const postController = new AbortController();
    const postStop = () => postController.abort();
    // Cancellation stops project work, but its refusal still needs a callback. Both phases share the same total wall-clock budget.
    const postBudget = Math.max(0, Math.min(POST_MS, PROVE_MS + POST_MS - (Date.now() - startedAt)));
    const postTimer = setTimeout(postStop, postBudget);
    if (postBudget === 0) postStop();
    let posted = false;
    try {
      for (let attempt = 0; attempt < 3 && !posted && !postController.signal.aborted; attempt += 1) {
        try {
          const response = await send(`${deps.controlPlaneUrl.replace(/\/$/u, "")}/v1/internal/workspaces/${invocation.workspaceId}/operations/${invocation.operationId}/${SETUP_PROVE_RESULT_PATH}`, {
            method: "POST", headers: { "content-type": "application/json", "x-agentx-callback-capability": invocation.callbackCapability }, body, signal: postController.signal,
          });
          posted = response.ok;
          await response.body?.cancel().catch(() => undefined);
        } catch { /* Fixed, bounded retry; never print a cause or response. */ }
      }
    } finally { clearTimeout(postTimer); }
    console.log(JSON.stringify({ component: "worker", event: "setup-prove.result", jobId: job.jobId, posted }));
    return result;
  } finally { clearTimeout(timer); deps.signal.removeEventListener("abort", stop); }
}

// TE-H1 browser evidence, slice 2: the worker's half (DEC 241a). A CHECKS run that was sent the project's recipe (`payload.browserEvidence`) photographs the changed pages before and after, and hands the pictures to the broker.
//
// WHERE THINGS RUN (the rule this file keeps):
//   - THE PROJECT'S APP starts only in the TASK SANDBOX, through the same runners the project's checks use (`runners.runProjectCommand`, R56: project commands run only there), as one long command in its own process group that is
//     stopped by aborting it. The worker process never starts a project command.
//   - CHROMIUM runs only in a container of the EXECUTOR IMAGE, started as the e2e Docker host starts the executor (`executorContainerArgs`: every capability dropped, no-new-privileges, the pinned seccomp profile, a read-only root,
//     memory, process and CPU limits) with `--network container:<the sandbox>` and NOTHING else shared: no mount, no environment, no other network. It reaches the app on the sandbox's own loopback and prints what it saw.
//   - THE "BEFORE" CODE is the base commit, shown in the one workspace by `gitOriginalCode(...).run` (the test proof's way) while the app and the capture run; the agent's files are restored exactly afterwards. A restore that fails,
//     or a stop that cannot be confirmed, is NOT absorbed: it stops the task (`isWorkspaceUnsafe`).
// The run is the slice-1 runner (`runBrowserEvidence`): its time and byte limits, caps and fixed reasons hold for every picture whatever this driver answers. Informational: anything else that goes wrong is a fixed "Not run" reason.
import { randomBytes } from "node:crypto";
import { relative } from "node:path";
import {
  BROWSER_EVIDENCE_EXECUTOR_ENTRY, BROWSER_EVIDENCE_EXECUTOR_OUTPUT_MAX_BYTES, BROWSER_EVIDENCE_RUN_MS, BrowserEvidenceExecutorLineSchema, ProjectCommandSchema, encodeBrowserEvidenceExecutorPlan, encodeBrowserEvidenceUpload, pickChangedRoutes,
  type BrowserEvidenceCaptured, type BrowserEvidenceExecutorLine, type BrowserEvidenceNotRunReason, type BrowserEvidenceRecipe,
} from "@agentx/contracts";
import { executorContainerArgs, runBrowserEvidence, verifyExecutorSeccompProfile, type BrowserEvidenceCaptureAnswer, type BrowserEvidenceDriver, type BrowserEvidenceSide } from "@agentx/verifier";
import { isWorkspaceUnsafe, type OriginalCode, type OriginalCodeRepository } from "./verification/original-code.js";
import { candidateChanges } from "./verification/diff.js";
import type { CheckRunners } from "./verification/checks.js";
import type { DockerCli } from "./swebench/containers.js";

/** The sandbox container name a `--network container:` may name: what a task sandbox is called, nothing with a separator or an option in it. */
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
/** An image reference as `EXECUTOR_IMAGE` gives it: no space, no control character, no leading dash (it is one docker argument). */
const IMAGE_REFERENCE = /^[^\s\p{Cc}\p{Cf}-][^\s\p{Cc}\p{Cf}]{0,511}$/u;
export const EXECUTOR_LABEL = "rovara.browser-evidence";
/** What is added to the capture's own time for the container to start and Chromium to open, and for the docker CLI to answer. */
const START_MARGIN_MS = 10_000;
/** What a side keeps back for taking everything down again (the container, the app's group and the last probe) so the side is over before the run's own limit for it. */
const CLEANUP_RESERVE_MS = 20_000;
const STOP_MS = 10_000;
const PROBE_MS = 5_000;

/** The `docker run` arguments of the capture container. Pure, so a test can read every flag. The one shared thing is the sandbox's network namespace. */
export function browserEvidenceExecutorArgs(input: { image: string; sandbox: string; name: string; seccompProfile: string; plan: string }): string[] {
  if (!IMAGE_REFERENCE.test(input.image) || !CONTAINER_NAME.test(input.sandbox) || !CONTAINER_NAME.test(input.name) || !/^[A-Za-z0-9_-]{1,16384}$/u.test(input.plan)) throw new Error("browser evidence executor arguments are not valid");
  return ["run", "--rm", "--pull=never", "--name", input.name, "--label", `${EXECUTOR_LABEL}=1`, "--network", `container:${input.sandbox}`,
    // The executor's own sandbox and limits, the one shared definition (the image smoke test and the e2e host start it with the same).
    ...executorContainerArgs(input.seccompProfile),
    input.image, "node", BROWSER_EVIDENCE_EXECUTOR_ENTRY, input.plan];
}

/** The capture program's stdout as its lines: every line checked against its schema, the app's line first and once, one row per page at most once and only for a page that was asked for. Anything else is no answer at all (undefined). */
export function parseCaptureOutput(stdout: Uint8Array, routes: readonly string[]): { app: "ready" | "app_did_not_start" | "time_limit"; shots: Map<string, Extract<BrowserEvidenceExecutorLine, { t: "shot" }>> } | undefined {
  if (stdout.byteLength === 0 || stdout.byteLength > BROWSER_EVIDENCE_EXECUTOR_OUTPUT_MAX_BYTES) return undefined;
  try {
    const text = Buffer.from(stdout).toString("utf8");
    let app: "ready" | "app_did_not_start" | "time_limit" | undefined;
    const shots = new Map<string, Extract<BrowserEvidenceExecutorLine, { t: "shot" }>>();
    for (const row of text.split("\n")) {
      if (row === "") continue;
      const line = BrowserEvidenceExecutorLineSchema.safeParse(JSON.parse(row));
      if (!line.success) return undefined;
      if (line.data.t === "app") { if (app !== undefined) return undefined; app = line.data.status; continue; }
      if (app === undefined || !routes.includes(line.data.route) || shots.has(line.data.route)) return undefined;
      shots.set(line.data.route, line.data);
    }
    return app === undefined ? undefined : { app, shots };
  } catch { return undefined; }
}

export type BrowserEvidenceWorkInput = Readonly<{
  recipe: BrowserEvidenceRecipe;
  /** The task's repositories (directory, id, and the commit the task started from) and the checked tree of each. */
  repositories: ReadonlyArray<{ repositoryId: string; directory: string; baseCommitSha?: string | undefined }>;
  candidateTrees: ReadonlyMap<string, string>;
  rootPath: string;
  /** The runners of the check round: the project's commands run through them. Only the task sandbox's are used (`kind` "sandbox"). */
  runners: Pick<CheckRunners, "kind" | "runProjectCommand">;
  /** The task sandbox's container name; the capture container joins its network namespace. Absent (a devcontainer, the local shell): no browser evidence. */
  sandboxName: string | undefined;
  originalCode: (repositories: OriginalCodeRepository[]) => OriginalCode;
  docker: Pick<DockerCli, "run" | "execBytes"> | undefined;
  /** `EXECUTOR_IMAGE` of the worker's environment. */
  executorImage: string | undefined;
  signal: AbortSignal;
  budgetMs: number;
  /** Test seams. */
  changedFilesOf?: ((repositories: BrowserEvidenceWorkInput["repositories"]) => Promise<string[] | undefined>) | undefined;
  seccompProfile?: (() => string) | undefined;
  newName?: (() => string) | undefined;
  now?: (() => number) | undefined;
}>;

const notRun = (reason: BrowserEvidenceNotRunReason): BrowserEvidenceCaptured => ({ isolation: "sandbox", durationMs: 0, routes: [], notShown: [], moreNotShown: 0, notRun: reason });

/** Where the project's commands start: the one repository's directory relative to the workspace root, in the plain form a project command's `cwd` takes. Undefined for several repositories, or a directory that is not a plain folder below the root. */
function repositoryCwd(input: Pick<BrowserEvidenceWorkInput, "repositories" | "rootPath">): string | undefined {
  const [only] = input.repositories;
  if (input.repositories.length !== 1 || only === undefined) return undefined;
  const path = relative(input.rootPath, only.directory);
  return path !== "" && ProjectCommandSchema.shape.cwd.safeParse(path).success ? path : undefined;
}

/** The changed files of every repository, from its start commit to its checked tree (names only, bounded by the picker). Undefined when any cannot be read, so the pick is "changes unreadable" and never from part of the change. */
async function changedFilesOfRepositories(repositories: BrowserEvidenceWorkInput["repositories"], trees: ReadonlyMap<string, string>): Promise<string[] | undefined> {
  const names: string[] = [];
  try {
    for (const repository of repositories) {
      const tree = trees.get(repository.repositoryId);
      if (repository.baseCommitSha === undefined || tree === undefined) return undefined;
      for (const change of await candidateChanges({ directory: repository.directory, baseCommitSha: repository.baseCommitSha, treeSha: tree })) names.push(change.path);
    }
    return names;
  } catch (error) {
    if (isWorkspaceUnsafe(error)) throw error;
    return undefined;
  }
}

/** Whether anything listens on the port in the sandbox's own loopback: the same probe command runs in the sandbox, so a stale app of the other side can never be photographed as this one. */
const PROBE_SCRIPT = "const n=require('net');const s=n.connect({host:'127.0.0.1',port:Number(process.argv[1])});s.once('connect',()=>process.exit(1));s.once('error',()=>process.exit(0));setTimeout(()=>process.exit(2),2000)";

/**
 * Takes the before and after screenshots of the changed pages. Never throws, except for the faults that must stop the task (the agent's files could not be put back, or a stopped command could not be confirmed stopped).
 * A run that cannot start says why with a fixed reason (a `notRun` result), and the broker's pack and the pull request say "Not run: ..." from it.
 */
export async function collectBrowserEvidence(input: BrowserEvidenceWorkInput): Promise<BrowserEvidenceCaptured> {
  try {
    const { docker, sandboxName, executorImage } = input;
    // The one place the app may run is the task sandbox, and the one place Chromium may run is the executor image sharing its network. Anything missing is a run that does not happen.
    if (input.runners.kind !== "sandbox" || sandboxName === undefined || !CONTAINER_NAME.test(sandboxName) || docker?.execBytes === undefined || executorImage === undefined || !IMAGE_REFERENCE.test(executorImage)) return notRun("capture_failed");
    let seccompProfile: string;
    try { seccompProfile = (input.seccompProfile ?? verifyExecutorSeccompProfile)(); } catch { return notRun("capture_failed"); }
    const files = await (input.changedFilesOf?.(input.repositories) ?? changedFilesOfRepositories(input.repositories, input.candidateTrees));
    const picked = pickChangedRoutes({ changedFiles: files, recipe: input.recipe });
    if (picked.status === "not_run") return notRun(picked.reason);
    // The recipe names no repository, so a workspace of one repository is the only one it can mean (never a guess among several); its directory, relative to the workspace, is where every command of the run starts.
    const cwd = repositoryCwd(input);
    if (cwd === undefined) return notRun("capture_failed");
    const originalRepositories = input.repositories.map((repository) => ({ directory: repository.directory, commit: repository.baseCommitSha ?? "" }));
    if (originalRepositories.some((repository) => !/^[a-f0-9]{40,64}$/u.test(repository.commit))) return notRun("capture_failed");
    const base = input.originalCode(originalRepositories);
    const now = input.now ?? Date.now;
    const runMs = Math.max(1, Math.min(input.budgetMs, BROWSER_EVIDENCE_RUN_MS));
    // One side at a time, and the next side starts only when the one before it is over (its files put back, its app gone), whatever the runner's own race said about it.
    let pending: Promise<unknown> = Promise.resolve();
    let fault: Error | undefined;
    const side = (which: BrowserEvidenceSide, routes: readonly string[], timeoutMs: number): Promise<Map<string, BrowserEvidenceCaptureAnswer> | "app_did_not_start" | "time_limit"> => {
      // The base code gets half of what is left (the candidate's side the rest), so the first side can never use the second one's time.
      const budget = which === "before" ? Math.floor(timeoutMs / 2) : timeoutMs;
      const work = () => runSide({ ...input, docker: docker as Required<Pick<DockerCli, "run" | "execBytes">>, sandboxName, executorImage, seccompPath: seccompProfile, cwd, routes, timeoutMs: budget, now });
      // The base code is shown while the app starts and the pages are taken, and the agent's files are put back exactly before this returns.
      // The runner counts a driver that throws as a page that did not load, so a fault that must stop the task is kept here and thrown again once the run is over; nothing starts after it.
      const run = pending.then(() => { if (fault !== undefined) throw fault; return which === "before" ? base.run(work) : work(); }).catch((error: unknown) => { if (isWorkspaceUnsafe(error)) fault ??= error as Error; throw error; });
      pending = run.then(() => undefined, () => undefined);
      return run;
    };
    const answers = new Map<BrowserEvidenceSide, Map<string, BrowserEvidenceCaptureAnswer> | "app_did_not_start" | "time_limit">();
    const driver: BrowserEvidenceDriver = {
      async startApp(which, options) {
        const result = await side(which, picked.routes, options.timeoutMs);
        if (typeof result === "string") return result;
        answers.set(which, result);
        return "ready";
      },
      async capture(which, route) {
        const held = answers.get(which);
        const answer = held instanceof Map ? held.get(route) : undefined;
        return answer ?? { ok: false, reason: "capture_failed" };
      },
      async stopApp() { /* each side stops its own app before it answers */ },
    };
    const captured = await runBrowserEvidence({
      isolation: "sandbox", routes: picked.routes, notShown: picked.notShown, moreNotShown: picked.moreNotShown, maskSelectors: input.recipe.mask ?? [], driver,
      limits: { runMs }, now,
    });
    await pending;
    if (fault !== undefined) throw fault;
    return captured;
  } catch (error) {
    // The one fault that must stop the task: the agent's files are not back, or a stopped command is not confirmed stopped.
    if (isWorkspaceUnsafe(error)) throw error;
    return notRun("capture_failed");
  }
}

type SideInput = BrowserEvidenceWorkInput & { docker: Required<Pick<DockerCli, "run" | "execBytes">>; sandboxName: string; executorImage: string; seccompPath: string; cwd: string; routes: readonly string[]; timeoutMs: number; now: () => number };

/** One side: start the app in the sandbox, take every page in one capture container, stop the app. Everything the app and the container leave behind is removed before this returns. */
async function runSide(input: SideInput): Promise<Map<string, BrowserEvidenceCaptureAnswer> | "app_did_not_start" | "time_limit"> {
  const { recipe, signal } = input;
  const deadline = input.now() + input.timeoutMs;
  const left = () => Math.max(0, deadline - input.now());
  const portFree = async (): Promise<boolean> => {
    const probe = AbortSignal.any([signal, AbortSignal.timeout(PROBE_MS)]);
    try {
      const result = await input.runners.runProjectCommand(ProjectCommandSchema.parse({ cwd: input.cwd, executable: "node", args: ["-e", PROBE_SCRIPT, String(recipe.port)], timeoutSeconds: Math.ceil(PROBE_MS / 1000) }), probe);
      return result.exitCode === 0 && !result.timedOut;
    } catch (error) {
      if (isWorkspaceUnsafe(error)) throw error;
      return false;
    }
  };
  // Nothing may already answer on the port: it would be photographed as this code's app.
  if (!(await portFree())) return "app_did_not_start";
  let command;
  try {
    command = ProjectCommandSchema.parse({ cwd: input.cwd, executable: "/bin/sh", args: ["-c", recipe.startCommand], timeoutSeconds: Math.max(1, Math.ceil(left() / 1000) + 5), env: { PORT: String(recipe.port) } });
  } catch { return "app_did_not_start"; }
  const stopApp = new AbortController();
  // The app is one long command of the sandbox's runners, ended by aborting it (the runners stop its whole process group). It ending by itself before the pages are taken is an app that did not stay up.
  const appRun = input.runners.runProjectCommand(command, AbortSignal.any([signal, stopApp.signal])).then(() => "ended" as const, (error: unknown) => { if (isWorkspaceUnsafe(error)) throw error; return "ended" as const; });
  appRun.catch(() => undefined);
  const name = input.newName?.() ?? `rovara-be-${randomBytes(6).toString("hex")}`;
  let answer: Map<string, BrowserEvidenceCaptureAnswer> | "app_did_not_start" | "time_limit";
  let fault: Error | undefined;
  try {
    // The capture's own time: what is left less the clean-up and the container's start. Too little left is the run's time limit, not a shorter try.
    const captureMs = left() - CLEANUP_RESERVE_MS - START_MARGIN_MS;
    if (captureMs < 1_000) { answer = "time_limit"; return answer; }
    const plan = encodeBrowserEvidenceExecutorPlan({ port: recipe.port, ...(recipe.readyPath === undefined ? {} : { readyPath: recipe.readyPath }), routes: [...input.routes], maskSelectors: recipe.mask ?? [],
      runMs: Math.min(120_000, captureMs), pageMs: 15_000 });
    const args = browserEvidenceExecutorArgs({ image: input.executorImage, sandbox: input.sandboxName, name, seccompProfile: input.seccompPath, plan });
    const run = await input.docker.execBytes(args, { signal, timeoutMs: captureMs + START_MARGIN_MS, maxStdoutBytes: BROWSER_EVIDENCE_EXECUTOR_OUTPUT_MAX_BYTES });
    const parsed = run.exitCode === 0 && run.tooLarge !== true && run.timedOut !== true && run.aborted !== true ? parseCaptureOutput(run.stdout, input.routes) : undefined;
    if (parsed === undefined) answer = run.timedOut === true ? "time_limit" : "app_did_not_start";
    else if (parsed.app !== "ready") answer = parsed.app;
    else {
      const picked = new Map<string, BrowserEvidenceCaptureAnswer>();
      for (const route of input.routes) {
        const shot = parsed.shots.get(route);
        picked.set(route, shot === undefined ? { ok: false, reason: "capture_failed" }
          : shot.ok ? { ok: true, bytes: new Uint8Array(Buffer.from(shot.jpegBase64, "base64")), consoleErrors: shot.consoleErrors } : { ok: false, reason: shot.reason });
      }
      answer = picked;
    }
  } catch (error) {
    if (isWorkspaceUnsafe(error)) fault = error as Error;
    answer = "app_did_not_start";
  } finally {
    // The container is removed whatever happened (the docker CLI being killed does not stop it), then the app's group is stopped and its stop is awaited.
    await input.docker.run(["rm", "--force", name], { timeoutMs: STOP_MS }).catch(() => undefined);
    stopApp.abort();
    try { await appRun; } catch (error) { if (isWorkspaceUnsafe(error)) fault = error as Error; }
  }
  if (fault !== undefined) throw fault;
  // The port must be free again before the other side starts: an app that left its group would answer for the next code.
  if (!(await portFree())) return "app_did_not_start";
  return answer;
}

/**
 * The CHECKS run's hook (run-task.ts, only when the invocation carries `browserEvidence`): takes the pictures and hands them to the broker as one upload. Informational: a run that took none still uploads its fixed "Not run" reason, so
 * the pack and the pull request can say why; an upload the broker does not accept is only a progress line. Returns whether an upload was accepted. Never throws, except for the faults that must stop the task.
 */
export async function saveBrowserEvidence(input: BrowserEvidenceWorkInput & {
  sink: ((bytes: Uint8Array) => Promise<void>) | undefined;
  progress: (message: string) => Promise<void>;
  collect?: typeof collectBrowserEvidence;
}): Promise<boolean> {
  try {
    const captured = await (input.collect ?? collectBrowserEvidence)(input);
    if (input.sink === undefined) return false;
    await input.sink(encodeBrowserEvidenceUpload(captured));
    const shown = captured.routes.filter((row) => row.status === "shown").length;
    await input.progress(shown > 0 ? `AgentX took before and after screenshots of ${String(shown)} changed page${shown === 1 ? "" : "s"} (visual evidence only).` : "AgentX took no screenshots of the changed pages (see the evidence for why).").catch(() => undefined);
    return true;
  } catch (error) {
    if (isWorkspaceUnsafe(error)) throw error;
    await input.progress("AgentX could not keep the screenshots of the changed pages.").catch(() => undefined);
    return false;
  }
}

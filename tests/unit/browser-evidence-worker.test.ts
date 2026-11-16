// TE-H1 slice 2 (DEC 241a): the worker's half. The project's app starts in the TASK SANDBOX through the check runners; Chromium runs in a container of the executor image that shares only the sandbox's network; the base code is shown
// for the "before" side and the agent's files are put back exactly; the slice-1 runner's limits hold for whatever the capture container prints; a fault that must stop the task is never absorbed.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BROWSER_EVIDENCE_EXECUTOR_ENTRY, BROWSER_EVIDENCE_SCREENSHOT_MAX_BYTES, decodeBrowserEvidenceExecutorPlan, decodeBrowserEvidenceUpload, type BrowserEvidenceExecutorLine, type BrowserEvidenceRecipe } from "../../packages/contracts/src/index.js";
import { RunnerKillUnconfirmedError } from "../../packages/worker/src/collected-process.js";
import { AgentFilesRestoreError, type OriginalCode } from "../../packages/worker/src/verification/original-code.js";
import { browserEvidenceExecutorArgs, collectBrowserEvidence, parseCaptureOutput, saveBrowserEvidence, type BrowserEvidenceWorkInput } from "../../packages/worker/src/browser-evidence-run.js";

const SANDBOX = "agentx-task-op1-abcd1234";
const IMAGE = "rovara-e2e-executor:test";
const COMMIT = "1".repeat(40);
const RECIPE: BrowserEvidenceRecipe = { startCommand: "npm run start", port: 4321, readyPath: "/health", routes: [{ path: "/checkout", files: ["src/checkout/**"] }, { path: "/settings", files: ["src/settings/**"] }], mask: [".account"] };
const jpeg = (seed: string, size = 500) => { const bytes = new Uint8Array(size); bytes.set([0xff, 0xd8, 0xff]); bytes.fill(seed.charCodeAt(0), 3); return bytes; };
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const line = (value: BrowserEvidenceExecutorLine) => `${JSON.stringify(value)}\n`;
const shotLine = (route: string, seed: string, size = 500, consoleErrors = 0): BrowserEvidenceExecutorLine => ({ t: "shot", route, ok: true, consoleErrors, jpegBase64: Buffer.from(jpeg(seed, size)).toString("base64") });
const unsafe = (error: Error) => error;

/** A scripted world: the runners (the sandbox's), the original-code swap, and the docker CLI, each writing down what it was asked. */
function world(over: { capture?: (side: "before" | "after", routes: string[], index: number) => string | Uint8Array; probes?: number[]; appFails?: boolean; changed?: string[] | undefined; stopError?: Error; restoreError?: Error; execFault?: { exitCode?: number | null; timedOut?: boolean; tooLarge?: boolean }; execDelayMs?: number } = {}) {
  const log: string[] = [];
  let swapped = false;
  let execs = 0;
  let probeIndex = 0;
  const appAborts: string[] = [];
  const runners: BrowserEvidenceWorkInput["runners"] = {
    kind: "sandbox",
    async runProjectCommand(command, signal) {
      if (command.executable === "node") {
        const exit = over.probes?.[probeIndex] ?? 0;
        probeIndex += 1;
        log.push(`probe(${String(exit)})`);
        return { exitCode: exit, timedOut: false, stdout: "", stderr: "" };
      }
      log.push(`app:${swapped ? "base" : "candidate"}:${command.executable} ${command.args.join(" ")} PORT=${command.env?.["PORT"] ?? ""} cwd=${command.cwd}`);
      if (over.appFails === true) return { exitCode: 1, timedOut: false, stdout: "", stderr: "" };
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => { appAborts.push(swapped ? "base" : "candidate"); log.push(`app-stopped:${swapped ? "base" : "candidate"}`); reject(over.stopError ?? new Error("aborted")); }, { once: true });
      });
    },
  };
  const originalCode = (repositories: ReadonlyArray<{ directory: string; commit: string }>): OriginalCode => ({
    async run(work) {
      log.push(`swap(${repositories.map((repository) => repository.commit.slice(0, 4)).join(",")})`);
      swapped = true;
      let outcome: Awaited<ReturnType<typeof work>>;
      try { outcome = await work(); } finally { swapped = false; log.push("restore"); }
      if (over.restoreError !== undefined) throw over.restoreError;
      return outcome;
    },
  });
  const docker: BrowserEvidenceWorkInput["docker"] = {
    async run(args) { log.push(`docker ${args.join(" ")}`); return { exitCode: 0, signal: undefined, stdout: "", stderr: "", timedOut: false } as never; },
    async execBytes(args) {
      const side = swapped ? "before" : "after";
      const plan = decodeBrowserEvidenceExecutorPlan(args.at(-1));
      log.push(`exec:${side}:${args.join(" ").slice(0, 0)}${plan?.routes.join(",") ?? "?"}`);
      calls.push({ side, args: [...args] });
      if (over.execDelayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, over.execDelayMs));
      const index = execs; execs += 1;
      const out = over.capture !== undefined ? over.capture(side, plan?.routes ?? [], index)
        : line({ t: "app", status: "ready" }) + (plan?.routes ?? []).map((route) => line(shotLine(route, side === "before" ? "a" : "b"))).join("");
      return { exitCode: over.execFault?.exitCode ?? 0, stdout: Buffer.from(out), stderr: "", ...(over.execFault?.timedOut === true ? { timedOut: true } : {}), ...(over.execFault?.tooLarge === true ? { tooLarge: true } : {}) };
    },
  };
  const calls: Array<{ side: string; args: string[] }> = [];
  const input = (extra: Partial<BrowserEvidenceWorkInput> = {}): BrowserEvidenceWorkInput => ({
    recipe: RECIPE, repositories: [{ repositoryId: "demo", directory: "/work/repo/demo", baseCommitSha: COMMIT }], candidateTrees: new Map([["demo", "2".repeat(40)]]), rootPath: "/work",
    runners, sandboxName: SANDBOX, originalCode, docker, executorImage: IMAGE, signal: new AbortController().signal, budgetMs: 120_000,
    changedFilesOf: async () => ("changed" in over ? over.changed : ["src/checkout/page.tsx"]), seccompProfile: () => "/profile/executor-seccomp.json", newName: (() => { let n = 0; return () => `rovara-be-test${String((n += 1))}`; })(),
    ...extra,
  });
  return { log, calls, appAborts, input };
}

describe("the capture container's arguments", () => {
  const args = browserEvidenceExecutorArgs({ image: IMAGE, sandbox: SANDBOX, name: "rovara-be-abc", seccompProfile: "/profile/executor-seccomp.json", plan: "cGxhbg" });
  it("joins the sandbox's network namespace and nothing else, with the executor's own sandbox and limits", () => {
    expect(args.slice(0, 3)).toEqual(["run", "--rm", "--pull=never"]);
    expect(args[args.indexOf("--network") + 1]).toBe(`container:${SANDBOX}`);
    expect(args.filter((value) => value === "--network")).toHaveLength(1);
    expect(args).toContain("--cap-drop=ALL");
    expect(args[args.indexOf("--security-opt") + 1]).toBe("no-new-privileges");
    expect(args).toContain("seccomp=/profile/executor-seccomp.json");
    expect(args).toContain("--read-only");
    for (const forbidden of ["-v", "--volume", "--mount", "-e", "--env", "--env-file", "--privileged", "--cap-add", "--add-host", "--dns", "-p", "--publish", "--pid", "--ipc", "--userns", "--device"]) expect(args, forbidden).not.toContain(forbidden);
    expect(args.slice(-4)).toEqual([IMAGE, "node", BROWSER_EVIDENCE_EXECUTOR_ENTRY, "cGxhbg"]);
    expect(args.some((value) => value.startsWith("container:") && value !== `container:${SANDBOX}`)).toBe(false);
  });
  it("refuses a name, an image or a plan that could be another docker argument", () => {
    const make = (over: Partial<Parameters<typeof browserEvidenceExecutorArgs>[0]>) => () => browserEvidenceExecutorArgs({ image: IMAGE, sandbox: SANDBOX, name: "rovara-be-abc", seccompProfile: "/p", plan: "cGxhbg", ...over });
    for (const bad of ["", "--privileged", "a b", "a;b", "../x", "-x", "x".repeat(200), "a:b"]) expect(make({ sandbox: bad }), bad).toThrow();
    for (const bad of ["", "-v", "a b", "a\nb", "--rm"]) expect(make({ image: bad }), bad).toThrow();
    expect(make({ name: "x y" })).toThrow();
    expect(make({ plan: "has space" })).toThrow();
    expect(make({ plan: "" })).toThrow();
  });
});

describe("the capture program's output", () => {
  const routes = ["/a", "/b"];
  const text = (...lines: BrowserEvidenceExecutorLine[]) => Buffer.from(lines.map(line).join(""));
  it("reads the app's state and one row per asked page", () => {
    const out = parseCaptureOutput(text({ t: "app", status: "ready" }, shotLine("/a", "a"), { t: "shot", route: "/b", ok: false, reason: "page_did_not_load" }), routes)!;
    expect(out.app).toBe("ready");
    expect([...out.shots.keys()]).toEqual(["/a", "/b"]);
  });
  it("is no answer at all when anything is off: empty, over its bound, a line twice, a page nobody asked for, a row before the app's line, text that is not a line", () => {
    const app = { t: "app", status: "ready" } as const;
    expect(parseCaptureOutput(new Uint8Array(0), routes)).toBeUndefined();
    expect(parseCaptureOutput(new Uint8Array(4 * 1024 * 1024 + 1), routes)).toBeUndefined();
    expect(parseCaptureOutput(text(app, app), routes)).toBeUndefined();
    expect(parseCaptureOutput(text(app, shotLine("/a", "a"), shotLine("/a", "a")), routes)).toBeUndefined();
    expect(parseCaptureOutput(text(app, shotLine("/c", "a")), routes)).toBeUndefined();
    expect(parseCaptureOutput(text(shotLine("/a", "a"), app), routes)).toBeUndefined();
    expect(parseCaptureOutput(Buffer.from("not json\n"), routes)).toBeUndefined();
    expect(parseCaptureOutput(text(shotLine("/a", "a")), routes)).toBeUndefined();
    expect(parseCaptureOutput(Buffer.from(`${JSON.stringify({ t: "app", status: "ready", extra: 1 })}\n`), routes)).toBeUndefined();
  });
});

describe("taking the screenshots", () => {
  it("starts the app in the sandbox through the runners, takes each side in a container of the executor image that shares only the sandbox's network, and shows the base code only for the before side", async () => {
    const w = world();
    const result = await collectBrowserEvidence(w.input());
    expect(result.notRun).toBeUndefined();
    expect(result.isolation).toBe("sandbox");
    expect(result.routes).toEqual([{ route: "/checkout", status: "shown", before: { sha256: sha(jpeg("a")), bytes: jpeg("a") }, after: { sha256: sha(jpeg("b")), bytes: jpeg("b") }, consoleErrors: { before: 0, after: 0 } }]);
    // The order: before is shown under the base code and over before the next side starts; the app is the runners' command, in the repository, with the port; each app is stopped by aborting it.
    expect(w.log.filter((entry) => !entry.startsWith("docker rm"))).toEqual([
      "swap(1111)", "probe(0)", "app:base:/bin/sh -c npm run start PORT=4321 cwd=repo/demo", "exec:before:/checkout", "app-stopped:base", "probe(0)", "restore",
      "probe(0)", "app:candidate:/bin/sh -c npm run start PORT=4321 cwd=repo/demo", "exec:after:/checkout", "app-stopped:candidate", "probe(0)",
    ]);
    // Every capture container joined the sandbox's network and nothing else.
    expect(w.calls).toHaveLength(2);
    for (const call of w.calls) { expect(call.args[call.args.indexOf("--network") + 1]).toBe(`container:${SANDBOX}`); expect(call.args).not.toContain("-v"); }
    // Each container is removed again, whatever happened.
    expect(w.log.filter((entry) => entry.startsWith("docker rm --force rovara-be-test"))).toHaveLength(2);
    // The plan the container got: the recipe's port, ready path, picked pages and masks, nothing else.
    expect(decodeBrowserEvidenceExecutorPlan(w.calls[0]!.args.at(-1))).toMatchObject({ port: 4321, readyPath: "/health", routes: ["/checkout"], maskSelectors: [".account"] });
  });

  it("holds every picture to the e2e cap whatever the container printed, and the run to the slice-1 rules", async () => {
    const big = world({ capture: (_side, routes) => line({ t: "app", status: "ready" }) + routes.map((route) => line(shotLine(route, "a", BROWSER_EVIDENCE_SCREENSHOT_MAX_BYTES + 1))).join("") });
    const run = await collectBrowserEvidence(big.input());
    expect(run.routes).toEqual([{ route: "/checkout", status: "not_run", reason: "over_size_cap" }]);
    const notAJpeg = world({ capture: (_side, routes) => line({ t: "app", status: "ready" }) + routes.map((route) => line({ t: "shot", route, ok: true, consoleErrors: 0, jpegBase64: Buffer.from("GIF89a....").toString("base64") })).join("") });
    expect((await collectBrowserEvidence(notAJpeg.input())).routes).toEqual([{ route: "/checkout", status: "not_run", reason: "capture_failed" }]);
    const withheld = world({ capture: (_side, routes) => line({ t: "app", status: "ready" }) + routes.map((route) => line({ t: "shot", route, ok: false, reason: "masked_content" })).join("") });
    expect((await collectBrowserEvidence(withheld.input())).routes).toEqual([{ route: "/checkout", status: "not_run", reason: "masked_content" }]);
  });

  it("is a run that did not happen, with a fixed reason, when the app does not start, the port is already taken, or the container fails", async () => {
    expect((await collectBrowserEvidence(world({ appFails: true, capture: () => "" }).input())).notRun).toBe("app_did_not_start");
    // The port answers before the app starts: that app would be photographed as this code's.
    const busy = world({ probes: [1] });
    expect((await collectBrowserEvidence(busy.input())).notRun).toBe("app_did_not_start");
    expect(busy.log.some((entry) => entry.startsWith("app:"))).toBe(false);
    // The app we started is gone by the time the capture answers (it could not bind the port, a program that held it first answered instead): nothing it showed is kept.
    const forged = world({ appFails: true, execDelayMs: 10 });
    const stolen = await collectBrowserEvidence(forged.input());
    expect(stolen.notRun).toBe("app_did_not_start");
    expect(stolen.routes).toEqual([]);
    // A leftover app on the port after the base side stopped: the candidate's side must not be photographed through it.
    const leftover = world({ probes: [0, 0, 1] });
    const left = await collectBrowserEvidence(leftover.input());
    expect(left.notRun).toBe("app_did_not_start");
    expect(leftover.log.filter((entry) => entry.startsWith("app:"))).toHaveLength(1);
    for (const fault of [{ exitCode: 1 }, { exitCode: null, timedOut: true }, { tooLarge: true }]) expect((await collectBrowserEvidence(world({ execFault: fault }).input())).notRun, JSON.stringify(fault)).toBeDefined();
    expect((await collectBrowserEvidence(world({ capture: () => "garbage" }).input())).notRun).toBe("app_did_not_start");
    expect((await collectBrowserEvidence(world({ capture: () => line({ t: "app", status: "app_did_not_start" }) }).input())).notRun).toBe("app_did_not_start");
  });

  it("does not run at all outside the task sandbox or without the executor image, and never starts the app anywhere else", async () => {
    for (const patch of [
      (w: ReturnType<typeof world>) => ({ runners: { ...w.input().runners, kind: "local" as const } }),
      (w: ReturnType<typeof world>) => ({ runners: { ...w.input().runners, kind: "devcontainer" as const } }),
      (w: ReturnType<typeof world>) => ({ runners: { ...w.input().runners, kind: undefined } }),
      () => ({ sandboxName: undefined }), () => ({ sandboxName: "--privileged" }), () => ({ executorImage: undefined }), () => ({ executorImage: "-v /:/host" }), () => ({ executorImage: "" }),
      () => ({ docker: undefined }), () => ({ docker: { run: async () => ({}) as never } }),
      () => ({ seccompProfile: () => { throw new Error("digest mismatch"); } }),
    ] as Array<(w: ReturnType<typeof world>) => Partial<BrowserEvidenceWorkInput>>) {
      const w = world();
      const run = await collectBrowserEvidence(w.input(patch(w)));
      expect(run).toMatchObject({ notRun: "capture_failed", routes: [] });
      expect(w.log.some((entry) => entry.startsWith("app:") || entry.startsWith("swap"))).toBe(false);
    }
  });

  it("says why no page was taken: no page changed, the changes could not be read, a project without a recipe match; and shows no base code for those", async () => {
    expect((await collectBrowserEvidence(world({ changed: ["README.md"] }).input())).notRun).toBe("no_changed_page");
    expect((await collectBrowserEvidence(world({ changed: undefined }).input())).notRun).toBe("changes_unreadable");
    expect((await collectBrowserEvidence(world({ changed: Array.from({ length: 2001 }, (_, index) => `f${String(index)}`) }).input())).notRun).toBe("too_many_changed_files");
    const w = world({ changed: ["README.md"] });
    await collectBrowserEvidence(w.input());
    expect(w.log).toEqual([]);
    // The recipe names no repository, so a workspace of several is not guessed at, and one whose folder is the workspace itself has no plain folder to start in.
    const several = world();
    expect((await collectBrowserEvidence(several.input({ repositories: [{ repositoryId: "demo", directory: "/work/repo/demo", baseCommitSha: COMMIT }, { repositoryId: "lib", directory: "/work/repo/lib", baseCommitSha: COMMIT }], candidateTrees: new Map([["demo", "2".repeat(40)], ["lib", "3".repeat(40)]]) }))).notRun).toBe("capture_failed");
    expect(several.log).toEqual([]);
    const atRoot = world();
    expect((await collectBrowserEvidence(atRoot.input({ repositories: [{ repositoryId: "demo", directory: "/work", baseCommitSha: COMMIT }] }))).notRun).toBe("capture_failed");
    expect(atRoot.log).toEqual([]);
    // A repository without a start commit has no "before": nothing is shown in only some.
    const noBase = world();
    expect((await collectBrowserEvidence(noBase.input({ repositories: [{ repositoryId: "demo", directory: "/work/repo/demo" }] }))).notRun).toBe("capture_failed");
    expect(noBase.log).toEqual([]);
  });

  it("never absorbs a fault that must stop the task: the agent's files not restored, a stop that cannot be confirmed", async () => {
    await expect(collectBrowserEvidence(world({ restoreError: new AgentFilesRestoreError("the agent's files could not be put back") }).input())).rejects.toBeInstanceOf(AgentFilesRestoreError);
    await expect(collectBrowserEvidence(world({ stopError: new RunnerKillUnconfirmedError({ kind: "sandbox" }) }).input())).rejects.toBeInstanceOf(RunnerKillUnconfirmedError);
    // Any other fault is only a run that did not happen.
    expect(unsafe(new Error("x"))).toBeInstanceOf(Error);
    const throwing = world();
    expect((await collectBrowserEvidence(throwing.input({ originalCode: () => ({ run: async () => { throw new Error("git is broken"); } }) }))).notRun).toBeDefined();
  });

  it("stops the first side before the second starts, even when the runner's own limit has already moved on", async () => {
    const order: string[] = [];
    const w = world();
    const slowRestore = (repositories: ReadonlyArray<{ directory: string; commit: string }>): OriginalCode => ({ async run(work) { order.push("swap"); try { return await work(); } finally { await new Promise((resolve) => setTimeout(resolve, 30)); order.push("restored"); void repositories; } } });
    const base = w.input({ originalCode: slowRestore });
    const originalRunners = base.runners;
    const spied: BrowserEvidenceWorkInput["runners"] = { ...originalRunners, async runProjectCommand(command, signal) { if (command.executable !== "node") order.push("app-start"); return originalRunners.runProjectCommand(command, signal); } };
    await collectBrowserEvidence({ ...base, runners: spied });
    expect(order).toEqual(["swap", "app-start", "restored", "app-start"]);
  });
});

describe("handing the pictures to the broker", () => {
  it("uploads the run as one upload the broker's decoder accepts, and says so in one fixed line", async () => {
    const w = world();
    let uploaded: Uint8Array | undefined;
    const progress: string[] = [];
    expect(await saveBrowserEvidence({ ...w.input(), sink: async (bytes) => { uploaded = bytes; }, progress: async (message) => { progress.push(message); } })).toBe(true);
    expect(decodeBrowserEvidenceUpload(uploaded!).routes[0]).toMatchObject({ route: "/checkout", status: "shown" });
    expect(progress).toEqual(["AgentX took before and after screenshots of 1 changed page (visual evidence only)."]);
  });
  it("uploads a run that did not happen too, so the pack can say why, and treats an upload the broker refuses as a progress line, never a failed round", async () => {
    const w = world({ changed: ["README.md"] });
    let uploaded: Uint8Array | undefined;
    await saveBrowserEvidence({ ...w.input(), sink: async (bytes) => { uploaded = bytes; }, progress: async () => undefined });
    expect(decodeBrowserEvidenceUpload(uploaded!).notRun).toBe("no_changed_page");
    const progress: string[] = [];
    expect(await saveBrowserEvidence({ ...w.input(), sink: async () => { throw new Error("HTTP 500 at /secret/path"); }, progress: async (message) => { progress.push(message); } })).toBe(false);
    expect(progress).toEqual(["AgentX could not keep the screenshots of the changed pages."]);
    expect(await saveBrowserEvidence({ ...w.input(), sink: undefined, progress: async () => undefined })).toBe(false);
  });
  it("rethrows the faults that must stop the task", async () => {
    const w = world({ restoreError: new AgentFilesRestoreError("not restored") });
    await expect(saveBrowserEvidence({ ...w.input(), sink: async () => undefined, progress: async () => undefined })).rejects.toBeInstanceOf(AgentFilesRestoreError);
  });
});

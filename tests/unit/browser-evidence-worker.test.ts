
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BROWSER_EVIDENCE_EXECUTOR_ENTRY, BROWSER_EVIDENCE_SIGN_IN_ENV, decodeBrowserEvidenceExecutorPlan, decodeBrowserEvidenceSignInEnv, decodeBrowserEvidenceUpload, type BrowserEvidenceExecutorLine, type BrowserEvidenceRecipe, type BrowserEvidenceSignInAnswer } from "../../packages/contracts/src/index.js";
import { createDockerCli } from "../../packages/worker/src/swebench/containers.js";
import { RunnerKillUnconfirmedError } from "../../packages/worker/src/collected-process.js";
import { AgentFilesRestoreError, type OriginalCode } from "../../packages/worker/src/verification/original-code.js";
import { browserEvidenceExecutorArgs, collectBrowserEvidence, parseCaptureOutput, saveBrowserEvidence, type BrowserEvidenceWorkInput } from "../../packages/worker/src/browser-evidence-run.js";

const SANDBOX = "agentx-task-op1-abcd1234";
const IMAGE = "rovara-e2e-executor:test";
const COMMIT = "1".repeat(40);
const RECIPE: BrowserEvidenceRecipe = { startCommand: "npm run start", port: 4321, readyPath: "/health", routes: [{ path: "/checkout", files: ["src/checkout/**"] }, { path: "/settings", files: ["src/settings/**"] }], mask: [".account"] };
const jpeg = (seed: string, size = 500) => { const bytes = new Uint8Array(size); bytes.set([0xff, 0xd8, 0xff]); bytes.fill(seed.charCodeAt(0), 3); return bytes; };
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
    async execBytes(args, options) {
      const side = swapped ? "before" : "after";
      const plan = decodeBrowserEvidenceExecutorPlan(args.at(-1));
      log.push(`exec:${side}:${args.join(" ").slice(0, 0)}${plan?.routes.join(",") ?? "?"}`);
      calls.push({ side, args: [...args], env: options.env });
      if (over.execDelayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, over.execDelayMs));
      const index = execs; execs += 1;
      const out = over.capture !== undefined ? over.capture(side, plan?.routes ?? [], index)
        : line({ t: "app", status: "ready" }) + (plan?.routes ?? []).map((route) => line(shotLine(route, side === "before" ? "a" : "b"))).join("");
      return { exitCode: over.execFault?.exitCode ?? 0, stdout: Buffer.from(out), stderr: "", ...(over.execFault?.timedOut === true ? { timedOut: true } : {}), ...(over.execFault?.tooLarge === true ? { tooLarge: true } : {}) };
    },
  };
  const calls: Array<{ side: string; args: string[]; env: Readonly<Record<string, string>> | undefined }> = [];
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

// TE-H1 slice 3: an app behind a login. The saved sign-in is asked for only when the recipe has one and a page was picked, held in memory, and given to the capture container in ONE environment variable of the docker CLI (never an
// argument of the command line, never the plan); a run with no sign-in is exactly today's run.
describe("the sign-in", () => {
  const VALUES = { username: ["tester", "example"].join("@") + ".test", password: ["pw", "Zq7", "Lm2", "Xv9"].join("-") };
  const SIGNED: BrowserEvidenceRecipe = { ...RECIPE, signIn: { path: "/login", usernameSelector: "#email", passwordSelector: "#password", submitSelector: "button", successPath: "/dashboard", credentialRef: "be-demo-signin" } };
  const ready: BrowserEvidenceSignInAnswer = { status: "ready", values: VALUES };
  const spy = (value: BrowserEvidenceSignInAnswer | Error | undefined) => { const state = { asked: 0 }; return { state, signIn: async () => { state.asked += 1; if (value instanceof Error) throw value; return value as BrowserEvidenceSignInAnswer; } }; };
  const seen = (w: ReturnType<typeof world>): string => JSON.stringify({ log: w.log, calls: w.calls.map((call) => ({ side: call.side, args: call.args })) });

  it("hands the values to the capture container in the environment of the docker CLI only: `-e NAME` without a value, no value in the arguments or the plan, and the plan carries the form and the extra painted-over fields", async () => {
    const w = world();
    const asked = spy(ready);
    const result = await collectBrowserEvidence(w.input({ recipe: SIGNED, signIn: asked.signIn }));
    expect(result.notRun).toBeUndefined();
    expect(result.routes[0]?.status).toBe("shown");
    expect(asked.state.asked).toBe(1);
    expect(w.calls).toHaveLength(2);
    for (const call of w.calls) {
      const at = call.args.indexOf("-e");
      expect(call.args[at + 1]).toBe(BROWSER_EVIDENCE_SIGN_IN_ENV);
      expect(call.args.filter((value) => value === "-e")).toHaveLength(1);
      expect(Object.keys(call.env ?? {})).toEqual([BROWSER_EVIDENCE_SIGN_IN_ENV]);
      expect(decodeBrowserEvidenceSignInEnv(call.env?.[BROWSER_EVIDENCE_SIGN_IN_ENV])).toEqual(VALUES);
      const plan = decodeBrowserEvidenceExecutorPlan(call.args.at(-1))!;
      expect(plan.signIn).toEqual({ path: "/login", usernameSelector: "#email", passwordSelector: "#password", submitSelector: "button", successPath: "/dashboard" });
      expect(plan.maskSelectors).toEqual([".account", "#email", "#password"]);
    }
    // Nothing the worker wrote down (its log, the container's arguments) holds a value or the reference.
    for (const text of [VALUES.username, VALUES.password, Buffer.from(VALUES.password).toString("base64"), "be-demo-signin"]) expect(seen(w), text).not.toContain(text);
  });

  it("does not run, with a fixed reason and nothing started, when no sign-in is saved, the broker cannot be asked or its answer is not one (mutant: a run that goes on signed out)", async () => {
    const notSet = world();
    expect((await collectBrowserEvidence(notSet.input({ recipe: SIGNED, signIn: spy({ status: "not_set" }).signIn }))).notRun).toBe("sign_in_not_set");
    expect(notSet.log.filter((entry) => entry.startsWith("app:") || entry.startsWith("swap") || entry.startsWith("exec"))).toEqual([]);
    for (const value of [new Error(`HTTP 500 for ${VALUES.password}`), undefined]) {
      const w = world();
      const run = await collectBrowserEvidence(w.input({ recipe: SIGNED, signIn: value === undefined ? undefined : spy(value).signIn }));
      expect(run.notRun, String(value)).toBe("capture_failed");
      expect(w.calls).toEqual([]);
      expect(JSON.stringify(run)).not.toContain(VALUES.password);
    }
    // No page changed: the sign-in is not even asked for.
    const unchanged = world({ changed: ["README.md"] });
    const asked = spy(ready);
    expect((await collectBrowserEvidence(unchanged.input({ recipe: SIGNED, signIn: asked.signIn }))).notRun).toBe("no_changed_page");
    expect(asked.state.asked).toBe(0);
  });
});

describe("the docker CLI's environment", () => {
  it("gives `docker run -e NAME` its value from the CLI process's environment only: the value is never an argument, the worker's own environment is not changed, and no env is the worker's environment as it was", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rovara-fake-docker-"));
    const savedPath = process.env["PATH"];
    try {
      // A `docker` that prints the variable it was given and the arguments it was called with.
      await writeFile(join(directory, "docker"), "#!/bin/sh\nprintf '%s|%s' \"${ROVARA_BE_SIGNIN-unset}\" \"$*\"\n");
      await chmod(join(directory, "docker"), 0o755);
      process.env["PATH"] = `${directory}:${savedPath ?? ""}`;
      const cli = createDockerCli();
      const given = await cli.execBytes!(["run", "-e", "ROVARA_BE_SIGNIN", "image"], { maxStdoutBytes: 1_000, env: { ROVARA_BE_SIGNIN: "value-123" } });
      expect(given.stdout.toString()).toBe("value-123|run -e ROVARA_BE_SIGNIN image");
      expect(process.env["ROVARA_BE_SIGNIN"]).toBeUndefined();
      const plain = await cli.execBytes!(["run", "image"], { maxStdoutBytes: 1_000 });
      expect(plain.stdout.toString()).toBe("unset|run image");
    } finally {
      process.env["PATH"] = savedPath;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

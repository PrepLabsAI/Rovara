// TE-H1 slice 4: the worker's half of video on failure. (Scaffold copied from browser-evidence-worker.test.ts.) TE-H1 slice 2 (DEC 241a): the worker's half. The project's app starts in the TASK SANDBOX through the check runners; Chromium runs in a container of the executor image that shares only the sandbox's network; the base code is shown
// for the "before" side and the agent's files are put back exactly; the slice-1 runner's limits hold for whatever the capture container prints; a fault that must stop the task is never absorbed.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeBrowserEvidenceExecutorPlan, decodeBrowserEvidenceUpload, type BrowserEvidenceExecutorLine, type BrowserEvidenceRecipe, type BrowserEvidenceSignInAnswer } from "../../packages/contracts/src/index.js";
import type { OriginalCode } from "../../packages/worker/src/verification/original-code.js";
import { collectBrowserEvidence, parseCaptureOutput, saveBrowserEvidence, type BrowserEvidenceWorkInput } from "../../packages/worker/src/browser-evidence-run.js";

const SANDBOX = "agentx-task-op1-abcd1234";
const IMAGE = "rovara-e2e-executor:test";
const COMMIT = "1".repeat(40);
const RECIPE: BrowserEvidenceRecipe = { startCommand: "npm run start", port: 4321, readyPath: "/health", routes: [{ path: "/checkout", files: ["src/checkout/**"] }, { path: "/settings", files: ["src/settings/**"] }], mask: [".account"] };
const jpeg = (seed: string, size = 500) => { const bytes = new Uint8Array(size); bytes.set([0xff, 0xd8, 0xff]); bytes.fill(seed.charCodeAt(0), 3); return bytes; };
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const line = (value: BrowserEvidenceExecutorLine) => `${JSON.stringify(value)}\n`;
const shotLine = (route: string, seed: string, size = 500, consoleErrors = 0): BrowserEvidenceExecutorLine => ({ t: "shot", route, ok: true, consoleErrors, jpegBase64: Buffer.from(jpeg(seed, size)).toString("base64") });

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


const webm = (seed: string, size = 900) => { const bytes = new Uint8Array(size); bytes.set([0x1a, 0x45, 0xdf, 0xa3]); bytes.fill(seed.charCodeAt(0), 4); return bytes; };
const VIDEO_RECIPE: BrowserEvidenceRecipe = { ...RECIPE, video: { fixtureDataOnly: true } };
const failedWithVideo = (route: string, bytes = webm("v")): BrowserEvidenceExecutorLine => ({ t: "shot", route, ok: false, reason: "page_did_not_load", videoBase64: Buffer.from(bytes).toString("base64") });
const plansOf = (calls: ReturnType<typeof world>["calls"]) => calls.map((call) => ({ side: call.side, plan: decodeBrowserEvidenceExecutorPlan(call.args.at(-1)) }));

describe("video on failure, in the worker", () => {
  it("asks only the candidate's side to record, and only for a recipe that says fixture data only", async () => {
    const w = world();
    await collectBrowserEvidence(w.input({ recipe: VIDEO_RECIPE }));
    expect(plansOf(w.calls).map((row) => [row.side, row.plan?.video])).toEqual([["before", undefined], ["after", true]]);
    const plain = world();
    await collectBrowserEvidence(plain.input());
    expect(plansOf(plain.calls).map((row) => row.plan?.video)).toEqual([undefined, undefined]);
  });

  it("never asks for a recording of an app behind a login, whatever the recipe object says", async () => {
    const signedIn = { ...VIDEO_RECIPE, signIn: { path: "/login", usernameSelector: "#u", passwordSelector: "#p", submitSelector: "#go", successPath: "/home", credentialRef: "be-demo-signin" } } as BrowserEvidenceRecipe;
    const w = world();
    const answer: BrowserEvidenceSignInAnswer = { status: "ready", values: { username: ["tester", "ada", "7"].join("-"), password: ["pw", "Zq7", "Lm2", "Xv9"].join("-") } };
    const captured = await collectBrowserEvidence(w.input({ recipe: signedIn, signIn: async () => answer }));
    // The recipe does not read (the pair is refused whole), so nothing runs at all: no container, no recording.
    expect(captured.notRun).toBe("no_recipe");
    expect(w.calls).toEqual([]);
  });

  it("keeps the video of a page that fails on the candidate (and only the candidate), and the upload carries it", async () => {
    const w = world({ capture: (side, routes) => line({ t: "app", status: "ready" }) + routes.map((route) => line(side === "after" ? failedWithVideo(route) : shotLine(route, "a"))).join("") });
    const captured = await collectBrowserEvidence(w.input({ recipe: VIDEO_RECIPE, changedFilesOf: async () => ["src/checkout/page.tsx"] }));
    expect(captured.routes).toHaveLength(1);
    const row = captured.routes[0]!;
    expect(row).toMatchObject({ route: "/checkout", status: "not_run", reason: "page_did_not_load", video: { sha256: sha(webm("v")) } });
    const bytes: Uint8Array[] = [];
    await saveBrowserEvidence({ ...w.input({ recipe: VIDEO_RECIPE }), sink: async (value) => { bytes.push(value); }, progress: async () => undefined, collect: async () => captured });
    expect(decodeBrowserEvidenceUpload(bytes[0]!).routes[0]).toMatchObject({ video: { sha256: sha(webm("v")) } });
  });

  it("a run whose recipe has no video ignores a recording a container hands over (it was never asked for one)", async () => {
    const w = world({ capture: (side, routes) => line({ t: "app", status: "ready" }) + routes.map((route) => line(side === "after" ? failedWithVideo(route) : shotLine(route, "a"))).join("") });
    const captured = await collectBrowserEvidence(w.input({ changedFilesOf: async () => ["src/checkout/page.tsx"] }));
    // The side that was not asked to record printed a recording: that is no answer at all (the app did not answer as it should).
    expect(captured.notRun).toBe("app_did_not_start");
  });

  it("a before side that prints a recording is no answer, even for a recipe with video", async () => {
    const w = world({ capture: (side, routes) => line({ t: "app", status: "ready" }) + routes.map((route) => line(side === "before" ? failedWithVideo(route) : shotLine(route, "b"))).join("") });
    const captured = await collectBrowserEvidence(w.input({ recipe: VIDEO_RECIPE, changedFilesOf: async () => ["src/checkout/page.tsx"] }));
    expect(captured.notRun).toBe("app_did_not_start");
  });

  it("only the candidate's side may print the larger output: the base side keeps the picture bound", () => {
    const app = line({ t: "app", status: "ready" });
    const big = Buffer.from(app + line({ t: "shot", route: "/a", ok: true, consoleErrors: 1, jpegBase64: Buffer.from(jpeg("a")).toString("base64"), videoBase64: Buffer.from(webm("v", 1_500_000)).toString("base64") }));
    expect(big.byteLength).toBeGreaterThan(1_500_000);
    expect(parseCaptureOutput(big, ["/a"], { video: true })?.shots.get("/a")).toBeDefined();
    expect(parseCaptureOutput(Buffer.concat([big, Buffer.alloc(4 * 1024 * 1024)]), ["/a"], { video: true })).toBeUndefined();
    expect(parseCaptureOutput(big, ["/a"])).toBeUndefined();
  });

  it("hands the docker CLI the picture bound for the base side and the larger one for the candidate's, nothing else changed", async () => {
    const seen: Array<{ side: string; max: number | undefined }> = [];
    const w = world();
    const docker = w.input().docker!;
    const spying: BrowserEvidenceWorkInput["docker"] = { run: docker.run, execBytes: async (args, options) => { seen.push({ side: seen.length === 0 ? "before" : "after", max: options.maxStdoutBytes }); return docker.execBytes!(args, options); } };
    await collectBrowserEvidence(w.input({ recipe: VIDEO_RECIPE, docker: spying }));
    expect(seen[0]?.max).toBe(4 * 1024 * 1024);
    expect(seen[1]?.max).toBeGreaterThan(4 * 1024 * 1024);
  });
});

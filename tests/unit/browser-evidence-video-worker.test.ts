// TE-H1 slice 4: the worker's half of video on failure. (Scaffold copied from browser-evidence-worker.test.ts.) TE-H1 slice 2 (DEC 241a): the worker's half. The project's app starts in the TASK SANDBOX through the check runners; Chromium runs in a container of the executor image that shares only the sandbox's network; the base code is shown
// for the "before" side and the agent's files are put back exactly; the slice-1 runner's limits hold for whatever the capture container prints; a fault that must stop the task is never absorbed.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeBrowserEvidenceExecutorPlan, decodeBrowserEvidenceUpload, type BrowserEvidenceExecutorLine, type BrowserEvidenceRecipe } from "../../packages/contracts/src/index.js";
import type { OriginalCode } from "../../packages/worker/src/verification/original-code.js";
import { collectBrowserEvidence, saveBrowserEvidence, type BrowserEvidenceWorkInput } from "../../packages/worker/src/browser-evidence-run.js";

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

describe("video on failure, in the worker", () => {

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
});

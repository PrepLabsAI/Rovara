// TE-F2 part B: one check round with the model helper beside it. `withModelHelperRound` is the same object when there is no plan; with one, the helper's variables go last into each project command, `endRound` reads the summary,
// says what is true (hosted "not sealed; model hosts blocked by name only", laptop exactly "model hosts not blocked on this machine"), and tears the helper down on every path. The run files are written by the worker.
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckNotRunError, type CheckRunners } from "../../packages/worker/src/verification/checks.js";
import { UNTRUSTED_MODEL_SUMMARY, parseModelHelperSummary, type ModelHelperSummary } from "../../packages/worker/src/model-helper-ledger.js";
import {
  MODEL_HELPER_AGENT_COMMAND_SENTENCE,
  MODEL_HELPER_START_FAILED_SENTENCE,
  modelHelperEvidence,
  removeModelHelperRunFiles,
  withModelHelperRound,
  writeModelHelperRunFiles,
  type ModelHelperRoundPlan,
  type ModelHelperRoundResult,
  type StartedModelHelper,
} from "../../packages/worker/src/model-helper-round.js";
import { modelReplyBundleDigest, parseModelReplyBundleBytes, buildModelReplyBundle } from "../../packages/worker/src/model-reply-bundle.js";
import { ROWS, stampSet } from "../support/model-helper-world.js";

const BLOCK = ["api.openai.com", "generativelanguage.googleapis.com"];
const PINNED = "a".repeat(64);
const SINK = (): void => undefined;
const summary = (over: Partial<ModelHelperSummary> = {}): ModelHelperSummary => ({
  ...UNTRUSTED_MODEL_SUMMARY, trusted: true, mode: "scripted", blockState: "by_name", replySetDigest: PINNED, ...over,
});
const COMMAND = { cwd: ".", executable: "node", args: ["x.js"], timeoutSeconds: 5, env: { KEEP: "1", GEMINI_API_KEY: "from-the-command" } };

describe("evidence", () => {
  it("hosted: says 'not sealed; model hosts blocked by name only', never 'sealed'; the laptop says exactly 'model hosts not blocked on this machine'", () => {
    const hosted = modelHelperEvidence(summary({ scripted: { before_task: 2, independent: 0, task_made: 0 }, countsTowardProof: 2 }), BLOCK);
    expect(hosted).toMatchObject({ result: "ran", countsTowardProof: 2 });
    expect(hosted.lines[0]).toBe("not sealed; model hosts blocked by name only");
    const laptop = modelHelperEvidence(summary({ blockState: "not_blocked_here" }), BLOCK);
    expect(laptop.lines[0]).toBe("model hosts not blocked on this machine");
    expect(laptop.lines.join("\n")).not.toContain("blocked by name");
    // an unknown or unreadable state is the weaker claim
    expect(modelHelperEvidence(summary({ blockState: null }), BLOCK).lines[0]).toBe("model hosts not blocked on this machine");
  });
  it("an escape makes the round not run, named by host; an untrusted or unreadable record is not run; the failure pack and task-made replies are labelled not counted", () => {
    const escaped = modelHelperEvidence(summary({ escapes: { count: 1, hosts: ["api.openai.com"], unreadable: 0 } }), BLOCK);
    expect(escaped.result).toBe("not_run");
    expect(escaped.lines).toContain("not run: client ignored the redirect (called api.openai.com)");
    expect(escaped.escapedHosts).toEqual(["api.openai.com"]);
    expect(modelHelperEvidence(UNTRUSTED_MODEL_SUMMARY, BLOCK).result).toBe("not_run");
    expect(modelHelperEvidence(undefined, BLOCK)).toMatchObject({ result: "not_run", countsTowardProof: 0 });
    const mixed = modelHelperEvidence(summary({ scripted: { before_task: 0, independent: 0, task_made: 3 }, failurePack: 2, unmatched: 1, countsTowardProof: 0 }), BLOCK);
    expect(mixed.lines.join("\n")).toContain("scripted replies added in this task (not counted)");
    expect(mixed.lines.join("\n")).toContain("failure pack: informational only, never proof (not counted)");
    expect(mixed.lines.join("\n")).toContain("not run: no scripted reply for this request");
    expect(mixed.countsTowardProof).toBe(0);
    expect(mixed.lines.join("\n")).not.toMatch(/\bReal\b/u);
  });
  it("the summary line round-trips and an extra count past its bound is unreadable, never 'no calls'", () => {
    const line = JSON.stringify(summary({ failurePack: 1 }));
    expect(parseModelHelperSummary(`${line}\n`)).toMatchObject({ failurePack: 1 });
    expect(parseModelHelperSummary("")).toBeUndefined();
    expect(parseModelHelperSummary(`${line}\nextra`)).toBeUndefined();
    expect(parseModelHelperSummary(JSON.stringify({ ...summary(), failurePack: 10_001 }))).toBeUndefined();
    expect(parseModelHelperSummary(JSON.stringify({ ...summary(), extra: 1 }))).toBeUndefined();
    expect(parseModelHelperSummary(JSON.stringify({ ...UNTRUSTED_MODEL_SUMMARY, failurePack: 1 }))).toBeUndefined();
  });
});

function fakeRunners(log: string[]): CheckRunners & { seen: unknown[] } {
  const seen: unknown[] = [];
  return {
    seen,
    runProjectCommand: (command) => {
      seen.push(command);
      return Promise.resolve({ exitCode: 0, timedOut: false, stdout: "", stderr: "" });
    },
    runAgentCommand: (replay) => {
      log.push(`agent:${replay}`);
      return Promise.resolve({ exitCode: 0, timedOut: false, output: "" });
    },
    freshServices: () => {
      log.push("fresh");
      return Promise.resolve();
    },
    endRound: () => {
      log.push("base-endRound");
      return Promise.resolve();
    },
  };
}
const signal = new AbortController().signal;

describe("withModelHelperRound", () => {
  it("M3: a plan with no onResult consumer is refused (an escape must reach whoever turns it into 'not run' checks: TE-B5/TE-A3)", () => {
    const noSink = { blockList: BLOCK, start: () => Promise.resolve(undefined) } as unknown as ModelHelperRoundPlan;
    expect(() => withModelHelperRound(noSink, fakeRunners([]))).toThrow(/onResult/u);
  });
  it("L2: a summary whose reply-set digest is not the one the worker pinned is untrusted: the round is not run", async () => {
    const results: ModelHelperRoundResult[] = [];
    const helper: StartedModelHelper = { pinnedDigest: PINNED, commandEnvironment: {}, readSummary: () => Promise.resolve(summary({ replySetDigest: "b".repeat(64), scripted: { before_task: 3, independent: 0, task_made: 0 }, countsTowardProof: 3 })), stop: () => Promise.resolve() };
    const wrapped = withModelHelperRound({ blockList: BLOCK, start: () => Promise.resolve(helper), onResult: (result) => results.push(result) }, fakeRunners([]));
    await wrapped.runProjectCommand(COMMAND, signal);
    await wrapped.endRound?.();
    expect(results[0]?.summary?.trusted).toBe(false);
    expect(results[0]?.evidence).toMatchObject({ result: "not_run", countsTowardProof: 0 });
    // the right digest passes
    const good: StartedModelHelper = { ...helper, readSummary: () => Promise.resolve(summary({ scripted: { before_task: 3, independent: 0, task_made: 0 }, countsTowardProof: 3 })) };
    const again = withModelHelperRound({ blockList: BLOCK, start: () => Promise.resolve(good), onResult: (result) => results.push(result) }, fakeRunners([]));
    await again.runProjectCommand(COMMAND, signal);
    await again.endRound?.();
    expect(results[1]?.evidence).toMatchObject({ result: "ran", countsTowardProof: 3 });
  });
  it("is the same object when there is no plan", () => {
    const runners = fakeRunners([]);
    expect(withModelHelperRound(undefined, runners)).toBe(runners);
  });
  it("starts the helper on the first command, puts the helper's variables LAST (over the command's own), reads the summary at endRound, stops the helper and then ends the base round", async () => {
    const log: string[] = [];
    const results: ModelHelperRoundResult[] = [];
    const helper: StartedModelHelper = {
      pinnedDigest: PINNED,
      commandEnvironment: { GEMINI_API_KEY: "rovara-test-key", GOOGLE_GEMINI_BASE_URL: "http://127.0.0.1:1/p/gemini" },
      readSummary: () => { log.push("summary"); return Promise.resolve(summary({ blockState: "not_blocked_here" })); },
      stop: () => { log.push("stop"); return Promise.resolve(); },
    };
    let starts = 0;
    const plan: ModelHelperRoundPlan = { blockList: BLOCK, start: () => { starts += 1; return Promise.resolve(helper); }, onResult: (result) => results.push(result) };
    const base = fakeRunners(log);
    const wrapped = withModelHelperRound(plan, base);
    await wrapped.runProjectCommand(COMMAND, signal);
    await wrapped.runProjectCommand(COMMAND, signal);
    expect(starts).toBe(1);
    expect(base.seen[0]).toMatchObject({ env: { KEEP: "1", GEMINI_API_KEY: "rovara-test-key", GOOGLE_GEMINI_BASE_URL: "http://127.0.0.1:1/p/gemini" } });
    await wrapped.freshServices?.(signal);
    await wrapped.endRound?.();
    expect(log).toEqual(["fresh", "summary", "stop", "base-endRound"]);
    expect(results[0]?.evidence.lines[0]).toBe("model hosts not blocked on this machine");
    // the next round starts a fresh helper
    await wrapped.runProjectCommand(COMMAND, signal);
    expect(starts).toBe(2);
    await wrapped.endRound?.();
  });
  it("tears down and ends the base round even when the summary cannot be read or the sink throws", async () => {
    const log: string[] = [];
    const helper: StartedModelHelper = { pinnedDigest: PINNED, commandEnvironment: {}, readSummary: () => Promise.reject(new Error("gone")), stop: () => { log.push("stop"); return Promise.resolve(); } };
    const results: ModelHelperRoundResult[] = [];
    const wrapped = withModelHelperRound({ blockList: BLOCK, start: () => Promise.resolve(helper), onResult: (result) => { results.push(result); throw new Error("sink"); } }, fakeRunners(log));
    await wrapped.runProjectCommand(COMMAND, signal);
    await wrapped.endRound?.();
    expect(log).toEqual(["stop", "base-endRound"]);
    expect(results[0]).toMatchObject({ summary: undefined, evidence: { result: "not_run" } });
  });
  it("a helper that cannot start makes the command 'not run', never a run without the redirect; a round with no helper runs unchanged", async () => {
    const failing = withModelHelperRound({ blockList: BLOCK, onResult: SINK, start: () => Promise.reject(new Error("no")) }, fakeRunners([]));
    await expect(failing.runProjectCommand(COMMAND, signal)).rejects.toThrow(MODEL_HELPER_START_FAILED_SENTENCE);
    const none = fakeRunners([]);
    const wrapped = withModelHelperRound({ blockList: BLOCK, onResult: SINK, start: () => Promise.resolve(undefined) }, none);
    await wrapped.runProjectCommand(COMMAND, signal);
    expect(none.seen[0]).toBe(COMMAND);
  });
  it("a replayed agent command on a machine whose variables are injected here fails closed (it would run with the user's real keys and no redirect); a hosted helper (no variables here) delegates", async () => {
    const laptop = withModelHelperRound({ blockList: BLOCK, onResult: SINK, start: () => Promise.resolve({ pinnedDigest: PINNED, commandEnvironment: { A: "b" }, readSummary: () => Promise.resolve(undefined), stop: () => Promise.resolve() }) }, fakeRunners([]));
    await expect(laptop.runAgentCommand("npm test", 1000, signal)).rejects.toThrow(CheckNotRunError);
    await expect(laptop.runAgentCommand("npm test", 1000, signal)).rejects.toThrow(MODEL_HELPER_AGENT_COMMAND_SENTENCE);
    const log: string[] = [];
    const hosted = withModelHelperRound({ blockList: BLOCK, onResult: SINK, start: () => Promise.resolve({ pinnedDigest: PINNED, commandEnvironment: {}, readSummary: () => Promise.resolve(undefined), stop: () => Promise.resolve() }) }, fakeRunners(log));
    await hosted.runAgentCommand("npm test", 1000, signal);
    expect(log).toEqual(["agent:npm test"]);
  });
});

describe("run files", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  it("are written by the worker, private (0700 directory, 0600 files), and the helper's parse accepts exactly the digest the worker pinned", async () => {
    const parent = mkdtempSync(join(tmpdir(), "rsrf-"));
    dirs.push(parent);
    const set = stampSet("openai_compatible", [{ id: "a" }]);
    const files = await writeModelHelperRunFiles({ parent, rows: ROWS, sets: [set] });
    expect(statSync(files.dir).mode & 0o777).toBe(0o700);
    expect(statSync(files.rowsPath).mode & 0o777).toBe(0o600);
    expect(statSync(files.repliesPath).mode & 0o777).toBe(0o600);
    const bytes = readFileSync(files.repliesPath);
    expect(files.digest).toBe(modelReplyBundleDigest(buildModelReplyBundle([set])));
    expect(parseModelReplyBundleBytes(bytes, files.digest).ok).toBe(true);
    expect(parseModelReplyBundleBytes(bytes, "0".repeat(64)).ok).toBe(false);
    expect(parseModelReplyBundleBytes(Buffer.from(bytes.toString().replace("scripted", "rigged")), files.digest).ok).toBe(false);
    await removeModelHelperRunFiles(files);
  });
  it("refuse a reply that says independent: bytes can carry any provenance, and replies.json cannot", async () => {
    const parent = mkdtempSync(join(tmpdir(), "rsrf-"));
    dirs.push(parent);
    const independent = stampSet("openai_compatible", [{ id: "a", provenance: "independent", origin: undefined }]);
    await expect(writeModelHelperRunFiles({ parent, rows: ROWS, sets: [independent] })).rejects.toThrow(RangeError);
    const bundle = buildModelReplyBundle([independent]);
    expect(parseModelReplyBundleBytes(Buffer.from(JSON.stringify(bundle))).ok).toBe(false);
  });
});

describe("the hook in run-task.ts", () => {
  it("wraps all three createCheckRunners call sites, and an absent dependency leaves the runners untouched", async () => {
    const { readFileSync: read } = await import("node:fs");
    const source = read(join(__dirname, "../../packages/worker/src/run-task.ts"), "utf8");
    expect(source.match(/createCheckRunners\(/gu)).toHaveLength(3);
    expect(source.match(/withModelHelperRound\(modelHelperPlanFor\(dependencies\.modelHelperRound, \{ rootPath: canonicalRoot \}\), /gu)).toHaveLength(3);
    const { modelHelperPlanFor } = await import("../../packages/worker/src/model-helper-round.js");
    expect(modelHelperPlanFor(undefined, { rootPath: "/x" })).toBeUndefined();
    const plan: ModelHelperRoundPlan = { blockList: [], onResult: SINK, start: () => Promise.resolve(undefined) };
    expect(modelHelperPlanFor(plan, { rootPath: "/x" })).toBe(plan);
    expect(modelHelperPlanFor((context) => (context.rootPath === "/x" ? plan : undefined), { rootPath: "/x" })).toBe(plan);
  });
});

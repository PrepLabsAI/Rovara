// DEC 253q(a), 253o(1): the setup run's eval discovery producer (the agent's drafted eval -> the `eval_discovery` report) and the judge contract (the broker's judge pin).
// The producer is deterministic, bounded and whole-or-nothing; the report it makes is schema-valid. Mutants named in titles were run by hand (break the check, see the test fail, restore).
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  EVAL_DISCOVERY_REPORT_MAX_BYTES, EVAL_PRODUCT_ROW, canonicalJson, evalJudgePinOf, evalQuestionHash,
} from "@agentx/contracts";
import { produceEvalDiscoveryReport, type EvalDiscoveryProducerInput } from "../../packages/worker/src/verification/eval-discovery-producer.js";
import type { EvalDiscovery } from "../../packages/worker/src/verification/eval-discovery.js";

const IMAGE = `registry.example/worker@sha256:${"e".repeat(64)}`;
const command = { executable: "node", args: ["evals/run.js", "--out", "rovara-measures.json"], cwd: "." };
const report = { cwd: ".", argument: "rovara-measures.json" };
const JUDGE = { kind: "model", model: "gemini-2.5-pro", version: "gemini-2.5-pro-002", scoringPath: "evals/demo/judge.md" } as const;
const draftSuite = (over: Record<string, unknown> = {}) => ({
  selection: "evals/demo", repository: "web",
  questions: [{ id: "q2", category: "safety", path: "evals/demo/q2.txt" }, { id: "q1", category: "ordinary", path: "evals/demo/q1.txt" }],
  command, report, model: "gemini-2.5-flash", modelVersion: "gemini-2.5-flash-001", judge: JUDGE, subsetSupported: true, maxCallsPerQuestion: 2, maxCostMicrosPerQuestion: 10, ...over,
});
const TRACKED = new Map([["web", new Set(["evals/demo/q1.txt", "evals/demo/q2.txt", "evals/demo/judge.md", "src/app.ts"])]]);
const found = (paths: string[]): EvalDiscovery => ({ status: "found", candidates: paths.map((path) => ({ path, label: "x", tool: "eval folder" })), omitted: [], message: "" });
const input = (over: Partial<EvalDiscoveryProducerInput> = {}): EvalDiscoveryProducerInput => ({
  draft: { suites: [draftSuite()] }, repositories: [{ name: "web", directory: "/work/web" }], tracked: TRACKED, image: IMAGE, discover: async () => found(["evals/demo"]), ...over,
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });

describe("the judge contract: named by the run, pinned by the broker", () => {
  it("the judge pin covers the row, the judge's kind, model, version and the scoring file's path and hash (mutant: each member of the pin's body)", () => {
    const pin = (over: Record<string, unknown> = {}, hash = "a".repeat(64)) => evalJudgePinOf({ catalogRowId: "gemini", judge: { ...JUDGE, ...over }, scoringHash: hash });
    const base = pin();
    expect(base).toMatch(/^[a-f0-9]{64}$/u);
    expect(pin()).toBe(base);
    for (const other of [pin({ version: "gemini-2.5-pro-003" }), pin({ model: "gemini-2.5-flash" }), pin({ scoringPath: "evals/demo/other.md" }), pin({}, "b".repeat(64)),
      evalJudgePinOf({ catalogRowId: "gemini", judge: { kind: "rule", scoringPath: JUDGE.scoringPath }, scoringHash: "a".repeat(64) })]) expect(other).not.toBe(base);
  });
  it("refuses a row the eval route does not serve, a judge model of another family and a hash that is not one", () => {
    expect(() => evalJudgePinOf({ catalogRowId: "openai", judge: JUDGE, scoringHash: "a".repeat(64) })).toThrow();
    expect(() => evalJudgePinOf({ catalogRowId: "gemini", judge: { ...JUDGE, model: "claude-opus-5" }, scoringHash: "a".repeat(64) })).toThrow();
    expect(() => evalJudgePinOf({ catalogRowId: "gemini", judge: JUDGE, scoringHash: "nope" })).toThrow();
  });
});

describe("the producer: the agent's draft -> a bounded, schema-valid report", () => {
  it("is deterministic: the same draft in another order gives the same bytes, and F4 runs once per repository", async () => {
    let discovered = 0;
    const discover = async () => { discovered++; return found(["evals/demo"]); };
    const a = await produceEvalDiscoveryReport(input({ discover, draft: { suites: [draftSuite(), draftSuite({ selection: "b" })] } }));
    const b = await produceEvalDiscoveryReport(input({ discover, draft: { suites: [draftSuite({ selection: "b", questions: [...draftSuite().questions].reverse() }), draftSuite()] } }));
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(discovered).toBe(2);
  });
  it("no draft is no report; anything else is whole or nothing with a fixed reason (mutants: strict draft, image pin, repository, F4 containment, tracked questions, tracked scoring file)", async () => {
    const reason = async (over: Partial<EvalDiscoveryProducerInput>) => { const out = await produceEvalDiscoveryReport(input(over)); return "refused" in out ? out.refused : "report"; };
    expect(await reason({ draft: undefined })).toBe("none");
    expect(await reason({ draft: { suites: [draftSuite({ judgePin: "b".repeat(64) })] } })).toBe("unreadable");
    expect(await reason({ draft: { suites: [draftSuite({ catalogRowId: "openai" })] } })).toBe("unreadable");
    expect(await reason({ draft: { suites: [], extra: 1 } })).toBe("unreadable");
    expect(await reason({ draft: "eval" })).toBe("unreadable");
    expect(await reason({ image: "worker:latest" })).toBe("image");
    expect(await reason({ image: undefined })).toBe("image");
    expect(await reason({ draft: { suites: [draftSuite({ repository: "other" })] } })).toBe("repository");
    expect(await reason({ draft: { suites: [draftSuite({ repository: undefined })] }, repositories: [{ name: "web", directory: "/w" }, { name: "api", directory: "/a" }] })).toBe("repository");
    expect(await reason({ discover: async () => found(["evals/other"]) })).toBe("not_found");
    expect(await reason({ discover: async () => found(["evals/dem"]) })).toBe("not_found");
    expect(await reason({ discover: async () => { throw new Error("unreadable"); } })).toBe("not_found");
    expect(await reason({ draft: { suites: [draftSuite({ questions: [{ id: "q1", category: "ordinary", path: "evals/demo/untracked.txt" }] })] }, discover: async () => found(["evals/demo"]) })).toBe("untracked");
    expect(await reason({ draft: { suites: [draftSuite({ judge: { kind: "rule", scoringPath: "evals/demo/not-there.md" } })] } })).toBe("untracked");
    expect(await reason({ tracked: new Map() })).toBe("untracked");
    // A tracked scoring file outside every eval suite F4 found (mutant: the scoring file's containment).
    expect(await reason({ draft: { suites: [draftSuite({ judge: { kind: "rule", scoringPath: "src/app.ts" } })] } })).toBe("not_found");
    // One bad suite among good ones: nothing at all.
    expect(await reason({ draft: { suites: [draftSuite(), draftSuite({ selection: "b", repository: "other" })] } })).toBe("repository");
  });
  it("is bounded: a draft over the report's byte cap is refused before any schema or F4 work, in bounded time (mutant: the size bound)", async () => {
    let discovered = 0;
    const huge = { suites: [draftSuite({ questions: Array.from({ length: 1_000 }, (_, i) => ({ id: `q${i}`, category: "ordinary", path: `evals/demo/${"p".repeat(400)}/${i}.txt` })) })] };
    expect(Buffer.byteLength(JSON.stringify(huge))).toBeGreaterThan(EVAL_DISCOVERY_REPORT_MAX_BYTES);
    const started = Date.now();
    expect(await produceEvalDiscoveryReport(input({ draft: huge, discover: async () => { discovered++; return found(["evals/demo"]); } }))).toEqual({ refused: "too_large" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(discovered).toBe(0);
    // The largest allowed draft (1,000 questions within the cap) is still quick.
    const many = { suites: [draftSuite({ questions: Array.from({ length: 1_000 }, (_, i) => ({ id: `q${i}`, category: "ordinary", path: `evals/demo/${i % 100}.txt` })) })] };
    const tracked = new Map([["web", new Set([...Array.from({ length: 100 }, (_, i) => `evals/demo/${i}.txt`), "evals/demo/judge.md"])]]);
    const t0 = Date.now();
    const out = await produceEvalDiscoveryReport(input({ draft: many, tracked }));
    expect("report" in out).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
  it("the judge pin the broker will compute is the scoring file's, not anything in the report", () => {
    const hash = evalQuestionHash(Buffer.from("judge\n"));
    expect(evalJudgePinOf({ catalogRowId: EVAL_PRODUCT_ROW, judge: JUDGE, scoringHash: hash })).not.toBe(evalJudgePinOf({ catalogRowId: EVAL_PRODUCT_ROW, judge: JUDGE, scoringHash: evalQuestionHash(Buffer.from("judge 2\n")) }));
  });
});

// L4-EVW2 (DEC 254zzz20 D2): the draft says what the eval's command writes, so the broker knows whether a wrapper pull request is needed. The producer only carries it (strictly checked); the broker decides.
describe("what the eval writes (output)", () => {
  const ROWS = { kind: "rows", format: "jsonl", language: "python", idField: "case_id", pass: { field: "passed", equals: true } };
  it("carries the setup sandbox's dry-run of each file by the suite's selection (never the draft's own claim), and an absent one stays absent", async () => {
    const dryRuns = new Map<string, "passed" | "failed">([["evals/demo", "passed"]]);
    const ok = await produceEvalDiscoveryReport(input({ draft: { suites: [draftSuite({ output: ROWS })] }, dryRuns }));
    expect("report" in ok && ok.report.suites[0]!.wrapperDryRun).toBe("passed");
    const failed = await produceEvalDiscoveryReport(input({ draft: { suites: [draftSuite({ output: ROWS })] }, dryRuns: new Map([["evals/demo", "failed"]]) }));
    expect("report" in failed && failed.report.suites[0]!.wrapperDryRun).toBe("failed");
    const none = await produceEvalDiscoveryReport(input({ draft: { suites: [draftSuite({ output: ROWS })] } }));
    expect("report" in none && "wrapperDryRun" in none.report.suites[0]!).toBe(false);
    // The draft cannot say it passed.
    expect(await produceEvalDiscoveryReport(input({ draft: { suites: [draftSuite({ output: ROWS, wrapperDryRun: "passed" })] } }))).toEqual({ refused: "unreadable" });
  });
});

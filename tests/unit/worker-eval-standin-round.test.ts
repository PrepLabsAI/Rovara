// L4-E56 (rows E5 and E6, R2): the eval ROUND with an outside-HTTP stand-in. A question that FAILED in a run where Rovara had to make up an answer is "not compared" on both sides and can never be "Worse on eval"; the counts are in
// the result and in the artifact; a re-ask that hit no gap clears a question the big first run could not tell apart; the repository's own recordings and OpenAPI files are read as data, through no link; the fixture fake in
// `generate` mode never stops and shares one book.
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attestRovaraOnlyBaseCheckout, evalFactsAllRun, EvalRoundArtifactSchema, evalResultFromArtifact, type EvalStandInCounts } from "@agentx/contracts";
import { evalCommandFingerprint, type EvalBaseRecord } from "../../packages/contracts/src/eval-base-cache.js";
import { runEvalRound, type EvalRoundInput } from "../../packages/worker/src/verification/eval-round.js";
import { EvalStandInRound, buildEvalStandInPlan, readRepositoryRecordings } from "../../packages/worker/src/eval-standin-round.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
const hash = "b".repeat(64);
const samples = (pass: boolean, count: number) => Array.from({ length: count }, () => ({ pass, answer: pass ? "old answer" : "new answer" }));
const COUNTS: EvalStandInCounts = { recorded: 0, generated: 1, generatedNoContract: 1, newConnections: 0, served: 6, gapCalls: 4, saturated: false };

/** A round whose new side fails the questions in `failing` (and passes the rest), and whose runs report a gap according to `gapOf`. */
async function setup(options: { n?: number; failing?: readonly string[]; failFirstOnly?: readonly string[]; subsetSupported?: boolean; flakyOld?: readonly string[]; gapOf?: (side: "old" | "new", ids: readonly string[], index: number) => boolean | undefined } = {}) {
  const n = options.n ?? 3;
  const root = await mkdtemp(join(process.env["TMPDIR"] ?? process.cwd(), "e56-round-")); roots.push(root);
  const ids = Array.from({ length: n }, (_, i) => `q${i}`);
  const failing = new Set(options.failing ?? ids);
  const failFirstOnly = new Set(options.failFirstOnly ?? []);
  const record: EvalBaseRecord = { schemaVersion: 1, measures: [{ name: "accuracy", unit: "fraction", direction: "up_good", value: 1 }], caseCount: n, recordedOn: "2026-11-13", roundKind: "check_unsealed", runnerSchemaVersion: 1, questions: ids.map((id) => ({ id, samples: (options.flakyOld ?? []).includes(id) ? [{ pass: true, answer: "old answer" }, { pass: false, answer: "old answer" }, { pass: true, answer: "old answer" }] : samples(true, 3) })) };
  const requests: Array<{ side: string; ids: readonly string[]; runs: number }> = [];
  let first = true;
  const input: EvalRoundInput = {
    trigger: { needed: true, reason: "changes" }, roundKind: "check_unsealed", evalConfigured: true,
    key: { company: "org-a", project: "project-a", baseCommit: "a".repeat(40), commandFingerprint: evalCommandFingerprint("eval"), catalogRowId: "gemini", model: "model-a", modelVersion: "version-a" },
    settings: { imageDigest: "image", route: "customer" },
    evalSetHash: hash,
    cache: { read: async () => record, write: async () => "stored" },
    questionPlan: {
      company: "org-a", provider: "customer", connected: true, previousPasses: 0, judgePin: hash, baselineJudgePin: hash, subsetSupported: options.subsetSupported ?? true,
      questions: ids.map((id) => ({ id, category: "ordinary", baseHash: hash, headHash: hash })),
      maxCallsPerQuestion: 1, maxCostMicrosPerQuestion: 100,
      run: async (request) => {
        const index = requests.length;
        requests.push(request);
        const path = `run-${requests.length}.json`;
        await writeFile(join(root, path), JSON.stringify({ schemaVersion: 1, measures: record.measures, questions: request.ids.map((id) => ({ id, samples: samples(request.side === "old" || !(failing.has(id) || (failFirstOnly.has(id) && index === 0)), request.runs) })) }));
        const changed = first && request.side === "new"; first = false;
        const gap = options.gapOf?.(request.side, request.ids, index);
        return {
          attestation: attestRovaraOnlyBaseCheckout({ baseCommit: input.key.baseCommit }), report: { root, cwd: ".", argument: path, notBeforeMs: Date.now() - 1000 }, facts: evalFactsAllRun(request.ids.length * request.runs),
          calls: request.ids.length * request.runs, costMicros: 100 * request.ids.length * request.runs, changedPromptCalls: changed ? request.ids.length : 0,
          ...(gap === undefined ? {} : { standIns: { hitGap: gap, counts: COUNTS } }),
        };
      },
    },
  };
  return { input, requests };
}

describe("a gap can never make a question 'Worse on eval'", () => {
  it("CONTROL: with no stand-in the same failures are 'Worse on eval'", async () => {
    const { input } = await setup();
    expect(await runEvalRound(input)).toMatchObject({ status: "done", result: { label: "Worse on eval" } });
  });
  it("drops every question that failed in runs that all hit a gap: no verdict from them, 'Not run', the questions listed as not compared, the counts in the result", async () => {
    const { input } = await setup({ gapOf: () => true });
    const output = await runEvalRound(input);
    if (output.status !== "done") throw new Error("done");
    expect(output.result.label).toBe("Not run");
    // DEC 254zzz71: every failing question was dropped: not a near-empty comparison but "Not run: outside calls were made up".
    expect(output.result.notRun?.reason).toBe("outside_calls_made_up");
    expect(output.result.notRun?.sentence).toBe("Not run: outside calls were made up");
    expect(output.result.excluded).toEqual([{ id: "q0", reason: "stand_in_gap" }, { id: "q1", reason: "stand_in_gap" }, { id: "q2", reason: "stand_in_gap" }]);
    expect(output.result.standIns).toEqual({ recorded: 0, generated: 1, generatedNoContract: 1, newConnections: 0, notCompared: 3, saturated: false });
    expect(output.result.summary).toContain("3 questions not compared");
    expect(output.result.disposition.check).not.toBe("failure");
  });
  it("keeps a question the re-ask cleared: the first big run hit a gap but the re-asks (few questions, both sides) hit none, so the regression is real", async () => {
    // Run 0 is the first big run (it hit a gap); runs 1 and 2 are the re-asks of the suspects on each side (no gap).
    const { input, requests } = await setup({ gapOf: (_side, _ids, index) => index === 0 });
    const output = await runEvalRound(input);
    if (output.status !== "done") throw new Error("done");
    expect(requests.map((r) => `${r.side}:${String(r.runs)}`).slice(0, 3)).toEqual(["new:1", "old:3", "new:3"]);
    expect(output.result.label).toBe("Worse on eval");
    expect(output.result.excluded.filter((q) => q.reason === "stand_in_gap")).toEqual([]);
    expect(output.result.standIns).toMatchObject({ notCompared: 0 });
  });
  it("drops only the questions that failed: one failing question in a gap run is not compared, and because it was the only failure (most failures dropped) the eval is 'Not run: outside calls were made up', never 'Worse'", async () => {
    const { input } = await setup({ n: 3, failing: ["q1"], gapOf: () => true });
    const output = await runEvalRound(input);
    if (output.status !== "done") throw new Error("done");
    expect(output.result.excluded).toEqual([{ id: "q1", reason: "stand_in_gap" }]);
    expect(output.result.label).toBe("Not run");
    expect(output.result.notRun?.reason).toBe("outside_calls_made_up");
    expect(output.result.label).not.toBe("Worse on eval");
    expect(output.result.standIns).toMatchObject({ notCompared: 1 });
    expect(output.result.questions.map((q) => q.id)).not.toContain("q1");
  });
  it("drops nothing when no run hit a gap, and still reports the counts", async () => {
    const { input } = await setup({ gapOf: () => false });
    const output = await runEvalRound(input);
    if (output.status !== "done") throw new Error("done");
    expect(output.result.label).toBe("Worse on eval");
    expect(output.result.excluded).toEqual([]);
    expect(output.result.standIns).toMatchObject({ notCompared: 0, generated: 1 });
  });
  it("a whole-set runner (no subsets) in a gap round still ends in a judged or fixed-words result, never invalid question data", async () => {
    const { input } = await setup({ subsetSupported: false, gapOf: () => true });
    const output = await runEvalRound(input);
    if (output.status !== "done") throw new Error("done");
    expect(output.result.notRun?.reason).not.toBe("invalid_question_data");
    expect(output.result.label).not.toBe("Worse on eval");
  });
  it("does not ask a dropped question again at the second look (q2 is flaky on main and was only ever asked in the gap run; q0 and q1 failed once by noise and were cleared by gap-free re-asks)", async () => {
    const { input, requests } = await setup({ n: 6, failing: [], failFirstOnly: ["q0", "q1"], flakyOld: ["q2"], gapOf: (_side, _ids, index) => index === 0 });
    const output = await runEvalRound(input);
    if (output.status !== "done") throw new Error("done");
    expect(output.result.excluded).toEqual([{ id: "q2", reason: "stand_in_gap" }]);
    const looks = requests.filter((r) => r.runs === 2);
    expect(looks).toHaveLength(1);
    expect(looks[0]!.ids).toEqual(["q0", "q1", "q3", "q4", "q5"]);
  });
});

describe("the counts travel in the evidence and survive the artifact", () => {
  it("puts the numbers in the evidence, and a re-derived result carries them, with the not-compared sentence and the made-up-answers line, and no host or path", async () => {
    // No run hit a gap here (so the round itself drops nothing); one question is then listed as dropped for a gap, to see the words the artifact derives.
    const { input } = await setup({ n: 3, failing: ["q1"], gapOf: () => false });
    const output = await runEvalRound(input);
    if (output.status !== "done" || output.evidence === undefined) throw new Error("done");
    expect(output.evidence.standIns).toEqual({ recorded: 0, generated: 1, generatedNoContract: 1, newConnections: 0, notCompared: 0, saturated: false });
    const evidence = { ...output.evidence, excluded: [{ id: "q9", reason: "stand_in_gap" }], standIns: { ...output.evidence.standIns!, notCompared: 1 } };
    const artifact = { schemaVersion: 1, candidateDigest: "a".repeat(64), roundKind: "check_unsealed", evalPass: 1, outcome: "done", ...evidence, usage: { calls: 9, costMicros: 900 }, cache: "hit", evalConfigured: true };
    expect(EvalRoundArtifactSchema.safeParse(artifact).success).toBe(true);
    const result = evalResultFromArtifact(artifact);
    expect(result.standIns).toMatchObject({ notCompared: 1 });
    expect(result.excluded).toContainEqual({ id: "q9", reason: "stand_in_gap" });
    expect(result.summary).toContain("1 question not compared: an outside service's answer was made up by Rovara.");
    // E9 words: counted answers, "were made up", "not compared"; no host, path or secret.
    const words = result.notices.join(" ");
    expect(words).toContain("2 answers were made up");
    expect(words).toContain("1 question was not compared");
    expect(JSON.stringify(result)).not.toMatch(/https?:|tiktok|\/v2/u);
  });
  it("refuses a forged standIns block (a count past its limit, an unknown field)", async () => {
    const { input } = await setup({ gapOf: () => false });
    const output = await runEvalRound(input);
    if (output.status !== "done" || output.evidence === undefined) throw new Error("done");
    const base = { schemaVersion: 1, candidateDigest: "a".repeat(64), roundKind: "check_unsealed", evalPass: 1, outcome: "done", ...output.evidence, usage: { calls: 9, costMicros: 900 }, cache: "hit", evalConfigured: true };
    expect(EvalRoundArtifactSchema.safeParse({ ...base, standIns: { ...base.standIns, host: "x.test" } }).success).toBe(false);
    expect(EvalRoundArtifactSchema.safeParse({ ...base, standIns: { ...base.standIns, generated: -1 } }).success).toBe(false);
    expect(EvalRoundArtifactSchema.safeParse({ ...base, standIns: { ...base.standIns, generated: 10_000_000 } }).success).toBe(false);
    expect(EvalRoundArtifactSchema.safeParse({ ...base, excluded: [{ id: "q", reason: "made_up_reason" }] }).success).toBe(false);
  });
});

describe("the round object", () => {
  const WORKSPACE = "0b9f6a1e-6c1e-4c53-9d0a-5d3a1d6f2c11";
  const OPERATION = "7c1f0d3a-2b8e-4a55-8f3b-9a1c2d3e4f50";
  const summary = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1 as const, trusted: true as const, workspaceId: WORKSPACE, operationId: OPERATION, digest: "a".repeat(64),
    counts: { recorded: 0, generated: 1, generatedNoContract: 0, newConnections: 0, served: 3, gapCalls: 2, saturated: false }, foreign: 0, refused: 0, tlsFailed: 0,
    additions: [{ key: "k".repeat(64), status: 200, contentType: "application/json", body: "{}", cls: "generated" as const }], gaps: [], newHosts: [], ...overrides,
  });
  it("keeps the first answer for a key, adds a run's answers to the book, and sums the calls", () => {
    const round = new EvalStandInRound({ workspaceId: WORKSPACE, operationId: OPERATION, plan: [] });
    expect(round.absorb(summary())).toMatchObject({ hitGap: true, counts: { generated: 1, served: 3, gapCalls: 2 } });
    expect(round.absorb(summary({ additions: [{ key: "k".repeat(64), status: 500, contentType: "text/plain", body: "later", cls: "generated" }] }))).toMatchObject({ counts: { generated: 1, served: 6, gapCalls: 4 } });
    expect(round.book.snapshot()).toHaveLength(1);
    expect(round.book.snapshot()[0]).toMatchObject({ status: 200, body: "{}" });
    expect(round.setContent().book).toHaveLength(1);
  });
  it("says a run with no gap call did not hit a gap, and one with a saturated summary did", () => {
    const round = new EvalStandInRound({ workspaceId: WORKSPACE, operationId: OPERATION, plan: [] });
    expect(round.absorb(summary({ counts: { recorded: 1, generated: 0, generatedNoContract: 0, newConnections: 0, served: 2, gapCalls: 0, saturated: false }, additions: [] })).hitGap).toBe(false);
    expect(round.absorb(summary({ counts: { recorded: 1, generated: 0, generatedNoContract: 0, newConnections: 0, served: 2, gapCalls: 0, saturated: true }, additions: [] })).hitGap).toBe(true);
  });
  it("counts a TLS handshake a client abandoned, or a refused request, as a run that hit a gap even with no made-up answer", () => {
    for (const extra of [{ tlsFailed: 1 }, { refused: 1 }]) {
      const round = new EvalStandInRound({ workspaceId: WORKSPACE, operationId: OPERATION, plan: [] });
      expect(round.absorb(summary({ counts: { recorded: 0, generated: 0, generatedNoContract: 0, newConnections: 0, served: 1, gapCalls: 0, saturated: false }, additions: [], ...extra })).hitGap).toBe(true);
    }
  });
  it("counts an unreadable summary as a run that hit a gap and marks every count a lower bound", () => {
    const round = new EvalStandInRound({ workspaceId: WORKSPACE, operationId: OPERATION, plan: [] });
    expect(round.absorb(undefined)).toMatchObject({ hitGap: true, counts: { saturated: true } });
  });
  it("preloads the repository's recordings into the book and the set", () => {
    const round = new EvalStandInRound({ workspaceId: WORKSPACE, operationId: OPERATION, plan: [], recorded: [{ method: "GET", host: "api.vendor.test", path: "/v1/me", query: "", status: 200, contentType: "application/json", body: "{}" }] });
    expect(round.setContent().recorded).toHaveLength(1);
  });
});

describe("the repository's own files", () => {
  const dir = async (): Promise<string> => { const root = await mkdtemp(join(process.env["TMPDIR"] ?? process.cwd(), "e56-repo-")); roots.push(root); return root; };
  it("reads cassettes, HAR files and WireMock mappings by their conventional place, JSON and YAML, and nothing else", async () => {
    const root = await dir();
    await mkdir(join(root, "tests", "cassettes"), { recursive: true });
    await mkdir(join(root, "wiremock", "mappings"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "tests", "cassettes", "me.yaml"), "interactions:\n- request:\n    method: GET\n    uri: https://api.vendor.test/v1/me\n  response:\n    status:\n      code: 200\n    headers:\n      Content-Type: [application/json]\n    body:\n      string: '{\"me\":1}'\nversion: 1\n");
    await writeFile(join(root, "tests", "recording.har"), JSON.stringify({ log: { entries: [{ request: { method: "GET", url: "https://api.vendor.test/v1/har" }, response: { status: 200, content: { mimeType: "application/json", text: "{}" } } }] } }));
    await writeFile(join(root, "wiremock", "mappings", "x.json"), JSON.stringify({ request: { method: "GET", urlPath: "/v1/wm" }, response: { status: 200, jsonBody: { wm: true } } }));
    await writeFile(join(root, "src", "config.json"), JSON.stringify({ request: { method: "GET", urlPath: "/v1/not-a-recording" }, response: { status: 200, body: "x" } }));
    const read = await readRepositoryRecordings(root, "api.vendor.test");
    expect(read.recorded.map((entry) => entry.path).sort()).toEqual(["/v1/har", "/v1/me", "/v1/wm"]);
    expect(read.files).toBe(3);
  });
  it("follows no link, reads nothing past its limits, skips a file that does not parse, and never throws", async () => {
    const root = await dir();
    const outside = await dir();
    await writeFile(join(outside, "secret.json"), JSON.stringify({ mappings: [{ request: { method: "GET", url: "https://evil.test/s" }, response: { status: 200, body: "SECRET" } }] }));
    await mkdir(join(root, "cassettes"), { recursive: true });
    await symlink(join(outside, "secret.json"), join(root, "cassettes", "link.json"));
    await symlink(outside, join(root, "cassettes", "dir"));
    await writeFile(join(root, "cassettes", "broken.json"), "{ not json");
    await writeFile(join(root, "cassettes", "big.json"), `{"mappings":[],"pad":"${"x".repeat(1_100_000)}"}`);
    const read = await readRepositoryRecordings(root, undefined);
    expect(read.recorded).toEqual([]);
    expect(JSON.stringify(read)).not.toContain("SECRET");
    expect((await readRepositoryRecordings(join(root, "missing"), undefined)).recorded).toEqual([]);
  });
  it("builds the plan from an OpenAPI file in the checkout, leaves a host with a bad or outside file standing in by its reads, and reads no link", async () => {
    const root = await dir();
    const outside = await dir();
    await writeFile(join(root, "openapi.yaml"), "openapi: 3.0.3\ninfo: {title: t, version: '1'}\npaths:\n  /v1/me:\n    get:\n      responses:\n        '200':\n          description: ok\n          content:\n            application/json:\n              schema:\n                type: object\n                properties:\n                  id: {type: string}\n");
    await writeFile(join(outside, "other.yaml"), "openapi: 3.0.3\ninfo: {title: t, version: '1'}\npaths: {}\n");
    await symlink(join(outside, "other.yaml"), join(root, "linked.yaml"));
    const plan = await buildEvalStandInPlan(root, [
      { host: "api.vendor.test", specPath: "openapi.yaml", reads: ["data.id"] },
      { host: "linked.vendor.test", specPath: "linked.yaml", reads: ["x"] },
      { host: "up.vendor.test", specPath: "../outside.yaml" },
      { host: "missing.vendor.test", specPath: "nope.yaml" },
      { host: "Bad Host" },
      { host: "api.vendor.test" },
    ]);
    expect(plan.map((entry) => entry.host)).toEqual(["api.vendor.test", "linked.vendor.test", "up.vendor.test", "missing.vendor.test"]);
    expect(plan[0]!.openapi?.status).toBe("built");
    expect(plan[0]!.reads).toEqual(["data.id"]);
    expect(plan[1]!.openapi).toBeUndefined();
    expect(plan[1]!.reads).toEqual(["x"]);
    expect(plan[2]!.openapi).toBeUndefined();
    expect(plan[3]!.openapi).toBeUndefined();
  });
});

// L4-VX: Rovara's real check and eval path over a stand-in for an AI builder's project (tests/fixtures/ai-builder-sample: a Gemini-on-Vertex agent with unit tests, a scored eval set and a fake Vertex).
// Real here: the git repository, the project's own eval command (a child process), the plan, the metered stage, the egress route check, the baseline measurement, the question-level comparison, the
// changed-prompt classifier, the broker's eval-round reader, the evidence pack and the pull request description. Stand-ins: the model (a local stub), the money (a scripted meter), the sandbox (a checkout).
// Tests named "KNOWN GAP" pin what Rovara does TODAY (G1, the Vertex-shaped client, was closed by L4-EVV: see the Vertex describe below) where a customer would expect more; each is listed in briefs/lead4/L4-VX-SCOPE.md. When a gap is closed, its test is changed on purpose.
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EVAL_ROUND_ARTIFACT, EvalRoundArtifactSchema, WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, evalResultFromArtifact, readEvidencePack, rovaraCheckOf,
  type EvalRoundArtifact, type EvidencePack, type EvidencePackRead, type PromptLocation, type WorkflowSnapshot,
} from "@agentx/contracts";
import { isPromptHintPath } from "../../packages/broker/src/core/decisions/sensitive-list.js";
import { tierFromDiff, type TierFile } from "../../packages/broker/src/core/decisions/change-tier.js";
import { noEvalOf } from "../../packages/broker/src/core/proof/pull-request-layout.js";
import { buildEvidencePack, evidencePackV2Of, type EvidenceV2Writer } from "../../packages/broker/src/core/proof/evidence-pack.js";
import { evalRequestFor, loadEvalRound } from "../../packages/broker/src/core/proof/eval-round-reader.js";
import { rovaraPullRequestBody, rovaraStatusLines, type PullRequestBodyContext } from "../../packages/broker/src/core/proof/pull-request-body.js";
import type { TestProofActions } from "../../packages/broker/src/developer/test-proof-lines.js";
import { discoverEvals } from "../../packages/worker/src/verification/eval-discovery.js";
import { produceEvalDiscoveryReport } from "../../packages/worker/src/verification/eval-discovery-producer.js";
import { runFinalCheckEval } from "../../packages/worker/src/verification/eval-final-check.js";
import {
  CASES_DIR, EVAL_COMMAND, EVAL_REPORT, SCORING_PATH, createStandInWorld, git, pythonAvailable, runProject, teamGate, unitTests, type StandInWorld,
} from "../support/ai-builder-standin.js";

const GREEN = "01-friendlier-tone.patch";
const REGRESSION = "02-simplify-prompt-regression.patch";
const PROMPT_IN_CODE = "03-prompt-in-code.patch";
const CLIENT_CHANGE = "04-client-timeout.patch";
const UNRELATED = "05-scoring-trim.patch";
/** What setup confirmed for Deskbot: the user-message template is built in code, in `DeskAgent.build_contents`. */
const DESKBOT_LOCATIONS: PromptLocation[] = [{ repo: "app", path: "deskbot/agent.py", kind: "function", symbol: "DeskAgent.build_contents" }];
const request = { aiChange: true as const, reason: "eval_hint" as const, evalPass: 1 as const, callsAlreadyUsed: 0, costAlreadyUsedMicros: 0 };
const TIMEOUT = 180_000;

// ---- a pull request over the stand-in's candidate, built the way the broker builds it (the artifact goes through the broker's own reader)

const manifestOf = (world: StandInWorld) => createCandidateManifest([{ repositoryId: "app", commitSha: world.candidate.commitSha, treeSha: world.candidate.treeSha, baseCommitSha: world.repo.baseSha }]);
const workflowOf = (world: StandInWorld): WorkflowSnapshot => {
  const candidate = manifestOf(world);
  return WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", ownerId: "a".repeat(64), now: "2026-11-17T12:00:00.000Z", definitionVersion: "1.1.0" }),
    stage: "PULL_REQUEST", state: "READY", candidate,
    checkPolicy: { required: [{ id: "unit", label: "Unit tests", command: { cwd: "repo/app", executable: "python3", args: ["-m", "unittest", "discover", "-s", "tests", "-t", "."], timeoutSeconds: 60 } }], optional: [], selectedOptionalIds: [], proposed: [] },
    verification: { candidateDigest: candidate.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: "2026-11-17T12:00:00.000Z", results: [{ checkId: "unit", status: "PASS" }] },
    reviews: (["CRITIC", "SECURITY"] as const).map(role => ({ operationId: randomUUID(), candidateDigest: candidate.digest, role, provider: "test", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: "2026-11-17T12:00:00.000Z" })),
  });
};
const packOf = (digest: string): EvidencePack => buildEvidencePack({
  candidateDigest: digest,
  rawText: JSON.stringify({ schemaVersion: 1, candidateDigest: digest, checks: [{ checkId: "readiness:0", tests: { total: 14, passed: 14, failed: 0, skipped: 0, errored: 0, names: [{ name: "tests.test_agent.AgentTests.test_answers_a_policy_question_through_the_fake", status: "passed" }], newTests: [] } }], selection: { method: "full", selected: 14, total: 14 } }),
  checks: [{ id: "readiness:0", label: "python3 -m unittest discover -s tests -t .", source: "project" as const, before: "passed" as const, after: "passed" as const, class: "passing" as const, output: "", durationMs: 1000, exitCode: 0 }],
  checkKinds: new Map([["readiness:0", "test" as const]]),
  environment: { tier: "sandbox", envRevision: 1, services: [], data: "synthetic", accounts: [] }, storedArtifacts: new Map(),
}).pack!;
/** The worker saves the artifact; the broker lists and reads it back under its own bounds (`loadEvalRound`), then writes it into the evidence pack. */
async function savedAndReadBack(artifact: EvalRoundArtifact, digest: string): Promise<EvalRoundArtifact | undefined> {
  const key = `private/owner-a/workspace-a/op-1/${EVAL_ROUND_ARTIFACT}`;
  const actions: TestProofActions = {
    operations: async () => [{ id: "op-1", kind: "task", status: "SUCCEEDED", createdAt: "2026-11-17T12:00:00.000Z", fence: 1 }],
    artifacts: async () => [{ name: EVAL_ROUND_ARTIFACT, objectKey: key }],
    readArtifact: async () => JSON.stringify(artifact),
  };
  return loadEvalRound(actions, { ownerKey: "owner-a", workspaceId: "workspace-a" }, digest);
}
const writer: EvidenceV2Writer = { version: 2, producer: { edition: "code", isolation: "sandbox" } };
async function pullRequest(world: StandInWorld, artifact: EvalRoundArtifact | undefined, over: Partial<PullRequestBodyContext> = {}, flow?: WorkflowSnapshot["flow"]) {
  const digest = manifestOf(world).digest;
  const loaded = artifact === undefined ? undefined : await savedAndReadBack(artifact, digest);
  const pack = packOf(digest);
  const read: EvidencePackRead = readEvidencePack(JSON.parse(JSON.stringify(evidencePackV2Of(pack, { ...writer, evalArtifact: loaded }))));
  if (read.status !== "v2") throw new Error("not a version 2 pack");
  const origin = "https://rovara.example";
  const context: PullRequestBodyContext = {
    proof: { evidence: { pack, mode: "link", origin, taskUrl: `${origin}/tasks/1`, read } },
    changedFiles: { files: [{ repository: "app", path: "deskbot/prompts/system.txt", added: 1, removed: 1 }], complete: true }, repositoryKnownPrivate: true, evidenceWriter: 2, ...over,
  };
  const workflow = flow === undefined ? workflowOf(world) : { ...workflowOf(world), flow };
  return {
    body: rovaraPullRequestBody({ summary: ["Change the Deskbot prompt"], fallbackTitle: "t", workflow, context, reviewLines: () => ["- no findings"], pageUrl: undefined }),
    block: rovaraStatusLines(workflow, context, () => ["- no findings"]),
  };
}
const heading = (block: readonly string[]): string => block[0]!.replace(/^## /u, "");
const check = async (world: StandInWorld, status: "verified" | "failed" = "verified"): Promise<EvalRoundArtifact> => {
  const artifact = await runFinalCheckEval(request, world.ports, { status, candidateDigest: manifestOf(world).digest, signal: new AbortController().signal });
  expect(artifact).toBeDefined();
  expect(EvalRoundArtifactSchema.safeParse(artifact).success).toBe(true);
  return artifact!;
};

const worlds: StandInWorld[] = [];
const world = async (options: Parameters<typeof createStandInWorld>[0] = {}): Promise<StandInWorld> => { const created = await createStandInWorld(options); worlds.push(created); return created; };
afterAll(async () => { await Promise.all(worlds.map(w => w.cleanup())); });

describe("the stand-in project (the customer's side)", () => {
  it("needs python3: the stand-in is a Python project, like an AI team's agent service", () => { expect(pythonAvailable()).toBe(true); });

  it("its own unit tests and gate pass on the base; the friendly change keeps both green", async () => {
    const w = await world({ patch: GREEN });
    for (const dir of [w.baseDir, w.candidateDir]) {
      expect(unitTests(dir).status).toBe(0);
      expect(teamGate(dir).status).toBe(0);
    }
    expect(git(w.repo.dir, "diff", "--name-only", w.repo.baseSha, w.candidate.commitSha)).toBe("deskbot/prompts/system.txt");
  }, TIMEOUT);

  it("the friendly change really changes the answers (the fake follows the new tone) while every score stays", async () => {
    const w = await world({ patch: GREEN });
    const answers = async (dir: string): Promise<Record<string, { pass: boolean; answer: string }>> => {
      const run = runProject(dir, "python3", ["evals/run.py", "--out", "rovara-measures.json"], { VERTEX_API_ENDPOINT: w.fake.endpoint, ROVARA_EVAL_RUNS: "1" });
      expect(run.status).toBe(0);
      const file = JSON.parse(await readFile(`${dir}/rovara-measures.json`, "utf8")) as { questions: Array<{ id: string; samples: Array<{ pass: boolean; answer: string }> }> };
      return Object.fromEntries(file.questions.map(q => [q.id, q.samples[0]!]));
    };
    const before = await answers(w.baseDir); const after = await answers(w.candidateDir);
    expect(before["returns-window"]!.answer).toBe("Unworn items can be returned within 30 days of delivery.");
    expect(after["returns-window"]!.answer).toBe("Happy to help! Unworn items can be returned within 30 days of delivery.");
    expect(Object.values(before).every(a => a.pass) && Object.values(after).every(a => a.pass)).toBe(true);
  }, TIMEOUT);

  it("the regressing change passes every unit test and fails only the project's own eval gate", async () => {
    const w = await world({ patch: REGRESSION });
    expect(unitTests(w.candidateDir).status).toBe(0);
    const gate = teamGate(w.candidateDir);
    expect(gate.status).toBe(1);
    expect(gate.stdout).toContain("FAIL privacy-email (refusal)");
    expect(gate.stdout).toContain("pass rate 0.90");
  }, TIMEOUT);
});

describe("setup: what a customer configures for an eval suite", () => {
  it("finds the eval folder, and the setup agent's draft becomes a confirmable report", async () => {
    const w = await world();
    const found = await discoverEvals(w.baseDir);
    expect(found.candidates.map(c => c.path)).toEqual(["evals/support"]);
    expect(found.status).toBe("found");
    const files = (await readdir(`${w.baseDir}/${CASES_DIR}`)).filter(n => n.endsWith(".json")).sort();
    const questions = await Promise.all(files.map(async file => {
      const parsed = JSON.parse(await readFile(`${w.baseDir}/${CASES_DIR}/${file}`, "utf8")) as { id: string; category: "ordinary" | "safety" | "refusal" };
      return { id: parsed.id, category: parsed.category, path: `${CASES_DIR}/${file}` };
    }));
    const tracked = new Map([["app", new Set([...questions.map(q => q.path), SCORING_PATH])]]);
    const draft = {
      suites: [{
        selection: "support desk", questions, command: { ...EVAL_COMMAND, args: [...EVAL_COMMAND.args] }, report: EVAL_REPORT, model: "gemini-2.5-flash", modelVersion: "gemini-2.5-flash-001",
        judge: { kind: "rule" as const, scoringPath: SCORING_PATH }, subsetSupported: true, maxCallsPerQuestion: 1, maxCostMicrosPerQuestion: 100,
      }],
    };
    const image = `registry.example/worker@sha256:${"2".repeat(64)}`;
    const produced = await produceEvalDiscoveryReport({ draft, repositories: [{ name: "app", directory: w.baseDir }], tracked, image });
    expect("report" in produced).toBe(true);
    if ("report" in produced) {
      expect(produced.report.suites[0]!.questions).toHaveLength(10);
      expect(produced.report.suites[0]!.questions.filter(q => q.category !== "ordinary").map(q => q.id)).toEqual(["privacy-email", "prompt-leak"]);
      expect(produced.report.suites[0]!.catalogRowId).toBe("gemini");
    }
    // A question outside the eval folder is refused, whole (a draft cannot point the eval at other files).
    const outside = { suites: [{ ...draft.suites[0]!, questions: [{ id: "x", category: "ordinary" as const, path: "deskbot/agent.py" }] }] };
    expect(await produceEvalDiscoveryReport({ draft: outside, repositories: [{ name: "app", directory: w.baseDir }], tracked: new Map([["app", new Set(["deskbot/agent.py", SCORING_PATH])]]), image })).toEqual({ refused: "not_found" });
  }, TIMEOUT);

  it("a prompt-named file asks for an eval by its name; a prompt kept inside code asks only where setup confirmed its location (L4-EVP closes G4)", () => {
    expect(isPromptHintPath("deskbot/prompts/system.txt")).toBe(true);
    // The path name alone is still not enough: agent.py and persona.py are not prompt paths. What changed is that the project can say where its prompts live (a confirmed prompt location), and the tier reads that (next tests).
    expect(isPromptHintPath("deskbot/agent.py")).toBe(false);
    expect(isPromptHintPath("deskbot/persona.py")).toBe(false);
  });
});

// ---- L4-EVP: a prompt kept in code, the tier, the classifier and the description

/** The change tier over the candidate's own diff, the way the broker reads it from the host: every changed file with its patch. */
function tierOver(w: StandInWorld, locations?: readonly PromptLocation[]) {
  const names = git(w.repo.dir, "diff", "--name-only", w.repo.baseSha, w.candidate.commitSha).split("\n").filter(name => name !== "");
  const files: TierFile[] = names.map(path => {
    const [added, removed] = git(w.repo.dir, "diff", "--numstat", w.repo.baseSha, w.candidate.commitSha, "--", path).split("\t");
    return { repository: "app", path, status: "modified", additions: Number(added), deletions: Number(removed), patch: git(w.repo.dir, "diff", w.repo.baseSha, w.candidate.commitSha, "--", path).split("\n").slice(4).join("\n") };
  });
  return tierFromDiff({ files, complete: true }, { headSha: w.candidate.commitSha, at: "2026-11-18T12:00:00.000Z", ...(locations === undefined ? {} : { promptLocations: locations }) });
}
const withTier = (w: StandInWorld, locations?: readonly PromptLocation[]): WorkflowSnapshot["flow"] => ({ tier: tierOver(w, locations) } as unknown as WorkflowSnapshot["flow"]);

describe("L4-EVP: a prompt kept in code (Deskbot's user-message template, changed in agent.py)", () => {
  let w: StandInWorld; let artifact: EvalRoundArtifact;
  beforeAll(async () => { w = await world({ patch: PROMPT_IN_CODE, promptLocations: DESKBOT_LOCATIONS }); artifact = await check(w); }, TIMEOUT);

  it("without a confirmed location the change asks for no eval (the gap), with one it does", () => {
    expect(git(w.repo.dir, "diff", "--name-only", w.repo.baseSha, w.candidate.commitSha)).toBe("deskbot/agent.py");
    expect(tierOver(w).reasons.map(r => r.code)).not.toContain("eval_hint");
    expect(tierOver(w, DESKBOT_LOCATIONS).reasons).toEqual([{ code: "eval_hint", path: "deskbot/agent.py" }]);
    expect(tierOver(w, DESKBOT_LOCATIONS).level).toBe("small");
    const asked = (flow: WorkflowSnapshot["flow"]) => evalRequestFor({ ...workflowOf(w), flow }, { done: 0, calls: 0, costMicros: 0 });
    expect(asked(withTier(w))).toBeUndefined();
    expect(asked(withTier(w, DESKBOT_LOCATIONS))).toMatchObject({ aiChange: true, reason: "eval_hint", evalPass: 1 });
  });
  it("then the eval runs on the real path: the changed template counts as a changed prompt on every call, and the answers still pass", () => {
    expect(artifact.outcome).toBe("done");
    expect(evalResultFromArtifact(artifact)).toMatchObject({ outcome: "ran", label: "No regression measured (eval)", casesRun: 10, casesTotal: 10 });
    expect(artifact.options?.changedPromptCalls).toBe(10);
  });
  it("and the description says nothing about a missing eval, because one ran", async () => {
    const { body, block } = await pullRequest(w, artifact, {}, withTier(w, DESKBOT_LOCATIONS));
    expect(heading(block)).toMatch(/· nothing extra to check$/u);
    expect(body).toContain("No regression measured.");
    expect(body).not.toContain("No eval ran for this change.");
  });
});

describe("L4-EVP: an unrelated code change does not ask for the eval, and says nothing", () => {
  it("scoring.py: no hint of either kind, with or without the setting, and no 'no eval' line", async () => {
    const w = await world({ patch: UNRELATED });
    for (const locations of [undefined, DESKBOT_LOCATIONS]) expect(tierOver(w, locations).reasons.map(r => r.code).filter(c => c === "eval_hint" || c === "ai_code_touched")).toEqual([]);
    const { body } = await pullRequest(w, undefined, {}, withTier(w, DESKBOT_LOCATIONS));
    expect(body).not.toContain("No eval ran for this change.");
  }, TIMEOUT);
});

describe("L4-EVP: AI code was touched and no eval ran: the description says so, with the reason", () => {
  it("a change to the model client (no confirmed prompt location in it) is AI code touched; no eval is asked for; the description says why", async () => {
    const w = await world({ patch: CLIENT_CHANGE });
    const tier = tierOver(w, DESKBOT_LOCATIONS);
    expect(tier.reasons).toEqual([{ code: "ai_code_touched", path: "deskbot/vertex_client.py" }]);
    expect(tier.level).toBe("small");
    expect(evalRequestFor({ ...workflowOf(w), flow: { tier } } as unknown as WorkflowSnapshot, { done: 0, calls: 0, costMicros: 0 })).toBeUndefined();
    const { body, block } = await pullRequest(w, undefined, {}, withTier(w, DESKBOT_LOCATIONS));
    expect(heading(block)).toMatch(/· 1 thing to check$/u);
    expect(body).toContain("No eval ran for this change.");
    expect(body).toContain("not a prompt location the project confirmed");
    // Advisory (owner, for the pilot): it is a thing to check in the description, and the Rovara Check stays green like for "Worse on eval" (G5).
    const payload = rovaraCheckOf({
      proof: { kind: "proceed", warns: false, relaxed: false, provenCount: 1, reasons: [] }, ci: "passing", ciMode: "their_ci_watch", fullSuite: "not_needed", firstSeenAtMs: 1_000, nowMs: 2_000,
      verdict: { resultKind: "checks_passed", heading: heading(block), body: [] },
    });
    expect(payload).toMatchObject({ status: "completed", conclusion: "success" });
  }, TIMEOUT);
  it("the other reasons, from the eval's own answer: no eval configured, not connected", () => {
    const flow = { flow: { tier: { reasons: [{ code: "eval_hint", path: "deskbot/agent.py" }] } } } as unknown as WorkflowSnapshot;
    expect(noEvalOf(flow, { eval: { label: "Not run", notRunReason: "no_eval_configured" }, promptWithoutEval: false }, true)).toEqual({ reason: "no_eval_configured" });
    expect(noEvalOf(flow, { eval: { label: "Not run", notRunReason: "not_connected" }, promptWithoutEval: false }, true)).toEqual({ reason: "not_connected" });
  });
});

describe("the check: a change that keeps the eval green", () => {
  let w: StandInWorld; let artifact: EvalRoundArtifact;
  beforeAll(async () => { w = await world({ patch: GREEN }); artifact = await check(w); }, TIMEOUT);

  it("measures the baseline on the base commit (three runs), compares once, and says No regression measured", () => {
    expect(artifact.outcome).toBe("done");
    const result = evalResultFromArtifact(artifact);
    expect(result).toMatchObject({ outcome: "ran", label: "No regression measured (eval)", casesRun: 10, casesTotal: 10, fixRequested: false });
    expect(result.disposition).toEqual({ draft: false, check: "success", retry: false });
    expect(w.sides.map(s => `${s.side}x${s.runs}`)).toEqual(["oldx1", "oldx1", "oldx1", "newx1"]);
    expect(w.sides.every(s => s.exitCode === 0)).toBe(true);
    const record = [...w.cache.records.values()][0]!;
    expect(record.questions!.every(q => q.samples.length === 3 && q.samples.every(s => s.pass))).toBe(true);
  });
  it("sends every model call through the stage's real route check, and the changed prompt was exercised", () => {
    expect(w.frames).toHaveLength(40);
    expect(w.frames.every(f => f.routed && f.row === "gemini" && /^\/v1beta\/models\/[\w.-]+:generateContent$/u.test(f.path))).toBe(true);
    expect(artifact.options?.changedPromptCalls).toBe(10);
    // 30 baseline calls (three runs of ten) plus the ten of the comparison.
    expect(artifact.usage).toMatchObject({ calls: 40, costMicros: 800 });
  });
  it("reaches the pull request description: the eval label and counts, nothing extra to check", async () => {
    const { body, block } = await pullRequest(w, artifact);
    expect(heading(block)).toMatch(/· nothing extra to check$/u);
    expect(body).toContain("No regression measured.");
    expect(body).toContain("Eval: No regression measured (eval)");
    expect(body).toContain("Eval counts: 10 questions; 0 broke");
    expect(body).not.toContain("The AI evaluation got worse.");
    expect(body).not.toContain("A prompt changed and no evaluation ran.");
  });
  it("a public repository's description keeps the label and counts only", async () => {
    const { body } = await pullRequest(w, artifact, { repositoryKnownPrivate: false });
    expect(body).toContain("Eval: No regression measured (eval)");
    expect(body).toContain("Eval counts: 10 questions");
  });
  it("the baseline is reused: a second task on the same base measures nothing again", async () => {
    const before = w.frames.length;
    const again = await runFinalCheckEval(request, w.ports, { status: "verified", candidateDigest: "e".repeat(64), signal: new AbortController().signal });
    expect(evalResultFromArtifact(again!).label).toBe("No regression measured (eval)");
    expect(w.frames.length - before).toBe(10);
  });
});

describe("the check: a change that regresses one eval case", () => {
  let w: StandInWorld; let artifact: EvalRoundArtifact;
  beforeAll(async () => { w = await world({ patch: REGRESSION }); artifact = await check(w); }, TIMEOUT);

  it("says Worse on eval, names the one broken question with its old and new answers, and asks for a fix", () => {
    const result = evalResultFromArtifact(artifact);
    expect(result).toMatchObject({ outcome: "ran", label: "Worse on eval", fixRequested: true });
    expect(result.questions.map(q => `${q.id}:${q.change}`)).toEqual(["privacy-email:broke"]);
    expect(result.questions[0]!.oldAnswers[0]).toContain("can't share");
    expect(result.questions[0]!.newAnswers[0]).toContain("The contact on file is");
    expect(result.disposition.check).toBe("failure");
    // The refusal case was re-asked three times on each side: 3 + 3 calls on top of the baseline (30) and the first run (10).
    expect(w.sides.map(s => `${s.side}x${s.runs}`)).toEqual(["oldx1", "oldx1", "oldx1", "newx1", "oldx3", "newx3"]);
    expect(artifact.usage).toMatchObject({ calls: 46, costMicros: 920 });
  });
  it("reaches the pull request: Worse on eval above the fold, as a thing to check, with the old and new answer", async () => {
    const { body, block } = await pullRequest(w, artifact);
    expect(heading(block)).toMatch(/· 1 thing to check$/u);
    expect(body).toContain("**The AI evaluation got worse.**");
    expect(body).toContain("Worse on eval: 1 question broke");
    expect(body).toContain("privacy-email");
    expect(body).toContain("I can't share another customer's personal details.");
    expect(body).toContain("The contact on file is");
    expect(block.join("\n")).toContain("Worse on eval.");
    expect(body.indexOf("The AI evaluation got worse.")).toBeLessThan(body.indexOf("<summary>Checks:"));
  });
  it("a public repository's description names the label and the count, not the answers", async () => {
    const { body } = await pullRequest(w, artifact, { repositoryKnownPrivate: false });
    expect(body).toContain("Worse on eval: 1 question broke");
    expect(body).not.toContain("The contact on file is");
  });
  it("KNOWN GAP (G5): Worse on eval is a thing to check in the description, but the Rovara Check on the pull request stays green", async () => {
    const { block } = await pullRequest(w, artifact);
    const payload = rovaraCheckOf({
      proof: { kind: "proceed", warns: false, relaxed: false, provenCount: 1, reasons: [] }, ci: "passing", ciMode: "their_ci_watch", fullSuite: "not_needed", firstSeenAtMs: 1_000, nowMs: 2_000,
      verdict: { resultKind: "checks_passed", heading: heading(block), body: [] },
    });
    // DECISIONS 192b says a measured regression is "red like a failing test"; nothing feeds the eval into the Check's conclusion, so it reads success, titled with the verdict heading.
    expect(payload).toMatchObject({ status: "completed", conclusion: "success" });
    expect(payload.title).toContain("1 thing to check");
  });
  it("the project's own gate would also have failed, so the two agree", async () => {
    expect(teamGate(w.candidateDir).status).toBe(1);
  });
});

describe("a project whose client speaks Vertex AI (L4-EVV; closes G1)", () => {
  // The confirmed plan names the `vertex` row. The sandbox gets the variables google-genai in Vertex mode reads (the production `freshEvalEnvironment`), the stage's access is the real gateway adapter over an in-process Cloud gateway, and the
  // project's own Vertex-shaped client (project and location in the path, a token from the metadata server) reaches it with no change to its code.
  let w: StandInWorld; let artifact: EvalRoundArtifact;
  beforeAll(async () => { w = await world({ patch: GREEN, transport: "vertex" }); artifact = await check(w); }, TIMEOUT);

  it("the Vertex-shaped client now gets through: No regression measured, with the same calls and counts as the Gemini shape", () => {
    expect(evalResultFromArtifact(artifact)).toMatchObject({ outcome: "ran", label: "No regression measured (eval)", casesRun: 10, casesTotal: 10, fixRequested: false });
    expect(w.sides.map(s => `${s.side}x${s.runs}`)).toEqual(["oldx1", "oldx1", "oldx1", "newx1"]);
    expect(w.sides.every(s => s.exitCode === 0)).toBe(true);
    expect(artifact.options?.changedPromptCalls).toBe(10);
    expect(artifact.usage).toMatchObject({ calls: 40, costMicros: 800 });
    expect(artifact.notRunReason).toBeUndefined();
  });
  it("every call took the Vertex product route in the shape google-genai sends, with Rovara's placeholder project and location, and passed the real route check", () => {
    expect(w.frames).toHaveLength(40);
    for (const f of w.frames) {
      expect(f).toMatchObject({ row: "vertex", routed: true });
      expect(f.path).toBe("/v1beta1/projects/rovara-eval-project/locations/rovara-eval1/publishers/google/models/gemini-2.5-flash:generateContent");
    }
  });
  it("holds each stage whole (the baseline's, then the comparison's), releases each once at its counted spend, and the client took its token from the metadata stand-in, never from a Google host", () => {
    expect(w.gateway!.holds).toHaveLength(2);
    expect(w.gateway!.releases).toHaveLength(2);
    expect(w.gateway!.releases.every(r => r["unknown"] === false)).toBe(true);
    expect(w.gateway!.releases.reduce((n, r) => n + (r["calls"] as number), 0)).toBe(40);
    expect(w.gateway!.releases.reduce((n, r) => n + (r["costMicros"] as number), 0)).toBe(800);
    expect(w.metadataTokenRequests()).toBeGreaterThan(0);
  });
  it("the plan, the judge pin and the approval's inputs name the vertex row, so an approval for the Gemini row does not carry over", async () => {
    const gemini = await world({ patch: GREEN });
    expect(w.plan.key.catalogRowId).toBe("vertex");
    expect(w.plan.inputs.catalogRowId).toBe("vertex");
    expect(w.plan.judgePin).not.toBe(gemini.plan.judgePin);
    expect(w.grant.inputsDigest).not.toBe(gemini.grant.inputsDigest);
  });
  it("reaches the pull request description like the Gemini shape", async () => {
    const { body, block } = await pullRequest(w, artifact);
    expect(heading(block)).toMatch(/· nothing extra to check$/u);
    expect(body).toContain("Eval: No regression measured (eval)");
    expect(body).toContain("Eval counts: 10 questions; 0 broke");
    expect(body).not.toContain("Eval: Not run");
  });
  it("a regressing change reads Worse on eval through the Vertex shape too, and the privacy case is the one that broke", async () => {
    const bad = await world({ patch: REGRESSION, transport: "vertex" });
    const regressed = await check(bad);
    const result = evalResultFromArtifact(regressed);
    expect(result).toMatchObject({ outcome: "ran", label: "Worse on eval", fixRequested: true });
    expect(result.questions.map(q => `${q.id}:${q.change}`)).toEqual(["privacy-email:broke"]);
    expect(regressed.usage).toMatchObject({ calls: 46, costMicros: 920 });
    expect(bad.frames.every(f => f.routed && f.row === "vertex")).toBe(true);
    const { body } = await pullRequest(bad, regressed);
    expect(body).toContain("**The AI evaluation got worse.**");
    expect(body).toContain("Worse on eval: 1 question broke");
  }, TIMEOUT);
  it("code that hardcodes another project is refused by the gateway before any send: Not run, no cost, never a pass", async () => {
    const other = await world({ patch: GREEN, transport: "vertex", clientProject: "other-project-99" });
    const refused = await check(other);
    expect(evalResultFromArtifact(refused)).toMatchObject({ outcome: "not_run", label: "Not run" });
    expect(other.frames.length).toBeGreaterThan(0);
    expect(other.frames.every(f => !f.routed && f.refusal === "not_allowed")).toBe(true);
    expect(other.cache.records.size).toBe(0);
    expect(other.gateway!.releases.every(r => r["costMicros"] === 0)).toBe(true);
    const { body } = await pullRequest(other, refused);
    expect(body).toContain("Eval: Not run");
    expect(body).not.toContain("No regression measured");
  }, TIMEOUT);
  it("a project with no Vertex connection in Cloud gets no hold: no model call, Not run", async () => {
    const none = await world({ patch: GREEN, transport: "vertex", vertexConnected: false });
    const outcome = await check(none);
    expect(evalResultFromArtifact(outcome)).toMatchObject({ outcome: "not_run" });
    expect(none.frames).toHaveLength(0);
    expect(none.sides).toHaveLength(0);
  }, TIMEOUT);
  it("a rate limit from Vertex is Not run with its own words, nothing is measured as a pass", async () => {
    const limited = await world({ patch: GREEN, transport: "vertex", providerClass: "rate_limit" });
    expect(evalResultFromArtifact(await check(limited))).toMatchObject({ outcome: "not_run", label: "Not run" });
    expect(limited.cache.records.size).toBe(0);
  }, TIMEOUT);
  it("the setup draft names the row: provider vertex is confirmed as the vertex row, absent stays gemini, anything else is refused whole", async () => {
    const base = await world();
    const files = (await readdir(`${base.baseDir}/${CASES_DIR}`)).filter(n => n.endsWith(".json")).sort();
    const questions = await Promise.all(files.map(async file => {
      const parsed = JSON.parse(await readFile(`${base.baseDir}/${CASES_DIR}/${file}`, "utf8")) as { id: string; category: "ordinary" | "safety" | "refusal" };
      return { id: parsed.id, category: parsed.category, path: `${CASES_DIR}/${file}` };
    }));
    const tracked = new Map([["app", new Set([...questions.map(q => q.path), SCORING_PATH])]]);
    const suite = {
      selection: "support desk", questions, command: { ...EVAL_COMMAND, args: [...EVAL_COMMAND.args] }, report: EVAL_REPORT, model: "gemini-2.5-flash", modelVersion: "gemini-2.5-flash-001",
      judge: { kind: "rule" as const, scoringPath: SCORING_PATH }, subsetSupported: true, maxCallsPerQuestion: 1, maxCostMicrosPerQuestion: 100,
    };
    const image = `registry.example/worker@sha256:${"2".repeat(64)}`;
    const produce = (extra: Record<string, unknown>) => produceEvalDiscoveryReport({ draft: { suites: [{ ...suite, ...extra }] }, repositories: [{ name: "app", directory: base.baseDir }], tracked, image });
    const vertex = await produce({ provider: "vertex" });
    expect("report" in vertex && vertex.report.suites[0]!.catalogRowId).toBe("vertex");
    const gemini = await produce({ provider: "gemini" });
    expect("report" in gemini && gemini.report.suites[0]!.catalogRowId).toBe("gemini");
    expect(await produce({ provider: "bedrock" })).toEqual({ refused: "unreadable" });
    expect(await produce({ provider: "" })).toEqual({ refused: "unreadable" });
  }, TIMEOUT);
});

describe("what happens when the eval cannot run (never a pass, never a fake Worse)", () => {
  it("a rate limit from the provider is Not run with its own words, and nothing is measured as a pass", async () => {
    const w = await world({ patch: GREEN, providerClass: "rate_limit" });
    const artifact = await check(w);
    expect(evalResultFromArtifact(artifact)).toMatchObject({ outcome: "not_run", label: "Not run" });
    expect(w.cache.records.size).toBe(0);
  }, TIMEOUT);

  it("failed unit tests: the eval is not run and no model call is made", async () => {
    const w = await world({ patch: GREEN });
    const artifact = await check(w, "failed");
    expect(artifact.notRunReason).toBe("checks_failed");
    expect(w.frames).toHaveLength(0);
  }, TIMEOUT);

  it("an unchanged candidate exercises no changed prompt: Not run, not a pass", async () => {
    const w = await world({ patch: undefined });
    const artifact = await check(w);
    expect(evalResultFromArtifact(artifact)).toMatchObject({ outcome: "not_run" });
    expect(artifact.notRunReason).toBe("no_changed_prompt_call");
  }, TIMEOUT);

  it("the broker asks for the eval only when the tier carries the prompt hint", () => {
    const flow = (reasons: Array<{ code: string }>) => ({ flow: { tier: { reasons } } }) as unknown as WorkflowSnapshot;
    expect(evalRequestFor(flow([{ code: "eval_hint" }]), { done: 0, calls: 0, costMicros: 0 })).toMatchObject({ aiChange: true, reason: "eval_hint", evalPass: 1 });
    expect(evalRequestFor(flow([]), { done: 0, calls: 0, costMicros: 0 })).toBeUndefined();
  });
});

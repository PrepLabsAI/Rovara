// L4-VX: Rovara's real check and eval path over a stand-in for an AI builder's project (tests/fixtures/ai-builder-sample: a Gemini-on-Vertex agent with unit tests, a scored eval set and a fake Vertex).
// Real here: the git repository, the project's own eval command (a child process), the plan, the metered stage, the egress route check, the baseline measurement, the question-level comparison, the
// changed-prompt classifier, the broker's eval-round reader, the evidence pack and the pull request description. Stand-ins: the model (a local stub), the money (a scripted meter), the sandbox (a checkout).
// Tests named "KNOWN GAP" pin what Rovara does TODAY where a customer would expect more; each is listed in briefs/lead4/L4-VX-SCOPE.md. When a gap is closed, its test is changed on purpose.
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_ALLOW_DOMAINS, GOOGLE_VERTEX_AI_ALLOW_GROUP, EVAL_ROUND_ARTIFACT, EvalRoundArtifactSchema, builtinModelCatalog, findRedirectEscapes, modelHostBlockList, WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, evalResultFromArtifact, readEvidencePack, rovaraCheckOf,
  type EvalRoundArtifact, type EvidencePack, type EvidencePackRead, type WorkflowSnapshot,
} from "@agentx/contracts";
import { laptopSandboxDenyList } from "../../packages/broker/src/local/isolation/sandbox-model-deny.js";
import { hostAlreadyAllowed, refuseSetupHost } from "../../packages/broker/src/core/setup-agent/host-refusal.js";
import { isPromptHintPath } from "../../packages/broker/src/core/decisions/sensitive-list.js";
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
async function pullRequest(world: StandInWorld, artifact: EvalRoundArtifact, over: Partial<PullRequestBodyContext> = {}) {
  const digest = manifestOf(world).digest;
  const loaded = await savedAndReadBack(artifact, digest);
  const pack = packOf(digest);
  const read: EvidencePackRead = readEvidencePack(JSON.parse(JSON.stringify(evidencePackV2Of(pack, { ...writer, evalArtifact: loaded }))));
  if (read.status !== "v2") throw new Error("not a version 2 pack");
  const origin = "https://rovara.example";
  const context: PullRequestBodyContext = {
    proof: { evidence: { pack, mode: "link", origin, taskUrl: `${origin}/tasks/1`, read } },
    changedFiles: { files: [{ repository: "app", path: "deskbot/prompts/system.txt", added: 1, removed: 1 }], complete: true }, repositoryKnownPrivate: true, evidenceWriter: 2, ...over,
  };
  const workflow = workflowOf(world);
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

  it("only a prompt-named file asks for an eval: a prompt kept inside code does not", () => {
    expect(isPromptHintPath("deskbot/prompts/system.txt")).toBe(true);
    // KNOWN GAP (G4): the broker's trigger is the changed path's name. A system prompt written as a string in agent code is not a prompt path, so no eval is requested for it.
    expect(isPromptHintPath("deskbot/agent.py")).toBe(false);
    expect(isPromptHintPath("deskbot/persona.py")).toBe(false);
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

describe("what happens when the eval cannot run (never a pass, never a fake Worse)", () => {
  it("KNOWN GAP (G1): a client built for Vertex AI only is refused by the eval route, so the eval is Not run", async () => {
    const w = await world({ patch: GREEN, transport: "vertex" });
    const artifact = await check(w);
    const result = evalResultFromArtifact(artifact);
    // The eval's product row is the Gemini API ("gemini"); Rovara's sandbox sets only GOOGLE_GEMINI_BASE_URL. A Vertex-shaped path under that row fails the real route check.
    expect(w.frames[0]).toMatchObject({ row: "gemini", routed: false, refusal: "not_allowed" });
    expect(w.frames[0]!.path).toMatch(/^\/v1\/projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/publishers\/google\/models\/[\w.-]+:generateContent$/u);
    expect(result).toMatchObject({ outcome: "not_run", label: "Not run" });
    expect(artifact.notRunReason).toBe("no_base_score");
    const { body } = await pullRequest(w, artifact);
    expect(body).toContain("Eval: Not run");
    expect(body).not.toContain("Worse on eval");
    expect(body).not.toContain("No regression measured");
  }, TIMEOUT);

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

describe("Google hosts and the default allow list (batch 16: #984 adds the narrow Google Vertex AI group, owner decision 2026-11-17)", () => {
  const vertexHost = "us-central1-aiplatform.googleapis.com";
  const groupHosts = GOOGLE_VERTEX_AI_ALLOW_GROUP.hosts.map((entry) => entry.host);
  it("the default DNS allow list holds exactly the Google Vertex AI group's Google hosts; *.googleapis.com, storage and www stay absent", () => {
    expect(DEFAULT_AGENT_ALLOW_DOMAINS.filter(host => host.includes("google"))).toEqual(groupHosts);
    for (const host of [vertexHost, "aiplatform.googleapis.com", "oauth2.googleapis.com", "sts.googleapis.com", "iamcredentials.googleapis.com"]) expect(hostAlreadyAllowed(host, []), host).toBe(true);
    for (const host of ["*.googleapis.com", "googleapis.com", "storage.googleapis.com", "www.googleapis.com", "accounts.google.com"]) expect(DEFAULT_AGENT_ALLOW_DOMAINS, host).not.toContain(host);
    for (const host of ["storage.googleapis.com", "www.googleapis.com", "me-central7-aiplatform.googleapis.com", "evil.googleapis.com"]) expect(hostAlreadyAllowed(host, []), host).toBe(false);
  });
  it("a Google host outside the group is covered only when a project adds it by exact name (an owner or admin approves it)", () => {
    const project = ["www.googleapis.com"];
    expect(hostAlreadyAllowed("www.googleapis.com", project)).toBe(true);
    // A wildcard is not implied: an unlisted region and another Google host stay blocked.
    expect(hostAlreadyAllowed("me-central7-aiplatform.googleapis.com", project)).toBe(false);
    expect(hostAlreadyAllowed("storage.googleapis.com", project)).toBe(false);
    // A hosted install can be asked for these names (no card is refused); a laptop's deny list refuses the model host with fixed words and leaves the token hosts askable.
    expect(refuseSetupHost(vertexHost)).toBeUndefined();
    expect(refuseSetupHost(vertexHost, undefined, laptopSandboxDenyList())).toBe("model_host");
    expect(refuseSetupHost("oauth2.googleapis.com", undefined, laptopSandboxDenyList())).toBeUndefined();
    // Storage under Google is refused outright, however the project asks.
    expect(refuseSetupHost("storage.googleapis.com")).toBe("raw_storage");
  });
  it("in a test round a model host is blocked by name even if the project allowed it: the run says so in fixed words, the token hosts are not flagged", () => {
    const blocked = modelHostBlockList(builtinModelCatalog().rows, []);
    expect(blocked).toContain(vertexHost);
    const found = findRedirectEscapes(blocked, [vertexHost, "oauth2.googleapis.com"]);
    expect(found).toEqual([{ host: vertexHost, kind: "ignored_redirect", sentence: `not run: client ignored the redirect (called ${vertexHost})` }]);
    // A Vertex location the catalog does not list is still named, as an unlisted model host.
    expect(findRedirectEscapes(blocked, ["me-central7-aiplatform.googleapis.com"])[0]).toMatchObject({ kind: "unlisted_model_host" });
  });
});

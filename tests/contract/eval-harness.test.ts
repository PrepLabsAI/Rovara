import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type FauxProviderHandle, type JsonObject } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { EVAL_ROOT, EvalProjectSchema, loadCases, loadCatalog, loadProject, type EvalCase } from "../eval/case.js";
import { parseEvalArguments, recordLiveReport, runEvalCli, runEvalCommand } from "../eval/command.js";
import { legacyNotApplicable, legacyPresentation } from "../eval/legacy-presentation.js";
import { scriptExpectedAnswers } from "../eval/offline.js";
import { newPresentation } from "../eval/presentation.js";
import { createOrchestrationTools } from "../../packages/orchestrator/src/orchestration-tools.js";
import { cannedApi, caseHash, compareWithBaseline, reportPath, runEvaluation, scoreRun, type EvalReport } from "../eval/runner.js";
import { compareSc004 } from "../eval/sc004.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

/** An oracle that answers each case as expected, so the harness itself is what is tested. */
function oracle(faux: FauxProviderHandle, pick: (evalCase: EvalCase) => { tool?: string; args?: Record<string, unknown>; text?: string }) {
  return (evalCase: EvalCase) => {
    const answer = pick(evalCase);
    faux.setResponses(answer.tool === undefined
      ? [fauxAssistantMessage(answer.text ?? "")]
      : [fauxAssistantMessage([fauxToolCall(answer.tool, (answer.args ?? {}) as JsonObject)], { stopReason: "toolUse" }), fauxAssistantMessage("Done.")]);
  };
}

function expected(evalCase: EvalCase) {
  const tool = Array.isArray(evalCase.expect.tool) ? evalCase.expect.tool[0] : evalCase.expect.tool;
  const phrase = [evalCase.expect.refusal ?? [], evalCase.expect.contains ?? []].flat()[0] ?? "";
  return tool === null || tool === undefined ? { text: `Sorry, ${phrase}.` } : { tool, args: evalCase.expect.argsSubset ?? {} };
}

function liveReport(overrides: Partial<EvalReport> = {}): EvalReport {
  return {
    provider: "amazon-bedrock", model: "amazon.nova-pro-v1:0", presentation: "new", repeat: 3, generatedAt: "2026-09-25T00:00:00.000Z",
    cases: [{ id: "files-not-pr", passed: true, runs: [{ tool: "agentx_submit_task", toolOk: true, argsOk: true, phraseOk: null, refusalOk: null, containsOk: null }] }],
    summary: { cases: 1, passed: 1, errors: 0, toolAccuracy: 1, refusalCases: 0, refusalAccuracy: 1 },
    ...overrides,
  };
}

const erroredCases: EvalReport["cases"] = [{ id: "files-not-pr", passed: false, runs: [{ tool: null, toolOk: false, argsOk: true, phraseOk: null, refusalOk: null, containsOk: null, error: "throttled" }] }];
const erroredSummary: EvalReport["summary"] = { cases: 1, passed: 0, errors: 1, toolAccuracy: 0, refusalCases: 0, refusalAccuracy: 1 };

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agentx-eval-test-"));
}

describe("evaluation cases", () => {
  it("parse, have unique IDs, and name only tools their project offers", async () => {
    const cases = await loadCases();
    expect(cases.length).toBeGreaterThanOrEqual(3);
    expect(new Set(cases.map((entry) => entry.id)).size).toBe(cases.length);
    for (const evalCase of cases) {
      const project = await loadProject(evalCase.project);
      const catalogs = new Map(await Promise.all(project.connectors.map(async (connector) => [connector.catalog, await loadCatalog(connector.catalog)] as const)));
      const offered = newPresentation(project, catalogs).toolNames;
      for (const tool of [evalCase.expect.tool].flat()) {
        if (tool !== null) expect(offered, `${evalCase.id} expects ${tool}`).toContain(tool);
      }
    }
  });

  it("expect only arguments, and enum values, that the offered tool's schema declares", async () => {
    for (const evalCase of (await loadCases()).filter((entry) => entry.expect.argsSubset !== undefined)) {
      const project = await loadProject(evalCase.project);
      const catalogs = new Map(await Promise.all(project.connectors.map(async (connector) => [connector.catalog, await loadCatalog(connector.catalog)] as const)));
      const presented = newPresentation(project, catalogs);
      const tools = createOrchestrationTools(cannedApi(presented.catalogs), { workspaceId: "w", conversationId: "c" },
        { connectorCatalogs: presented.catalogs, recovery: presented.recoverableOperations.length > 0 });
      const name = [evalCase.expect.tool].flat()[0];
      const properties = (tools.find((tool) => tool.name === name)?.parameters as { properties?: Record<string, { enum?: unknown[] }> } | undefined)?.properties ?? {};
      for (const [key, value] of Object.entries(evalCase.expect.argsSubset ?? {})) {
        expect(Object.keys(properties), `${evalCase.id}: ${name} has no argument ${key}`).toContain(key);
        const allowed = properties[key]?.enum;
        if (allowed !== undefined) expect(allowed, `${evalCase.id}: ${key}`).toContain(value);
      }
    }
  });

  it("read fixture projects in the registered project format, resolved by the broker's own connector types", async () => {
    const project = await loadProject("fixtures/payments.yaml");
    expect(project).toMatchObject({
      name: "payments",
      instructions: "Delegate every repository read, edit, build and test to the worker.",
      repositories: ["payments-api", "payments-web"],
      recoverableOperations: [],
      connectors: [{
        name: "github", type: "github", label: "GitHub issues", vendor: "GitHub", scopeNoun: "repository",
        catalog: "github", scopes: ["payments-api", "payments-web"], connected: true,
      }],
    });
    expect(project.connectors[0]?.approvals.map((approval) => approval.name)).toEqual(["list_issues", "issue_read", "issue_write", "add_issue_comment"]);
    const presented = newPresentation(project, new Map([["github", await loadCatalog("github")]]));
    expect(presented.toolNames).toEqual([
      "agentx_submit_task", "agentx_create_pull_request", "agentx_follow_up", "agentx_manage_pull_request",
      "github__list_issues", "github__issue_read", "github__issue_write", "github__add_issue_comment",
    ]);
    expect(presented.catalogs[0]?.tools[2]?.description).toMatch(/^Create or update a GitHub issue\. Not for pull requests/);
  });

  it("refuses a connector type this release cannot resolve, an unknown not-connected name, or a missing catalog, loudly", async () => {
    const base = {
      name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate.",
      repositories: [{ name: "payments-api", url: "https://github.com/example/payments-api.git", path: "repo/payments-api", defaultBranch: "main", credentialRef: "github-agentx-sdlc" }],
    };
    const linear = EvalProjectSchema.safeParse({ ...base, integrations: { connectors: [{ name: "future", type: "future-vendor", credentialRef: "future-key", scopes: [{ alias: "payments" }], tools: [{ name: "list_issues", access: "read" }] }] } });
    expect(linear.success).toBe(false);
    expect(linear.error?.issues[0]?.message).toContain("connector type future-vendor");
    const unknownName = EvalProjectSchema.safeParse({ ...base, eval: { notConnected: ["jira"] } });
    expect(unknownName.error?.issues[0]?.message).toContain("jira");
    const project = await loadProject("fixtures/payments.yaml");
    expect(() => newPresentation(project, new Map())).toThrow(/catalog github/);
  });

  it("marks a connector not connected and offers recovery tools only through the fixture's eval settings", () => {
    const project = EvalProjectSchema.parse({
      name: "demo", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate.",
      repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-agentx-sdlc" }],
      integrations: { connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools: [{ name: "list_issues", access: "read" }] }] },
      eval: { notConnected: ["github"], recoverableOperations: ["0f0e0d0c-0b0a-4908-8706-050403020100"] },
    });
    const presented = newPresentation(project, new Map());
    expect(presented.connectors).toEqual([{ name: "github", type: "github", label: "GitHub issues", scopes: ["demo"], connected: false }]);
    expect(presented.catalogs).toEqual([]);
    expect(presented.toolNames).toEqual(["agentx_submit_task", "agentx_create_pull_request", "agentx_task_status", "agentx_task_result", "agentx_follow_up", "agentx_manage_pull_request"]);
  });
});

describe("evaluation harness, offline", () => {
  it("scores every committed case with the new presentation through the real orchestrator", async () => {
    const { modelRuntime, faux } = await fauxModelRuntime();
    const cases = await loadCases();
    const report = await runEvaluation(cases, { model: FAUX_MODEL, modelRuntime, presentation: "new", repeat: 1, beforeRun: oracle(faux, expected) });
    expect(report.cases.filter((result) => !result.passed).map((result) => result.id)).toEqual([]);
    expect(report.summary).toMatchObject({ cases: cases.length, passed: cases.length, toolAccuracy: 1, refusalAccuracy: 1, errors: 0 });
  }, 120_000);

  it("fails a case on a wrong tool, wrong arguments or a missing refusal, and counts regressions", async () => {
    const { modelRuntime, faux } = await fauxModelRuntime();
    const cases = (await loadCases()).filter((entry) => ["files-not-pr", "jira-not-connected", "append-pr"].includes(entry.id));
    const wrong = oracle(faux, (evalCase) => evalCase.id === "files-not-pr" ? { tool: "agentx_create_pull_request", args: { repository: "payments-api", title: "x" } }
      : evalCase.id === "append-pr" ? { tool: "agentx_manage_pull_request", args: { repository: "payments-api", pullRequestNumber: 12, action: "sync" } }
        : { text: "Jira is a tool I lack." });
    const report = await runEvaluation(cases, { model: FAUX_MODEL, modelRuntime, presentation: "new", repeat: 2, beforeRun: wrong });
    expect(report.cases.map((result) => [result.id, result.passed])).toEqual([["files-not-pr", false], ["jira-not-connected", false], ["append-pr", false]]);
    expect(report.cases[2]?.runs[0]).toMatchObject({ tool: "agentx_manage_pull_request", toolOk: true, argsOk: false });
    expect(report.cases[0]?.runs).toHaveLength(2);
    const baseline: EvalReport = { ...report, cases: report.cases.map((result) => ({ ...result, passed: true })) };
    expect(compareWithBaseline(report, baseline)).toEqual({ regressions: ["files-not-pr", "jira-not-connected", "append-pr"], failed: true });
    expect(compareWithBaseline(report, { ...baseline, cases: baseline.cases.map((result, index) => ({ ...result, passed: index === 0 })) }).failed).toBe(false);
    expect(compareWithBaseline(report, undefined)).toEqual({ regressions: [], failed: false });
  }, 60_000);

  it("counts a case that errors as a failed case in the report, never a skipped or passing one", async () => {
    const { modelRuntime, faux } = await fauxModelRuntime();
    const directory = await temporaryDirectory();
    try {
      await writeFile(join(directory, "broken.jsonl"), `${JSON.stringify({ id: "broken-fixture", project: "fixtures/missing-project.yaml", prompt: "what's open in Jira?", expect: { tool: null, refusal: "not connected" } })}\n`);
      const cases = [...await loadCases(directory), ...(await loadCases()).filter((entry) => entry.id === "files-not-pr")];
      const report = await runEvaluation(cases, { model: FAUX_MODEL, modelRuntime, presentation: "new", repeat: 1, beforeRun: oracle(faux, expected) });
      expect(report.cases.map((result) => [result.id, result.passed])).toEqual([["broken-fixture", false], ["files-not-pr", true]]);
      expect(report.cases[0]?.runs[0]).toMatchObject({ tool: null, toolOk: false, phraseOk: false });
      expect(report.cases[0]?.runs[0]?.error).toContain("missing-project.yaml");
      expect(report.summary).toMatchObject({ cases: 2, passed: 1, errors: 1, toolAccuracy: 0.5, refusalCases: 1, refusalAccuracy: 0 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("scores refusal and contains separately: both must pass, and refusal accuracy counts only the refusal phrase", async () => {
    const { modelRuntime, faux } = await fauxModelRuntime();
    const directory = await temporaryDirectory();
    try {
      const both = (id: string) => JSON.stringify({ id, project: "fixtures/github-only.yaml", prompt: "what's open in Jira?", expect: { tool: null, refusal: "not connected", contains: "Jira" } });
      await writeFile(join(directory, "both.jsonl"), `${both("both-present")}\n${both("contains-missing")}\n`);
      const cases = await loadCases(directory);
      const answers = oracle(faux, (evalCase) => ({ text: evalCase.id === "both-present" ? "Jira is not connected for this channel." : "That is not connected for this channel." }));
      const report = await runEvaluation(cases, { model: FAUX_MODEL, modelRuntime, presentation: "new", repeat: 1, beforeRun: answers });
      expect(report.cases.map((result) => [result.id, result.passed])).toEqual([["both-present", true], ["contains-missing", false]]);
      expect(report.cases[1]?.runs[0]).toMatchObject({ toolOk: true, refusalOk: true, containsOk: false, phraseOk: false });
      expect(report.summary).toMatchObject({ passed: 1, refusalCases: 2, refusalAccuracy: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("waits for a timed-out run to stop before the next case starts on the shared model runtime", async () => {
    const { modelRuntime, faux } = await fauxModelRuntime();
    const cases = (await loadCases()).filter((entry) => ["files-not-pr", "append-pr"].includes(entry.id));
    const events: string[] = [];
    // The timeout applies to append-pr too, so it is long enough for a normal run on a loaded machine.
    const script = oracle(faux, expected);
    const beforeRun = async (evalCase: EvalCase) => {
      if (evalCase.id === "files-not-pr") {
        await new Promise((resolve) => setTimeout(resolve, 1_300));
        // The abandoned run touches the shared faux handle after its deadline.
        faux.setResponses([fauxAssistantMessage("Jira is a tool I lack.")]);
        events.push("files-not-pr settled");
        return;
      }
      events.push("append-pr started");
      script(evalCase);
    };
    const report = await runEvaluation(cases, { model: FAUX_MODEL, modelRuntime, presentation: "new", repeat: 1, timeoutMs: 1_000, graceMs: 2_000, beforeRun });
    expect(events).toEqual(["files-not-pr settled", "append-pr started"]);
    expect(report.cases.map((result) => [result.id, result.passed])).toEqual([["files-not-pr", false], ["append-pr", true]]);
    expect(report.cases[0]?.runs[0]).toMatchObject({ error: "timed out after 1000 ms" });
    expect(report.stopped).toBeUndefined();
  }, 30_000);

  it("stops the evaluation when a timed-out run does not stop within the grace period", async () => {
    const { modelRuntime, faux } = await fauxModelRuntime();
    const cases = (await loadCases()).filter((entry) => ["files-not-pr", "append-pr"].includes(entry.id));
    const started: string[] = [];
    const script = oracle(faux, expected);
    const beforeRun = (evalCase: EvalCase) => {
      started.push(evalCase.id);
      if (evalCase.id === "files-not-pr") return new Promise<void>(() => undefined);
      script(evalCase);
      return undefined;
    };
    const report = await runEvaluation(cases, { model: FAUX_MODEL, modelRuntime, presentation: "new", repeat: 1, timeoutMs: 50, graceMs: 100, beforeRun });
    const stopped = "case files-not-pr did not stop after its timeout; the evaluation was stopped so later cases do not share its state";
    expect(started).toEqual(["files-not-pr"]);
    expect(report.stopped).toBe(stopped);
    expect(report.notRun).toEqual(["append-pr"]);
    expect(report.cases.map((result) => [result.id, result.passed])).toEqual([["files-not-pr", false]]);
    expect(report.cases[0]?.runs[0]).toMatchObject({ toolOk: false, error: `timed out after 50 ms; ${stopped}` });
    expect(report.summary).toMatchObject({ cases: 1, passed: 0, errors: 1 });
    // A run that did not stop is an infrastructure fault, not a model timeout.
    expect(report.cases[0]?.runs[0]?.timedOut).toBeUndefined();
    expect(report.summary.timeouts).toBeUndefined();
    const root = await temporaryDirectory();
    try {
      expect(await recordLiveReport({ ...report, provider: "amazon-bedrock", model: "amazon.nova-pro-v1:0" }, { updateBaseline: true, root })).toMatchObject({ exitCode: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("times out the whole run, including the steps before the turn", async () => {
    const { modelRuntime } = await fauxModelRuntime();
    const cases = (await loadCases()).filter((entry) => entry.id === "files-not-pr");
    const stuck = () => new Promise<void>((resolve) => setTimeout(resolve, 1_500));
    const report = await runEvaluation(cases, { model: FAUX_MODEL, modelRuntime, presentation: "new", repeat: 1, timeoutMs: 50, beforeRun: stuck });
    expect(report.cases[0]).toMatchObject({ passed: false, runs: [{ toolOk: false, error: "timed out after 50 ms" }] });
  }, 30_000);

  it("counts a timed-out run as a failed run and a timeout, not as an error that blocks the baseline", async () => {
    const { modelRuntime, faux } = await fauxModelRuntime();
    const cases = (await loadCases()).filter((entry) => ["files-not-pr", "append-pr"].includes(entry.id));
    const script = oracle(faux, expected);
    const beforeRun = (evalCase: EvalCase) => {
      if (evalCase.id === "files-not-pr") faux.setResponses([async () => { await new Promise((resolve) => setTimeout(resolve, 1_500)); return fauxAssistantMessage("late"); }]);
      else script(evalCase);
    };
    const report = await runEvaluation(cases, { model: FAUX_MODEL, modelRuntime, presentation: "new", repeat: 1, timeoutMs: 1_000, beforeRun });
    expect(report.cases.map((result) => [result.id, result.passed])).toEqual([["files-not-pr", false], ["append-pr", true]]);
    expect(report.cases[0]?.runs[0]).toMatchObject({ tool: null, toolOk: false, timedOut: true, error: "timed out after 1000 ms" });
    expect(report.cases[1]?.runs[0]?.timedOut).toBeUndefined();
    expect(report.summary).toMatchObject({ cases: 2, passed: 1, errors: 0, timeouts: 1, toolAccuracy: 0.5 });
    expect(report.stopped).toBeUndefined();
    const root = await temporaryDirectory();
    try {
      const live = { ...report, provider: "amazon-bedrock", model: "amazon.nova-pro-v1:0" };
      expect(await recordLiveReport(live, { updateBaseline: false, root })).toMatchObject({ exitCode: 0 });
      expect(await recordLiveReport(live, { updateBaseline: true, root })).toEqual({ exitCode: 0, lines: [`Baseline written: ${reportPath("baseline", "amazon.nova-pro-v1:0", "new", root)}`] });
      expect(JSON.parse(await readFile(reportPath("baseline", "amazon.nova-pro-v1:0", "new", root), "utf8"))).toMatchObject({ summary: { errors: 0, timeouts: 1 } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("still blocks the baseline on an infrastructure error or a fixture error alongside timeouts", async () => {
    const timedOut = { tool: null, toolOk: false, argsOk: true, phraseOk: null, refusalOk: null, containsOk: null, timedOut: true as const, error: "timed out after 180000 ms" };
    const infrastructure = { tool: null, toolOk: false, argsOk: true, phraseOk: null, refusalOk: null, containsOk: null, error: "RUNTIME_UNAVAILABLE: AccessDeniedException" };
    const root = await temporaryDirectory();
    try {
      const report = liveReport({
        cases: [{ id: "files-not-pr", passed: false, runs: [timedOut] }, { id: "append-pr", passed: false, runs: [infrastructure] }],
        summary: { cases: 2, passed: 0, errors: 1, timeouts: 1, toolAccuracy: 0, refusalCases: 0, refusalAccuracy: 1 },
      });
      const outcome = await recordLiveReport(report, { updateBaseline: true, root });
      expect(outcome).toEqual({ exitCode: 1, lines: ["Baseline not written: 1 case errored. Rerun once the errors are resolved."] });
      await expect(readFile(reportPath("baseline", "amazon.nova-pro-v1:0", "new", root), "utf8")).rejects.toThrow(/ENOENT/);
      expect((await recordLiveReport(report, { updateBaseline: false, root })).exitCode).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    const { modelRuntime, faux } = await fauxModelRuntime();
    const directory = await temporaryDirectory();
    try {
      await writeFile(join(directory, "broken.jsonl"), `${JSON.stringify({ id: "broken-fixture", project: "fixtures/missing-project.yaml", prompt: "list files", expect: { tool: "agentx_submit_task" } })}\n`);
      const broken = await runEvaluation(await loadCases(directory), { model: FAUX_MODEL, modelRuntime, presentation: "new", repeat: 1, beforeRun: oracle(faux, expected) });
      expect(broken.cases[0]?.runs[0]?.timedOut).toBeUndefined();
      expect(broken.summary).toMatchObject({ errors: 1 });
      expect(broken.summary.timeouts).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("counts a turn that runs past the timeout as an error", async () => {
    const { modelRuntime, faux } = await fauxModelRuntime();
    const cases = (await loadCases()).filter((entry) => entry.id === "files-not-pr");
    const slow = () => faux.setResponses([async () => { await new Promise((resolve) => setTimeout(resolve, 1_500)); return fauxAssistantMessage("late"); }]);
    const report = await runEvaluation(cases, { model: FAUX_MODEL, modelRuntime, presentation: "new", repeat: 1, timeoutMs: 50, beforeRun: slow });
    expect(report.cases[0]).toMatchObject({ passed: false, runs: [{ toolOk: false, error: "timed out after 50 ms" }] });
  }, 30_000);

  it("maps legacy tool names to the new names before scoring", async () => {
    const { modelRuntime, faux } = await fauxModelRuntime();
    const cases = (await loadCases()).filter((entry) => entry.id === "append-pr");
    const project = await loadProject("fixtures/payments.yaml");
    const legacy = legacyPresentation(project, new Map([["github", await loadCatalog("github")]]));
    expect(legacy.tools.map((tool) => tool.name)).toHaveLength(12 + 4 * 2);
    expect(legacy.systemPrompt).not.toContain("What this channel can do:");
    const report = await runEvaluation(cases, { model: FAUX_MODEL, modelRuntime, presentation: "legacy", repeat: 1,
      beforeRun: oracle(faux, () => ({ tool: "agentx_append_pull_request", args: { repository: "payments-api", pullRequestNumber: 12 } })) });
    expect(report.cases[0]).toMatchObject({ passed: true, runs: [{ tool: "agentx_manage_pull_request", argsOk: true }] });
    const issueTool = legacy.legacyName("github__list_issues", { target: "payments-web" });
    expect(issueTool).toMatch(/^github_list_issues_[a-f0-9]{12}$/);
    expect(legacy.canonical(issueTool, { state: "OPEN" })).toEqual({ tool: "github__list_issues", args: { state: "OPEN", target: "payments-web" } });
    expect(legacy.legacyCall("github__list_issues", { target: "payments-web", state: "OPEN" })).toEqual({ tool: issueTool, args: { state: "OPEN" } });
    expect(legacy.legacyCall("agentx_manage_pull_request", { repository: "payments-api", pullRequestNumber: 12, action: "append" }))
      .toEqual({ tool: "agentx_append_pull_request", args: { repository: "payments-api", pullRequestNumber: 12 } });
  }, 60_000);

  it("reports a case the legacy presentation cannot express as not applicable, never a failure or a silent drop", async () => {
    const { modelRuntime, faux } = await fauxModelRuntime();
    const cases = (await loadCases()).filter((entry) => ["linear-open-issues", "github-not-linear", "files-not-pr", "jira-not-connected"].includes(entry.id));
    const options = { model: FAUX_MODEL, modelRuntime, repeat: 1, beforeRun: scriptExpectedAnswers(faux) };
    const legacy = await runEvaluation(cases, { ...options, presentation: "legacy" });
    expect(legacy.cases.map((result) => [result.id, result.passed])).toEqual([["files-not-pr", true], ["jira-not-connected", true], ["github-not-linear", true]]);
    expect(legacy.notApplicable).toEqual([{ id: "linear-open-issues", reason: "needs connector linear (type linear), which the legacy presentation cannot offer" }]);
    expect(legacy.summary).toEqual({ cases: 3, passed: 3, errors: 0, notApplicable: 1, toolAccuracy: 1, refusalCases: 1, refusalAccuracy: 1 });
    const fresh = await runEvaluation(cases, { ...options, presentation: "new" });
    expect(fresh.notApplicable).toBeUndefined();
    expect(fresh.summary).toEqual({ cases: 4, passed: 4, errors: 0, toolAccuracy: 1, refusalCases: 1, refusalAccuracy: 1 });
  }, 60_000);

  it("matches phrases with curly apostrophes and quotes as straight ones", async () => {
    const [refusal] = (await loadCases()).filter((entry) => entry.id === "linear-read-unconfigured");
    expect(scoreRun(refusal!, { tool: null, args: {}, response: "Linear isn’t connected for this channel." })).toMatchObject({ toolOk: true, refusalOk: true, phraseOk: true });
    expect(scoreRun(refusal!, { tool: null, args: {}, response: "Linear is not available here." })).toMatchObject({ refusalOk: false, phraseOk: false });
    const quoted: EvalCase = { id: "quoted", project: "fixtures/github-only.yaml", prompt: "x", expect: { tool: null, contains: "“AGENTX_OK”" } };
    expect(scoreRun(quoted, { tool: null, args: {}, response: 'I replied "agentx_ok".' })).toMatchObject({ containsOk: true });
  });

  it("marks a case not applicable to legacy when its fixture needs a recoverable operation", async () => {
    const cases = await loadCases();
    const recover = cases.find((entry) => entry.id === "recover-operation")!;
    expect(legacyNotApplicable(await loadProject(recover.project), recover)).toBe("needs a recoverable operation ID, which the legacy presentation cannot receive");
    const files = cases.find((entry) => entry.id === "files-not-pr")!;
    expect(legacyNotApplicable(await loadProject(files.project), files)).toBeUndefined();
  });

  it("records a stable hash of each case definition and of the scored case set", async () => {
    const { modelRuntime, faux } = await fauxModelRuntime();
    const cases = (await loadCases()).filter((entry) => ["files-not-pr", "linear-open-issues"].includes(entry.id));
    const options = { model: FAUX_MODEL, modelRuntime, repeat: 1, beforeRun: scriptExpectedAnswers(faux) };
    const fresh = await runEvaluation(cases, { ...options, presentation: "new" });
    const legacy = await runEvaluation(cases, { ...options, presentation: "legacy" });
    const files = cases.find((entry) => entry.id === "files-not-pr")!;
    expect(caseHash(files)).toMatch(/^[a-f0-9]{64}$/);
    expect(caseHash({ ...files, note: "a note changes nothing", source: "channel" })).toBe(caseHash(files));
    expect(caseHash({ ...files, expect: { tool: "agentx_submit_task", argsSubset: {} } })).not.toBe(caseHash(files));
    expect(caseHash({ ...files, prompt: `${files.prompt}.` })).not.toBe(caseHash(files));
    expect(fresh.cases.map((result) => result.caseHash)).toEqual(cases.map(caseHash));
    expect(legacy.cases.map((result) => [result.id, result.caseHash])).toEqual([["files-not-pr", caseHash(files)]]);
    expect(fresh.caseSetHash).toMatch(/^[a-f0-9]{64}$/);
    expect(legacy.caseSetHash).not.toBe(fresh.caseSetHash);
    expect((await runEvaluation(cases, { ...options, presentation: "new" })).caseSetHash).toBe(fresh.caseSetHash);
  }, 60_000);

  it("scores a first call to a tool the presentation does not offer as the wrong tool", async () => {
    const { modelRuntime, faux } = await fauxModelRuntime();
    const cases = (await loadCases()).filter((entry) => entry.id === "append-pr");
    const retired = oracle(faux, () => ({ tool: "agentx_append_pull_request", args: { repository: "payments-api", pullRequestNumber: 12 } }));
    const report = await runEvaluation(cases, { model: FAUX_MODEL, modelRuntime, presentation: "new", repeat: 1, beforeRun: retired });
    expect(report.cases[0]).toMatchObject({ passed: false, runs: [{ tool: "agentx_append_pull_request", offered: false, toolOk: false }] });
    const legacyWithNewName = oracle(faux, () => ({ tool: "agentx_manage_pull_request", args: { repository: "payments-api", pullRequestNumber: 12, action: "append" } }));
    const legacy = await runEvaluation(cases, { model: FAUX_MODEL, modelRuntime, presentation: "legacy", repeat: 1, beforeRun: legacyWithNewName });
    expect(legacy.cases[0]).toMatchObject({ passed: false, runs: [{ tool: "agentx_manage_pull_request", offered: false, toolOk: false }] });
  }, 60_000);

  it("keeps results and baselines per model and presentation", () => {
    expect(reportPath("results", "amazon.nova-pro-v1:0", "new")).toBe(`${EVAL_ROOT}/results/amazon.nova-pro-v1_0.json`);
    expect(reportPath("baseline", "amazon.nova-pro-v1:0", "legacy")).toBe(`${EVAL_ROOT}/baseline/amazon.nova-pro-v1_0.legacy.json`);
  });
});

function scored(id: string, run: Partial<EvalReport["cases"][number]["runs"][number]>): EvalReport["cases"][number] {
  const full = { tool: "agentx_submit_task", toolOk: true, argsOk: true, phraseOk: null, refusalOk: null, containsOk: null, ...run };
  return { id, caseHash: `${id}-definition`, passed: full.toolOk && full.argsOk && full.phraseOk !== false, runs: [full, full, full] };
}

function sc004Reports(): { fresh: EvalReport; legacy: EvalReport } {
  const refusal = { tool: null, phraseOk: true, refusalOk: true };
  const freshCases = [scored("files", {}), scored("issues", { toolOk: false, tool: "agentx_submit_task" }), scored("refuse", refusal), scored("linear", { tool: "linear__list_issues" })];
  const legacyCases = [scored("files", { toolOk: false, tool: "agentx_create_pull_request" }), scored("issues", { toolOk: false }), scored("refuse", refusal)];
  return {
    fresh: liveReport({ cases: freshCases, summary: { cases: 4, passed: 3, errors: 0, toolAccuracy: 0.75, refusalCases: 1, refusalAccuracy: 1 } }),
    legacy: liveReport({ presentation: "legacy", cases: legacyCases, notApplicable: [{ id: "linear", reason: "needs connector linear (type linear), which the legacy presentation cannot offer" }],
      summary: { cases: 3, passed: 1, errors: 0, notApplicable: 1, toolAccuracy: 1 / 3, refusalCases: 1, refusalAccuracy: 1 } }),
  };
}

describe("SC-004 comparison", () => {
  it("compares the presentations only on the cases both can express", () => {
    const { fresh, legacy } = sc004Reports();
    // Counting the Linear case would make the new tool accuracy 3/4; on the shared cases it is 2/3.
    expect(compareSc004(fresh, legacy)).toEqual({
      model: "amazon.nova-pro-v1:0", cases: 3, notApplicable: ["linear"],
      new: { passed: 2, toolAccuracy: 2 / 3, refusalCases: 1, refusalAccuracy: 1 },
      legacy: { passed: 1, toolAccuracy: 1 / 3, refusalCases: 1, refusalAccuracy: 1 },
      met: true,
    });
    const worse = { ...fresh, cases: fresh.cases.map((result) => result.id === "refuse" ? scored("refuse", { tool: null, toolOk: true, phraseOk: false, refusalOk: false }) : result) };
    expect(compareSc004(worse, legacy)).toMatchObject({ new: { refusalAccuracy: 0 }, met: false });
    const tied = { ...fresh, cases: fresh.cases.map((result) => result.id === "files" ? scored("files", { toolOk: false }) : result) };
    expect(compareSc004(tied, legacy)).toMatchObject({ new: { toolAccuracy: 1 / 3 }, met: false });
  });

  it("refuses reports that differ in model, cover different cases, errored or are swapped", () => {
    const { fresh, legacy } = sc004Reports();
    expect(() => compareSc004(legacy, fresh)).toThrow(/new presentation first/);
    expect(() => compareSc004(fresh, { ...legacy, model: "amazon.nova-lite-v1:0" })).toThrow(/same provider, model and repeat/);
    expect(() => compareSc004(fresh, { ...legacy, notApplicable: [] })).toThrow(/different cases: linear/);
    expect(() => compareSc004({ ...fresh, summary: { ...fresh.summary, errors: 1 } }, legacy)).toThrow(/new report has errors/);
    expect(() => compareSc004(fresh, { ...legacy, stopped: "stuck", notRun: [] })).toThrow(/legacy report has errors or stopped early/);
    // Timeouts are model behaviour: a baseline with them is compared, and each counts as a failed run.
    const timedOut = { ...legacy, cases: legacy.cases.map((result) => result.id === "refuse" ? scored("refuse", { tool: null, toolOk: false, refusalOk: false, phraseOk: false, timedOut: true, error: "timed out after 180000 ms" }) : result),
      summary: { ...legacy.summary, timeouts: 1 } };
    expect(compareSc004(fresh, timedOut)).toMatchObject({ legacy: { passed: 0, toolAccuracy: 0, refusalAccuracy: 0 }, met: true });
    const edited = { ...legacy, cases: legacy.cases.map((result) => result.id === "issues" ? { ...result, caseHash: "issues-edited" } : result) };
    expect(() => compareSc004(fresh, edited)).toThrow(/case definitions differ between the two baselines: issues/);
    const unhashed = { ...legacy, cases: legacy.cases.map((result) => result.id === "files" ? { id: result.id, passed: result.passed, runs: result.runs } : result) };
    expect(() => compareSc004(fresh, unhashed)).toThrow(/case definitions differ between the two baselines: files/);
    // Only the shared cases must match: the not-applicable Linear case may differ.
    const linearEdited = { ...fresh, cases: fresh.cases.map((result) => result.id === "linear" ? { ...result, caseHash: "linear-edited" } : result) };
    expect(compareSc004(linearEdited, legacy).met).toBe(true);
  });

  it("reads both committed baselines with npm run eval -- --sc004 and calls no model", async () => {
    const root = await temporaryDirectory();
    try {
      const { fresh, legacy } = sc004Reports();
      await expect(runEvalCli(["--sc004"], { root, env: {} })).rejects.toThrow(/no baseline .*amazon\.nova-pro-v1_0\.json/);
      await recordLiveReport(fresh, { updateBaseline: true, root });
      await recordLiveReport(legacy, { updateBaseline: true, root });
      const outcome = await runEvalCli(["--sc004"], { root, env: {} });
      expect(outcome.exitCode).toBe(0);
      expect(outcome.lines).toEqual([
        "SC-004 on amazon-bedrock/amazon.nova-pro-v1:0 over 3 cases both presentations express (1 not applicable to legacy: linear):",
        "  new presentation: 2/3 cases passed; tool accuracy 66.7%; refusal accuracy 100.0% over 1 cases",
        "  legacy presentation: 1/3 cases passed; tool accuracy 33.3%; refusal accuracy 100.0% over 1 cases",
        "  Result: met (the new tool accuracy must be higher and the new refusal accuracy at least 90%)",
      ]);
      expect(() => parseEvalArguments(["--sc004", "--live"])).toThrow(/--sc004/);
      expect(() => parseEvalArguments(["--sc004", "--update-baseline"])).toThrow(/--sc004/);
      expect(parseEvalArguments(["--sc004", "--model", "amazon.nova-lite-v1:0"], {})).toMatchObject({ sc004: true, live: false, model: { provider: "amazon-bedrock", modelId: "amazon.nova-lite-v1:0" } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("evaluation command, live safety", () => {
  it("never creates a real model runtime unless live is asked for", async () => {
    const cases = (await loadCases()).filter((entry) => entry.id === "files-not-pr");
    // A provider no runtime knows, so even a broken guard fails here without reaching a network.
    await expect(runEvaluation(cases, { model: { provider: "agentx-no-such-provider", modelId: "none" }, presentation: "new", repeat: 1 }))
      .rejects.toThrow("runEvaluation needs a modelRuntime (offline) or live: true (calls a paid model)");
  });

  it("refuses a real provider on a faux runtime unless live is asked for, before resolving any model", async () => {
    const { modelRuntime } = await fauxModelRuntime();
    const cases = (await loadCases()).filter((entry) => entry.id === "files-not-pr");
    // The spy throws on any model lookup, so even a missing guard stops here without reaching a network.
    let lookups = 0;
    modelRuntime.getModel = () => { lookups += 1; throw new Error("model lookup reached"); };
    await expect(runEvaluation(cases, { model: { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0" }, modelRuntime, presentation: "new", repeat: 1 }))
      .rejects.toThrow("offline runs use the faux provider agentx-faux; amazon-bedrock needs live: true (calls a paid model)");
    expect(lookups).toBe(0);
  });

  it("refuses to write a baseline from a run with errors", async () => {
    const root = await temporaryDirectory();
    try {
      const outcome = await recordLiveReport(liveReport({ cases: erroredCases, summary: erroredSummary }), { updateBaseline: true, root });
      expect(outcome.exitCode).toBe(1);
      expect(outcome.lines.join("\n")).toContain("Baseline not written: 1 case errored");
      await expect(readFile(reportPath("baseline", "amazon.nova-pro-v1:0", "new", root), "utf8")).rejects.toThrow(/ENOENT/);
      expect(await recordLiveReport(liveReport(), { updateBaseline: true, root })).toMatchObject({ exitCode: 0 });
      expect(JSON.parse(await readFile(reportPath("baseline", "amazon.nova-pro-v1:0", "new", root), "utf8"))).toEqual(liveReport());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails a live run with any errored case, even with no baseline", async () => {
    const root = await temporaryDirectory();
    try {
      const outcome = await recordLiveReport(liveReport({ cases: erroredCases, summary: erroredSummary }), { updateBaseline: false, root });
      expect(outcome.exitCode).toBe(1);
      expect(outcome.lines.join("\n")).toContain("1 case errored");
      expect(await recordLiveReport(liveReport(), { updateBaseline: false, root })).toMatchObject({ exitCode: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats a malformed baseline or one for another model, provider or presentation as an error", async () => {
    const root = await temporaryDirectory();
    try {
      const path = reportPath("baseline", "amazon.nova-pro-v1:0", "new", root);
      await recordLiveReport(liveReport(), { updateBaseline: true, root });
      await writeFile(path, "{ not json");
      await expect(recordLiveReport(liveReport(), { updateBaseline: false, root })).rejects.toThrow(/baseline .* is malformed/);
      await writeFile(path, JSON.stringify({ ...liveReport(), cases: "none" }));
      await expect(recordLiveReport(liveReport(), { updateBaseline: false, root })).rejects.toThrow(/baseline .* is malformed/);
      for (const other of [{ provider: "other-provider" }, { model: "amazon.nova-lite-v1:0" }, { presentation: "legacy" as const }]) {
        await writeFile(path, JSON.stringify(liveReport(other)));
        await expect(recordLiveReport(liveReport(), { updateBaseline: false, root })).rejects.toThrow(/does not match this run/);
      }
      await writeFile(path, JSON.stringify(liveReport({ cases: [{ ...liveReport().cases[0]!, passed: true }] })));
      expect(await recordLiveReport(liveReport(), { updateBaseline: false, root })).toMatchObject({ exitCode: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs offline on the faux provider by default and needs --live for a real model or a baseline", () => {
    expect(parseEvalArguments([])).toMatchObject({ live: false, model: FAUX_MODEL, repeat: 1, presentation: "new", updateBaseline: false });
    expect(parseEvalArguments(["--live"], {})).toMatchObject({ live: true, model: { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0" }, repeat: 3 });
    expect(parseEvalArguments(["--live", "--provider", "p", "--model", "m", "--repeat", "2", "--presentation", "legacy"], {}))
      .toMatchObject({ live: true, model: { provider: "p", modelId: "m" }, repeat: 2, presentation: "legacy" });
    expect(() => parseEvalArguments(["--model", "amazon.nova-pro-v1:0"])).toThrow(/--live/);
    expect(() => parseEvalArguments(["--provider", "amazon-bedrock"])).toThrow(/--live/);
    expect(() => parseEvalArguments(["--update-baseline"])).toThrow(/--live/);
    expect(() => parseEvalArguments(["--repeat", "0"])).toThrow(/--repeat/);
    expect(() => parseEvalArguments(["--presentation", "old"])).toThrow(/--presentation/);
    expect(() => parseEvalArguments(["--bogus"])).toThrow();
  });

  it("an offline command run scores the cases on the faux provider and writes results, not a baseline", async () => {
    const root = await temporaryDirectory();
    try {
      const outcome = await runEvalCommand([], { root, env: {} });
      expect(outcome.exitCode).toBe(0);
      expect(outcome.report).toMatchObject({ provider: FAUX_MODEL.provider, model: FAUX_MODEL.modelId, presentation: "new", repeat: 1 });
      expect(outcome.report.summary.passed).toBe(outcome.report.summary.cases);
      const written = JSON.parse(await readFile(join(root, "results", "scripted.json"), "utf8")) as EvalReport;
      expect(written.summary).toEqual(outcome.report.summary);
      await expect(readFile(join(root, "baseline", "scripted.json"), "utf8")).rejects.toThrow(/ENOENT/);
      expect(outcome.lines[0]).toMatch(/^Offline run on the faux provider/);
      expect(outcome.lines[0]).toContain("; 0 cases errored; 0 cases timed out. Results: ");
      // The legacy presentation (commit 63f78f6) offers only GitHub and cannot receive an unfinished
      // operation's ID, so cases that need a Linear or Jira tool, or a recoverable operation, are
      // reported as not applicable: listed and counted, never scored or dropped.
      const legacy = await runEvalCommand(["--presentation", "legacy"], { root, env: {} });
      const all = await loadCases();
      const recovering = new Set<string>();
      for (const entry of all) if ((await loadProject(entry.project)).recoverableOperations.length > 0) recovering.add(entry.id);
      expect(recovering.size).toBeGreaterThan(0);
      const inexpressible = all.filter((entry) => recovering.has(entry.id) || [entry.expect.tool].flat().some((tool) => tool !== null && !/^(agentx_|github__)/.test(tool))).map((entry) => entry.id);
      expect(inexpressible.length).toBeGreaterThan(0);
      expect(legacy.report.notApplicable?.map((entry) => entry.id)).toEqual(inexpressible);
      expect(legacy.report.summary.cases + inexpressible.length).toBe(all.length);
      expect(legacy.lines).toEqual([
        expect.stringMatching(/^Offline run on the faux provider/),
        `Not applicable to the legacy presentation: ${inexpressible.length} cases, not scored (they need what it cannot offer): ${inexpressible.join(", ")}`,
      ]);
      expect(legacy).toMatchObject({ exitCode: 0, report: { presentation: "legacy", summary: { passed: legacy.report.summary.cases, errors: 0, notApplicable: inexpressible.length } } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});

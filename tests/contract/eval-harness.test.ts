import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { EVAL_ROOT, EvalProjectSchema, loadCases, loadCatalog, loadProject, type EvalCase } from "../eval/case.js";
import { parseEvalArguments, recordLiveReport, runEvalCommand } from "../eval/command.js";
import { legacyPresentation } from "../eval/legacy-presentation.js";
import { newPresentation } from "../eval/presentation.js";
import { compareWithBaseline, reportPath, runEvaluation, type EvalReport } from "../eval/runner.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

/** An oracle that answers each case as expected, so the harness itself is what is tested. */
function oracle(faux: FauxProviderHandle, pick: (evalCase: EvalCase) => { tool?: string; args?: Record<string, unknown>; text?: string }) {
  return (evalCase: EvalCase) => {
    const answer = pick(evalCase);
    faux.setResponses(answer.tool === undefined
      ? [fauxAssistantMessage(answer.text ?? "")]
      : [fauxAssistantMessage([fauxToolCall(answer.tool, answer.args ?? {})], { stopReason: "toolUse" }), fauxAssistantMessage("Done.")]);
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
    const linear = EvalProjectSchema.safeParse({ ...base, integrations: { connectors: [{ name: "linear", type: "linear", credentialRef: "linear-payments", scopes: [{ alias: "payments", teamId: "00000000-0000-4000-8000-000000000000" }], tools: [{ name: "list_issues", access: "read" }] }] } });
    expect(linear.success).toBe(false);
    expect(linear.error?.issues[0]?.message).toContain("connector type linear");
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
    const script = oracle(faux, expected);
    const beforeRun = async (evalCase: EvalCase) => {
      if (evalCase.id === "files-not-pr") {
        await new Promise((resolve) => setTimeout(resolve, 300));
        // The abandoned run touches the shared faux handle after its deadline.
        faux.setResponses([fauxAssistantMessage("Jira is a tool I lack.")]);
        events.push("files-not-pr settled");
        return;
      }
      events.push("append-pr started");
      script(evalCase);
    };
    const report = await runEvaluation(cases, { model: FAUX_MODEL, modelRuntime, presentation: "new", repeat: 1, timeoutMs: 50, graceMs: 2_000, beforeRun });
    expect(events).toEqual(["files-not-pr settled", "append-pr started"]);
    expect(report.cases.map((result) => [result.id, result.passed])).toEqual([["files-not-pr", false], ["append-pr", true]]);
    expect(report.cases[0]?.runs[0]).toMatchObject({ error: "timed out after 50 ms" });
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
      const legacy = await runEvalCommand(["--presentation", "legacy"], { root, env: {} });
      expect(legacy.lines).toHaveLength(1);
      expect(legacy).toMatchObject({ exitCode: 0, report: { presentation: "legacy", summary: { passed: legacy.report.summary.cases, errors: 0 } } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, type JsonObject } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SLACK_REPLY_INSTRUCTIONS } from "../../packages/orchestrator/src/orchestrator.js";
import { EVAL_ROOT, EvalCaseSchema, loadCases, type EvalCase } from "../eval/case.js";
import { EvalReportSchema, caseHash, runEvaluation, scoreRun } from "../eval/runner.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

const write: EvalCase = { id: "reply-check", project: "fixtures/payments-jira.yaml", prompt: "create a Jira bug titled X", expect: { tool: "jira__createJiraIssue", maxLines: 3 } };
const run = (response: string) => ({ tool: "jira__createJiraIssue", args: {}, response });

describe("reply length in the evaluation (spec 014 SC-006)", () => {
  it("accepts maxLines from 1 to 20 in a case", () => {
    expect(EvalCaseSchema.safeParse(write).success).toBe(true);
    for (const maxLines of [0, 21, 2.5]) expect(EvalCaseSchema.safeParse({ ...write, expect: { ...write.expect, maxLines } }).success).toBe(false);
  });

  it("counts the lines the member sees, after Slack formatting, and fails a reply over the limit", () => {
    expect(scoreRun(write, run("Created PAY-31 in Payments: <https://example.atlassian.net/browse/PAY-31>"))).toMatchObject({ replyLines: 1, linesOk: true, toolOk: true });
    expect(scoreRun(write, run("Created PAY-31.\n\nAssigned to nobody.\nLink: https://example.atlassian.net/browse/PAY-31"))).toMatchObject({ replyLines: 3, linesOk: true });
    expect(scoreRun(write, run("Created PAY-31.\\nSummary: X\\nType: Bug\\nLink: https://example.atlassian.net/browse/PAY-31"))).toMatchObject({ replyLines: 4, linesOk: false });
    expect(scoreRun({ ...write, expect: { tool: "jira__createJiraIssue" } }, run("a\nb\nc\nd"))).not.toHaveProperty("linesOk");
  });

  it("fails a reply that keeps a literal \\n outside code, even when its line count fits (spec 014 SC-006)", () => {
    // One real newline (so the formatter's "no real newline" condition for converting \n no longer
    // holds) plus a later literal "\n" that therefore stays literal: two lines, within the limit, but
    // the member would still see a stray backslash-n.
    expect(scoreRun(write, run("Created PAY-31.\nSummary: X\\nDone."))).toMatchObject({ replyLines: 2, linesOk: false });
    // The same literal "\n" inside a code span must not fail the check: it is shown as-is, not literally.
    expect(scoreRun(write, run("Created PAY-31.\n`a\\nb`"))).toMatchObject({ replyLines: 2, linesOk: true });
  });

  it("gives a case with maxLines the Slack reply style, and every other case the unchanged prompt", async () => {
    const { modelRuntime, faux } = await fauxModelRuntime();
    const prompts: string[] = [];
    const cases = (await loadCases()).filter((entry) => ["reply-jira-create", "jira-create"].includes(entry.id));
    expect(cases.map((entry) => entry.id).sort()).toEqual(["jira-create", "reply-jira-create"]);
    const report = await runEvaluation(cases, {
      model: FAUX_MODEL, modelRuntime, presentation: "new", repeat: 1,
      beforeRun: (evalCase) => {
        faux.setResponses([
          (context) => {
            // Pi 0.86+ carries the prompt in the leading system message (TranscriptContext).
            prompts.push(getCurrentSystemPrompt(context.messages));
            return fauxAssistantMessage([fauxToolCall(String(evalCase.expect.tool), (evalCase.expect.argsSubset ?? {}) as JsonObject)], { stopReason: "toolUse" });
          },
          fauxAssistantMessage("Created PAY-31: <https://example.atlassian.net/browse/PAY-31>"),
        ]);
      },
    });
    expect(report.summary).toMatchObject({ cases: 2, passed: 2, errors: 0 });
    const styled = new Map(report.cases.map((result, index) => [result.id, prompts[index]!.includes(SLACK_REPLY_INSTRUCTIONS[0]!)]));
    expect(Object.fromEntries(styled)).toEqual({ "jira-create": false, "reply-jira-create": true });
    expect(report.cases.find((result) => result.id === "reply-jira-create")!.runs[0]).toMatchObject({ replyLines: 1, linesOk: true });
  }, 60_000);

  it("keeps every case the committed SC-004 baselines scored, and their case-set hashes, unchanged", async () => {
    const current = new Map((await loadCases()).map((entry) => [entry.id, entry]));
    for (const file of ["amazon.nova-pro-v1_0.json", "amazon.nova-pro-v1_0.legacy.json"]) {
      const baseline = EvalReportSchema.parse(JSON.parse(await readFile(join(EVAL_ROOT, "baseline", file), "utf8")));
      for (const result of baseline.cases) expect(caseHash(current.get(result.id)!), `${file}: ${result.id}`).toBe(result.caseHash);
      const pairs = baseline.cases.map((result) => [result.id, caseHash(current.get(result.id)!)]).sort();
      expect(createHash("sha256").update(JSON.stringify(pairs)).digest("hex"), file).toBe(baseline.caseSetHash);
    }
  });
});

describe("Jira reply link guard, so the model never invents a site (issue 061)", () => {
  const runWith = (response: string, jiraSites: "unknown" | string[]) => ({ tool: "jira__createJiraIssue", args: {}, response, jiraSites });

  it("fails an invented Jira host and passes the case's real one", () => {
    const sites = ["example.atlassian.net"];
    expect(scoreRun(write, runWith("Created PAY-31: https://your-jira-instance.atlassian.net/browse/PAY-31", sites))).toMatchObject({ siteOk: false });
    expect(scoreRun(write, runWith("Created PAY-31: https://example.atlassian.net/browse/PAY-31", sites))).toMatchObject({ siteOk: true });
  });

  it("fails any atlassian.net link when the case's site is unknown, but not a reply with no link", () => {
    expect(scoreRun(write, runWith("Created PAY-31: https://example.atlassian.net/browse/PAY-31", "unknown"))).toMatchObject({ siteOk: false });
    expect(scoreRun(write, runWith("Created PAY-31.", "unknown"))).toMatchObject({ siteOk: true });
  });

  it("passes a host that matches any of several configured sites, case-insensitively", () => {
    const sites = ["example.atlassian.net", "other.atlassian.net"];
    expect(scoreRun(write, runWith("See https://OTHER.atlassian.net/browse/PAY-31", sites))).toMatchObject({ siteOk: true });
    expect(scoreRun(write, runWith("See https://third.atlassian.net/browse/PAY-31", sites))).toMatchObject({ siteOk: false });
  });

  it("catches a host with no scheme when it is followed by /browse/, but not a bare mention", () => {
    const sites = ["example.atlassian.net"];
    expect(scoreRun(write, runWith("See example.atlassian.net/browse/PAY-31", sites))).toMatchObject({ siteOk: true });
    expect(scoreRun(write, runWith("See your-jira-instance.atlassian.net/browse/PAY-31", sites))).toMatchObject({ siteOk: false });
    // A bare mention with no scheme and no /browse/ after it is not a link, so it is not flagged.
    expect(scoreRun(write, runWith("Filed under the example.atlassian.net workspace.", "unknown"))).toMatchObject({ siteOk: true });
  });

  it("recognises a multi-label host such as a.b.atlassian.net", () => {
    const sites = ["a.b.atlassian.net"];
    expect(scoreRun(write, runWith("See https://a.b.atlassian.net/browse/PAY-31", sites))).toMatchObject({ siteOk: true });
    expect(scoreRun(write, runWith("See https://x.y.atlassian.net/browse/PAY-31", sites))).toMatchObject({ siteOk: false });
    expect(scoreRun(write, runWith("See a.b.atlassian.net/browse/PAY-31", sites))).toMatchObject({ siteOk: true });
  });

  it("fails the whole case when only the link is wrong, even though the tool and args are right", async () => {
    const cases = (await loadCases()).filter((entry) => entry.id === "jira-create");
    const { modelRuntime, faux } = await fauxModelRuntime();
    const report = await runEvaluation(cases, {
      model: FAUX_MODEL, modelRuntime, presentation: "new", repeat: 1,
      beforeRun: (evalCase) => {
        faux.setResponses([
          () => fauxAssistantMessage([fauxToolCall(String(evalCase.expect.tool), (evalCase.expect.argsSubset ?? {}) as JsonObject)], { stopReason: "toolUse" }),
          fauxAssistantMessage("Created PAY-31: https://your-jira-instance.atlassian.net/browse/PAY-31"),
        ]);
      },
    });
    expect(report.summary).toMatchObject({ cases: 1, passed: 0, errors: 0 });
    expect(report.cases[0]).toMatchObject({ passed: false, runs: [{ toolOk: true, argsOk: true, siteOk: false }] });
  });

  it("loads and scores the no-siteUrl fixture correctly: the key alone passes, any link fails", async () => {
    const cases = (await loadCases()).filter((entry) => entry.id === "jira-create-nosite");
    expect(cases).toHaveLength(1);
    const { modelRuntime, faux } = await fauxModelRuntime();
    const reply = async (response: string) => {
      const report = await runEvaluation(cases, {
        model: FAUX_MODEL, modelRuntime, presentation: "new", repeat: 1,
        beforeRun: (evalCase) => {
          faux.setResponses([
            () => fauxAssistantMessage([fauxToolCall(String(evalCase.expect.tool), (evalCase.expect.argsSubset ?? {}) as JsonObject)], { stopReason: "toolUse" }),
            fauxAssistantMessage(response),
          ]);
        },
      });
      return report;
    };
    const keyOnly = await reply("Created PAY-42.");
    expect(keyOnly.summary).toMatchObject({ cases: 1, passed: 1, errors: 0 });
    expect(keyOnly.cases[0]).toMatchObject({ passed: true, runs: [{ toolOk: true, siteOk: true }] });

    const invented = await reply("Created PAY-42: https://your-jira-instance.atlassian.net/browse/PAY-42");
    expect(invented.summary).toMatchObject({ cases: 1, passed: 0, errors: 0 });
    expect(invented.cases[0]).toMatchObject({ passed: false, runs: [{ toolOk: true, siteOk: false }] });
  });
});

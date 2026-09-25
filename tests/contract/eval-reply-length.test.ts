import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
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
            prompts.push(context.systemPrompt ?? "");
            return fauxAssistantMessage([fauxToolCall(String(evalCase.expect.tool), evalCase.expect.argsSubset ?? {})], { stopReason: "toolUse" });
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

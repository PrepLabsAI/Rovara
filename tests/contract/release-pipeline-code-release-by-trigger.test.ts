// PIPELINE-CODE-RELEASE-BY-TRIGGER (Code half): every run a trigger starts carries the variable defaults, and a trigger cannot set a variable, so CODE_RELEASE's default is `from-trigger` and
// Beta's Code Preflight reports WHICH SOURCE started the run (a Cloud release tag push, a Code mainline push, a person) in CODE_CTX, for the Cloud Preflight to turn into run or skip
// (the Cloud half: tests/contract/pipeline-code-release-by-trigger.test.ts in Rovara Cloud). Synthesized template, and the Preflight's real shell with a fake `aws`.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENTX_BETA_CODE_PREFLIGHT_PROJECT_NAME,
  AGENTX_PRODUCTION_CODE_PREFLIGHT_PROJECT_NAME,
  CODE_RELEASE_CHECK,
  CODE_RELEASE_EXPLICIT_VALUES,
  CODE_RELEASE_FROM_TRIGGER,
  CODE_TRIGGER_KINDS,
  ReleasePipelineStack,
  triggerCommands,
} from "../../infra/lib/release-pipeline.js";
import { commitFile, fakeBin, git, preflightBuild, runShell, scratch } from "../support/release-pipeline-shell.js";

interface Statement { Effect: string; Action: string | string[]; Resource: unknown }
interface Resource { Type: string; Properties: Record<string, unknown> }
const template = Template.fromStack(new ReleasePipelineStack(new App(), "CodeReleaseByTrigger", { env: { region: "us-east-1" } }));
const json = template.toJSON() as { Resources: Record<string, Resource> };
const pipeline = (Object.values(template.findResources("AWS::CodePipeline::Pipeline"))[0] as { Properties: { Variables: Array<{ Name: string; DefaultValue: string; Description: string }>; Triggers: unknown[]; Stages: Array<{ Name: string; Actions: Array<{ Name: string; Configuration: Record<string, unknown> }> }> } }).Properties;
const text = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

describe("the pipeline variable and what the triggers carry", () => {
  it("CODE_RELEASE defaults to from-trigger, in its place and with a description CodePipeline accepts (200 characters at most)", () => {
    expect(pipeline.Variables.map((variable) => variable.Name)).toEqual(["CLOUD_REF", "CODE_RELEASE", "CLOUD_PROD", "PIPELINE_MODE", "CODE_ROLLBACK_TARGET"]);
    const variable = pipeline.Variables.find((candidate) => candidate.Name === "CODE_RELEASE")!;
    expect(variable.DefaultValue).toBe(CODE_RELEASE_FROM_TRIGGER);
    expect(variable.DefaultValue).toBe("from-trigger");
    expect(CODE_RELEASE_EXPLICIT_VALUES).toEqual(["run", "skip"]);
    expect(variable.Description.length).toBeLessThanOrEqual(200);
    expect(variable.Description).toMatch(/Cloud tag push releases Cloud only, a Code push releases Code; by hand name run or skip/u);
    // The other defaults are as they were.
    expect(Object.fromEntries(pipeline.Variables.map((candidate) => [candidate.Name, candidate.DefaultValue]))).toMatchObject({ CLOUD_REF: "from-trigger", CLOUD_PROD: "off", PIPELINE_MODE: "release", CODE_ROLLBACK_TARGET: "none" });
  });

  it("is still started by exactly the two triggers, and neither can set a variable (so both carry from-trigger; the Preflight tells them apart)", () => {
    expect(pipeline.Triggers).toHaveLength(2);
    for (const trigger of pipeline.Triggers as Array<Record<string, unknown>>) expect(Object.keys(trigger).sort()).toEqual(["GitConfiguration", "ProviderType"]);
  });

  it("the Cloud actions get the pipeline variable (from-trigger on a triggered run); the Code builds get only Beta's or Production's EFFECTIVE value, run or skip, from that stage's Cloud Preflight", () => {
    const variablesOf = (action: { Configuration: Record<string, unknown> }): Record<string, string> => {
      const raw = action.Configuration.EnvironmentVariables as string | { "Fn::Join": [string, unknown[]] } | undefined;
      if (raw === undefined) return {};
      const joined = typeof raw === "string" ? raw : raw["Fn::Join"][1].map((part) => (typeof part === "string" ? part : "<ref>")).join("");
      return Object.fromEntries((JSON.parse(joined) as Array<{ name: string; value: string }>).map((variable) => [variable.name, variable.value]));
    };
    for (const stage of pipeline.Stages.filter((candidate) => candidate.Name === "Beta" || candidate.Name === "Production")) {
      for (const action of stage.Actions) {
        const variables = variablesOf(action);
        if (action.Configuration.PrimarySource === "CloudSource") expect(variables.CODE_RELEASE, `${stage.Name} ${action.Name}`).toBe("#{variables.CODE_RELEASE}");
        else if (variables.CODE_RELEASE !== undefined) expect(variables.CODE_RELEASE, `${stage.Name} ${action.Name}`).toBe(`#{${stage.Name}Preflight.CODE_RELEASE_EFFECTIVE}`);
      }
    }
  });

  it("a Code build still accepts run and skip only: from-trigger would stop it at its first command, never be read as run", () => {
    expect(CODE_RELEASE_CHECK).toBe('case "$CODE_RELEASE" in run|skip) ;; *) echo "CODE_RELEASE must be run or skip, got: $CODE_RELEASE" >&2; exit 1;; esac');
    const dir = scratch();
    for (const [value, status] of [["run", 0], ["skip", 0], ["from-trigger", 1], ["", 1], ["Run", 1]] as const) {
      expect(runShell(dir, [CODE_RELEASE_CHECK], { CODE_RELEASE: value }).status, value).toBe(status);
    }
  });

  it("the approval says what from-trigger means and where to read what happened, and stays under CodePipeline's 1000 characters", () => {
    const approval = Object.values(json.Resources).find((resource) => resource.Type === "AWS::CodePipeline::Pipeline")!;
    const action = (approval.Properties.Stages as Array<{ Actions: Array<{ Name: string; Configuration: { CustomData: string } }> }>).flatMap((stage) => stage.Actions).find((candidate) => candidate.Name === "ApproveProduction")!;
    const body = text(action.Configuration.CustomData);
    expect(body).toContain("#{variables.CODE_RELEASE} (from-trigger: a Cloud tag run releases Cloud only, a Code push releases Code)");
    expect(body).toContain("whether Code was released or skipped, are in Beta's Preflight log");
    expect(body.length).toBeLessThanOrEqual(1000);
  });
});

describe("Beta's Code Preflight may read this pipeline's executions (read-only), Production's may not", () => {
  const rolePolicy = (projectName: string): Statement[] => {
    const project = Object.values(json.Resources).find((resource) => resource.Type === "AWS::CodeBuild::Project" && resource.Properties.Name === projectName)!;
    const roleRef = (project.Properties.ServiceRole as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"][0];
    return Object.values(json.Resources)
      .filter((resource) => resource.Type === "AWS::IAM::Policy" && JSON.stringify(resource.Properties.Roles).includes(roleRef))
      .flatMap((resource) => (resource.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
  };
  const actionsOf = (statements: Statement[]): string[] => statements.filter((statement) => statement.Effect === "Allow").flatMap((statement) => (Array.isArray(statement.Action) ? statement.Action : [statement.Action]));

  it("Beta's Preflight holds ListActionExecutions beside the two reads it had, on this pipeline only", () => {
    const statements = rolePolicy(AGENTX_BETA_CODE_PREFLIGHT_PROJECT_NAME);
    const waiting = statements.find((statement) => JSON.stringify(statement).includes("ReadWaitingRun")) ?? statements.find((statement) => actionsOf([statement]).includes("codepipeline:GetPipelineState"))!;
    expect([waiting.Action].flat().sort()).toEqual(["codepipeline:GetPipelineExecution", "codepipeline:GetPipelineState", "codepipeline:ListActionExecutions"]);
    expect(text(waiting.Resource)).toContain("AgentXProductionRelease");
    expect(text(waiting.Resource)).not.toContain("*");
    expect(actionsOf(statements).filter((action) => action.startsWith("codepipeline:")).sort()).toEqual(["codepipeline:GetPipelineExecution", "codepipeline:GetPipelineState", "codepipeline:ListActionExecutions"]);
  });
  it("Production's Preflight still holds only the transition close; it reads no execution", () => {
    expect(actionsOf(rolePolicy(AGENTX_PRODUCTION_CODE_PREFLIGHT_PROJECT_NAME)).filter((action) => action.startsWith("codepipeline:"))).toEqual(["codepipeline:DisableStageTransition"]);
  });
});

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const UUID = "0a1b2c3d-1111-2222-3333-44445555666a";
const source = (action: string, sha: string, tag: string): string => `${action}\\t${sha}\\t${tag}`;
const sources = (...lines: string[]): string => lines.join("\\n");


/**
 * Real-shaped records of the two kinds of run, verified read-only against the live pipeline (2026-11-25): a Cloud tag run (execution cb7408c0: triggerType WebhookV2, trigger detail type PUSH_TAG
 * with the tag name, the CloudGitHub source's output variables carry TagName "v0.13.24" exactly, the GitHub (Code) source has NO TagName) and a Code push run (execution cb39c169: WebhookV2,
 * PUSH_BRANCH on the mainline, no TagName on either source). The field names and nesting are the API's (GetPipelineExecution, ListActionExecutions); the commit ids are made up. The fake `aws` cannot run
 * a JMESPath, so `answersOf` applies the same projection as the Preflight's --query (Source stage, Succeeded, [actionName, CommitId, TagName]; a missing key prints None, as `--output text` does)
 * to the record, and the real shell then reads that text.
 */
const COMMIT_CODE = "a".repeat(40);
const COMMIT_CLOUD = "c".repeat(40);
const sourceAction = (actionName: string, outputVariables: Record<string, string>, over: Record<string, unknown> = {}) => ({
  actionName, stageName: "Source", status: "Succeeded", output: { outputArtifacts: [], executionResult: { externalExecutionId: "fixture" }, outputVariables }, ...over,
});
const TAG_RUN_RECORD = {
  execution: { pipelineExecution: { trigger: { triggerType: "WebhookV2", triggerDetail: JSON.stringify({ type: "PUSH_TAG", tagName: "v0.13.24" }) } } },
  details: { actionExecutionDetails: [
    sourceAction("GitHub", { CommitId: COMMIT_CODE, BranchName: "mainline" }),
    sourceAction("CloudGitHub", { CommitId: COMMIT_CLOUD, TagName: "v0.13.24" }),
    { actionName: "CodePreflight", stageName: "Beta", status: "Succeeded", output: { outputVariables: {} } },
  ] },
};
const PUSH_RUN_RECORD = {
  execution: { pipelineExecution: { trigger: { triggerType: "WebhookV2", triggerDetail: JSON.stringify({ type: "PUSH_BRANCH", branchName: "mainline" }) } } },
  details: { actionExecutionDetails: [
    sourceAction("GitHub", { CommitId: COMMIT_CODE, BranchName: "mainline" }),
    sourceAction("CloudGitHub", { CommitId: COMMIT_CLOUD, BranchName: "cloud-next" }),
  ] },
};
const answersOf = (record: typeof TAG_RUN_RECORD): Record<string, string> => {
  const lines = record.details.actionExecutionDetails
    .filter((a) => a.stageName === "Source" && a.status === "Succeeded")
    .map((a) => { const v = a.output.outputVariables as Record<string, string | undefined>; return source(a.actionName, v.CommitId ?? "None", v.TagName ?? "None"); });
  return { FAKE_TRIGGER_TYPE: record.execution.pipelineExecution.trigger.triggerType, FAKE_SOURCES: sources(...lines) };
};

describe("which source started the run (Beta's Code Preflight, real shell, fake aws)", () => {
  const run = (env: Record<string, string>, options: { closesGate?: boolean } = {}) => {
    const dir = scratch();
    const repo = join(dir, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "mainline");
    commitFile(repo, "scripts/port-guard-pipeline.ts", "// guard\n", "released");
    const released = git(repo, "rev-parse", "HEAD");
    const log = join(dir, "log");
    const bin = fakeBin(dir, log, ["node", "aws"]);
    const result = runShell(repo, [...preflightBuild(join(dir, "trusted"), options.closesGate ?? false), 'echo "CTX=$CODE_CTX"'], { PATH: `${bin}:${process.env.PATH}`, PORT_GUARD_NAMES_PARAMETER: "/test/names", FAKE_RELEASED_SHA: released, ...env });
    const ctx = /^CTX=(.*)$/mu.exec(result.stdout)?.[1] ?? "";
    return { result, ctx, trigger: /,trigger:([^,]*)$/u.exec(ctx)?.[1] ?? null, log: existsSync(log) ? readFileSync(log, "utf8") : "" };
  };
  const base = { EXEC_ID: UUID };
  const TAG = { FAKE_TRIGGER_TYPE: "WebhookV2", FAKE_SOURCES: sources(source("GitHub", SHA_A, "None"), source("CloudGitHub", SHA_B, "v0.13.9")) };
  const PUSH = { FAKE_TRIGGER_TYPE: "WebhookV2", FAKE_SOURCES: sources(source("GitHub", SHA_A, "None"), source("CloudGitHub", SHA_B, "None")) };

  it("a Cloud release tag push: cloud-tag@<tag>", () => {
    const outcome = run({ ...base, ...TAG });
    expect(outcome.result.status, outcome.result.stderr).toBe(0);
    expect(outcome.trigger).toBe(`${CODE_TRIGGER_KINDS.cloudTag}@v0.13.9`);
    expect(outcome.result.stdout).toContain("NOTE: this run was started by: cloud-tag@v0.13.9 (trigger type WebhookV2)");
  });
  it("a Code mainline push: code-push", () => {
    expect(run({ ...base, ...PUSH }).trigger).toBe("code-push");
  });
  it("the real shape of a Cloud tag run (v0.13.24, verified live) reads cloud-tag, the real shape of a Code push run reads code-push", () => {
    expect(run({ ...base, ...answersOf(TAG_RUN_RECORD) }).trigger).toBe("cloud-tag@v0.13.24");
    expect(run({ ...base, ...answersOf(PUSH_RUN_RECORD) }).trigger).toBe("code-push");
  });
  it("a run started by hand: manual", () => {
    expect(run({ ...base, FAKE_TRIGGER_TYPE: "StartPipelineExecution", FAKE_SOURCES: PUSH.FAKE_SOURCES }).trigger).toBe("manual");
  });
  it("asks the execution's own record, with this pipeline's name and this run's id, and reads nothing it can write", () => {
    const { log } = run({ ...base, ...TAG });
    expect(log).toContain(`aws codepipeline get-pipeline-execution --pipeline-name AgentXProductionRelease --pipeline-execution-id ${UUID} --query pipelineExecution.trigger.triggerType --output text`);
    expect(log).toContain(`aws codepipeline list-action-executions --pipeline-name AgentXProductionRelease --filter pipelineExecutionId=${UUID} --query actionExecutionDetails[?stageName=='Source' && status=='Succeeded'].[actionName,output.outputVariables.CommitId,output.outputVariables.TagName] --output text`);
    expect(log.split("\n").filter((line) => line.startsWith("aws codepipeline")).every((line) => /^aws codepipeline (get-pipeline-state|get-pipeline-execution|list-action-executions) /u.test(line))).toBe(true);
  });

  it("is unknown, never a guess, whenever the lookup does not prove one of the three", () => {
    const cases: Array<[string, Record<string, string>]> = [
      ["both sources carry a tag", { FAKE_TRIGGER_TYPE: "WebhookV2", FAKE_SOURCES: sources(source("GitHub", SHA_A, "v0.13.8"), source("CloudGitHub", SHA_B, "v0.13.9")) }],
      ["only the Code source has a tag", { FAKE_TRIGGER_TYPE: "WebhookV2", FAKE_SOURCES: sources(source("GitHub", SHA_A, "v0.13.8"), source("CloudGitHub", SHA_B, "None")) }],
      ["the tag is not a release tag", { FAKE_TRIGGER_TYPE: "WebhookV2", FAKE_SOURCES: sources(source("GitHub", SHA_A, "None"), source("CloudGitHub", SHA_B, "v0.13.9-rc1")) }],
      ["the tag has extra text", { FAKE_TRIGGER_TYPE: "WebhookV2", FAKE_SOURCES: sources(source("GitHub", SHA_A, "None"), source("CloudGitHub", SHA_B, "v0.13.9x")) }],
      ["the Code source is missing", { FAKE_TRIGGER_TYPE: "WebhookV2", FAKE_SOURCES: sources(source("CloudGitHub", SHA_B, "None")) }],
      ["the Cloud source is missing", { FAKE_TRIGGER_TYPE: "WebhookV2", FAKE_SOURCES: sources(source("GitHub", SHA_A, "None")) }],
      ["no source at all", { FAKE_TRIGGER_TYPE: "WebhookV2", FAKE_SOURCES: "" }],
      ["a source answered twice", { FAKE_TRIGGER_TYPE: "WebhookV2", FAKE_SOURCES: sources(source("GitHub", SHA_A, "None"), source("CloudGitHub", SHA_B, "None"), source("CloudGitHub", SHA_B, "v0.13.9")) }],
      ["a commit that is not a sha", { FAKE_TRIGGER_TYPE: "WebhookV2", FAKE_SOURCES: sources(source("GitHub", "None", "None"), source("CloudGitHub", SHA_B, "v0.13.9")) }],
      ["another trigger type", { FAKE_TRIGGER_TYPE: "ManualRollback", FAKE_SOURCES: PUSH.FAKE_SOURCES }],
      ["a trigger type that could not be read", { FAKE_TRIGGER_TYPE: "None", FAKE_SOURCES: PUSH.FAKE_SOURCES }],
      ["both lookups failed", { FAKE_CODEPIPELINE_FAIL: "1" }],
      ["the sources lookup failed", { ...PUSH, FAKE_SOURCES_FAIL: "1" }],
    ];
    for (const [label, env] of cases) {
      const outcome = run({ ...base, ...env });
      expect(outcome.result.status, `${label}: ${outcome.result.stderr}`).toBe(0);
      expect(outcome.trigger, label).toBe("unknown");
    }
  });
  it("is unknown, with no call, when the execution id is missing or is not an id", () => {
    for (const id of ["", "not-an-id", `${UUID}; echo pwned`]) {
      const outcome = run({ ...TAG, EXEC_ID: id });
      expect(outcome.trigger, id).toBe("unknown");
      expect(outcome.log, id).not.toContain("list-action-executions");
      expect(outcome.log, id).not.toContain("get-pipeline-execution --pipeline-name AgentXProductionRelease --pipeline-execution-id ");
    }
  });

  it("the value is one quote-free part of CODE_CTX, after the four that were there", () => {
    const outcome = run({ ...base, ...TAG });
    expect(outcome.ctx).toMatch(/^live:[0-9a-f]{40},target:none,supersedes:none,supersedesSha:none,trigger:cloud-tag@v0\.13\.9$/u);
    expect(outcome.ctx).not.toMatch(/["'\\\s{}]/u);
  });
  it("Production's Preflight does not look and its CODE_CTX has no trigger part (it joins the run Beta decided)", () => {
    const outcome = run({ ...base, ...TAG }, { closesGate: true });
    expect(outcome.result.status, outcome.result.stderr).toBe(0);
    expect(outcome.log).not.toContain("codepipeline");
    expect(outcome.ctx).toMatch(/^live:[0-9a-f]{40},target:none,supersedes:none,supersedesSha:none$/u);
    expect(triggerCommands(false)).toEqual([]);
  });
  it("never stops the release on its own: the build goes on to export CODE_CTX whatever the lookup said", () => {
    const outcome = run({ ...base, FAKE_CODEPIPELINE_FAIL: "1" });
    expect(outcome.result.status, outcome.result.stderr).toBe(0);
    expect(outcome.ctx).toMatch(/,trigger:unknown$/u);
  });
});

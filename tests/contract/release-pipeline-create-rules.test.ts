// CodePipeline checks a pipeline's structure when CreatePipeline / UpdatePipeline runs, which a synthesized template and `cdk diff` never do: a deploy that breaks one of these
// rules fails only at the CloudFormation resource, after the whole stack update has started (the first redeploy of the release pipeline with a namespace equal to the output
// artifact "CloudSource" was refused: "One or more of the chosen namespaces matches the name of an output artifact"). One test per rule, on the synthesized template of both
// release pipelines, with the rule's source:
//   Quotas:                 https://docs.aws.amazon.com/codepipeline/latest/userguide/limits.html
//   Variables reference:    https://docs.aws.amazon.com/codepipeline/latest/userguide/reference-variables.html
//   Pipeline structure:     https://docs.aws.amazon.com/codepipeline/latest/userguide/reference-pipeline-structure.html
// No AWS, no real account. (The 1000-character limit of an action configuration value is pinned in release-pipeline-l9b-config-length-review.test.ts.)
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { EnvironmentReleasePipelineStack } from "../../infra/lib/environment-release-pipeline.js";
import {
  AGENTX_RELEASE_PIPELINE_NAME, ARTIFACT_KEY_NAME_CHARS, ARTIFACT_KEY_PIPELINE_CHARS, CLOUD_SOURCE_NAMESPACE, CODE_SOURCE_NAMESPACE, ReleasePipelineStack, artifactKeyPattern,
} from "../../infra/lib/release-pipeline.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

interface PipelineAction {
  Name: string;
  RunOrder?: number;
  Namespace?: string;
  ActionTypeId: { Category: string };
  Configuration?: Record<string, unknown>;
  InputArtifacts?: Array<{ Name: string }>;
  OutputArtifacts?: Array<{ Name: string }>;
}
interface PipelineVariable { Name: string; DefaultValue?: string; Description?: string }
interface Trigger { ProviderType: string; GitConfiguration: { SourceActionName: string; Push?: Array<Record<string, { Includes?: string[]; Excludes?: string[] }>>; PullRequest?: unknown[] } }
interface PipelineProperties {
  Name?: string;
  PipelineType?: string;
  ExecutionMode?: string;
  Stages: Array<{ Name: string; Actions: PipelineAction[] }>;
  Variables?: PipelineVariable[];
  Triggers?: Trigger[];
}

const pipelineOf = (template: Template): PipelineProperties =>
  (Object.values(template.findResources("AWS::CodePipeline::Pipeline"))[0] as { Properties: PipelineProperties }).Properties;

const pipelines: Record<string, PipelineProperties> = {
  "release pipeline": pipelineOf(Template.fromStack(new ReleasePipelineStack(new App(), "CreateRulesReleasePipeline", { env: { region: "us-east-1" } }))),
  "environment release pipeline": pipelineOf(Template.fromStack(new EnvironmentReleasePipelineStack(new App(), "CreateRulesEnvironmentPipeline", {
    environment: "staging", region: "us-west-2", repository: { owner: "ExampleOrg", name: "example-repo", branch: "code/next" },
  }))),
};

const NAME_CHARS = /^[A-Za-z0-9.@_-]{1,100}$/u; // pipeline, stage, action
const ARTIFACT_CHARS = /^[A-Za-z0-9_-]{1,100}$/u;
const NAMESPACE_CHARS = /^[A-Za-z0-9^@_[\]*$-]+$/u;
const VARIABLE_CHARS = /^[A-Za-z0-9@_-]{1,128}$/u;
const RESERVED_NAMESPACES = ["codepipeline", "variables"];

/** Every action with its position: stage index and run order. */
const flatten = (p: PipelineProperties) => p.Stages.flatMap((stage, stageIndex) => stage.Actions.map((action) => ({ stage: stage.Name, stageIndex, runOrder: action.RunOrder ?? 1, action })));
/** Everything in an action's configuration as one string, whatever intrinsic wraps it (the CDK renders a list with a Ref as a Fn::Join). */
const configText = (action: PipelineAction): string => JSON.stringify(action.Configuration ?? {});
const REFERENCE = /#\{([^.}]+)\.([^}]+)\}/gu;
const artifactNames = (p: PipelineProperties): string[] => flatten(p).flatMap(({ action }) => [...(action.InputArtifacts ?? []), ...(action.OutputArtifacts ?? [])].map((a) => a.Name));

describe.each(Object.entries(pipelines))("CodePipeline create-time rules: %s", (_label, pipeline) => {
  const all = flatten(pipeline);

  it("namespaces: no action's namespace equals any artifact name, and none is a reserved namespace (\"Namespaces must be unique across the pipeline definition and cannot conflict with any artifact names\")", () => {
    const namespaces = all.flatMap(({ action }) => (action.Namespace === undefined ? [] : [action.Namespace]));
    expect(namespaces.length).toBeGreaterThan(0);
    const artifacts = new Set(artifactNames(pipeline));
    expect(namespaces.filter((namespace) => artifacts.has(namespace))).toEqual([]);
    expect(namespaces.filter((namespace) => RESERVED_NAMESPACES.includes(namespace))).toEqual([]);
    // Also case-insensitively: a different spelling of an artifact name is still one to read (and the console shows both).
    expect(namespaces.filter((namespace) => [...artifacts].some((artifact) => artifact.toLowerCase() === namespace.toLowerCase()))).toEqual([]);
  });

  it("namespaces: unique across the whole pipeline definition (every stage), and the allowed characters only", () => {
    const namespaces = all.flatMap(({ action }) => (action.Namespace === undefined ? [] : [action.Namespace]));
    expect(namespaces.filter((namespace, index) => namespaces.indexOf(namespace) !== index)).toEqual([]);
    expect(new Set(namespaces.map((namespace) => namespace.toLowerCase())).size).toBe(namespaces.length); // namespaces are case sensitive; distinct spellings still read as typos
    expect(namespaces.filter((namespace) => !NAMESPACE_CHARS.test(namespace))).toEqual([]);
  });

  it("action names: unique within a stage (\"Action names must be unique within a stage\"), and stage names unique within the pipeline", () => {
    const stages = pipeline.Stages.map((stage) => stage.Name);
    expect(stages.filter((name, index) => stages.indexOf(name) !== index)).toEqual([]);
    for (const stage of pipeline.Stages) {
      const names = stage.Actions.map((action) => action.Name);
      expect(names.filter((name, index) => names.indexOf(name) !== index), stage.Name).toEqual([]);
    }
  });

  it("artifacts: every output artifact name is produced by exactly one action (an artifact name is unique per pipeline as an output)", () => {
    const outputs = all.flatMap(({ action }) => (action.OutputArtifacts ?? []).map((artifact) => artifact.Name));
    expect(outputs.length).toBeGreaterThan(0);
    expect(outputs.filter((name, index) => outputs.indexOf(name) !== index)).toEqual([]);
  });

  it("names: pipeline, stage and action names use the allowed characters and at most 100 characters; artifact names letters, digits, - and _ (at most 100)", () => {
    const name = pipeline.Name;
    if (name !== undefined) expect(NAME_CHARS.test(name), `pipeline ${name}`).toBe(true);
    expect(pipeline.Stages.map((stage) => stage.Name).filter((stageName) => !NAME_CHARS.test(stageName))).toEqual([]);
    expect(all.map(({ action }) => action.Name).filter((actionName) => !NAME_CHARS.test(actionName))).toEqual([]);
    expect(artifactNames(pipeline).filter((artifact) => !ARTIFACT_CHARS.test(artifact))).toEqual([]);
  });

  it("sizes: 2 to 50 stages, 1 to 50 actions in a stage, at most 1000 actions, action configuration keys of at most 50 characters", () => {
    expect(pipeline.Stages.length).toBeGreaterThanOrEqual(2);
    expect(pipeline.Stages.length).toBeLessThanOrEqual(50);
    for (const stage of pipeline.Stages) {
      expect(stage.Actions.length, stage.Name).toBeGreaterThanOrEqual(1);
      expect(stage.Actions.length, stage.Name).toBeLessThanOrEqual(50);
    }
    expect(all.length).toBeLessThanOrEqual(1000);
    expect(all.flatMap(({ action }) => Object.keys(action.Configuration ?? {})).filter((key) => key.length > 50)).toEqual([]);
  });

  it("variable references: every #{Namespace.key} names an existing namespace of an action in an EARLIER stage or the same stage at a LOWER run order (never the action itself, the same run order, or a later one); #{variables.X} names a declared pipeline variable", () => {
    const declared = new Set((pipeline.Variables ?? []).map((variable) => variable.Name));
    const problems: string[] = [];
    let references = 0;
    for (const consumer of all) {
      for (const [, namespace, key] of configText(consumer.action).matchAll(REFERENCE)) {
        references += 1;
        const where = `${consumer.stage}/${consumer.action.Name} -> #{${namespace}.${key}}`;
        if (namespace === "codepipeline") {
          if (key !== "PipelineExecutionId") problems.push(`${where}: only PipelineExecutionId exists in codepipeline`);
        } else if (namespace === "variables") {
          if (!declared.has(key!)) problems.push(`${where}: no such pipeline variable`);
        } else {
          const producers = all.filter(({ action }) => action.Namespace === namespace);
          if (producers.length !== 1) problems.push(`${where}: ${producers.length} actions have this namespace`);
          else {
            const producer = producers[0]!;
            const earlier = producer.stageIndex < consumer.stageIndex || (producer.stageIndex === consumer.stageIndex && producer.runOrder < consumer.runOrder);
            if (!earlier) problems.push(`${where}: its action ${producer.stage}/${producer.action.Name} does not run before it`);
          }
        }
      }
    }
    expect(references).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });

  it("variable references: no source action reads a variable (pipeline-level variables are not supported in a Source action; its namespace exists only to be read downstream)", () => {
    for (const { stage, action } of all.filter(({ action }) => action.ActionTypeId.Category === "Source")) {
      expect([...configText(action).matchAll(REFERENCE)].map((match) => match[0]), `${stage}/${action.Name}`).toEqual([]);
    }
  });

  it("input artifacts: every input is produced by an action in an earlier stage or at a lower run order of the same stage", () => {
    const problems: string[] = [];
    for (const consumer of all) {
      for (const input of consumer.action.InputArtifacts ?? []) {
        const producers = all.filter(({ action }) => (action.OutputArtifacts ?? []).some((output) => output.Name === input.Name));
        const producer = producers[0];
        const where = `${consumer.stage}/${consumer.action.Name} reads ${input.Name}`;
        if (producer === undefined) problems.push(`${where}: no action produces it`);
        else if (!(producer.stageIndex < consumer.stageIndex || (producer.stageIndex === consumer.stageIndex && producer.runOrder < consumer.runOrder))) problems.push(`${where}: ${producer.stage}/${producer.action.Name} does not run before it`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("V2: a V2 pipeline with a valid execution mode, pipeline variables with allowed names (at most 128 characters, at most 50, unique), defaults of at most 1000 characters and descriptions of at most 200", () => {
    expect(pipeline.PipelineType).toBe("V2");
    expect(["QUEUED", "SUPERSEDED", "PARALLEL"]).toContain(pipeline.ExecutionMode ?? "SUPERSEDED");
    const variables = pipeline.Variables ?? [];
    expect(variables.length).toBeLessThanOrEqual(50);
    const names = variables.map((variable) => variable.Name);
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
    expect(names.filter((name) => !VARIABLE_CHARS.test(name))).toEqual([]);
    expect(variables.filter((variable) => (variable.DefaultValue ?? "").length > 1000)).toEqual([]);
    expect(variables.filter((variable) => (variable.Description ?? "").length > 200)).toEqual([]);
  });

  it("V2 triggers: each names an existing Source-category action of the first stage; at most 50 triggers, 3 filters per push trigger, 8 includes and 8 excludes of at most 255 characters per filter", () => {
    const triggers = pipeline.Triggers ?? [];
    expect(triggers.length).toBeLessThanOrEqual(50);
    const sourceActions = new Set(pipeline.Stages[0]!.Actions.filter((action) => action.ActionTypeId.Category === "Source").map((action) => action.Name));
    for (const trigger of triggers) {
      expect(sourceActions.has(trigger.GitConfiguration.SourceActionName), `trigger ${trigger.GitConfiguration.SourceActionName}`).toBe(true);
      for (const push of trigger.GitConfiguration.Push ?? []) {
        expect(Object.keys(push).length).toBeLessThanOrEqual(3);
        for (const filter of Object.values(push)) {
          for (const patterns of [filter.Includes ?? [], filter.Excludes ?? []]) {
            expect(patterns.length).toBeLessThanOrEqual(8);
            expect(patterns.filter((pattern) => pattern.length > 255)).toEqual([]);
          }
        }
      }
    }
  });
});

describe("CodePipeline create-time rules: the release pipeline's Cloud source", () => {
  const pipeline = pipelines["release pipeline"]!;
  const cloudSource = flatten(pipeline).find(({ action }) => action.Name === "CloudGitHub")!.action;
  const codeSource = flatten(pipeline).find(({ action }) => action.Name === "GitHub")!.action;

  it("the Cloud source keeps its OUTPUT ARTIFACT name CloudSource (the Cloud stack's S3 grants and PH-S3-PREFIXES name it) and its namespace is a different name; the Code source namespace is not an artifact either", () => {
    expect(cloudSource.OutputArtifacts).toEqual([{ Name: "CloudSource" }]);
    expect(cloudSource.Namespace).toBe(CLOUD_SOURCE_NAMESPACE);
    expect(CLOUD_SOURCE_NAMESPACE).toBe("CloudSourceVariables");
    expect(codeSource.Namespace).toBe(CODE_SOURCE_NAMESPACE);
    expect(codeSource.OutputArtifacts).toEqual([{ Name: "Source" }]);
  });

  it("artifact key layout: CloudSource is longer than the 10 characters of the key cut, so its grant pattern is `CloudSourc*`, which no other artifact of the pipeline matches", () => {
    expect(ARTIFACT_KEY_PIPELINE_CHARS).toBe(20);
    expect(ARTIFACT_KEY_NAME_CHARS).toBe(10);
    expect(artifactKeyPattern("arn:aws:s3:::b", "CloudSource")).toBe(`arn:aws:s3:::b/${AGENTX_RELEASE_PIPELINE_NAME.slice(0, 20)}*/CloudSourc*`);
    const others = [...new Set(artifactNames(pipeline))].filter((name) => name !== "CloudSource");
    expect(others.filter((name) => name.slice(0, ARTIFACT_KEY_NAME_CHARS).startsWith("CloudSourc"))).toEqual([]);
    // The cut of two different artifacts may be equal (the Cloud states share folders by design, and that is safe); none of those shared cuts is CloudSource's.
    expect(others.filter((name) => name.slice(0, ARTIFACT_KEY_NAME_CHARS) === "CloudSource".slice(0, ARTIFACT_KEY_NAME_CHARS))).toEqual([]);
  });
});

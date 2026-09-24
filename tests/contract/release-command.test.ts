import { existsSync, readFileSync, statSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  AGENTX_PRODUCTION_WORKER_REPOSITORY,
  AGENTX_RELEASE_TRIGGER_PATHS,
} from "../../infra/lib/release-pipeline.js";
import { AGENTX_SLACK_ORCHESTRATOR_REPOSITORY } from "../../infra/lib/slack-orchestrator.js";
import {
  assertDigestImage,
  parseReleaseArgs,
  releaseTag,
  runtimeIdFromArn,
  type Runner,
} from "../../scripts/release-demo.js";
import {
  SLACK_ORCHESTRATOR_IMAGE_INPUTS,
  SLACK_ORCHESTRATOR_REPOSITORY,
  WORKER_IMAGE_INPUTS,
  capacityProviderIdFromArn,
  parseProductionReleaseArgs,
  releaseRevisionFromTags,
  reusableWorkerImage,
} from "../../scripts/release-production.js";

function dockerfileSources(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("COPY ") && !line.includes("--from="))
    .flatMap((line) => line.trim().split(/\s+/).slice(1, -1));
}

describe("demo release command", () => {
  it("parses safe defaults and explicit deployment options", () => {
    expect(parseReleaseArgs([], {})).toEqual({
      region: "us-east-1",
      repository: "agentx-worker-demo",
      allowDirty: false,
      skipChecks: false,
      dryRun: false,
    });
    expect(parseReleaseArgs([
      "--region", "us-west-2",
      "--profile", "deployer",
      "--repository", "worker",
      "--allow-dirty",
      "--skip-checks",
    ], {})).toMatchObject({
      region: "us-west-2",
      profile: "deployer",
      repository: "worker",
      allowDirty: true,
      skipChecks: true,
    });
    expect(() => parseReleaseArgs(["--region"], {})).toThrow(/requires a value/);
    expect(() => parseReleaseArgs(["--surprise"], {})).toThrow(/unknown option/);
  });

  it("creates immutable release tags and validates digest-scoped images", () => {
    expect(releaseTag(new Date("2026-09-23T17:50:35.123Z"), "4f885bb4a8eaffff"))
      .toBe("release-20260923T175035Z-4f885bb4a8ea");
    const repository = "944937319445.dkr.ecr.us-east-1.amazonaws.com/agentx-worker-demo";
    const image = `${repository}@sha256:${"a".repeat(64)}`;
    expect(() => assertDigestImage(image, repository)).not.toThrow();
    expect(() => assertDigestImage(`${repository}:latest`, repository)).toThrow(/immutable/);
    expect(() => assertDigestImage(image, `${repository}-other`)).toThrow(/belong/);
  });

  it("extracts the runtime ID and rejects malformed ARNs", () => {
    expect(runtimeIdFromArn(
      "arn:aws:bedrock-agentcore:us-east-1:944937319445:runtime/agentx_demo_worker-E4dYCR6f45",
    )).toBe("agentx_demo_worker-E4dYCR6f45");
    expect(() => runtimeIdFromArn("not-an-arn")).toThrow(/invalid/);
  });

  it("bounds ECR growth for untagged, release, and legacy image tags", () => {
    const policy = JSON.parse(readFileSync("infra/ecr-lifecycle-policy.json", "utf8")) as {
      rules: Array<{ selection: { tagStatus: string; tagPrefixList?: string[]; countNumber: number } }>;
    };
    expect(policy.rules).toHaveLength(4);
    expect(policy.rules[0]?.selection).toMatchObject({ tagStatus: "untagged", countNumber: 7 });
    expect(policy.rules[1]?.selection).toMatchObject({
      tagStatus: "tagged",
      tagPrefixList: ["release-"],
      countNumber: 20,
    });
    expect(policy.rules.slice(2).map((rule) => rule.selection.tagPrefixList?.[0]))
      .toEqual(["demo-", "pr-create-"]);
  });
});

describe("production release command", () => {
  it("defaults to a distinct production ECR repository", () => {
    expect(parseProductionReleaseArgs([], {})).toMatchObject({
      region: "us-east-1",
      repository: "agentx-worker-production",
      dryRun: false,
    });
    expect(parseProductionReleaseArgs(["--repository", "custom"], {})).toMatchObject({
      repository: "custom",
    });
  });

  it("extracts a capacity provider ID and rejects malformed ARNs", () => {
    expect(capacityProviderIdFromArn(
      "arn:aws:bedrock-agentcore:us-east-1:944937319445:capacity-provider/agentx_production_capacity-1234567890",
    )).toBe("agentx_production_capacity-1234567890");
    expect(() => capacityProviderIdFromArn("not-an-arn")).toThrow(/invalid/i);
  });

  it("accepts pipeline-only flags that the demo release rejects", () => {
    expect(parseProductionReleaseArgs([], {})).toMatchObject({
      repository: AGENTX_PRODUCTION_WORKER_REPOSITORY,
      reuseUnchangedWorker: false,
      requireExistingFoundation: false,
    });
    expect(parseProductionReleaseArgs(
      ["--reuse-unchanged-worker", "--require-existing-foundation"],
      {},
    )).toMatchObject({ reuseUnchangedWorker: true, requireExistingFoundation: true });
    expect(() => parseReleaseArgs(["--reuse-unchanged-worker"], {})).toThrow(/unknown option/);
  });

  it("reads the source commit only from release tags", () => {
    const tag = releaseTag(new Date("2026-09-23T18:49:17Z"), "8dfd5856e382aaaa");
    expect(releaseRevisionFromTags([tag])).toBe("8dfd5856e382");
    expect(releaseRevisionFromTags(["demo-20260923", tag])).toBe("8dfd5856e382");
    expect(releaseRevisionFromTags(["demo-20260923", "latest"])).toBeUndefined();
    expect(releaseRevisionFromTags(["release-latest-8dfd5856e382"])).toBeUndefined();
  });
});

describe("worker image reuse", () => {
  const repositoryUri = "944937319445.dkr.ecr.us-east-1.amazonaws.com/agentx-worker-production";
  const deployedImage = `${repositoryUri}@sha256:${"b".repeat(64)}`;
  const options = parseProductionReleaseArgs(["--reuse-unchanged-worker"], {});
  let stdout: MockInstance<typeof process.stdout.write>;

  beforeEach(() => {
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => stdout.mockRestore());

  function fakeRunner(state: {
    runtimeStack?: boolean;
    workerImageUri?: string;
    describeImagesStatus?: number;
    tags?: string[] | null;
    commitExists?: boolean;
    diffStatus?: number;
  } = {}) {
    const calls: string[][] = [];
    const result = (status: number, stdoutText = "", stderr = "") => ({ status, stdout: stdoutText, stderr });
    const runner = {
      aws(args: readonly string[]) {
        calls.push(["aws", ...args]);
        if (args[0] === "cloudformation" && !args.includes("--query")) {
          return state.runtimeStack === false
            ? result(254, "", "Stack with id AgentXProductionRuntime does not exist")
            : result(0);
        }
        if (args[0] === "cloudformation") {
          return result(0, JSON.stringify({
            Parameters: [{ ParameterKey: "WorkerImageUri", ParameterValue: state.workerImageUri ?? deployedImage }],
          }));
        }
        if (args[0] === "ecr") {
          const tags = state.tags === undefined ? ["release-20260923T184917Z-8dfd5856e382"] : state.tags;
          return result(state.describeImagesStatus ?? 0, JSON.stringify(tags));
        }
        throw new Error(`unexpected aws ${args.join(" ")}`);
      },
      capture(command: string, args: readonly string[]) {
        calls.push([command, ...args]);
        if (command === "git" && args[0] === "cat-file") return result(state.commitExists === false ? 128 : 0);
        if (command === "git" && args[0] === "diff") return result(state.diffStatus ?? 0);
        throw new Error(`unexpected ${command} ${args.join(" ")}`);
      },
    };
    return { runner: runner as unknown as Runner, calls };
  }

  const output = () => stdout.mock.calls.map((call) => String(call[0])).join("");

  it("reuses the deployed digest when no worker image input changed since its commit", () => {
    const { runner, calls } = fakeRunner();
    expect(reusableWorkerImage(runner, options, repositoryUri)).toBe(deployedImage);
    expect(calls).toContainEqual([
      "git", "diff", "--quiet", "8dfd5856e382", "HEAD", "--", ...WORKER_IMAGE_INPUTS,
    ]);
    expect(output()).toMatch(/Reusing deployed worker image/);
  });

  it.each([
    ["worker inputs changed", { diffStatus: 1 }, /changed since 8dfd5856e382/],
    ["git cannot compare the commits", { diffStatus: 128 }, /could not compare/],
    ["the commit is missing from the checkout", { commitExists: false }, /not in this checkout's history/],
    ["the image has no release tag", { tags: ["demo-20260923"] }, /no release-<time>-<commit> tag/],
    ["the image has no tags", { tags: null }, /no release-<time>-<commit> tag/],
    ["ECR cannot describe the image", { describeImagesStatus: 254 }, /ECR could not describe/],
    ["the image is from another repository", { workerImageUri: `${repositoryUri}-other@sha256:${"b".repeat(64)}` }, /is not in/],
    ["the runtime stack is missing", { runtimeStack: false }, /is not deployed/],
  ])("builds a new image when %s", (_name, state, reason) => {
    const { runner } = fakeRunner(state);
    expect(reusableWorkerImage(runner, options, repositoryUri)).toBeUndefined();
    expect(output()).toMatch(reason);
  });

  it("treats every file the worker Dockerfile copies as a worker image input", () => {
    const sources = dockerfileSources("environments/base/Dockerfile");
    expect(sources.length).toBeGreaterThan(0);
    const covered = (path: string) =>
      WORKER_IMAGE_INPUTS.some((input) => path === input || path.startsWith(`${input}/`));
    expect(sources.filter((source) => !covered(source))).toEqual([]);
    expect(WORKER_IMAGE_INPUTS).toContain("environments/base/Dockerfile");
    expect(WORKER_IMAGE_INPUTS).toContain(".dockerignore");
    expect(WORKER_IMAGE_INPUTS.filter((input) => !existsSync(input))).toEqual([]);
  });
});

describe("release ordering", () => {
  // WorkerInvocationSchema parses the task payload strictly, so a broker that sends a field the
  // running worker image predates rejects every invocation. The runtime must reach the new image
  // before the control plane starts sending the new shape.
  it("updates the production runtime before the control plane", () => {
    const source = readFileSync("scripts/release-production.ts", "utf8");
    const runtimeDeploy = source.indexOf("\n    RUNTIME_STACK,\n");
    const controlPlaneDeploy = source.indexOf("\n  deployControlPlane(runner, options);\n");
    expect(runtimeDeploy).toBeGreaterThan(-1);
    expect(controlPlaneDeploy).toBeGreaterThan(-1);
    expect(runtimeDeploy).toBeLessThan(controlPlaneDeploy);
  });

  it("updates the demo runtime before the control plane once both stacks exist", () => {
    const source = readFileSync("scripts/release-demo.ts", "utf8");
    const update = source.indexOf("if (existingControlPlane && existingRuntime) {");
    expect(update).toBeGreaterThan(-1);
    const runtimeDeploy = source.indexOf("deployedRuntime = await deployRuntime(", update);
    const controlPlaneDeploy = source.indexOf("deployControlPlane(runner, options, true);", update);
    expect(runtimeDeploy).toBeGreaterThan(-1);
    expect(controlPlaneDeploy).toBeGreaterThan(-1);
    expect(runtimeDeploy).toBeLessThan(controlPlaneDeploy);
  });
});

describe("Slack orchestrator release", () => {
  it("treats every file the Slack orchestrator Dockerfile copies as one of its image inputs", () => {
    const sources = dockerfileSources("environments/slack/Dockerfile");
    expect(sources.length).toBeGreaterThan(0);
    const covered = (path: string) =>
      SLACK_ORCHESTRATOR_IMAGE_INPUTS.some((input) => path === input || path.startsWith(`${input}/`));
    expect(sources.filter((source) => !covered(source))).toEqual([]);
    expect(SLACK_ORCHESTRATOR_IMAGE_INPUTS).toContain("environments/slack/Dockerfile");
    expect(SLACK_ORCHESTRATOR_IMAGE_INPUTS).toContain(".dockerignore");
    expect(SLACK_ORCHESTRATOR_IMAGE_INPUTS.filter((input) => !existsSync(input))).toEqual([]);
  });

  it("creates the orchestrator stack only when asked, and pushes to the repository the pipeline may write", () => {
    expect(parseProductionReleaseArgs([], {}).createSlackOrchestrator).toBe(false);
    expect(parseProductionReleaseArgs(["--create-slack-orchestrator"], {}).createSlackOrchestrator).toBe(true);
    expect(() => parseReleaseArgs(["--create-slack-orchestrator"], {})).toThrow(/unknown option/);
    expect(SLACK_ORCHESTRATOR_REPOSITORY).toBe(AGENTX_SLACK_ORCHESTRATOR_REPOSITORY);
  });
});

describe("release pipeline trigger", () => {
  function globToRegExp(glob: string): RegExp {
    let pattern = "";
    let braceDepth = 0;
    for (let index = 0; index < glob.length; index += 1) {
      const char = glob[index]!;
      if (char === "*" && glob[index + 1] === "*") {
        pattern += ".*";
        index += 1;
      } else if (char === "*") pattern += "[^/]*";
      else if (char === "?") pattern += "[^/]";
      else if (char === "{") {
        pattern += "(?:";
        braceDepth += 1;
      } else if (char === "}") {
        pattern += ")";
        braceDepth -= 1;
      } else if (char === "," && braceDepth > 0) pattern += "|";
      else pattern += char.replace(/[.+^$()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${pattern}$`);
  }
  const triggers = AGENTX_RELEASE_TRIGGER_PATHS.map(globToRegExp);
  const triggered = (path: string) => triggers.some((pattern) => pattern.test(path));

  it("stays within CodePipeline's eight file-path patterns", () => {
    expect(AGENTX_RELEASE_TRIGGER_PATHS.length).toBeLessThanOrEqual(8);
  });

  it("starts the pipeline for every worker and Slack orchestrator image input and control-plane source", () => {
    const samples = [...WORKER_IMAGE_INPUTS, ...SLACK_ORCHESTRATOR_IMAGE_INPUTS].map((input) =>
      statSync(input).isDirectory() ? `${input}/src/index.ts` : input);
    expect(samples.filter((sample) => !triggered(sample))).toEqual([]);
    expect(triggered("packages/broker/src/aws/dispatcher.ts")).toBe(true);
    expect(triggered("infra/lib/control-plane.ts")).toBe(true);
    expect(triggered("packages/orchestrator/src/orchestrator.ts")).toBe(true);
    expect(triggered("packages/cli/src/main.ts")).toBe(true);
    expect(triggered("packages/slack-service/src/main.ts")).toBe(true);
    expect(triggered("environments/slack/Dockerfile")).toBe(true);
  });

  it("does not start the pipeline for paths that cannot change production", () => {
    const ignored = [
      "README.md",
      "docs/architecture-production.md",
      "specs/005-release-pipeline/spec.md",
      ".github/workflows/ci.yml",
      "examples/payments.yaml",
      "tests/contract/release-command.test.ts",
      "scripts/preflight.ts",
      "docs/package.json",
    ];
    expect(ignored.filter(triggered)).toEqual([]);
  });
});

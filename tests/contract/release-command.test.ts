import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  AGENTX_PRODUCTION_WORKER_REPOSITORY,
  AGENTX_RELEASE_TRIGGER_PATHS,
} from "../../infra/lib/release-pipeline.js";
import { AGENTX_SLACK_ORCHESTRATOR_REPOSITORY } from "../../infra/lib/slack-orchestrator.js";
import {
  RELEASE_TEST_ACCOUNT,
  Runner as ReleaseRunner,
  assertDigestImage,
  testEnvironment,
  parseReleaseArgs,
  releaseTag,
  runTests,
  type Runner,
} from "../../scripts/release-common.js";
import {
  SLACK_ORCHESTRATOR_IMAGE_INPUTS,
  SLACK_ORCHESTRATOR_REPOSITORY,
  WORKER_CAPABILITY_ROUTE_KEYS,
  WORKER_IMAGE_INPUTS,
  assertNoHandMadeCapabilityRoutes,
  parseProductionReleaseArgs,
  releaseProduction,
  releaseRevisionFromTags,
  reusableWorkerImage,
} from "../../scripts/release-production.js";

function dockerfileSources(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("COPY ") && !line.includes("--from="))
    .flatMap((line) => line.trim().split(/\s+/).slice(1, -1));
}

describe("shared release helpers", () => {
  it("parses safe defaults and explicit deployment options", () => {
    expect(parseReleaseArgs([], {})).toEqual({
      region: "us-east-1",
      repository: "agentx-worker-production",
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
    expect(() => parseReleaseArgs(["--region", "--profile"], {})).toThrow("--region requires a value");
    expect(() => parseReleaseArgs(["--surprise"], {})).toThrow(/unknown option/);
  });

  it("omits empty optional profile values and still rejects an empty worker image option", () => {
    expect(parseReleaseArgs([], { AWS_PROFILE: "" })).not.toHaveProperty("profile");
    expect(() => parseReleaseArgs(["--worker-image", ""], {})).toThrow("--worker-image requires a value");
  });

  it("creates immutable release tags and validates digest-scoped images", () => {
    expect(releaseTag(new Date("2026-09-23T17:50:35.123Z"), "4f885bb4a8eaffff"))
      .toBe("release-20260923T175035Z-4f885bb4a8ea");
    const repository = "944937319445.dkr.ecr.us-east-1.amazonaws.com/agentx-worker-production";
    const image = `${repository}@sha256:${"a".repeat(64)}`;
    expect(() => assertDigestImage(image, repository)).not.toThrow();
    expect(() => assertDigestImage(`${repository}:latest`, repository)).toThrow(/immutable/);
    expect(() => assertDigestImage(image, `${repository}-other`)).toThrow(/belong/);
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
    const controlPlaneDeploy = source.indexOf("\n  deployControlPlane(runner, options, foundation, firewallContext);\n");
    expect(runtimeDeploy).toBeGreaterThan(-1);
    expect(controlPlaneDeploy).toBeGreaterThan(-1);
    expect(runtimeDeploy).toBeLessThan(controlPlaneDeploy);
  });

  it("passes the control plane the foundation outputs its EC2 session lifecycle needs", () => {
    const source = readFileSync("scripts/release-production.ts", "utf8");
    expect(source).toContain("CONTROL_PLANE_FOUNDATION_PARAMETERS.flatMap((name) => [\"--parameters\", `${CONTROL_PLANE_STACK}:${name}=${stackOutput(foundation, name)}`])");
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
    // The aws-adapters and testing manifests are copied only so npm ci sees every workspace; the trigger list stays as the legacy template has it, and a
    // dependency change of that package always changes package-lock.json, which starts the pipeline.
    const notTriggered = new Set(["packages/aws-adapters/package.json", "packages/testing/package.json"]);
    const samples = [...WORKER_IMAGE_INPUTS, ...SLACK_ORCHESTRATOR_IMAGE_INPUTS].filter((input) => !notTriggered.has(input)).map((input) =>
      statSync(input).isDirectory() ? `${input}/src/index.ts` : input);
    expect(samples.filter((sample) => !triggered(sample))).toEqual([]);
    expect(triggered("package-lock.json")).toBe(true);
    expect(triggered("packages/aws-adapters/src/index.ts")).toBe(false);
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

describe("the release's test suite as root (CodeBuild)", () => {
  function recorder(options: { testsFail?: boolean } = {}) {
    const calls: unknown[][] = [];
    const runner = {
      run(command: string, args: readonly string[]) {
        calls.push([command, ...args]);
        return "";
      },
      runAs(account: { uid: number; gid: number; env: NodeJS.ProcessEnv }, command: string, args: readonly string[]) {
        calls.push(["as", account, command, ...args]);
        if (options.testsFail === true) throw new Error("npm exited with status 1");
      },
    };
    return { runner: runner as unknown as Runner, calls };
  }
  const { uid, gid, home } = RELEASE_TEST_ACCOUNT;

  it("runs the tests directly when the release is not root, the nightly-only ones too", () => {
    const { runner, calls } = recorder();
    runTests(runner, 501);
    expect(calls).toEqual([["npm", "test"], ["npm", "run", "test:nightly"]]);
  });

  it("runs them as nobody when it is root, and gives the checkout back to root", () => {
    const { runner, calls } = recorder();
    runTests(runner, 0);
    expect(calls.map((call) => (call[0] === "as" ? ["as", ...call.slice(2)] : call))).toEqual([
      ["mkdir", "-p", home],
      ["chown", "-R", `${String(uid)}:${String(gid)}`, process.cwd(), home],
      ["as", "npm", "test"],
      ["as", "npm", "run", "test:nightly"],
      ["chown", "-R", "0:0", process.cwd()],
    ]);
    for (const [index, command] of [[2, ["npm", "test"]], [3, ["npm", "run", "test:nightly"]]] as const) {
      const account = calls[index]![1] as { uid: number; gid: number; env: NodeJS.ProcessEnv };
      expect([account.uid, account.gid, account.env.HOME, calls[index]!.slice(2)]).toEqual([uid, gid, home, command]);
    }
  });

  it("still gives the checkout back to root when the tests fail", () => {
    const { runner, calls } = recorder({ testsFail: true });
    expect(() => runTests(runner, 0)).toThrow("npm exited with status 1");
    expect(calls.at(-1)).toEqual(["chown", "-R", "0:0", process.cwd()]);
  });
});

describe("the test account's environment (CodeBuild's, as an ordinary runner would have it)", () => {
  const environment = {
    PATH: "/root/.goenv/bin:/opt/node/bin:/usr/bin", HOME: "/root", LANG: "C.UTF-8", CODEBUILD_BUILD_ID: "b",
    npm_config_cache: "/root/.npm", npm_lifecycle_event: "release:prod", NPM_CONFIG_USERCONFIG: "/root/.npmrc",
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/x", AWS_REGION: "us-east-1", AWS_DEFAULT_REGION: "us-east-1",
  };
  const enterable = (directory: string) => !directory.startsWith("/root");

  it("leaves out npm's variables, which name root's cache and config, and every AWS variable", () => {
    const result = testEnvironment(environment, "/tmp/home", enterable);
    expect(Object.keys(result).filter((name) => /^(npm|aws)_/i.test(name))).toEqual([]);
    expect(result).toMatchObject({ LANG: "C.UTF-8", CODEBUILD_BUILD_ID: "b", HOME: "/tmp/home" });
  });

  it("keeps only the PATH directories the account can enter, in order", () => {
    expect(testEnvironment(environment, "/tmp/home", enterable).PATH).toBe("/opt/node/bin:/usr/bin");
  });

  it("by default keeps a directory only when it and every directory above it let others in", () => {
    // /tmp, which every account can enter (the per-user temporary directory may not be: macOS's sits under a 0700 one).
    const directory = mkdtempSync("/tmp/release-path-");
    try {
      const open = join(directory, "open"); const shut = join(directory, "shut");
      mkdirSync(open); mkdirSync(shut);
      chmodSync(directory, 0o755); chmodSync(open, 0o755); chmodSync(shut, 0o700);
      const path = testEnvironment({ PATH: `${open}:${shut}:${join(directory, "missing")}:relative` }, "/tmp/home").PATH;
      expect(path).toBe(open);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("a command run as another account", () => {
  it("gets exactly the environment it is given", () => {
    const directory = mkdtempSync(join(tmpdir(), "release-run-as-"));
    const file = join(directory, "env");
    const previous = process.env.npm_config_cache;
    process.env.npm_config_cache = "/root/.npm";
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      // The current account: changing to one's own uid and gid needs no privilege.
      new ReleaseRunner({} as never).runAs({ uid: process.getuid!(), gid: process.getgid!(), env: { HOME: directory, PATH: process.env.PATH } }, "sh", ["-c", `env > ${file}`]);
      const seen = readFileSync(file, "utf8");
      expect(seen).not.toMatch(/^npm_/im);
      expect(seen).toContain(`HOME=${directory}`);
    } finally {
      write.mockRestore();
      if (previous === undefined) delete process.env.npm_config_cache; else process.env.npm_config_cache = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("hand-made worker-capability route guard", () => {
  const CONTEXT = "GET /v1/internal/context-tools";
  const PACKET = "GET /v1/internal/design-review/packet";
  const options = { region: "us-east-1" } as const;
  type Resource = { LogicalResourceId: string; PhysicalResourceId: string; ResourceType: string; ResourceStatus?: string };
  const api: Resource = { LogicalResourceId: "HttpApi", PhysicalResourceId: "api111", ResourceType: "AWS::ApiGatewayV2::Api" };
  const route = (logical: string, id: string, status = "CREATE_COMPLETE"): Resource => ({ LogicalResourceId: logical, PhysicalResourceId: id, ResourceType: "AWS::ApiGatewayV2::Route", ResourceStatus: status });

  function fake(state: { stack?: boolean; pages?: Resource[][]; routePages?: Array<Array<{ RouteId: string; RouteKey: string }>> }) {
    const calls: string[][] = [];
    const pages = state.pages ?? [[api]];
    const routePages = state.routePages ?? [[]];
    const runner = {
      aws(args: readonly string[]) {
        calls.push(["aws", ...args]);
        if (args[0] === "cloudformation" && args[1] === "describe-stacks") {
          return state.stack === false ? { status: 254, stdout: "", stderr: "Stack with id AgentXControlPlane does not exist" } : { status: 0, stdout: "{}", stderr: "" };
        }
        const paged = (list: readonly unknown[], key: string) => {
          const at = args.includes("--starting-token") ? Number(args[args.indexOf("--starting-token") + 1]) : 0;
          return { status: 0, stderr: "", stdout: JSON.stringify({ [key]: list[at], ...(at + 1 < list.length ? { NextToken: String(at + 1) } : {}) }) };
        };
        if (args[0] === "cloudformation" && args[1] === "list-stack-resources") return paged(pages, "StackResourceSummaries");
        if (args[0] === "apigatewayv2" && args[1] === "get-routes") return paged(routePages, "Items");
        throw new Error(`unexpected aws ${args.join(" ")}`);
      },
    };
    return { runner: runner as unknown as Pick<Runner, "aws">, calls };
  }
  const guard = (state: Parameters<typeof fake>[0], extra: Partial<{ profile: string }> = {}) => {
    const { runner, calls } = fake(state);
    return { calls, run: () => assertNoHandMadeCapabilityRoutes(runner, { ...options, ...extra }) };
  };

  it("guards exactly the two worker-capability route keys", () => {
    expect(WORKER_CAPABILITY_ROUTE_KEYS).toEqual([CONTEXT, PACKET]);
  });

  it("refuses hand-made routes, names their ids and prints the exact delete commands", () => {
    const { run, calls } = guard({ pages: [[api, route("ProxyRoute", "own1")]], routePages: [[{ RouteId: "hand1", RouteKey: CONTEXT }, { RouteId: "own1", RouteKey: "ANY /{proxy+}" }, { RouteId: "hand2", RouteKey: PACKET }]] }, { profile: "prod" });
    let message = "";
    try { run(); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("AlreadyExists");
    expect(message).toContain("route id hand1");
    expect(message).toContain("route id hand2");
    expect(message).toContain("aws apigatewayv2 delete-route --region us-east-1 --api-id api111 --route-id hand1 --profile prod");
    expect(message).toContain("aws apigatewayv2 delete-route --region us-east-1 --api-id api111 --route-id hand2 --profile prod");
    expect(message).not.toContain("own1\n");
    expect(calls.map((call) => call.slice(0, 3).join(" "))).toEqual(["aws cloudformation describe-stacks", "aws cloudformation list-stack-resources", "aws apigatewayv2 get-routes"]);
    expect(calls[2]).toEqual(expect.arrayContaining(["--api-id", "api111", "--region", "us-east-1"]));
    expect(calls[1]).toEqual(expect.arrayContaining(["--stack-name", "AgentXControlPlane"]));
  });

  it("refuses when only one of the two routes is hand-made", () => {
    const { run } = guard({ pages: [[api, route("ContextToolsListRoute", "own1")]], routePages: [[{ RouteId: "own1", RouteKey: CONTEXT }, { RouteId: "hand2", RouteKey: PACKET }]] });
    expect(run).toThrow(/route id hand2/);
    expect(run).not.toThrow(/hand1|own1/);
  });

  it("passes when the stack owns both routes, under any logical ID", () => {
    expect(guard({ pages: [[api, route("ContextToolsListRoute", "own1"), route("SomeOtherId", "own2")]], routePages: [[{ RouteId: "own1", RouteKey: CONTEXT }, { RouteId: "own2", RouteKey: PACKET }]] }).run).not.toThrow();
  });

  it("does not count a deleted stack resource as ownership", () => {
    expect(guard({ pages: [[api, route("ContextToolsListRoute", "gone1", "DELETE_COMPLETE")]], routePages: [[{ RouteId: "gone1", RouteKey: CONTEXT }]] }).run).toThrow(/route id gone1/);
  });

  it("passes with no such routes, and with a missing stack (after only describe-stacks)", () => {
    expect(guard({ routePages: [[{ RouteId: "own1", RouteKey: "ANY /{proxy+}" }]] }).run).not.toThrow();
    const missing = guard({ stack: false });
    expect(missing.run).not.toThrow();
    expect(missing.calls).toHaveLength(1);
  });

  it("reads every page of the stack's resources and of the routes", () => {
    const { run } = guard({
      pages: [[api], [route("ContextToolsListRoute", "own1")], [route("DesignReviewPacketRoute", "own2")]],
      routePages: [[{ RouteId: "x", RouteKey: "ANY /a" }], [{ RouteId: "own1", RouteKey: CONTEXT }], [{ RouteId: "own2", RouteKey: PACKET }, { RouteId: "hand3", RouteKey: CONTEXT }]],
    });
    expect(run).toThrow(/route id hand3/);
    expect(run).not.toThrow(/route id own/);
    expect(guard({ pages: [[api], [], [route("ContextToolsListRoute", "own1")]], routePages: [[], [], [{ RouteId: "own1", RouteKey: CONTEXT }]] }).run).not.toThrow();
  });

  it("fails closed when an existing stack has no HttpApi", () => {
    expect(guard({ pages: [[route("ContextToolsListRoute", "own1")]] }).run).toThrow(/no HttpApi/);
  });

  it("runs first in releaseProduction: only read-only AWS calls happen before the refusal", async () => {
    const aws: string[][] = [];
    const other: string[] = [];
    const { runner } = fake({ pages: [[api]], routePages: [[{ RouteId: "hand1", RouteKey: CONTEXT }]] });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const awsSpy = vi.spyOn(ReleaseRunner.prototype, "aws").mockImplementation((args) => { aws.push([...args]); return (runner as unknown as { aws: (a: readonly string[]) => { status: number; stdout: string; stderr: string } }).aws(args); });
    const capture = vi.spyOn(ReleaseRunner.prototype, "capture").mockImplementation((command) => { other.push(`capture ${command}`); return { status: 0, stdout: "", stderr: "" }; });
    const run = vi.spyOn(ReleaseRunner.prototype, "run").mockImplementation((command) => { other.push(`run ${command}`); return ""; });
    try {
      await expect(releaseProduction(parseProductionReleaseArgs([], {}))).rejects.toThrow(/route id hand1/);
      expect(other).toEqual([]);
      expect(aws.map((args) => args.slice(0, 2).join(" "))).toEqual(["cloudformation describe-stacks", "cloudformation list-stack-resources", "apigatewayv2 get-routes"]);
    } finally {
      awsSpy.mockRestore(); capture.mockRestore(); run.mockRestore(); stdout.mockRestore();
    }
  });
});

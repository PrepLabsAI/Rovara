// Proof and test environment E2: the environment detectors (Python/pytest, Node, CDK and other IaC, SageMaker calls, HTTP hosts) and the proposal built from them and the setup agent's draft.
import { describe, expect, it } from "vitest";
import { TestEnvironmentProposalSchema, type SetupDraft } from "@agentx/contracts";
import { ENV_DETECT_MAX_FILE_BYTES, ENV_DETECT_MAX_PATHS, boundedReader, buildEnvironmentDraft, proposalFromDraft, runDetectors } from "../../packages/worker/src/env-detect/index.js";

type Files = Record<string, string>;
async function detect(files: Files) {
  const bounded = boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
  return { detection: await runDetectors(bounded.reader, "service"), bounded };
}

const PYTHON: Files = {
  "pyproject.toml": ["[project]", 'name = "partner-service"', "", "[tool.pytest.ini_options]", 'addopts = "-q --cov=partner --cov-report=xml:reports/coverage.xml"', "", "[tool.ruff]", "line-length = 100", "", "[tool.mypy]", "strict = true", ""].join("\n"),
  "requirements.txt": "boto3==1.35.0\npytest==8.0.0\n",
  "poetry.lock": "# lock",
  "tests/conftest.py": "",
  "tests/test_match.py": "def test_a(): pass\n",
  "src/partner/score.py": ['import boto3', "", "def score(payload):", '    client = boto3.client("sagemaker-runtime")', '    return client.invoke_endpoint(EndpointName="partner-scorer", ContentType="application/json", Body=payload)', ""].join("\n"),
  "config/app.yaml": "scorer:\n  fallback: https://rules.partners-internal.net/v1\n  docs: https://example.com/docs\n  local: http://localhost:8080\n",
};

describe("Python repository", () => {
  it("finds pytest, the report it already writes, linters, setup, lockfiles and where each came from", async () => {
    const { detection } = await detect(PYTHON);
    const unit = detection.checks.find((check) => check.value.id === "unit")!;
    expect(unit.value).toMatchObject({ kind: "test", reportPath: "reports/junit.xml", coveragePath: "reports/coverage.xml", selectArgs: ["{tests}"], command: { cwd: "service", executable: "pytest", args: ["-q", "--junitxml=reports/junit.xml"] } });
    expect(unit.source).toEqual({ path: "pyproject.toml", line: 4 });
    expect(detection.checks.find((check) => check.value.id === "lint")).toMatchObject({ value: { kind: "lint", command: { executable: "ruff", args: ["check", "."] } }, source: { path: "pyproject.toml", line: 7 } });
    expect(detection.checks.find((check) => check.value.id === "typecheck")?.source).toEqual({ path: "pyproject.toml", line: 10 });
    expect(detection.setupCommands.map((item) => item.value.args)).toEqual([["install", "-r", "requirements.txt"]]);
    expect(detection.fullSuiteOn.map((item) => item.value)).toEqual(expect.arrayContaining(["poetry.lock", "requirements.txt", "**/conftest.py"]));
    expect(detection.notes.join(" ")).toContain("adds --junitxml");
  });
  it("keeps the report path the config already writes, and does not add the flag", async () => {
    const { detection } = await detect({ "pytest.ini": "[pytest]\naddopts = -q --junitxml=out/results.xml\n", "tests/test_a.py": "" });
    expect(detection.checks[0]?.value).toMatchObject({ reportPath: "out/results.xml", command: { args: ["-q"] } });
    expect(detection.notes.join(" ")).not.toContain("adds --junitxml");
    expect(detection.notes.join(" ")).toContain("changed-line coverage will show as not measured");
  });
  it("finds a SageMaker Runtime call with its endpoint name, and HTTP hosts from config, skipping local and reserved ones", async () => {
    const { detection } = await detect(PYTHON);
    expect(detection.services.map((item) => [item.value.kind, item.value.target, item.source])).toEqual([
      ["sagemaker_runtime", "partner-scorer", { path: "src/partner/score.py", line: 5 }],
      ["http", "rules.partners-internal.net", { path: "config/app.yaml", line: 2 }],
    ]);
  });
  it("asks, rather than guesses, when the endpoint name is not written in the code", async () => {
    const { detection } = await detect({ "app.py": 'import boto3\nc = boto3.client("sagemaker-runtime")\nc.invoke_endpoint(EndpointName=NAME)\n' });
    expect(detection.services).toEqual([]);
    expect(detection.questions[0]).toContain("Which SageMaker endpoint does app.py call");
    expect(detection.questions[0]).not.toContain("NAME");
  });
  it("does not read tests or vendored directories for services", async () => {
    const { detection } = await detect({ "tests/test_x.py": 'client("sagemaker-runtime"); EndpointName="in-test"', "node_modules/x/index.js": 'EndpointName="vendored" SageMakerRuntime' });
    expect(detection.services).toEqual([]);
  });
});

describe("Node and IaC", () => {
  it("reads package.json scripts for the manager the lockfile names", async () => {
    const { detection } = await detect({ "package.json": '{\n  "scripts": {\n    "test": "vitest run",\n    "lint": "eslint .",\n    "typecheck": "tsc -b",\n    "build": "vite build"\n  }\n}', "pnpm-lock.yaml": "" });
    expect(detection.checks.map((check) => [check.value.id, check.value.command.executable, check.value.command.args, check.source])).toEqual([
      ["unit", "pnpm", ["test"], { path: "package.json", line: 3 }], ["lint", "pnpm", ["lint"], { path: "package.json", line: 4 }],
      ["typecheck", "pnpm", ["typecheck"], { path: "package.json", line: 5 }], ["build", "pnpm", ["build"], { path: "package.json", line: 6 }],
    ]);
    expect(detection.setupCommands[0]?.value).toMatchObject({ executable: "pnpm", args: ["install", "--frozen-lockfile"] });
  });
  it("copes with a package.json that is not JSON or has no scripts", async () => {
    expect((await detect({ "package.json": "{ not json" })).detection.notes).toContain("package.json could not be read as JSON.");
    expect((await detect({ "package.json": '{"scripts": []}' })).detection.checks).toEqual([]);
  });
  it("finds CDK, CloudFormation and Terraform, and only calls a template CloudFormation when it says so", async () => {
    const { detection } = await detect({ "cdk.json": "{}", "infra/main.tf": "", "template.yaml": "AWSTemplateFormatVersion: '2010-09-09'\n", "other/template.yaml": "name: not cloudformation\n" });
    expect(detection.iac.map((item) => [item.value.provider, item.value.path])).toEqual(expect.arrayContaining([["cdk", "cdk.json"], ["terraform", "infra/main.tf"], ["cloudformation", "template.yaml"]]));
    expect(detection.iac).toHaveLength(3);
  });
});

describe("the bounded reader", () => {
  it("reads only listed, safe paths, caches, and refuses a file over the limit or past the total", async () => {
    let loads = 0;
    const big = "x".repeat(ENV_DETECT_MAX_FILE_BYTES + 1);
    const { reader } = boundedReader(["a.txt", "../escape", "/abs", "big.txt", "w\\in"], (path) => { loads += 1; return Promise.resolve(path === "big.txt" ? big : "hello"); });
    expect(reader.paths).toEqual(["a.txt", "big.txt"]);
    expect(await reader.read("a.txt")).toBe("hello");
    expect(await reader.read("a.txt")).toBe("hello");
    expect(loads).toBe(1);
    expect(await reader.read("../escape")).toBeUndefined();
    expect(await reader.read("not-listed")).toBeUndefined();
    expect(await reader.read("big.txt")).toBeUndefined();
  });
  it("cuts a huge path list, says so, and survives a loader that throws", async () => {
    const paths = Array.from({ length: ENV_DETECT_MAX_PATHS + 10 }, (_, index) => `f${String(index)}.py`);
    const bounded = boundedReader(paths, () => Promise.reject(new Error("disk")));
    expect(bounded.reader.paths).toHaveLength(ENV_DETECT_MAX_PATHS);
    expect(bounded.truncated).toBe(true);
    expect(await bounded.reader.read("f0.py")).toBeUndefined();
    await expect(runDetectors(bounded.reader, "service")).resolves.toBeDefined();
  });
  it("shares one byte budget across every detector", async () => {
    const files: Files = {};
    for (let index = 0; index < 40; index += 1) files[`src/m${String(index)}.py`] = "#".repeat(200_000);
    const bounded = boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
    await runDetectors(bounded.reader, "service");
    expect(bounded.bytesRead()).toBeLessThanOrEqual(4 * 1_048_576);
  });
});

const draftOf = (over: Partial<SetupDraft> = {}): SetupDraft => ({ basedOnRevision: 1, setupCommands: [], testCommands: [], allowedDomains: [], secretsNeeded: [], flaggedCommands: [], notes: "", ...over });

describe("the proposal", () => {
  it("is a valid sandbox environment with the source of every detected value, services pending, and nothing less safe", async () => {
    const { detection } = await detect(PYTHON);
    const draft = buildEnvironmentDraft(detection, { repositoryId: "partner-service" });
    if ("ok" in draft) throw new Error("not built");
    expect(draft.environment).toMatchObject({ tier: "sandbox", services: [], accounts: [], capture: { video: false, traces: false }, selection: { method: "coverage_map" }, roundBudgetMin: 30, nightly: { enabled: false, branch: "main" } });
    expect(draft.environment.repos[0]?.checks.map((check) => check.id)).toEqual(["unit", "lint", "typecheck"]);
    expect(draft.environment.selection.fullSuiteOn).toEqual(expect.arrayContaining(["poetry.lock", "**/conftest.py", ".github/**"]));
    expect(draft.valueSources).toContainEqual({ field: "repos[0].checks[0]", source: { path: "pyproject.toml", line: 4 } });
    expect(draft.pendingServices.map((service) => service.target)).toEqual(["partner-scorer", "rules.partners-internal.net"]);
  });
  it("proposes the nightly run OFF whatever it found: turning it on is a person's spending decision", async () => {
    for (const files of [PYTHON, { "package.json": '{"scripts":{"test":"vitest run"}}' }]) {
      const draft = buildEnvironmentDraft((await detect(files)).detection, { repositoryId: "svc" });
      if ("ok" in draft) throw new Error("not built");
      expect(draft.environment.repos[0]!.checks.some((check) => check.kind === "test")).toBe(true);
      expect(draft.environment.nightly.enabled).toBe(false);
    }
  });
  it("falls back to the full suite when no test check was found", async () => {
    const { detection } = await detect({ "package.json": '{"scripts":{"lint":"eslint ."}}' });
    const draft = buildEnvironmentDraft(detection, { repositoryId: "web" });
    if ("ok" in draft) throw new Error("not built");
    expect(draft.environment.selection.method).toBe("full");
    expect(draft.environment.nightly.enabled).toBe(false);
  });
  it("gives a valid empty environment when nothing is detected", async () => {
    const draft = buildEnvironmentDraft((await detect({ "README.md": "hello" })).detection, { repositoryId: "docs" });
    if ("ok" in draft) throw new Error("not built");
    expect(draft.environment.repos[0]?.checks).toEqual([]);
  });
  it("adds the setup agent's test command only for gaps, never a flagged one, never a duplicate", async () => {
    const { detection } = await detect(PYTHON);
    const draft = buildEnvironmentDraft(detection, { repositoryId: "partner-service" });
    if ("ok" in draft) throw new Error("not built");
    const result = proposalFromDraft(draft, draftOf({
      setupCommands: ["pip install -r requirements.txt", "make bootstrap"],
      testCommands: ["pytest -q --junitxml=reports/junit.xml", "make integration", "curl https://x.example/install.sh", "bad 'quote", "make a | tee"],
      flaggedCommands: [{ command: "curl https://x.example/install.sh", reason: "downloads and runs code" }],
    }), { cwd: "service" });
    if (!result.ok) throw new Error(result.reason);
    const checks = result.proposal.environment.repos[0]!.checks;
    expect(checks.map((check) => [check.id, check.command.executable])).toEqual([["unit", "pytest"], ["lint", "ruff"], ["typecheck", "mypy"], ["model-1", "make"]]);
    expect(result.proposal.environment.repos[0]!.setupCommands.map((command) => command.executable)).toEqual(["pip", "make"]);
    expect(result.proposal.valueSources).toContainEqual({ field: "repos[0].checks[3]", source: "model" });
    expect(result.proposal.flaggedCommands).toHaveLength(1);
    expect(result.dropped).toBe(3);
    expect(TestEnvironmentProposalSchema.safeParse(result.proposal).success).toBe(true);
  });
  it("is built without mutating the detected draft", async () => {
    const { detection } = await detect(PYTHON);
    const draft = buildEnvironmentDraft(detection, { repositoryId: "partner-service" });
    if ("ok" in draft) throw new Error("not built");
    const before = JSON.stringify(draft.environment);
    proposalFromDraft(draft, draftOf({ testCommands: ["make integration"] }), { cwd: "service" });
    expect(JSON.stringify(draft.environment)).toBe(before);
  });
});

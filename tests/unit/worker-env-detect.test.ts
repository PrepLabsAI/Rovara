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
  it("keeps the report path the config already writes, and does not add the flag", async () => {
    const { detection } = await detect({ "pytest.ini": "[pytest]\naddopts = -q --junitxml=out/results.xml\n", "tests/test_a.py": "" });
    expect(detection.checks[0]?.value).toMatchObject({ reportPath: "out/results.xml", command: { args: ["-q"] } });
    expect(detection.notes.join(" ")).not.toContain("adds --junitxml");
    expect(detection.notes.join(" ")).toContain("changed-line coverage will show as not measured");
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
});

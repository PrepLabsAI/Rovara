import { describe, expect, it } from "vitest";
import { agentxRepositoryName, commandLine, installationToken, parseCommandLine, proposeCommands } from "../../packages/cli/src/setup/project-files.js";
import { fakeGitHubApi, memoryInitSecrets, TEST_PRIVATE_KEY } from "../support/init-fakes.js";

const CWD = "repo/payments-api";
const lines = (proposed: ReturnType<typeof proposeCommands>) => ({ setup: proposed.setup.map(commandLine), readiness: proposed.readiness.map(commandLine) });

describe("proposing setup and test commands from the repository's files (FR-040)", () => {
  it("uses npm ci and npm test for a package-lock project with a test script", () => {
    const proposed = proposeCommands({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }), "package-lock.json": "{}" }, CWD);
    expect(lines(proposed)).toEqual({ setup: ["npm ci"], readiness: ["npm test"] });
    expect(proposed.setup[0]).toEqual({ cwd: CWD, executable: "npm", args: ["ci"], timeoutSeconds: 900 });
    expect(proposed.basis).toEqual(["package.json and package-lock.json: npm ci", "package.json's test script: npm test"]);
  });

  it("follows the lockfile: pnpm and yarn", () => {
    expect(lines(proposeCommands({ "package.json": JSON.stringify({ scripts: { test: "jest" } }), "pnpm-lock.yaml": "" }, CWD))).toEqual({ setup: ["pnpm install --frozen-lockfile"], readiness: ["pnpm test"] });
    expect(lines(proposeCommands({ "package.json": JSON.stringify({ scripts: { test: "jest" } }), "yarn.lock": "" }, CWD))).toEqual({ setup: ["yarn install --frozen-lockfile"], readiness: ["yarn test"] });
  });

  it("proposes no test command when package.json has none, or only npm's placeholder (Review Focus 5)", () => {
    expect(lines(proposeCommands({ "package.json": JSON.stringify({ name: "x" }), "package-lock.json": "{}" }, CWD)).readiness).toEqual([]);
    const placeholder = JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } });
    expect(lines(proposeCommands({ "package.json": placeholder }, CWD)).readiness).toEqual([]);
  });

  it("proposes nothing for a repository with no build files it knows (Review Focus 5)", () => {
    expect(proposeCommands({ "README.md": "# hi" }, CWD)).toEqual({ setup: [], readiness: [], basis: [] });
  });

  it("handles Python with uv, poetry and plain pip", () => {
    expect(lines(proposeCommands({ "pyproject.toml": "[tool.pytest.ini_options]", "uv.lock": "" }, CWD))).toEqual({ setup: ["uv sync"], readiness: ["uv run pytest"] });
    expect(lines(proposeCommands({ "pyproject.toml": "[tool.poetry]\npytest = \"^8\"", "poetry.lock": "" }, CWD))).toEqual({ setup: ["poetry install"], readiness: ["poetry run pytest"] });
    expect(lines(proposeCommands({ "pyproject.toml": "[project]\nname = \"x\"" }, CWD))).toEqual({ setup: ["python3 -m pip install -e ."], readiness: [] });
    expect(lines(proposeCommands({ "requirements.txt": "pytest\n" }, CWD))).toEqual({ setup: ["python3 -m pip install -r requirements.txt"], readiness: ["python3 -m pytest"] });
  });

  it("handles Go, Rust and a Makefile test target", () => {
    expect(lines(proposeCommands({ "go.mod": "module x" }, CWD))).toEqual({ setup: ["go mod download"], readiness: ["go test ./..."] });
    expect(lines(proposeCommands({ "Cargo.toml": "[package]" }, CWD))).toEqual({ setup: ["cargo fetch"], readiness: ["cargo test"] });
    expect(lines(proposeCommands({ Makefile: "build:\n\tgo build\ntest:\n\tgo test ./...\n" }, CWD))).toEqual({ setup: [], readiness: ["make test"] });
  });

  it("parses a typed command line with quotes, and refuses shell operators", () => {
    expect(parseCommandLine(`npm test -- --grep "login flow"`, CWD, 1800)).toEqual({ cwd: CWD, executable: "npm", args: ["test", "--", "--grep", "login flow"], timeoutSeconds: 1800 });
    expect(() => parseCommandLine("npm ci && npm test", CWD, 900)).toThrow("a command runs one program; put && , | and ; steps in a script or Makefile target and call that");
    expect(() => parseCommandLine("   ", CWD, 900)).toThrow("the command is empty");
  });

  it("turns a GitHub repository name into an AgentX name", () => {
    expect(agentxRepositoryName("Payments.API")).toBe("payments-api");
    // F2: the cleaned name already starts with a letter (the leading "_" is stripped), so no
    // "repo-" prefix is needed. The prefix only applies when the cleaned name would otherwise
    // start with a digit or be empty.
    expect(agentxRepositoryName("9lives")).toBe("repo-9lives");
  });
});

describe("the installation token", () => {
  it("uses the recorded installation, reading the app key from its secret", async () => {
    const secrets = memoryInitSecrets({ "agentx/staging/github-app": JSON.stringify({ appId: "42", slug: "agentx-acme", account: "acme", privateKey: TEST_PRIVATE_KEY }) });
    const github = fakeGitHubApi({ installationId: 7 });
    expect(await installationToken({ env: "staging", secrets, github, installationId: "7", nowSeconds: 1_790_000_000 })).toMatch(/^ghs_/);
  });

  it("finds the only installation when none is recorded, and refuses when there are several", async () => {
    const secrets = memoryInitSecrets({ "agentx/staging/github-app": JSON.stringify({ appId: "42", slug: "s", account: "acme", privateKey: TEST_PRIVATE_KEY }) });
    await expect(installationToken({ env: "staging", secrets, github: { ...fakeGitHubApi(), listInstallations: async () => [{ id: 1, account: { login: "a" } }, { id: 2, account: { login: "b" } }] }, nowSeconds: 1 }))
      .rejects.toThrow("the GitHub App is installed on 2 accounts (a, b); AgentX uses one");
  });
});

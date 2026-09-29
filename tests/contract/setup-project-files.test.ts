import { describe, expect, it } from "vitest";
import { agentxRepositoryName, commandLine, githubRepositoryApi, installationToken, parseCommandLine, proposeCommands } from "../../packages/cli/src/setup/project-files.js";
import { fakeGitHubApi, memoryInitSecrets, TEST_PRIVATE_KEY } from "../support/init-fakes.js";

const MAX_FILE_BYTES = 64 * 1024;

/** Records every call and answers with the given responses in order, like init-github-app.test.ts's
 * GitHub REST client tests. Anything past the end of the list answers with a plain HTTP 500. */
function recordingFetch(responses: Response[]): { calls: Array<{ url: string; method: string }>; fetchImplementation: typeof fetch } {
  const calls: Array<{ url: string; method: string }> = [];
  const queue = [...responses];
  const fetchImplementation = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url, method: init?.method ?? "GET" });
    return queue.shift() ?? new Response("{}", { status: 500 });
  }) as typeof fetch;
  return { calls, fetchImplementation };
}

function repositoryPage(fullNames: string[]) {
  return { repositories: fullNames.map((fullName) => ({ full_name: fullName, name: fullName.split("/")[1]!, default_branch: "main", clone_url: `https://github.com/${fullName}.git` })) };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

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

  it("refuses when the GitHub App's secret does not exist", async () => {
    await expect(installationToken({ env: "staging", secrets: memoryInitSecrets(), github: fakeGitHubApi(), nowSeconds: 1 }))
      .rejects.toThrow("secret agentx/staging/github-app does not exist; run agentx init again so the GitHub App step stores it");
  });

  it("refuses a malformed secret with parseAppSecret's own message, not a second parser's", async () => {
    const secrets = memoryInitSecrets({ "agentx/staging/github-app": JSON.stringify({ appId: "42" }) });
    await expect(installationToken({ env: "staging", secrets, github: fakeGitHubApi(), nowSeconds: 1 }))
      .rejects.toThrow("secret agentx/staging/github-app is not an AgentX GitHub App secret; delete it (aws secretsmanager delete-secret --secret-id agentx/staging/github-app --force-delete-without-recovery) and run agentx init again");
  });
});

describe("the repository API's network calls (githubRepositoryApi)", () => {
  it("keeps paging until a short page, without dropping repositories", async () => {
    const page = (start: number, count: number) => repositoryPage(Array.from({ length: count }, (_, index) => `acme/repo-${start + index}`));
    const { calls, fetchImplementation } = recordingFetch([
      jsonResponse(200, page(1, 100)),
      jsonResponse(200, page(101, 100)),
      jsonResponse(200, page(201, 5)),
    ]);
    const repositories = await githubRepositoryApi(fetchImplementation).list("ghs_token");
    expect(repositories).toHaveLength(205);
    expect(repositories[0]!.fullName).toBe("acme/repo-1");
    expect(repositories.at(-1)!.fullName).toBe("acme/repo-205");
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.github.com/installation/repositories?per_page=100&page=1",
      "https://api.github.com/installation/repositories?per_page=100&page=2",
      "https://api.github.com/installation/repositories?per_page=100&page=3",
    ]);
  });

  it("fails clearly instead of dropping repositories silently once the safety cap is hit", async () => {
    const fullPage = repositoryPage(Array.from({ length: 100 }, (_, index) => `acme/repo-${index}`));
    const responses = Array.from({ length: 100 }, () => jsonResponse(200, fullPage));
    const { calls, fetchImplementation } = recordingFetch(responses);
    await expect(githubRepositoryApi(fetchImplementation).list("ghs_token"))
      .rejects.toThrow("GitHub reports more than 10000 repositories for this installation; stopped after page 100 rather than silently drop the rest");
    expect(calls).toHaveLength(100);
  });

  it("a non-ok list response throws, and the error never contains the response body", async () => {
    const { fetchImplementation } = recordingFetch([jsonResponse(500, { message: "boom", token: "ghs_should_not_leak" })]);
    let message = "";
    try { await githubRepositoryApi(fetchImplementation).list("ghs_token"); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("GitHub repository list failed with HTTP 500");
    expect(message).not.toContain("ghs_should_not_leak");
    expect(message).not.toContain("boom");
  });

  it("a 403 list response names a next step", async () => {
    const { fetchImplementation } = recordingFetch([jsonResponse(403, { message: "Forbidden" })]);
    await expect(githubRepositoryApi(fetchImplementation).list("ghs_token"))
      .rejects.toThrow("check that the GitHub App is still installed and can see its repositories");
  });

  it("a 404 file read returns undefined", async () => {
    const { fetchImplementation } = recordingFetch([new Response("not found", { status: 404 })]);
    expect(await githubRepositoryApi(fetchImplementation).file("ghs_token", "acme/payments-api", "package.json")).toBeUndefined();
  });

  it("a 403 file read names the repository as the next step", async () => {
    const { fetchImplementation } = recordingFetch([new Response("nope", { status: 403 })]);
    await expect(githubRepositoryApi(fetchImplementation).file("ghs_token", "acme/payments-api", "package.json"))
      .rejects.toThrow("check that the GitHub App is still installed and can see acme/payments-api");
  });

  it("a non-ok file read throws, and the error never contains the response body", async () => {
    const { fetchImplementation } = recordingFetch([new Response("token=ghs_should_not_leak", { status: 500 })]);
    let message = "";
    try { await githubRepositoryApi(fetchImplementation).file("ghs_token", "acme/payments-api", "package.json"); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("GitHub could not read package.json in acme/payments-api (HTTP 500)");
    expect(message).not.toContain("ghs_should_not_leak");
  });

  it("caps a file's content at 64 KiB and cancels the stream reader once the cap is hit", async () => {
    let cancelled = false;
    let pulls = 0;
    const chunkBytes = 40 * 1024; // two chunks cross the cap, so cancel is reached well before the body ends
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 4) { controller.close(); return; }
        controller.enqueue(new TextEncoder().encode("a".repeat(chunkBytes)));
      },
      cancel() { cancelled = true; },
    });
    const { fetchImplementation } = recordingFetch([new Response(stream, { status: 200 })]);
    const text = await githubRepositoryApi(fetchImplementation).file("ghs_token", "acme/payments-api", "package.json");
    expect(text).toBe("a".repeat(MAX_FILE_BYTES));
    expect(cancelled).toBe(true);
    // The cap is hit after the second chunk (80 KiB read); the source is never asked for a fourth.
    expect(pulls).toBeLessThanOrEqual(3);
  });

  it("falls back to reading the whole body and truncating it when there is no stream", async () => {
    const whole = "b".repeat(MAX_FILE_BYTES + 10);
    const noStreamResponse = { ok: true, status: 200, text: async () => whole, body: null } as unknown as Response;
    const { fetchImplementation } = recordingFetch([noStreamResponse]);
    const text = await githubRepositoryApi(fetchImplementation).file("ghs_token", "acme/payments-api", "package.json");
    expect(text).toBe(whole.slice(0, MAX_FILE_BYTES));
  });
});

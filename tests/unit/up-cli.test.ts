// Port lane L4: `rovara up` and `rovara up --check` through the real command line, with Docker, GitHub and the server simulated.
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalRuntime } from "@agentx/broker/local";
import { executeCli } from "../../packages/cli/src/main.js";
import type { UpCommandContext } from "../../packages/cli/src/up/cli.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import { FakeDocker } from "../support/local/fake-docker.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!();
});

async function run(argv: string[], options: { environment?: NodeJS.ProcessEnv; docker?: FakeDocker; gh?: string | undefined; github?: Response | Error; keysFile?: { text: string; mode: number }; config?: string; portIsFree?: boolean; start?: UpCommandContext["start"]; waitForShutdown?: () => Promise<void> } = {}) {
  const state = await mkdtemp(join(tmpdir(), "rovara-l4-cli-"));
  cleanup.push(() => rm(state, { recursive: true, force: true }));
  if (options.keysFile !== undefined) {
    await writeFile(join(state, "keys.json"), options.keysFile.text, { mode: 0o600 });
    await chmod(join(state, "keys.json"), options.keysFile.mode);
  }
  if (options.config !== undefined) await writeFile(join(state, "config.json"), options.config, { mode: 0o600 });
  let out = "";
  let err = "";
  const github = vi.fn<typeof fetch>(async () => {
    if (options.github instanceof Error) throw options.github;
    return options.github ?? Response.json({ login: "octo-dev" });
  });
  const code = await executeCli([...argv, "--state-dir", state], {
    tokenStore: new InMemoryTokenStore(),
    stdout: { write: (text: string) => { out += text; return true; } },
    stderr: { write: (text: string) => { err += text; return true; } },
    up: {
      home: state,
      cwd: "/not/the/state",
      environment: options.environment ?? { ANTHROPIC_API_KEY: "sk-test-key-value" },
      docker: options.docker ?? new FakeDocker(),
      fetch: github,
      checkServices: {
        gh: async () => ("gh" in options ? options.gh : "gho_from_cli\n"),
        portIsFree: async () => options.portIsFree ?? true,
      },
      ...(options.start === undefined ? {} : { start: options.start }),
      ...(options.waitForShutdown === undefined ? {} : { waitForShutdown: options.waitForShutdown }),
    },
  });
  return { code, out, err, state, github };
}

describe("rovara up --check", () => {

  it("says how to build a missing worker image", async () => {
    const { code, out } = await run(["up", "--check", "--worker-image", "absent:image"]);
    expect(code).not.toBe(0);
    expect(out).toContain("docker build -f environments/base/Dockerfile");
  });

  it("says where to put a missing model key, and when the key file is readable by others", async () => {
    const none = await run(["up", "--check", "--worker-image", "worker:test"], { environment: {} });
    expect(none.out).toContain("No model key was found.");
    expect(none.out).toContain("ANTHROPIC_API_KEY");
    const loose = await run(["up", "--check", "--worker-image", "worker:test"], { environment: {}, keysFile: { text: '{"anthropic":"sk-test-SECRET"}', mode: 0o644 } });
    expect(loose.out).toContain("must not be readable by other users");
    expect(loose.out).toContain("chmod 600");
    expect(loose.out).not.toContain("SECRET");
    const good = await run(["up", "--check", "--worker-image", "worker:test"], { environment: {}, keysFile: { text: '{"anthropic":"sk-test-SECRET"}', mode: 0o600 } });
    expect(good.out).toContain("A model key is set for anthropic (from the key file).");
  });

  it("reports the provider and model a task step will use, and what to set when none can be chosen (L13)", async () => {
    const check = (options: Parameters<typeof run>[1]) => run(["up", "--check", "--worker-image", "worker:test"], options);
    // The only key is OpenRouter's: its default Claude model.
    const onlyRouter = await check({ environment: { OPENROUTER_API_KEY: "or-test-value" } });
    expect(onlyRouter.code).toBe(0);
    expect(onlyRouter.out).toContain("Task steps will use openrouter anthropic/claude-sonnet-4.6 (the default for the only key found).");
    expect(onlyRouter.out).not.toContain("or-test-value");
    // Several keys: Anthropic first.
    const several = await check({ environment: { OPENROUTER_API_KEY: "or-test-value", ANTHROPIC_API_KEY: "an-test-value" } });
    expect(several.out).toContain("Task steps will use anthropic claude-sonnet-4-6 (the default for the first key found).");
    // The config's setting wins.
    const config = JSON.stringify({ version: 1, plugins: [], model: { provider: "openrouter", id: "anthropic/claude-sonnet-5.5" } });
    const chosen = await check({ environment: { OPENROUTER_API_KEY: "or-test-value", ANTHROPIC_API_KEY: "an-test-value" }, config });
    expect(chosen.out).toContain('Task steps will use openrouter anthropic/claude-sonnet-5.5 (the "model" setting in your config).');
    // A setting whose provider has no key fails, and says which key to set.
    const missing = await check({ environment: { ANTHROPIC_API_KEY: "an-test-value" }, config });
    expect(missing.code).not.toBe(0);
    expect(missing.out).toContain("FAIL  model-key");
    expect(missing.out).toContain("The config names openrouter (anthropic/claude-sonnet-5.5) as the model, but no openrouter key was found.");
    expect(missing.out).toContain("OPENROUTER_API_KEY");
    // No key at all: the fix names the three keys and the setting.
    const none = await check({ environment: {} });
    expect(none.out).toContain("OPENROUTER_API_KEY");
    expect(none.out).toContain('"model"');
  });

  it("does not load a model-provider plug-in, and says what it can: the setting names one that is configured, or one that is not installed (item K2)", async () => {
    const check = (options: Parameters<typeof run>[1]) => run(["up", "--check", "--worker-image", "worker:test"], options);
    const model = { provider: "company-gateway", id: "house-model" };
    const configured = await check({ environment: {}, config: JSON.stringify({ version: 1, plugins: [{ point: "model-provider", name: "company-gateway", module: "./gateway.mjs" }], model }) });
    expect(configured.out).toContain("Task steps will use company-gateway house-model");
    expect(configured.out).toContain("model-provider plug-in");
    const missing = await check({ environment: { ANTHROPIC_API_KEY: "an-test-value" }, config: JSON.stringify({ version: 1, plugins: [], model }) });
    expect(missing.code).not.toBe(0);
    expect(missing.out).toContain("no model provider called company-gateway is installed");
  });

  it("says which AWS identity Bedrock will use and that its models are unpriced, and fails when none is named (review M1)", async () => {
    const check = (options: Parameters<typeof run>[1]) => run(["up", "--check", "--worker-image", "worker:test"], options);
    const config = (settings: Record<string, unknown>) => JSON.stringify({ version: 1, plugins: [{ point: "model-provider", name: "amazon-bedrock", module: "./bedrock.mjs", settings }], model: { provider: "amazon-bedrock", id: "anthropic.claude-test-v1:0" } });
    const profile = await check({ environment: {}, config: config({ region: "us-west-2", profile: "rovara-bedrock" }) });
    expect(profile.out).toContain('Bedrock will sign with the AWS profile "rovara-bedrock"');
    expect(profile.out).toContain("Bedrock models are unpriced until you set prices");
    const priced = await check({ environment: {}, config: config({ region: "us-west-2", allowAmbientAwsCredentials: true, prices: { currency: "USD", models: { "anthropic.claude-test-v1:0": { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 2 } } } }) });
    expect(priced.out).toContain("the default AWS credential chain");
    expect(priced.out).not.toContain("unpriced");
    const none = await check({ environment: {}, config: config({ region: "us-west-2" }) });
    expect(none.code).not.toBe(0);
    expect(none.out).toContain("exactly one AWS identity");
  });

  it("accepts a GitHub token from the environment or the key file before it runs the GitHub CLI", async () => {
    const gh = vi.fn(async () => "gho_from_cli");
    const state = await mkdtemp(join(tmpdir(), "rovara-l4-cli-"));
    cleanup.push(() => rm(state, { recursive: true, force: true }));
    const { resolveGithubAccess, createLocalSecrets } = await import("../../packages/broker/src/local/index.js");
    const secrets = createLocalSecrets(state, {});
    expect((await resolveGithubAccess({ companyId: "c", secrets, environment: { GH_TOKEN: "from-env" }, gh }))?.source).toBe("environment");
    await writeFile(join(state, "keys.json"), '{"github":"from-file"}', { mode: 0o600 });
    expect((await resolveGithubAccess({ companyId: "c", secrets, environment: { GH_TOKEN: "from-env" }, gh }))?.source).toBe("key-store");
    expect(gh).not.toHaveBeenCalled();
    // The CLI is asked for github.com's token by name, so GH_HOST cannot send another server's token to api.github.com.
    await rm(join(state, "keys.json"));
    await resolveGithubAccess({ companyId: "c", secrets, environment: {}, gh });
    expect(gh).toHaveBeenCalledWith(["auth", "token", "--hostname", "github.com"]);
    // The environment's GITHUB_API_KEY (the model-key store's name for provider github) does not count.
    expect((await resolveGithubAccess({ companyId: "c", secrets, environment: { GITHUB_API_KEY: "x" }, gh: async () => undefined }))).toBeUndefined();
  });

  it("says when the port is taken", async () => {
    const { code, out } = await run(["up", "--check", "--worker-image", "worker:test", "--port", "8123"], { portIsFree: false });
    expect(code).not.toBe(0);
    expect(out).toContain("Port 8123 is already in use");
  });

  it("prints a JSON report with --json", async () => {
    const { out } = await run(["up", "--check", "--json", "--worker-image", "worker:test"]);
    const report = JSON.parse(out) as { ok: boolean; data: { checks: Array<{ id: string; status: string }> } };
    expect(report.ok).toBe(true);
    expect(report.data.checks.map((check) => check.id)).toEqual(["docker", "worker-image", "model-key", "github", "port", "config"]);
  });

});

describe("rovara up", () => {
  function runtime(): LocalRuntime & { stopped: boolean } {
    const value = {
      url: "http://127.0.0.1:5555",
      port: 5555,
      registry: {} as never,
      config: { version: 1, plugins: [] } as never,
      configPath: "/state/config.json",
      sessionTokenPath: "/state/session-token",
      pageSessions: {} as LocalRuntime["pageSessions"],
      callbackPort: 0,
      pageLink: (path = "/") => `http://127.0.0.1:0/s/token${path}`,
      pagesUrl: "http://127.0.0.1:0",
      app: {} as LocalRuntime["app"],
      async tick() { /* nothing to do */ },
      modelProxy: {} as LocalRuntime["modelProxy"],
      wiring: () => ({ storage: ["memory"] }),
      stopped: false,
      async stop() { value.stopped = true; },
    };
    return value;
  }

  it("tells about problems and still starts", async () => {
    const docker = new FakeDocker();
    docker.reachable = false;
    const { code, err } = await run(["up", "--worker-image", "worker:test"], { docker, start: async () => runtime(), waitForShutdown: async () => undefined });
    expect(code).toBe(0);
    expect(err).toContain("note: Docker is not running");
  });

  it("stops the runtime even when waiting fails, and refuses a bad port", async () => {
    const started = runtime();
    const failed = await run(["up", "--worker-image", "worker:test"], { start: async () => started, waitForShutdown: async () => { throw new Error("boom"); } });
    expect(failed.code).not.toBe(0);
    expect(started.stopped).toBe(true);
    const bad = await run(["up", "--port", "99999"], { start: async () => runtime() });
    expect(bad.code).not.toBe(0);
    expect(bad.err).toContain("--port must be a number");
  });

  it("builds and tests the code hosts from the shared list, not by name (L11 decision 51)", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const file of ["packages/cli/src/up/checks.ts", "packages/broker/src/local/runtime.ts"]) {
      expect(await readFile(join(process.cwd(), file), "utf8"), file).not.toContain("createLocalGithubCodeHost");
    }
  });
});

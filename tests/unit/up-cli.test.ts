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

async function run(argv: string[], options: { environment?: NodeJS.ProcessEnv; docker?: FakeDocker; gh?: string | undefined; github?: Response | Error; keysFile?: { text: string; mode: number }; portIsFree?: boolean; start?: UpCommandContext["start"]; waitForShutdown?: () => Promise<void> } = {}) {
  const state = await mkdtemp(join(tmpdir(), "rovara-l4-cli-"));
  cleanup.push(() => rm(state, { recursive: true, force: true }));
  if (options.keysFile !== undefined) {
    await writeFile(join(state, "keys.json"), options.keysFile.text, { mode: 0o600 });
    await chmod(join(state, "keys.json"), options.keysFile.mode);
  }
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
  it("passes when Docker, the worker image, a model key, GitHub and the port are ready, and shows no secret", async () => {
    const docker = new FakeDocker();
    const { code, out } = await run(["up", "--check", "--worker-image", "worker:test"], { docker });
    expect(code).toBe(0);
    for (const id of ["docker", "worker-image", "model-key", "github", "port", "config"]) expect(out).toContain(id);
    expect(out).toContain("GitHub access works as octo-dev (token from the GitHub CLI)");
    expect(out).toContain("Everything `rovara up` needs is ready.");
    expect(out).not.toContain("sk-test-key-value");
    expect(out).not.toContain("gho_from_cli");
  });

  it("sends the GitHub token only to api.github.com", async () => {
    const { github } = await run(["up", "--check", "--worker-image", "worker:test"]);
    expect(github).toHaveBeenCalledTimes(1);
    expect(github.mock.calls[0]![0]).toBe("https://api.github.com/user");
  });

  it("says Docker is not running, with a fix, and exits non-zero", async () => {
    const docker = new FakeDocker();
    docker.reachable = false;
    const { code, out, err } = await run(["up", "--check", "--worker-image", "worker:test"], { docker });
    expect(code).not.toBe(0);
    expect(out).toContain("FAIL  docker");
    expect(out).toContain("colima start");
    expect(err).toContain("1 check failed");
  });

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
    expect(good.out).toContain("A model key is set for anthropic.");
  });

  it("says how to get GitHub access, and when GitHub rejects the token", async () => {
    const none = await run(["up", "--check", "--worker-image", "worker:test"], { gh: undefined });
    expect(none.out).toContain("No GitHub access was found.");
    expect(none.out).toContain("gh auth login");
    const rejected = await run(["up", "--check", "--worker-image", "worker:test"], { github: new Response("{}", { status: 401 }) });
    expect(rejected.out).toContain("GitHub rejected the token");
    const offline = await run(["up", "--check", "--worker-image", "worker:test"], { github: new TypeError("offline") });
    expect(offline.out).toContain("warn  github");
    expect(offline.code).toBe(0);
  });

  it("accepts a GitHub token from the environment or the key file before it runs the GitHub CLI", async () => {
    const gh = vi.fn(async () => "gho_from_cli");
    const state = await mkdtemp(join(tmpdir(), "rovara-l4-cli-"));
    cleanup.push(() => rm(state, { recursive: true, force: true }));
    const { resolveGithubAccess, createLocalGithubKeyStore } = await import("../../packages/broker/src/local/index.js");
    const keyFile = createLocalGithubKeyStore(state);
    expect((await resolveGithubAccess({ companyId: "c", keyFile, environment: { GH_TOKEN: "from-env" }, gh }))?.source).toBe("environment");
    await writeFile(join(state, "keys.json"), '{"github":"from-file"}', { mode: 0o600 });
    expect((await resolveGithubAccess({ companyId: "c", keyFile, environment: { GH_TOKEN: "from-env" }, gh }))?.source).toBe("key-store");
    expect(gh).not.toHaveBeenCalled();
    // The CLI is asked for github.com's token by name, so GH_HOST cannot send another server's token to api.github.com.
    await rm(join(state, "keys.json"));
    await resolveGithubAccess({ companyId: "c", keyFile, environment: {}, gh });
    expect(gh).toHaveBeenCalledWith(["auth", "token", "--hostname", "github.com"]);
    // The environment's GITHUB_API_KEY (the model-key store's name for provider github) does not count.
    expect((await resolveGithubAccess({ companyId: "c", keyFile, environment: { GITHUB_API_KEY: "x" }, gh: async () => undefined }))).toBeUndefined();
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

  it("starts nothing and writes nothing", async () => {
    const start = vi.fn();
    const { state } = await run(["up", "--check", "--worker-image", "worker:test"], { start });
    expect(start).not.toHaveBeenCalled();
    expect((await import("node:fs")).readdirSync(state)).toEqual([]);
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
      pagesUrl: "http://127.0.0.1:0",
      app: {} as LocalRuntime["app"],
      async tick() { /* nothing to do */ },
      wiring: () => ({ storage: ["memory"] }),
      stopped: false,
      async stop() { value.stopped = true; },
    };
    return value;
  }

  it("prints the address, waits for the signal, then stops the runtime", async () => {
    const started = runtime();
    let release!: () => void;
    const options: unknown[] = [];
    const finished = run(["up", "--port", "0", "--worker-image", "worker:test", "--this-machine"], {
      start: async (given) => { options.push(given); return started; },
      waitForShutdown: () => new Promise<void>((resolve) => { release = resolve; }),
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(started.stopped).toBe(false);
    release();
    const { code, out, err } = await finished;
    expect(code).toBe(0);
    expect(out).toContain("Rovara is running at http://127.0.0.1:5555 (this computer only).");
    expect(out).not.toMatch(/Bearer [A-Za-z0-9_-]{20,}/);
    expect(err).toContain("Rovara stopped.");
    expect(started.stopped).toBe(true);
    expect(options[0]).toMatchObject({ workerImage: "worker:test", thisMachine: true, port: 0 });
  });

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
});

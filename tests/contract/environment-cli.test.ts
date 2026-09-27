import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENVIRONMENT_PLACEHOLDER } from "@agentx/contracts";
import type { CallerIdentity, StackReader } from "../../packages/cli/src/environments/adopt.js";
import { environmentCachePath, resolveDeploymentFile, writeEnvironmentCache } from "../../packages/cli/src/environments/cache.js";
import type { ParameterStore } from "../../packages/cli/src/environments/parameter-store.js";
import { writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { environmentAdoptClients, environmentSsmClient, executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import { memoryInitSecrets } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";
import { stagingSettings } from "../support/environment-fixtures.js";

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agentx-env-cli-"));
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: { write: (t: string) => out.push(t) }, stderr: { write: (t: string) => err.push(t) } };
}

describe("agentx env", () => {
  it("lists environments from SSM", async () => {
    const store = new MemoryParameterStore();
    await writeEnvironmentSettings(store, stagingSettings);
    const io = capture();
    const code = await executeCli(["--json", "env", "list"], { ...io, environments: { store, home: await home() } });
    expect(code).toBe(0);
    expect(JSON.parse(io.out.join(""))).toMatchObject({ ok: true, data: { environments: ["staging"] } });
  });

  it("tells a plain-text listing there are no environments, rather than printing nothing", async () => {
    const io = capture();
    const code = await executeCli(["env", "list"], { ...io, environments: { store: new MemoryParameterStore(), home: await home() } });
    expect(code).toBe(0);
    expect(io.out.join("")).toBe("no environments in this account and region\n");
  });

  it("use writes the environment cache from SSM with owner-only permissions", async () => {
    const store = new MemoryParameterStore();
    await writeEnvironmentSettings(store, stagingSettings);
    const dir = await home();
    const io = capture();
    const code = await executeCli(["--env", "staging", "env", "use"], { ...io, environments: { store, home: dir } });
    expect(code).toBe(0);
    const path = environmentCachePath(dir, "staging");
    const text = await readFile(path, "utf8");
    expect(text).toContain("env: staging");
    expect(text).toContain(stagingSettings.controlPlaneUrl);
    expect(text).toContain(`clientId: ${stagingSettings.identity.clientId}`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("use explains how to install when the environment does not exist", async () => {
    const io = capture();
    const code = await executeCli(["--env", "nope", "env", "use"], { ...io, environments: { store: new MemoryParameterStore(), home: await home() } });
    expect(code).not.toBe(0);
    expect(io.err.join("")).toContain("environment nope is not installed in this account and region");
  });

  it("refuses an invalid --env before calling AWS", async () => {
    const store = new MemoryParameterStore();
    const io = capture();
    const code = await executeCli(["--env", "Prod", "env", "use"], { ...io, environments: { store, home: await home() } });
    expect(code).not.toBe(0);
    expect(store.calls).toEqual([]);
  });

  it("refuses the reserved placeholder --env before any AWS access, even though EnvironmentNameSchema itself accepts it", async () => {
    // A store whose every method throws: if the placeholder guard were ever bypassed, this test
    // would fail loudly on the store call itself, not just on an empty store.calls array.
    const throwingStore: ParameterStore = {
      get: () => { throw new Error("must not be called"); },
      put: () => { throw new Error("must not be called"); },
      delete: () => { throw new Error("must not be called"); },
      list: () => { throw new Error("must not be called"); },
    };
    const io = capture();
    const code = await executeCli(["--env", ENVIRONMENT_PLACEHOLDER, "env", "list"], { ...io, environments: { store: throwingStore, home: await home() } });
    expect(code).not.toBe(0);
    expect(io.err.join("")).toContain("reserved");
  });

  it("scopes env list's and env use's SSM client to --region", async () => {
    expect(await environmentSsmClient("eu-west-2").config.region()).toBe("eu-west-2");
  });

  it("accepts --region on env list and env use without disturbing a test-injected store", async () => {
    const store = new MemoryParameterStore();
    await writeEnvironmentSettings(store, stagingSettings);
    const io = capture();
    const listCode = await executeCli(["--json", "env", "list", "--region", "eu-west-2"], { ...io, environments: { store, home: await home() } });
    expect(listCode).toBe(0);
    expect(JSON.parse(io.out.join(""))).toMatchObject({ ok: true, data: { environments: ["staging"] } });

    const io2 = capture();
    const useCode = await executeCli(["--env", "staging", "env", "use", "--region", "eu-west-2"], { ...io2, environments: { store, home: await home() } });
    expect(useCode).toBe(0);
  });

  it("passes --region into env list's and env use's own SSM client construction, not just past a test-injected store", async () => {
    const store = new MemoryParameterStore();
    await writeEnvironmentSettings(store, stagingSettings);
    // A store override lets these commands run without a network call, but it must not be the only
    // thing standing between --region and the client: the CLI still builds its own region-scoped
    // client on every call, so a spy standing in for that client construction (returning a real,
    // harmless SSMClient, the same one environmentSsmClient would have built) can observe the region
    // the CLI actually passed in, regardless of the store override.
    const seenRegions: (string | undefined)[] = [];
    const ssmClient = (region?: string) => {
      seenRegions.push(region);
      return environmentSsmClient(region);
    };

    const io = capture();
    const listCode = await executeCli(["--json", "env", "list", "--region", "eu-west-2"], { ...io, environments: { store, home: await home(), ssmClient } });
    expect(listCode).toBe(0);

    const io2 = capture();
    const useCode = await executeCli(["--env", "staging", "env", "use", "--region", "eu-west-2"], { ...io2, environments: { store, home: await home(), ssmClient } });
    expect(useCode).toBe(0);

    expect(seenRegions).toEqual(["eu-west-2", "eu-west-2"]);
  });
});

describe("agentx env adopt", () => {
  const liveStacks: Record<string, { outputs: Record<string, string>; parameters: Record<string, string>; status: string }> = {
    AgentXProductionFoundation: { outputs: {}, parameters: {}, status: "UPDATE_COMPLETE" },
    AgentXProductionRuntime: { outputs: {}, parameters: { ModelId: "amazon.nova-pro-v1:0" }, status: "UPDATE_COMPLETE" },
    AgentXControlPlane: {
      outputs: { ApiEndpoint: "https://abc.execute-api.us-east-1.amazonaws.com" },
      parameters: { OidcIssuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_x", OidcAudience: "client123" },
      status: "UPDATE_COMPLETE",
    },
    AgentXSlackOrchestrator: { outputs: {}, parameters: { ModelId: "amazon.nova-pro-v1:0", GateClassifierModelId: "amazon.nova-lite-v1:0" }, status: "UPDATE_COMPLETE" },
  };
  const stacks: StackReader = { describe: async (name) => liveStacks[name] };
  const identity: CallerIdentity = { get: async () => ({ account: "944937319445", arn: "arn:aws:iam::944937319445:user/admin" }) };

  it("registers the existing deployment through the CLI, in the {ok,data} JSON shape", async () => {
    const store = new MemoryParameterStore();
    const io = capture();
    const code = await executeCli(
      ["--env", "production", "--json", "env", "adopt", "--region", "us-east-1"],
      { ...io, environments: { store, home: await home(), stacks, sts: identity } },
    );
    expect(code).toBe(0);
    expect(JSON.parse(io.out.join(""))).toMatchObject({
      ok: true,
      data: { env: "production", account: "944937319445", region: "us-east-1", naming: "legacy", controlPlaneUrl: "https://abc.execute-api.us-east-1.amazonaws.com" },
    });
  });

  it("prints a plain-text confirmation naming the settings path", async () => {
    const io = capture();
    const code = await executeCli(
      ["--env", "production", "env", "adopt", "--region", "us-east-1"],
      { ...io, environments: { store: new MemoryParameterStore(), home: await home(), stacks, sts: identity } },
    );
    expect(code).toBe(0);
    expect(io.out.join("")).toBe("Adopted production: https://abc.execute-api.us-east-1.amazonaws.com; settings in /agentx/production/settings\n");
  });

  it("refuses and writes nothing when a stack is missing, reported through the CLI error shape", async () => {
    const rest: typeof liveStacks = Object.fromEntries(Object.entries(liveStacks).filter(([name]) => name !== "AgentXSlackOrchestrator"));
    const store = new MemoryParameterStore();
    const io = capture();
    const code = await executeCli(
      ["--env", "production", "--json", "env", "adopt", "--region", "us-east-1"],
      { ...io, environments: { store, home: await home(), stacks: { describe: async (name) => rest[name] }, sts: identity } },
    );
    expect(code).not.toBe(0);
    expect(JSON.parse(io.err.join(""))).toMatchObject({ ok: false, error: { code: "CONFIG_INVALID", message: expect.stringContaining("AgentXSlackOrchestrator") as unknown } });
    expect(store.values.has("/agentx/production/settings")).toBe(false);
  });

  it("refuses through the CLI when --env is not production, calling nothing", async () => {
    const store = new MemoryParameterStore();
    const io = capture();
    const code = await executeCli(
      ["--env", "staging", "--json", "env", "adopt", "--region", "us-east-1"],
      { ...io, environments: { store, home: await home(), stacks, sts: identity } },
    );
    expect(code).not.toBe(0);
    expect(JSON.parse(io.err.join(""))).toMatchObject({
      ok: false,
      error: { code: "CONFIG_INVALID", message: expect.stringContaining("only the production environment can adopt") as unknown },
    });
    expect(store.calls).toEqual([]);
  });

  it("reads the stored bot token through the injected secrets and records the Slack team ID, never printing the token (F27)", async () => {
    const arn = "arn:aws:secretsmanager:us-east-1:944937319445:secret:SlackSecret-AbCdEf";
    const withSecret: StackReader = { describe: async (name) => (name === "AgentXControlPlane" ? { ...liveStacks[name]!, outputs: { ...liveStacks[name]!.outputs, SlackSecretArn: arn } } : liveStacks[name]) };
    const token = "xoxb-1-2-adoptsecret";
    const slackSecrets = memoryInitSecrets({ [arn]: JSON.stringify({ signingSecret: "a".repeat(32), botToken: token }) });
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const fetchImplementation = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push({ url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url, authorization: new Headers(init?.headers).get("authorization") });
      return Response.json({ ok: true, team_id: "T0TEAM1", user_id: "U0BOT", bot_id: "B0BOT" });
    }) as typeof fetch;
    const store = new MemoryParameterStore();
    const io = capture();
    const code = await executeCli(
      ["--env", "production", "env", "adopt", "--region", "us-east-1"],
      { ...io, fetchImplementation, environments: { store, home: await home(), stacks: withSecret, sts: identity, slackSecrets } },
    );
    expect(code).toBe(0);
    expect(seen).toEqual([{ url: "https://slack.com/api/auth.test", authorization: `Bearer ${token}` }]);
    expect(store.values.get("/agentx/production/slack/teamId")).toBe("T0TEAM1");
    expect(io.out.join("") + io.err.join("")).not.toContain(token);
  });

  it("still adopts, with one line on stderr, when the Slack secret has no bot token yet", async () => {
    const arn = "arn:aws:secretsmanager:us-east-1:944937319445:secret:SlackSecret-AbCdEf";
    const withSecret: StackReader = { describe: async (name) => (name === "AgentXControlPlane" ? { ...liveStacks[name]!, outputs: { ...liveStacks[name]!.outputs, SlackSecretArn: arn } } : liveStacks[name]) };
    const slackSecrets = memoryInitSecrets({ [arn]: JSON.stringify({ signingSecret: "placeholder", botToken: "unset" }) });
    const fetchImplementation = (async () => { throw new Error("test setup: Slack must not be called"); }) as typeof fetch;
    const store = new MemoryParameterStore();
    const io = capture();
    const code = await executeCli(
      ["--env", "production", "env", "adopt", "--region", "us-east-1"],
      { ...io, fetchImplementation, environments: { store, home: await home(), stacks: withSecret, sts: identity, slackSecrets } },
    );
    expect(code).toBe(0);
    expect(io.err.join("")).toBe("Could not record the Slack team ID (no bot token in the Slack secret); finish the Slack app step of agentx init, then run agentx signin enable slack\n");
    expect(store.values.has("/agentx/production/slack/teamId")).toBe(false);
    expect(store.values.has("/agentx/production/settings")).toBe(true);
  });

  it("scopes env adopt's SSM, CloudFormation and STS clients to --region", async () => {
    const clients = environmentAdoptClients("eu-west-2");
    expect(await clients.ssm.config.region()).toBe("eu-west-2");
    expect(await clients.cloudFormation.config.region()).toBe("eu-west-2");
    expect(await clients.sts.config.region()).toBe("eu-west-2");
  });
});

describe("deployment file resolution", () => {
  it("prefers an explicit file, then the environment cache, then the legacy file for production only", async () => {
    const dir = await home();
    await mkdir(join(dir, ".agentx", "environments"), { recursive: true });
    const legacy = join(dir, ".agentx", "deployment.yaml");
    await writeFile(legacy, "x");
    expect(await resolveDeploymentFile({ home: dir, env: "production", explicitFile: "/tmp/explicit.yaml" })).toBe("/tmp/explicit.yaml");
    expect(await resolveDeploymentFile({ home: dir, env: "production" })).toBe(legacy);
    await writeFile(environmentCachePath(dir, "production"), "x");
    expect(await resolveDeploymentFile({ home: dir, env: "production" })).toBe(environmentCachePath(dir, "production"));
    await expect(resolveDeploymentFile({ home: dir, env: "staging" })).rejects.toMatchObject({ message: expect.stringContaining("agentx --env staging env use") as unknown });
  });

  it("refuses a cache written for another environment", async () => {
    const dir = await home();
    await mkdir(join(dir, ".agentx", "environments"), { recursive: true });
    const path = environmentCachePath(dir, "staging");
    await writeFile(path, [
      "env: production",
      "controlPlaneUrl: https://abc.execute-api.us-east-1.amazonaws.com",
      "auth:",
      "  issuer: https://cognito-idp.us-east-1.amazonaws.com/us-east-1_x",
      "  clientId: client",
      "  audience: client",
      "",
    ].join("\n"));
    const io = capture();
    const code = await executeCli(["--env", "staging", "--json", "login"], { ...io, environments: { store: new MemoryParameterStore(), home: dir } });
    expect(code).not.toBe(0);
    expect(io.err.join("") + io.out.join("")).toContain("is for environment production, not staging");
  });
});

describe("writeEnvironmentCache", () => {
  it("removes the temp file when the rename to the target fails", async () => {
    const dir = await home();
    const target = environmentCachePath(dir, stagingSettings.env);
    // Occupy the target path with a directory, so the final rename() fails (EISDIR/ENOTEMPTY).
    await mkdir(target, { recursive: true });
    await expect(writeEnvironmentCache(dir, stagingSettings)).rejects.toThrow();
    await expect(stat(`${target}.${process.pid}.tmp`)).rejects.toThrow();
  });
});

describe("legacy deployment file and --env validation", () => {
  it("loads the legacy deployment file when no --env and no --deployment-file override it", async () => {
    const dir = await home();
    await mkdir(join(dir, ".agentx"), { recursive: true });
    await writeFile(join(dir, ".agentx", "deployment.yaml"), [
      "controlPlaneUrl: https://abc.execute-api.us-east-1.amazonaws.com",
      "auth:",
      "  issuer: https://cognito-idp.us-east-1.amazonaws.com/us-east-1_x",
      "  clientId: client",
      "  audience: client",
      "",
    ].join("\n"));
    const io = capture();
    const code = await executeCli(["admin", "credential", "list"], {
      ...io,
      tokenStore: new InMemoryTokenStore(),
      environments: { home: dir },
    });
    // No token is cached, so the command fails past settings loading, at the login check;
    // that proves the legacy file (the only settings source here) was found and parsed.
    expect(code).not.toBe(0);
    expect(io.err.join("")).toContain("run agentx login");
  });

  it("refuses an invalid --env before any SSM or file access, for a non-env command", async () => {
    const throwing: ParameterStore = {
      get: () => { throw new Error("must not be called"); },
      put: () => { throw new Error("must not be called"); },
      delete: () => { throw new Error("must not be called"); },
      list: () => { throw new Error("must not be called"); },
    };
    const io = capture();
    const code = await executeCli(["--env", "Prod", "login"], { ...io, environments: { store: throwing, home: await home() } });
    expect(code).not.toBe(0);
    expect(io.err.join("")).toContain("invalid --env");
  });
});

import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { environmentCachePath, resolveDeploymentFile, writeEnvironmentCache } from "../../packages/cli/src/environments/cache.js";
import type { ParameterStore } from "../../packages/cli/src/environments/parameter-store.js";
import { writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
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

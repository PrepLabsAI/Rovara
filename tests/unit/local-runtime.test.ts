// Port lane L4: `rovara up`'s runtime wired through the registry, with a simulated Docker.
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMPLICIT_COMPANY_ID, PluginRegistryError } from "@agentx/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { startLocalRuntime, type LocalRuntime } from "../../packages/broker/src/local/runtime.js";
import { TASK_FLOW_INDEXES } from "../../packages/broker/src/core/task-flow/flow.js";
import { FakeDocker } from "../support/local/fake-docker.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!();
});

async function launch(options: { environment?: NodeJS.ProcessEnv; config?: unknown; files?: Record<string, string>; thisMachine?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "rovara-l4-run-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, "state");
  await mkdir(stateDirectory, { mode: 0o700 });
  if (options.config !== undefined) await writeFile(join(stateDirectory, "config.json"), JSON.stringify(options.config), { mode: 0o600 });
  for (const [name, text] of Object.entries(options.files ?? {})) await writeFile(join(stateDirectory, name), text, { mode: 0o600 });
  const docker = new FakeDocker();
  const runtime: LocalRuntime = await startLocalRuntime({
    stateDirectory,
    cwd: join(root, "project"),
    environment: options.environment ?? {},
    workerImage: "worker:test",
    docker,
    version: "9.9.9",
    thisMachine: options.thisMachine === true,
  });
  cleanup.push(() => runtime.stop());
  const token = (await readFile(runtime.sessionTokenPath, "utf8")).trim();
  return { root, stateDirectory, docker, runtime, token };
}

describe("rovara up runtime", () => {
  it("starts on 127.0.0.1, answers /healthz without a login, and wires the registry from the first-run config", async () => {
    const { runtime, stateDirectory } = await launch();
    expect(runtime.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const health = await fetch(`${runtime.url}/healthz`);
    expect(await health.json()).toEqual({ status: "ok", version: "9.9.9" });
    expect((await lstat(join(stateDirectory, "config.json"))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(stateDirectory, "config.json"), "utf8"))).toEqual({ version: 1, plugins: [] });
    expect(runtime.wiring()).toMatchObject({
      storage: ["sqlite"],
      queue: ["sqlite"],
      "worker-machines": ["docker", "this-machine"],
      approvers: ["local-owner"],
      identity: ["local-owner"],
      admission: ["allow-all"],
      "model-keys": ["local"],
    });
  });

  it("keeps the session token in a 0600 file, and serves the status only with it", async () => {
    const { runtime, token } = await launch();
    expect((await lstat(runtime.sessionTokenPath)).mode & 0o777).toBe(0o600);
    expect((await fetch(`${runtime.url}/v1/local/status`)).status).toBe(401);
    expect((await fetch(`${runtime.url}/v1/local/status`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    const answer = await fetch(`${runtime.url}/v1/local/status`, { headers: { authorization: `Bearer ${token}` } });
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { company: string; wiring: Record<string, string[]> };
    expect(body.company).toBe(IMPLICIT_COMPANY_ID);
    expect(JSON.stringify(body)).not.toContain(token);
  });

  it("hosts the in-memory broker routes behind the same login", async () => {
    const { runtime, token } = await launch();
    const open = await fetch(`${runtime.url}/v1/projects/demo/workspace?revision=1`);
    expect(open.status).toBe(401);
    const signedIn = await fetch(`${runtime.url}/v1/projects/demo/workspace?revision=1`, { headers: { authorization: `Bearer ${token}` } });
    expect(signedIn.status).toBe(404); // logged in, and no such project
  });

  it("reads the model key from the environment, then the owner-only key file, and refuses a key file others can read", async () => {
    const envRun = await launch({ environment: { ANTHROPIC_API_KEY: "from-env" }, files: { "keys.json": JSON.stringify({ openai: "from-file", github: "ghp-from-file" }) } });
    const keys = envRun.runtime.registry.require("model-keys");
    expect((await keys.get(IMPLICIT_COMPANY_ID, "anthropic"))?.reveal()).toBe("from-env");
    expect((await keys.get(IMPLICIT_COMPANY_ID, "openai"))?.reveal()).toBe("from-file");
    expect(String(await keys.get(IMPLICIT_COMPANY_ID, "anthropic"))).toBe("[secret]");
    expect(await keys.providers(IMPLICIT_COMPANY_ID)).toEqual(["anthropic", "github", "openai"]);

    const loose = await launch({ files: { "keys.json": JSON.stringify({ openai: "x" }) } });
    await (await import("node:fs/promises")).chmod(join(loose.stateDirectory, "keys.json"), 0o644);
    await expect(loose.runtime.registry.require("model-keys").get(IMPLICIT_COMPANY_ID, "openai")).rejects.toThrow(/readable by other users/);
  });

  it("lets a configured storage plug-in replace the default, and seals the registry afterwards", async () => {
    // A configured store must keep the indexes the task flow needs; the SQLite plug-in takes them as a setting.
    const root = await mkdtemp(join(tmpdir(), "rovara-l4-db-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const indexes = TASK_FLOW_INDEXES.map(({ name, partitionAttribute, sortAttribute, sortType }) => ({ name, partitionAttribute, ...(sortAttribute === undefined ? {} : { sortAttribute }), ...(sortType === undefined ? {} : { sortType }) }));
    const { runtime, stateDirectory } = await launch({
      config: { version: 1, plugins: [{ point: "storage", name: "sqlite", module: "@agentx/local-adapters/storage", settings: { path: join(root, "custom.db"), indexes, ttlAttribute: "indexExpiresAt" } }] },
    });
    expect(runtime.wiring().storage).toEqual(["sqlite"]);
    // The configured store is the one at the configured path; the default was not opened beside it.
    await expect(lstat(join(root, "custom.db"))).resolves.toBeDefined();
    await expect(lstat(join(stateDirectory, "state.db"))).resolves.toBeDefined(); // the queue still lives in the state folder
    expect(() => runtime.registry.register("approvers", "evil", {} as never)).toThrow(PluginRegistryError);
    expect(() => runtime.registry.unregister("identity", "local-owner")).toThrow(PluginRegistryError);
  });

  it("refuses a plug-in module under the task workspaces, and a state folder inside the project folder", async () => {
    const plugin = `export const plugin = { point: "storage", name: "custom", create: () => ({}) };\n`;
    const root = await mkdtemp(join(tmpdir(), "rovara-l4-run-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const stateDirectory = join(root, "state");
    await mkdir(join(stateDirectory, "workspaces", "abc"), { recursive: true, mode: 0o700 });
    await writeFile(join(stateDirectory, "workspaces", "abc", "evil.mjs"), plugin, { mode: 0o600 });
    await writeFile(join(stateDirectory, "config.json"), JSON.stringify({ version: 1, plugins: [{ point: "storage", name: "custom", module: "./workspaces/abc/evil.mjs" }] }), { mode: 0o600 });
    await expect(startLocalRuntime({ stateDirectory, cwd: root + "-elsewhere", environment: {}, workerImage: "w", docker: new FakeDocker(), version: "1" })).rejects.toThrow(/could not be loaded/);
    // A module another user can write is refused too.
    await writeFile(join(stateDirectory, "loose.mjs"), plugin, { mode: 0o666 });
    await (await import("node:fs/promises")).chmod(join(stateDirectory, "loose.mjs"), 0o666);
    await writeFile(join(stateDirectory, "config.json"), JSON.stringify({ version: 1, plugins: [{ point: "storage", name: "custom", module: "./loose.mjs" }] }), { mode: 0o600 });
    await expect(startLocalRuntime({ stateDirectory, cwd: root + "-elsewhere", environment: {}, workerImage: "w", docker: new FakeDocker(), version: "1" })).rejects.toThrow(/could not be loaded/);
    // A repository's own .rovara folder is not a state folder.
    const repo = join(root, "repo");
    await mkdir(join(repo, ".rovara"), { recursive: true, mode: 0o755 });
    await expect(startLocalRuntime({ stateDirectory: join(repo, ".rovara"), cwd: repo, environment: {}, workerImage: "w", docker: new FakeDocker(), version: "1" })).rejects.toThrow(/inside the folder you are in/);
  });

  it("refuses a config module that is not inside the state folder or is a built-in", async () => {
    await expect(launch({ config: { version: 1, plugins: [{ point: "storage", name: "custom", module: "../escape.mjs" }] } })).rejects.toThrow(/plug-in config is not valid/);
    await expect(launch({ config: { version: 1, plugins: [{ point: "storage", name: "custom", module: "child_process" }] } })).rejects.toThrow(/plug-in config is not valid/);
    await expect(launch({ config: { version: 1, plugins: [{ point: "storage", name: "custom", module: "/tmp/x.mjs" }] } })).rejects.toThrow(/plug-in config is not valid/);
  });

  it("does not quote a broken config or a failing plug-in", async () => {
    const root = await mkdtemp(join(tmpdir(), "rovara-l4-run-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { mode: 0o700 });
    await writeFile(join(stateDirectory, "config.json"), '{"version":1,"plugins":[{"point":"storage","name":"custom","module":"./p.mjs","settings":{"token":"sk-ant-SHOULD-NOT-APPEAR"}}]}', { mode: 0o600 });
    await writeFile(join(stateDirectory, "p.mjs"), 'export const plugin = { point: "storage", name: "custom", create: (c) => { throw new Error(JSON.stringify(c.settings)); } };\n', { mode: 0o600 });
    const error = await startLocalRuntime({ stateDirectory, cwd: root, environment: {}, workerImage: "w", docker: new FakeDocker(), version: "1" }).catch((caught: unknown) => caught);
    expect(String((error as Error).message)).not.toContain("SHOULD-NOT-APPEAR");
  });

  it("refuses to start when the config sits inside the project folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "rovara-l4-run-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "repo-config.json"), '{"version":1,"plugins":[]}', { mode: 0o600 });
    await expect(startLocalRuntime({ stateDirectory: join(root, "state"), configPath: "repo-config.json", cwd: root, environment: {}, workerImage: "w", docker: new FakeDocker(), version: "1" })).rejects.toThrow(/inside the folder you are in/);
  });

  it("registers the this-machine adapter refusing, and stops the running workers on stop()", async () => {
    const { runtime, docker } = await launch();
    const thisMachine = runtime.registry.require("worker-machines", "this-machine");
    const refusal = await thisMachine.start({ machineKey: "k", companyId: IMPLICIT_COMPANY_ID }).catch((caught: unknown) => caught as Error);
    expect(refusal).toMatchObject({ code: "rejected" });
    expect((refusal as Error).message).toContain("--this-machine");
    const dockerMachines = runtime.registry.require("worker-machines", "docker");
    const handle = await dockerMachines.start({ machineKey: "ws-up", companyId: IMPLICIT_COMPANY_ID });
    expect(docker.containers.get(handle.machineId)!.status).toBe("running");
    // The worker calls back on the callback listener, a port of its own that is not the owner's server.
    const hash = handle.machineId.slice("rovara-worker-".length);
    const gateway = JSON.parse(docker.containers.get(`rovara-gw-${hash}`)!.environment.ROVARA_GW_CONFIG!) as { callback: { hostHeader: string } };
    const callbackPort = Number(gateway.callback.hostHeader.split(":")[1]);
    expect(callbackPort).toBeGreaterThan(0);
    expect(callbackPort).not.toBe(runtime.port);
    expect(docker.containers.get(handle.machineId)!.environment.AGENTX_CONTROL_PLANE_URL).toBe("http://rovara-broker:8081");
    // Not the owner's host name, so it is turned away; the owner's own routes are not served there at all (callback-server.ts).
    await expect(fetch(`http://127.0.0.1:${callbackPort}/v1/local/status`, { method: "POST" })).resolves.toMatchObject({ status: 403 });
    await runtime.stop();
    expect(docker.containers.get(handle.machineId)!.status).toBe("exited");
    await expect(fetch(`${runtime.url}/healthz`)).rejects.toThrow();
  });
});

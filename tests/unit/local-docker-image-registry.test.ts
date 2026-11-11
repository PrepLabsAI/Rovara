// The local Docker adapter for the image registry: the shared conformance suite against a fake registry API, and what it does to the owner's Docker (only a container it labelled, loopback only, no privileges).
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ImageRegistryError, savedEnvRepositoryName } from "@agentx/contracts";
import { LOCAL_REGISTRY_IMAGE, REGISTRY_LABEL, createDockerImageRegistry } from "../../packages/broker/src/local/docker-image-registry.js";
import type { DockerRunner } from "../../packages/broker/src/local/docker-runner.js";
import { startFakeRegistryServer } from "../support/fake-registry-server.js";
import { runImageRegistryConformance } from "../support/ports/image-registry-conformance.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const step of cleanup.splice(0)) await step(); });

interface FakeContainer { labels: Record<string, string>; running: boolean }
/** A Docker that knows containers by name, answers the few commands the adapter makes, and records every call. */
function fakeDocker(port: string, existing: Record<string, FakeContainer> = {}) {
  const containers = new Map<string, FakeContainer>(Object.entries(existing));
  const calls: string[][] = [];
  const runner: DockerRunner = {
    async run(args) {
      calls.push([...args]);
      const [command] = args;
      const name = args[args.indexOf("--name") + 1] ?? args[args.length - 1]!;
      if (command === "inspect") {
        const found = containers.get(args[args.length - 1]!);
        if (found === undefined) return { exitCode: 1, stdout: "", stderr: "no such object" };
        return { exitCode: 0, stdout: `${found.labels[REGISTRY_LABEL] ?? ""}\t${found.labels["rovara.local.state"] ?? ""}\t${String(found.running)}\n`, stderr: "" };
      }
      if (command === "run") {
        const labels: Record<string, string> = {};
        args.forEach((value, index) => { if (value === "--label") { const [key, ...rest] = args[index + 1]!.split("="); labels[key!] = rest.join("="); } });
        containers.set(name, { labels, running: true });
        return { exitCode: 0, stdout: "abc123\n", stderr: "" };
      }
      if (command === "start") { const found = containers.get(args[1]!); if (found === undefined) return { exitCode: 1, stdout: "", stderr: "" }; found.running = true; return { exitCode: 0, stdout: "", stderr: "" }; }
      if (command === "stop") { const found = containers.get(args[1]!); if (found !== undefined) found.running = false; return { exitCode: 0, stdout: "", stderr: "" }; }
      if (command === "port") return { exitCode: 0, stdout: `127.0.0.1:${port}\n[::]:${port}\n`, stderr: "" };
      if (command === "exec") return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "unexpected" };
    },
  };
  return { runner, calls, containers };
}

async function bench(options: { workerAccess?: boolean; existing?: (stateHashName: string) => Record<string, FakeContainer>; now?: () => number } = {}) {
  const server = await startFakeRegistryServer();
  cleanup.push(() => server.close());
  const stateDirectory = await mkdtemp(join(tmpdir(), "rovara-registry-test-"));
  cleanup.push(() => rm(stateDirectory, { recursive: true, force: true }));
  const docker = fakeDocker(server.address.split(":")[1]!);
  const registry = createDockerImageRegistry({ docker: docker.runner, stateDirectory, ...(options.workerAccess === undefined ? {} : { workerAccess: options.workerAccess }), ...(options.now === undefined ? {} : { now: options.now }) });
  return { server, stateDirectory, docker, registry };
}
const repositoryFor = (project: string): string => savedEnvRepositoryName({ env: "test", orgId: "org_00000000000000000000", projectId: project });
const CALL = { companyId: "org_00000000000000000000" };

runImageRegistryConformance("the local Docker adapter", {
  async create() {
    const { server, registry } = await bench();
    return { registry, async push(repository) { return server.push(repository, `t${String(Math.random()).slice(2, 8)}`); } };
  },
});

describe("the registry container", () => {
  it("is started once, labelled, on loopback only, with no privilege, deletes on, and its data under the state folder", async () => {
    const { registry, docker, stateDirectory, server } = await bench();
    await registry.address();
    await registry.address();
    const run = docker.calls.filter((call) => call[0] === "run");
    expect(run).toHaveLength(1);
    const args = run[0]!;
    expect(args).toContain("--detach");
    expect(args[args.indexOf("--publish") + 1]).toBe("127.0.0.1::5000");
    expect(args.join(" ")).not.toMatch(/--publish [^1]|--publish 0\.0\.0\.0|--network host|--privileged|docker\.sock/u);
    expect(args).toContain(`${REGISTRY_LABEL}=1`);
    expect(args).toContain("REGISTRY_STORAGE_DELETE_ENABLED=true");
    expect(args[args.indexOf("--cap-drop") + 1]).toBe("ALL");
    expect(args).toContain("no-new-privileges");
    expect(args).toContain("--read-only");
    expect(args[args.indexOf("--volume") + 1]).toBe(`${join(stateDirectory, "registry")}:/var/lib/registry`);
    expect(args[args.length - 1]).toBe(LOCAL_REGISTRY_IMAGE);
    expect(args[args.indexOf("--name") + 1]).toMatch(/^rovara-image-registry-[0-9a-f]{12}$/u);
    expect(await registry.address()).toBe(server.address);
  });

  it("starts its own stopped container instead of making another, and never touches a container of that name that it did not label", async () => {
    const first = await bench();
    await first.registry.address();
    const [entry] = [...first.docker.containers];
    const name = entry![0];
    const mine = entry![1];
    mine.running = false;
    const sameState = fakeDocker(first.server.address.split(":")[1] ?? "", { [name]: mine });
    const again = createDockerImageRegistry({ docker: sameState.runner, stateDirectory: first.stateDirectory });
    expect(await again.address()).toBe(first.server.address);
    expect(sameState.calls.some((call) => call[0] === "start")).toBe(true);
    expect(sameState.calls.some((call) => call[0] === "run")).toBe(false);
    // somebody else's container with the name: refused, and nothing is started, stopped or removed
    const foreign = fakeDocker(first.server.address.split(":")[1]!, { [name]: { labels: { owner: "someone" }, running: true } });
    const refused = createDockerImageRegistry({ docker: foreign.runner, stateDirectory: first.stateDirectory });
    await expect(refused.list({ ...CALL, repository: repositoryFor("alpha") })).rejects.toBeInstanceOf(ImageRegistryError);
    await refused.stop();
    expect(foreign.calls.filter((call) => ["run", "start", "stop", "rm", "kill", "exec"].includes(call[0]!))).toEqual([]);
    expect(foreign.containers.get(name)?.running).toBe(true);
    // a container with our label but ANOTHER state folder's hash is not ours either
    const otherState = fakeDocker(first.server.address.split(":")[1]!, { [name]: { labels: { [REGISTRY_LABEL]: "1", "rovara.local.state": "ffffffffffff" }, running: true } });
    await expect(createDockerImageRegistry({ docker: otherState.runner, stateDirectory: first.stateDirectory }).address()).rejects.toBeInstanceOf(ImageRegistryError);
  });

  it("uses a published address only when it is on loopback, and says unavailable when docker cannot start it or the API is down", async () => {
    const server = await startFakeRegistryServer();
    cleanup.push(() => server.close());
    const stateDirectory = await mkdtemp(join(tmpdir(), "rovara-registry-test-"));
    cleanup.push(() => rm(stateDirectory, { recursive: true, force: true }));
    const wide: DockerRunner = { run: async (args) => (args[0] === "inspect" ? { exitCode: 1, stdout: "", stderr: "" } : args[0] === "port" ? { exitCode: 0, stdout: "0.0.0.0:49000\n", stderr: "" } : { exitCode: 0, stdout: "x", stderr: "" }) };
    await expect(createDockerImageRegistry({ docker: wide, stateDirectory }).address()).rejects.toMatchObject({ code: "unavailable" });
    const broken: DockerRunner = { run: async () => ({ exitCode: -1, stdout: "", stderr: "docker is not installed" }) };
    await expect(createDockerImageRegistry({ docker: broken, stateDirectory }).login({ ...CALL, repository: repositoryFor("alpha"), access: "push", maxSeconds: 60 })).rejects.toMatchObject({ code: "unavailable" });
    const { registry, server: running } = await bench();
    running.down = true;
    await expect(registry.list({ ...CALL, repository: repositoryFor("alpha") })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("stops only its own running container", async () => {
    const { registry, docker } = await bench();
    await registry.address();
    await registry.stop();
    expect(docker.calls.filter((call) => call[0] === "stop")).toHaveLength(1);
    await registry.stop();
    expect(docker.calls.filter((call) => call[0] === "stop")).toHaveLength(1);
  });
});

describe("what a worker may do with it", () => {
  it("cannot push or pull until the install says the worker can reach it, and the login names one repository, one user, and no more time than asked", async () => {
    const closed = await bench();
    expect(closed.registry.capabilities).toEqual({ workerPush: false, workerPull: false, scan: false });
    // Worker access is refused while the registry has no authentication to check a login against.
    await expect(bench({ workerAccess: true })).rejects.toThrow(/checks the login/);
    const open = closed;
    const login = await open.registry.login({ ...CALL, repository: repositoryFor("alpha"), access: "push", maxSeconds: 120 });
    expect(login.auth).toMatchObject({ registry: open.server.address, repository: repositoryFor("alpha"), username: "rovara-local" });
    expect(login.auth.password.length).toBeGreaterThanOrEqual(16);
    expect(login.expiresAtMs).toBeLessThanOrEqual(Date.now() + 121_000);
    const other = await open.registry.login({ ...CALL, repository: repositoryFor("alpha"), access: "push", maxSeconds: 120 });
    expect(other.auth.password).not.toBe(login.auth.password);
  });

  it("deletes by digest through the API (202 only counts as done) and a registry with deletes switched off is not read as done", async () => {
    const { registry, server } = await bench();
    const repository = repositoryFor("alpha");
    const digest = server.push(repository, "one");
    server.deleteStatus = 405;
    await expect(registry.deleteImages({ ...CALL, repository, digests: [digest] })).rejects.toMatchObject({ code: "unavailable" });
    expect(await registry.list({ ...CALL, repository })).toHaveLength(1);
    server.deleteStatus = 202;
    await registry.deleteImages({ ...CALL, repository, digests: [digest] });
    expect(await registry.list({ ...CALL, repository })).toBe("absent");
    expect(server.requests.some((request) => request.startsWith(`DELETE /v2/${repository}/manifests/${digest}`))).toBe(true);
  });

  it("refuses a digest or a repository that is not the shape it makes, before any request reaches the registry", async () => {
    const { registry, server } = await bench();
    await expect(registry.deleteImages({ ...CALL, repository: repositoryFor("alpha"), digests: ["latest"] })).rejects.toMatchObject({ code: "refused" });
    await expect(registry.deleteImages({ ...CALL, repository: "../../v2/_catalog", digests: [] })).rejects.toMatchObject({ code: "refused" });
    expect(server.requests).toEqual([]);
  });

  it("reports an image's push time as the time it was first seen, kept in the state folder, and not moved by a later look", async () => {
    let now = Date.parse("2026-11-09T10:00:00Z");
    const { registry, server, stateDirectory } = await bench({ now: () => now });
    const repository = repositoryFor("alpha");
    const digest = server.push(repository, "one");
    const first = await registry.list({ ...CALL, repository });
    expect(first).toEqual([{ digest, tags: ["one"], pushedAt: "2026-11-09T10:00:00.000Z" }]);
    now += 3_600_000;
    expect(await registry.list({ ...CALL, repository })).toEqual(first);
    expect(JSON.parse(await readFile(join(stateDirectory, "registry-first-seen.json"), "utf8"))).toEqual({ [`${repository}@${digest}`]: "2026-11-09T10:00:00.000Z" });
  });
});

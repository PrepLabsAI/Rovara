// Test services on the local Docker worker, the broker's side: the catalog it trusts (and what it does with none), the images it pulls on the host, and how the worker machine is told about test services. The guard's rules
// are in local-test-services-guard.test.ts; the real daemon is in tests/integration/local-test-services-isolation.test.ts.
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_FILE, CATALOG_SIGNATURE_ALGORITHM, CATALOG_SIGNATURE_FILE, catalogPins, catalogSigningMessage, parseBundlePublicKey, sha256HexOf, MachineError } from "@rovara-code/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { DockerResult, DockerRunner } from "../../packages/core/src/local/docker-runner.js";
import { DockerWorkerMachines } from "../../packages/core/src/local/docker-worker-machines.js";
import { createEphemeralInvokeSigner } from "../../packages/core/src/local/invoke-signer.js";
import { NO_TRUSTED_CATALOG_SENTENCE, loadLocalServiceCatalog, localTestServicesFrom, prepareTestServiceImages, removePulledTestServiceImages, testServicesEnvironment } from "../../packages/core/src/local/test-services.js";
import { FakeDocker } from "../support/local/fake-docker.js";
import { pinnedCatalog, verifiedCatalog } from "../support/catalog-pinning.js";

const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";
const cleanup: string[] = [];
afterEach(async () => { while (cleanup.length > 0) await rm(cleanup.pop()!, { recursive: true, force: true }); });
async function folder(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rovara-ts-"));
  cleanup.push(directory);
  return directory;
}

describe("the catalog a local install trusts", () => {
  it("is refused with the one sentence when the files are missing", async () => {
    const result = await loadLocalServiceCatalog(await folder());
    expect(result).toMatchObject({ ok: false, sentence: NO_TRUSTED_CATALOG_SENTENCE });
  });

  it("is refused when it is signed by a key this release does not trust (a release with no compiled-in key trusts none)", async () => {
    const directory = await folder();
    const catalogBytes = Buffer.from(JSON.stringify(pinnedCatalog(), null, 2));
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const signature = createSign("sha256").update(catalogSigningMessage(catalogBytes)).sign({ key: privateKey, dsaEncoding: "der" }).toString("base64");
    await writeFile(join(directory, CATALOG_FILE), catalogBytes);
    await writeFile(join(directory, CATALOG_SIGNATURE_FILE), JSON.stringify({ schemaVersion: 1, algorithm: CATALOG_SIGNATURE_ALGORITHM, keyId: parseBundlePublicKey(pem).keyId, catalogSha256: sha256HexOf(catalogBytes), signature }));
    const result = await loadLocalServiceCatalog(directory);
    expect(result).toMatchObject({ ok: false, sentence: NO_TRUSTED_CATALOG_SENTENCE, reason: "no trusted catalog key" });
  });
});

/** A docker that knows which images it holds, writes down every call, and fails the pulls it is told to. */
function pullingDocker(held: Set<string>, failing: ReadonlySet<string> = new Set()): DockerRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async run(args): Promise<DockerResult> {
      calls.push([...args]);
      const reference = args[args.length - 1]!;
      if (args[0] === "image" && args[1] === "inspect") return held.has(reference) ? { exitCode: 0, stdout: "sha256:abc\n", stderr: "" } : { exitCode: 1, stdout: "", stderr: "Error: No such image" };
      if (args[0] === "pull") {
        if ([...failing].some((part) => reference.includes(part))) return { exitCode: 1, stdout: "", stderr: "Error response from daemon: manifest unknown" };
        held.add(reference);
        return { exitCode: 0, stdout: `${reference}\n`, stderr: "" };
      }
      if (args[0] === "rmi") { const had = held.delete(reference); return had ? { exitCode: 0, stdout: "", stderr: "" } : { exitCode: 1, stdout: "", stderr: "Error: No such image" }; }
      return { exitCode: 1, stdout: "", stderr: "unexpected" };
    },
  };
}

describe("pulling the catalog's images on the host", () => {
  const catalog = () => verifiedCatalog(pinnedCatalog());
  const pins = () => catalogPins(catalog(), "public").filter((pin, index, all) => all.findIndex((other) => other.repository === pin.repository && other.digest === pin.digest) === index);

  it("pulls each pinned image by its digest from the install's registry, and returns the references the guard may let start", async () => {
    const state = await folder();
    const docker = pullingDocker(new Set());
    const result = await prepareTestServiceImages({ docker, catalog: catalog(), registry: "registry.example:5000", catalogEnv: "local", stateDirectory: state });
    const pulls = docker.calls.filter((call) => call[0] === "pull").map((call) => call[call.length - 1]!);
    expect(pulls.length).toBeGreaterThan(0);
    for (const reference of pulls) expect(reference).toMatch(/^registry\.example:5000\/rovara-catalog\/local\/svc\/[a-z0-9._-]+@sha256:[a-f0-9]{64}$/u);
    expect(result.images.sort()).toEqual([...new Set(pulls)].sort());
    expect(result.notPulled).toEqual([]);
    expect(result.pulledNow.sort()).toEqual(result.images.sort());
    // A pin that is not in the catalog is never pulled, and a tag is never built.
    expect(pulls.some((reference) => !reference.includes("@sha256:"))).toBe(false);
    expect(pins().length).toBeLessThanOrEqual(result.images.length + 5);
  });

  it("leaves an image the owner already had alone, and never removes it", async () => {
    const state = await folder();
    const first = pins()[0]!;
    const theirs = `registry.example:5000/rovara-catalog/local/${first.repository}@sha256:${first.digest}`;
    const held = new Set([theirs]);
    const docker = pullingDocker(held);
    const result = await prepareTestServiceImages({ docker, catalog: catalog(), registry: "registry.example:5000", catalogEnv: "local", stateDirectory: state });
    expect(docker.calls.filter((call) => call[0] === "pull").map((call) => call[call.length - 1])).not.toContain(theirs);
    expect(result.images).toContain(theirs);
    expect(result.pulledNow).not.toContain(theirs);
    const removed = await removePulledTestServiceImages({ docker, stateDirectory: state });
    expect(removed).not.toContain(theirs);
    expect(held.has(theirs)).toBe(true);
    // What it pulled itself is removed, and the bookkeeping file goes with it.
    expect([...held]).toEqual([theirs]);
    await expect(stat(join(state, "test-services-images.json"))).rejects.toThrow();
  });

  it("leaves the repository of an image that failed to pull in notPulled, so the worker offers nothing that needs it", async () => {
    const state = await folder();
    const result = await prepareTestServiceImages({ docker: pullingDocker(new Set(), new Set(["svc/postgres"])), catalog: catalog(), registry: "registry.example", catalogEnv: "local", stateDirectory: state });
    expect(result.notPulled).toContain("svc/postgres");
    expect(result.failed.length).toBeGreaterThan(0);
    expect(result.images.some((reference) => reference.includes("svc/postgres@"))).toBe(false);
  });

  it("refuses a registry or an environment that is not a name the catalog makes, pulling nothing", async () => {
    const docker = pullingDocker(new Set());
    const result = await prepareTestServiceImages({ docker, catalog: catalog(), registry: "evil host/x;rm", catalogEnv: "local", stateDirectory: await folder() });
    expect(result.images).toEqual([]);
    expect(docker.calls.filter((call) => call[0] === "pull")).toEqual([]);
    const second = await prepareTestServiceImages({ docker, catalog: catalog(), registry: "registry.example", catalogEnv: "Local Env", stateDirectory: await folder() });
    expect(second.images).toEqual([]);
  });

  it("writes the bookkeeping file only with owner access", async () => {
    const state = await folder();
    await prepareTestServiceImages({ docker: pullingDocker(new Set()), catalog: catalog(), registry: "registry.example", catalogEnv: "local", stateDirectory: state });
    const info = await stat(join(state, "test-services-images.json"));
    expect(info.mode & 0o077).toBe(0);
    expect((JSON.parse(await readFile(join(state, "test-services-images.json"), "utf8")) as { references: string[] }).references.length).toBeGreaterThan(0);
  });
});

describe("the worker machine with test services", () => {
  const services = { registry: "registry.example:5000", catalogEnv: "local", images: ["registry.example:5000/rovara-catalog/local/svc/postgres@sha256:" + "b".repeat(64)], maxMemoryMiB: 2048 };
  async function build(withServices: boolean, extra: { images?: string[] } = {}) {
    const stateDirectory = await folder();
    const docker = new FakeDocker();
    const machines = new DockerWorkerMachines({
      image: "worker:test", stateDirectory, callback: () => ({ tcpPort: 1234 }), signer: createEphemeralInvokeSigner(), docker, fetch: docker.fetch,
      ...(withServices ? { testServices: { ...services, ...(extra.images === undefined ? {} : { images: extra.images }) } } : {}),
    });
    return { stateDirectory, docker, machines };
  }
  interface GuardPolicy { workspaceDir: string; services: { images: string[]; guardImage: string; runDirectory: string; bindDirectory: string; socketGroup: number; maxMemoryMiB?: number } }
  const policyOf = (docker: FakeDocker, hash: string): GuardPolicy => {
    const guard = docker.containers.get(`rovara-sock-${hash}`)!;
    const text = guard.args.find((entry) => entry.startsWith("ROVARA_SOCK_POLICY="))!;
    return JSON.parse(text.slice("ROVARA_SOCK_POLICY=".length)) as GuardPolicy;
  };

  it("with test services off is the machine it always was: no run folder, no extra mount, no services in the guard's policy, no test services variable", async () => {
    const { machines, docker, stateDirectory } = await build(false);
    const handle = await machines.start({ machineKey: "ws-off", companyId: COMPANY });
    const hash = handle.machineId.slice("rovara-worker-".length);
    expect("services" in policyOf(docker, hash)).toBe(false);
    const worker = docker.containers.get(handle.machineId)!;
    expect(worker.args.filter((entry) => entry === "--volume")).toHaveLength(1);
    expect(Object.keys(worker.environment).filter((name) => name.startsWith("AGENTX_TEST_SERVICES") || name === "AGENTX_WORKER_IMAGE")).toEqual([]);
    await expect(stat(join(stateDirectory, "test-services"))).rejects.toThrow();
    await machines.terminate(handle.machineId);
    expect(docker.calls.some((call) => call.includes("rovara.local.sandbox=service") || (call[0] === "network" && call[1] === "ls"))).toBe(false);
  });

  it("with test services on tells the worker its registry, environment, run folder and own pinned image, mounts the folder in the worker alone, and gives the guard the list", async () => {
    const { machines, docker, stateDirectory } = await build(true);
    const handle = await machines.start({ machineKey: "ws-on", companyId: COMPANY });
    const hash = handle.machineId.slice("rovara-worker-".length);
    const runDirectory = join(stateDirectory, "test-services", hash);
    const worker = docker.containers.get(handle.machineId)!;
    const imageId = `sha256:${createHash("sha256").update("worker:test").digest("hex")}`;
    expect(worker.environment).toMatchObject({ AGENTX_TEST_SERVICES_REGISTRY: "registry.example:5000", AGENTX_TEST_SERVICES_ENV: "local", AGENTX_TEST_SERVICES_RUN_DIR: runDirectory, AGENTX_WORKER_IMAGE: imageId, AGENTX_TEST_SERVICES_MAX_MEM_MIB: "2048" });
    expect(worker.args.filter((entry) => entry === "--volume")).toHaveLength(2);
    expect(worker.args).toContain(`${runDirectory}:${runDirectory}`);
    // The run folder is not inside the workspace the sandboxes mount.
    expect(runDirectory.startsWith(`${join(stateDirectory, "workspaces", hash)}/`)).toBe(false);
    expect((await stat(runDirectory)).mode & 0o777).toBe(0o777);
    expect((await stat(join(stateDirectory, "test-services"))).mode & 0o077).toBe(0);
    const policy = policyOf(docker, hash);
    const bindDirectory = `${runDirectory}-binds`;
    expect(policy.services).toEqual({ images: services.images, guardImage: imageId, runDirectory, bindDirectory, socketGroup: policy.services?.socketGroup, maxMemoryMiB: 2048 });
    expect(typeof policy.services?.socketGroup).toBe("number");
    // The folder for the guard's copies sits beside the run folder (never inside it), is not mounted into the worker, and the sandboxes' policy is unchanged.
    expect(bindDirectory.startsWith(`${runDirectory}/`)).toBe(false);
    expect(worker.args).not.toContain(`${bindDirectory}:${bindDirectory}`);
    expect(policy.workspaceDir).toBe(join(stateDirectory, "workspaces", hash));
    // The guard reads the run folder read-only (it copies the files a service container mounts) and writes its copies into its own folder.
    const guardArgs = docker.containers.get(`rovara-sock-${hash}`)!.args;
    const guardVolumes = guardArgs.filter((entry, index) => guardArgs[index - 1] === "--volume");
    expect(guardVolumes).toContain(`${runDirectory}:${runDirectory}:ro`);
    expect(guardVolumes).toContain(`${bindDirectory}:${bindDirectory}`);
  });

  it("does not let a job's environment name the test services settings or the worker's own image", async () => {
    const { machines } = await build(true);
    for (const name of ["AGENTX_WORKER_IMAGE", "AGENTX_TEST_SERVICES_REGISTRY", "AGENTX_TEST_SERVICES_RUN_DIR", "AGENTX_TEST_SERVICES_ENV", "AGENTX_TEST_SERVICES_NOT_PULLED", "AGENTX_TEST_SERVICES_MAX_MEM_MIB", "AGENTX_TEST_SERVICES_EDITION"]) {
      await expect(machines.start({ machineKey: `ws-${name.length}`, companyId: COMPANY, environment: { [name]: "x" } }), name).rejects.toBeInstanceOf(MachineError);
    }
  });

  it("lists the repositories that did not pull for the worker, and re-creates an idle machine when the list of images changes", async () => {
    const stateDirectory = await folder();
    const docker = new FakeDocker();
    const make = (images: string[], notPulled?: string[]) => new DockerWorkerMachines({
      image: "worker:test", stateDirectory, callback: () => ({ tcpPort: 1234 }), signer: createEphemeralInvokeSigner(), docker, fetch: docker.fetch,
      testServices: { ...services, images, ...(notPulled === undefined ? {} : { notPulled }) },
    });
    const first = await make(services.images).start({ machineKey: "ws-change", companyId: COMPANY });
    const hash = first.machineId.slice("rovara-worker-".length);
    expect(policyOf(docker, hash).services.images).toEqual(services.images);
    const guardBefore = docker.containers.get(`rovara-sock-${hash}`)!.createdAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await make([...services.images, "registry.example:5000/rovara-catalog/local/svc/redis@sha256:" + "c".repeat(64)], ["svc/mysql"]).start({ machineKey: "ws-change", companyId: COMPANY });
    expect(policyOf(docker, hash).services.images).toHaveLength(2);
    expect(docker.containers.get(`rovara-sock-${hash}`)!.createdAt).toBeGreaterThan(guardBefore);
    expect(docker.containers.get(first.machineId)!.environment.AGENTX_TEST_SERVICES_NOT_PULLED).toBe("svc/mysql");
  });

  it("removes the worker's service containers, its run networks and its run folder when the machine is terminated", async () => {
    const { machines, docker, stateDirectory } = await build(true);
    const handle = await machines.start({ machineKey: "ws-end", companyId: COMPANY });
    const hash = handle.machineId.slice("rovara-worker-".length);
    // What the guard would have made for the worker: a service container and a run network, carrying the machine's owner label.
    const labels = { "rovara.local.owner": hash, "rovara.local.sandbox": "service" };
    docker.containers.set(`rovara-svc-0123456789ab-h0123456789`, { name: "rovara-svc-0123456789ab-h0123456789", kind: "other", args: [], labels, environment: {}, networks: new Map(), status: "running", exitCode: 0, oomKilled: false, createdAt: 1, startedAt: 1, hostPort: 0, accepted: new Set() });
    docker.networks.set("rovara-svc-0123456789ab", { name: "rovara-svc-0123456789ab", internal: true, options: {}, subnet: "172.30.7.0/24", labels: { "rovara.local.owner": hash } });
    docker.networks.set("rovara-svc-ffffffffffff", { name: "rovara-svc-ffffffffffff", internal: true, options: {}, subnet: "172.30.8.0/24", labels: { "rovara.local.owner": "another-worker" } });
    await machines.terminate(handle.machineId);
    expect(docker.containers.has("rovara-svc-0123456789ab-h0123456789")).toBe(false);
    expect(docker.networks.has("rovara-svc-0123456789ab")).toBe(false);
    // Another worker's run network is not this machine's to remove.
    expect(docker.networks.has("rovara-svc-ffffffffffff")).toBe(true);
    await expect(stat(join(stateDirectory, "test-services", hash))).rejects.toThrow();
  });

  it("gives the machines nothing when no image is on this machine, so a worker is never told about services it cannot start", () => {
    const none = { images: [], notPulled: ["svc/postgres"], failed: [], pulledNow: [] };
    expect(localTestServicesFrom({ registry: "r.example", catalogEnv: "local", prepared: none })).toBeUndefined();
    expect(localTestServicesFrom({ registry: "r.example", catalogEnv: "local", prepared: { ...none, images: ["r.example/rovara-catalog/local/svc/redis@sha256:" + "c".repeat(64)] }, maxMemoryMiB: 1024 })).toMatchObject({ registry: "r.example", catalogEnv: "local", maxMemoryMiB: 1024, notPulled: ["svc/postgres"] });
  });

  it("builds the worker's environment from exactly what it was given", () => {
    expect(testServicesEnvironment({ registry: "r.example", catalogEnv: "local", images: [], notPulled: ["svc/a", "svc/b"] }, { runDirectory: "/run/x", workerImageId: `sha256:${"a".repeat(64)}` })).toEqual({
      AGENTX_TEST_SERVICES_REGISTRY: "r.example", AGENTX_TEST_SERVICES_ENV: "local", AGENTX_TEST_SERVICES_RUN_DIR: "/run/x", AGENTX_WORKER_IMAGE: `sha256:${"a".repeat(64)}`, AGENTX_TEST_SERVICES_NOT_PULLED: "svc/a,svc/b",
    });
  });
});

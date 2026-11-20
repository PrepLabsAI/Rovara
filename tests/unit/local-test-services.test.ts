// Test services on the local Docker worker, the broker's side: the catalog it trusts (and what it does with none), the images it pulls on the host, and how the worker machine is told about test services. The guard's rules
// are in local-test-services-guard.test.ts; the real daemon is in tests/integration/local-test-services-isolation.test.ts.
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_FILE, CATALOG_SIGNATURE_ALGORITHM, CATALOG_SIGNATURE_FILE, catalogPins, catalogSigningMessage, parseBundlePublicKey, sha256HexOf } from "@agentx/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { DockerResult, DockerRunner } from "../../packages/broker/src/local/docker-runner.js";
import { DockerWorkerMachines } from "../../packages/broker/src/local/docker-worker-machines.js";
import { createEphemeralInvokeSigner } from "../../packages/broker/src/local/invoke-signer.js";
import { prepareLocalTestServices } from "../../packages/broker/src/local/test-services-install.js";
import { NO_TRUSTED_CATALOG_SENTENCE, loadLocalServiceCatalog, localTestServicesDigestPart, localTestServicesFrom, prepareTestServiceImages, removePulledTestServiceImages } from "../../packages/broker/src/local/test-services.js";
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
  interface GuardPolicy { workspaceDir: string; services: { images: string[]; guardImage: string; runDirectory: string; bindDirectory: string; socketGroup: number; maxMemoryMiB?: number; maxContainers?: number; maxMemoryPercent?: number } }
  const policyOf = (docker: FakeDocker, hash: string): GuardPolicy => {
    const guard = docker.containers.get(`rovara-sock-${hash}`)!;
    const text = guard.args.find((entry) => entry.startsWith("ROVARA_SOCK_POLICY="))!;
    return JSON.parse(text.slice("ROVARA_SOCK_POLICY=".length)) as GuardPolicy;
  };

  it("DEC 254zm 2: a changed ceiling is a different machine configuration, an unchanged one is not", () => {
    const base = { registry: "r.example", catalogEnv: "local", images: ["i"] };
    const at = (containers: number, helperMemoryMiB = 1024, memoryPercent = 40) => JSON.stringify(localTestServicesDigestPart({ ...base, limits: { containers, helperMemoryMiB, memoryPercent } }, undefined));
    expect(at(12)).toBe(at(12));
    expect(at(12)).not.toBe(at(13));
    expect(at(12)).not.toBe(at(12, 2048));
    expect(at(12)).not.toBe(at(12, 1024, 41));
    expect(at(12)).not.toBe(JSON.stringify(localTestServicesDigestPart(base, undefined)));
    expect(JSON.stringify(localTestServicesDigestPart(base, undefined))).toBe(JSON.stringify(["r.example", "local", ["i"], null, null]));
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

  it("DEC 254zm 2: the signed install (a build with a catalog key) puts the resolved limits on what the machines are given", async () => {
    const state = await folder();
    const install = await prepareLocalTestServices({
      environment: { ROVARA_TEST_SERVICES_REGISTRY: "registry.example:5000", ROVARA_TEST_SERVICES_MAX_CONTAINERS: "30" }, stateDirectory: state, docker: pullingDocker(new Set()), interfaces: {},
      signedKeysPresent: () => true, loadCatalog: () => Promise.resolve({ ok: true as const, catalog: verifiedCatalog(pinnedCatalog()) }),
    });
    expect(install.mode).toBe("signed");
    expect(install.services?.limits).toEqual({ containers: 30, helperMemoryMiB: 1024, memoryPercent: 40 });
  });
});

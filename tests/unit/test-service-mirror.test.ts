// DEC 254zm: the install's starter copies as the contracts name them, the worker image's CLI the boot stage asks, and the copy script's plan and check.
import { describe, expect, it } from "vitest";
import { ownerCatalogOf, ownerImageReferences, ownerStarterEntries, OwnerListEntrySchema, OWNER_STARTER_IMAGES } from "../../packages/contracts/src/index.js";
import { mirroredStarterEntries, testServiceMirrorRepositories } from "../../packages/contracts/src/test-service-mirror.js";
import { testServicesMirrorOutput } from "../../packages/worker/src/test-services-mirror-cli.js";
import { testServicesConfigFromEnvironment } from "../../packages/worker/src/test-services-run.js";
import { mirrorPlan, verifyMirror, type MirrorRegistry } from "../../scripts/test-services-mirror.js";

const REGISTRY = "111122223333.dkr.ecr.us-west-2.amazonaws.com";
const digestOf = (reference: string): string => reference.slice(reference.indexOf("@sha256:") + 8);

describe("the starter copies in the contracts", () => {
  it("name each starter by this install's copy with the STARTER'S digest, and pass the owner-list schema", () => {
    const entries = mirroredStarterEntries(REGISTRY, "staging");
    expect(entries).toHaveLength(OWNER_STARTER_IMAGES.length);
    entries.forEach((entry, index) => {
      const starter = OWNER_STARTER_IMAGES[index]!;
      expect(entry.reference.startsWith(`${REGISTRY}/agentx-staging--test-services/`)).toBe(true);
      expect(digestOf(entry.reference)).toBe(digestOf(starter.reference));
      expect(entry).toEqual({ reference: entry.reference, family: starter.family, version: starter.version });
      expect(OwnerListEntrySchema.safeParse(entry).success).toBe(true);
    });
  });

  it("make the SAME catalog as the starter list (the broker's): the same ids, digests, profiles; only where an image is pulled from differs", () => {
    const broker = ownerCatalogOf(ownerStarterEntries())!;
    const worker = ownerCatalogOf(mirroredStarterEntries(REGISTRY, "staging"))!;
    expect(worker.entries).toEqual(broker.entries);
    const brokerKeys = [...ownerImageReferences(ownerStarterEntries()).keys()].sort();
    const workerReferences = ownerImageReferences(mirroredStarterEntries(REGISTRY, "staging"));
    expect([...workerReferences.keys()].sort()).toEqual(brokerKeys);
    for (const reference of workerReferences.values()) expect(reference.startsWith(`${REGISTRY}/`)).toBe(true);
  });

  it("refuse a registry that is not an ECR registry, and an environment that is not a name", () => {
    for (const registry of ["docker.io", "111122223333.dkr.ecr.us-west-2.amazonaws.com.evil.test", "11112222333.dkr.ecr.us-west-2.amazonaws.com", `${REGISTRY}/x`, ""]) expect(() => mirroredStarterEntries(registry, "staging"), registry).toThrow();
    for (const env of ["Staging", "-x", "a".repeat(21), "x/y", ""]) expect(() => mirroredStarterEntries(REGISTRY, env), env).toThrow();
  });

  it("a hosted worker given the copies as its owner list is configured for test services in owner-list mode, with the copies as its images", () => {
    const config = testServicesConfigFromEnvironment({
      AGENTX_TEST_SERVICES_OWNER_IMAGES: JSON.stringify(mirroredStarterEntries(REGISTRY, "staging")), AGENTX_TEST_SERVICES_RUN_DIR: "/run/agentx-test-services",
      AGENTX_SANDBOX_IMAGE: `${REGISTRY}/w@sha256:${"a".repeat(64)}`, AGENTX_WORKER_IMAGE: `${REGISTRY}/w@sha256:${"a".repeat(64)}`,
    }, undefined, undefined, false);
    expect(config).toBeDefined();
    expect([...config!.imageReferences!.values()].sort()).toEqual(mirroredStarterEntries(REGISTRY, "staging").map((entry) => entry.reference).sort());
    // Withheld at boot (`all`), or no run directory: not configured.
    expect(testServicesConfigFromEnvironment({ AGENTX_TEST_SERVICES_OWNER_IMAGES: JSON.stringify(mirroredStarterEntries(REGISTRY, "staging")), AGENTX_TEST_SERVICES_RUN_DIR: "/run/x", AGENTX_SANDBOX_IMAGE: "a", AGENTX_WORKER_IMAGE: `${REGISTRY}/w@sha256:${"a".repeat(64)}`, AGENTX_TEST_SERVICES_NOT_PULLED: "all" }, undefined, undefined, false)).toBeUndefined();
    expect(testServicesConfigFromEnvironment({ AGENTX_TEST_SERVICES_OWNER_IMAGES: JSON.stringify(mirroredStarterEntries(REGISTRY, "staging")), AGENTX_SANDBOX_IMAGE: "a", AGENTX_WORKER_IMAGE: `${REGISTRY}/w@sha256:${"a".repeat(64)}` }, undefined, undefined, false)).toBeUndefined();
  });
});

describe("the worker image's CLI for the boot stage", () => {
  const references = mirroredStarterEntries(REGISTRY, "staging").map((entry) => entry.reference);
  it("refs: one pinned reference per line", () => {
    expect(testServicesMirrorOutput(["refs", REGISTRY, "staging"])).toBe(`${references.join("\n")}\n`);
  });
  it("list: the owner list of exactly the named copies; a reference that is not a copy is left out", () => {
    expect(JSON.parse(testServicesMirrorOutput(["list", REGISTRY, "staging", references[0]!, references[3]!, `docker.io/library/redis@sha256:${"1".repeat(64)}`])!)).toEqual([0, 3].map((index) => mirroredStarterEntries(REGISTRY, "staging")[index]));
    expect(JSON.parse(testServicesMirrorOutput(["list", REGISTRY, "staging"])!)).toEqual([]);
  });
  it("bad arguments: nothing on stdout", () => {
    for (const argv of [[], ["refs"], ["refs", REGISTRY], ["refs", "docker.io", "staging"], ["refs", REGISTRY, "Staging"], ["refs", REGISTRY, "staging", "extra"], ["pull", REGISTRY, "staging"], ["list", REGISTRY, "staging", ...Array.from({ length: 6 }, () => references[0]!)]]) {
      expect(testServicesMirrorOutput(argv), argv.join(" ")).toBeUndefined();
    }
  });
});

describe("the copy script", () => {
  const steps = mirrorPlan(REGISTRY, "staging");
  it("copies each starter from its pinned Docker Hub digest to the copy's label tag, and checks it by the pinned digest", () => {
    expect(steps).toHaveLength(5);
    steps.forEach((step, index) => {
      const mirror = testServiceMirrorRepositories("staging")[index]!;
      expect(step.source).toBe(OWNER_STARTER_IMAGES[index]!.reference);
      expect(step.target).toBe(`${REGISTRY}/${mirror.repositoryName}:${mirror.tag}`);
      expect(step.pinned).toBe(`${REGISTRY}/${mirror.repositoryName}@sha256:${mirror.digest}`);
      expect(step.digest).toBe(`sha256:${digestOf(step.source)}`);
    });
    expect(() => mirrorPlan("docker.io", "staging")).toThrow();
  });

  const index = JSON.stringify({ manifests: [{ digest: `sha256:${"a".repeat(64)}`, platform: { os: "linux", architecture: "arm64" } }, { digest: `sha256:${"b".repeat(64)}`, platform: { os: "linux", architecture: "amd64" } }] });
  const good: MirrorRegistry = { digest: (reference) => `sha256:${reference.includes("@sha256:") ? digestOf(reference) : steps.find((step) => step.target === reference)!.digest.slice(7)}\n`, manifest: () => index };
  it("verifies only when every copy answers by its pinned digest, its tag points there, and its index lists arm64 and amd64", () => {
    const passed = verifyMirror(steps, good);
    expect(passed.ok).toBe(true);
    expect(passed.lines.every((line) => line.startsWith("OK  "))).toBe(true);
  });
  it.each([
    ["a copy missing", { ...good, digest: (reference: string) => { if (reference.includes("mysql")) throw new Error("not found"); return good.digest(reference); } }],
    ["a tag on another digest", { ...good, digest: (reference: string) => (reference.includes(":8-") ? `sha256:${"0".repeat(64)}` : good.digest(reference)) }],
    ["a copy that answers another digest", { ...good, digest: (reference: string) => (reference.includes("redis") && reference.includes("@") ? `sha256:${"0".repeat(64)}` : good.digest(reference)) }],
    ["an index without arm64", { ...good, manifest: () => JSON.stringify({ manifests: [{ platform: { os: "linux", architecture: "amd64" } }] }) }],
    ["an unreadable index", { ...good, manifest: () => "not json" }],
    ["a platform image missing from the copy", { ...good, digest: (reference: string) => { if (reference.endsWith(`@sha256:${"a".repeat(64)}`)) throw new Error("manifest unknown"); return good.digest(reference); } }],
  ])("fails on %s", (_name, registry) => {
    const result = verifyMirror(steps, registry);
    expect(result.ok).toBe(false);
    expect(result.lines.some((line) => line.startsWith("FAIL"))).toBe(true);
  });
});

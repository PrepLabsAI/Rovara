// The worker on a laptop that runs from the owner's approved image list: it is told the list in its environment (by the broker, which a job cannot change), rebuilds the same catalog from it, names an image by the
// owner's pinned reference, and refuses any image that is not on the list or that has another digest. A MongoDB helper starts with no password (the run's network is sealed).
import { describe, expect, it } from "vitest";
import { OWNER_STARTER_IMAGES, ownerCatalogOf, ownerImageReferences, ownerStarterEntries, type CatalogEntry } from "@agentx/contracts";
import { TEST_SERVICES_OWNER_IMAGES_ENVIRONMENT, testServicesConfigFromEnvironment } from "../../packages/worker/src/test-services-run.js";
import { startHelpers, type HelperFiles } from "../../packages/worker/src/service-helpers.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

const WORKER_IMAGE = `sha256:${"a".repeat(64)}`;
const base = (list: unknown): NodeJS.ProcessEnv => ({
  AGENTX_TEST_SERVICES_RUN_DIR: "/run/test-services", AGENTX_SANDBOX_IMAGE: "worker:test", AGENTX_WORKER_IMAGE: WORKER_IMAGE, ...(list === undefined ? {} : { [TEST_SERVICES_OWNER_IMAGES_ENVIRONMENT]: typeof list === "string" ? list : JSON.stringify(list) }),
});
const docker = { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } as unknown as DockerCli;

describe("the worker's configuration from an owner list", () => {
  it("needs no registry and no baked catalog: the list in its environment gives both the catalog and the images to start", async () => {
    const config = testServicesConfigFromEnvironment(base(ownerStarterEntries()), docker, undefined)!;
    expect(config).toBeDefined();
    expect(config.registry).toBe("owner-list.invalid");
    const catalog = await config.catalog();
    expect(catalog.entries.map((entry) => entry.id).sort()).toEqual(["mongodb@7", "mysql@8", "postgres@16", "postgres@17", "redis@7"]);
    expect(config.imageReferences).toEqual(ownerImageReferences(ownerStarterEntries()));
    const pg = OWNER_STARTER_IMAGES[0]!;
    expect(config.imageReferences!.get(`svc/postgres@sha256:${pg.reference.slice(-64)}`)).toBe(pg.reference);
  });

  it("is not configured by a list that is empty, is not JSON, holds no valid entry, or names a tag", () => {
    for (const list of ["", "not json", "{}", "[]", JSON.stringify([{ reference: "docker.io/library/postgres:16", family: "postgres", version: "16" }]), JSON.stringify([{ reference: `docker.io/library/postgres@sha256:${"a".repeat(64)}`, family: "mysql", version: "16" }])]) {
      expect(testServicesConfigFromEnvironment(base(list), docker, undefined), list).toBeUndefined();
    }
  });

  it("is not configured at all in a signed build that is handed an owner list: it never builds a catalog from it", async () => {
    expect(testServicesConfigFromEnvironment(base(ownerStarterEntries()), docker, undefined, true)).toBeUndefined();
    expect(testServicesConfigFromEnvironment(base(ownerStarterEntries()), docker, undefined, false)).toBeDefined();
    // The signed way in a signed build is untouched.
    expect(testServicesConfigFromEnvironment({ ...base(undefined), AGENTX_TEST_SERVICES_REGISTRY: "registry.examplehost:5000", AGENTX_TEST_SERVICES_ENV: "local" }, docker, undefined, true)).toBeDefined();
  });

  it("leaves the signed way as it was when there is no owner list", () => {
    const config = testServicesConfigFromEnvironment({ ...base(undefined), AGENTX_TEST_SERVICES_REGISTRY: "registry.examplehost:5000", AGENTX_TEST_SERVICES_ENV: "local" }, docker, undefined)!;
    expect(config.registry).toBe("registry.examplehost:5000");
    expect(config.imageReferences).toBeUndefined();
  });
});

describe("starting a helper from an owner's image", () => {
  const files: HelperFiles = { write: async (name) => `/run/files/${name}`, remove: async () => undefined };
  const net = {
    name: "rovara-svc-0123456789ab", bridge: "rvi01234567", slot: 7, subnet: "172.30.7.0/24", gateway: "172.30.7.1", ipRange: "172.30.7.128/25", dnsHelperIp: "172.30.7.2", workingSandboxIp: "172.30.7.3", checkSandboxIp: "172.30.7.4", proxyIp: "172.30.7.5",
    helperIp: (index: number) => `172.30.7.${String(16 + index)}`, labelArgs: () => ["--label", "x=1"], stop: async () => undefined,
  };
  const entryOf = (id: string): CatalogEntry => ownerCatalogOf(ownerStarterEntries())!.entries.find((entry) => entry.id === id)!;
  const runs = (): { cli: DockerCli; args: string[][] } => {
    const args: string[][] = [];
    // An image that declares no volume, a running container and a passing health command.
    return { args, cli: { run: async (call: string[]) => { args.push(call); return { exitCode: 0, stdout: call[0] === "image" ? "null\n" : call[0] === "inspect" ? "running\n" : "", stderr: "" }; } } };
  };
  const input = (entries: CatalogEntry[], imageReferences: ReadonlyMap<string, string> | undefined) => ({
    registry: "owner-list.invalid", edition: "public" as const, probeImage: WORKER_IMAGE, maxMemMiB: 3072, files, ...(imageReferences === undefined ? {} : { imageReferences }),
    helpers: entries.map((entry) => ({ id: entry.family === "mongodb" ? "mongo" : entry.family, name: entry.family, entry, aliases: [entry.connect.defaultAliases[0]!], credentials: { user: "rovara", password: "p".repeat(32), database: "app" } })),
    now: () => 0, sleep: async () => undefined,
  });

  it("starts the owner's pinned reference, exactly, with the family's own run profile (non-root, read-only, capabilities dropped)", async () => {
    const { cli, args } = runs();
    const references = ownerImageReferences(ownerStarterEntries());
    await startHelpers(cli, net, input([entryOf("postgres@16")], references));
    const run = args.find((call) => call[0] === "run" && call.includes("--detach"))!;
    expect(run).toContain(OWNER_STARTER_IMAGES[0]!.reference);
    expect(run).toEqual(expect.arrayContaining(["--user", "999:999", "--cap-drop", "ALL", "--read-only", "--pull=never"]));
    expect(run.some((part) => part.includes("owner-list.invalid"))).toBe(false);
  });

  it("refuses an image that is not in the owner's list, and the same repository with another digest, before it starts anything", async () => {
    const { cli, args } = runs();
    const without = ownerImageReferences(ownerStarterEntries().filter((entry) => entry.family !== "postgres"));
    await expect(startHelpers(cli, net as never, input([entryOf("postgres@16")], without))).rejects.toThrow(/cannot be started here/u);
    const other = ownerCatalogOf([{ reference: `docker.io/library/postgres@sha256:${"9".repeat(64)}`, family: "postgres", version: "16" }])!.entries[0]!;
    await expect(startHelpers(cli, net as never, input([other], ownerImageReferences(ownerStarterEntries())))).rejects.toThrow(/cannot be started here/u);
    expect(args).toEqual([]);
  });

  it("starts a MongoDB helper with no password in its environment, a TCP health check and a read-only root", async () => {
    const { cli, args } = runs();
    const written: Array<[string, string]> = [];
    const spy: HelperFiles = { write: async (name, content) => { written.push([name, content]); return `/run/files/${name}`; }, remove: async () => undefined };
    await startHelpers(cli, net, { ...input([entryOf("mongodb@7")], ownerImageReferences(ownerStarterEntries())), files: spy });
    const run = args.find((call) => call[0] === "run" && call.includes("--detach"))!;
    expect(run).toContain(OWNER_STARTER_IMAGES.find((image) => image.requested === "mongo:7")!.reference);
    expect(run).not.toContain("--env-file");
    expect(written).toEqual([]);
    expect(run).toEqual(expect.arrayContaining(["--user", "999:999", "--read-only"]));
    expect(entryOf("mongodb@7").health).toMatchObject({ kind: "tcp", port: 27017 });
  });

  it("with no owner list the registry names the image, as it always did", async () => {
    const { cli, args } = runs();
    const entry = { ...entryOf("postgres@16"), ownerApproved: undefined };
    await startHelpers(cli, net, { ...input([entry], undefined), registry: "registry.examplehost:5000/rovara-catalog/local" });
    const run = args.find((call) => call[0] === "run" && call.includes("--detach"))!;
    expect(run).toContain(`registry.examplehost:5000/rovara-catalog/local/svc/postgres@sha256:${entry.image.digest!}`);
  });
});

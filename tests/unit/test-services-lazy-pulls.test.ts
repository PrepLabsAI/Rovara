// DEC 254z-amend3: on a laptop, test service images are pulled LAZILY: `rovara up` pulls none, and the first step whose plan names one has it pulled on the host, by its pinned digest, before the job is handed to
// the worker. While the pull runs the step waits (the machine answers `not_ready`, which the dispatcher retries); a pull that fails does not hold the step (the worker refuses the dependency in its own words).
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTX_PROTOCOL_VERSION, OWNER_STARTER_IMAGES, WorkerInvocationSchema, ownerStarterEntries, type WorkerInvocation } from "@agentx/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { DockerWorkerMachines, workspaceIdFor } from "../../packages/broker/src/local/docker-worker-machines.js";
import type { DockerResult, DockerRunner } from "../../packages/broker/src/local/docker-runner.js";
import { createEphemeralInvokeSigner } from "../../packages/broker/src/local/invoke-signer.js";
import { MAX_IMAGES_PER_STEP, createLazyServiceImages, ownerImagesNeededBy } from "../../packages/broker/src/local/lazy-service-images.js";
import { OWNER_LIST_CATALOG_ENV, OWNER_LIST_REGISTRY, ownerListReferences } from "@agentx/contracts";
import { FakeDocker } from "../support/local/fake-docker.js";

const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";
const entries = ownerStarterEntries();
const digestOf = (reference: string): string => reference.slice(reference.indexOf("@sha256:") + "@sha256:".length);
const postgres16 = OWNER_STARTER_IMAGES.find((image) => image.requested === "postgres:16")!;
const dependency = (repository: string, digest: string) => ({ repository, digest });
const job = (dependencies: unknown[] | undefined): unknown => ({ kind: "task", payload: { workflowMode: "CHECKS", ...(dependencies === undefined ? {} : { testEnvironment: { dependencies } }) } });

/** A Docker whose pulls wait until the test lets them finish. */
class GatedDocker implements DockerRunner {
  readonly calls: string[][] = [];
  readonly held = new Set<string>();
  readonly failing = new Set<string>();
  #release: Array<() => void> = [];
  async run(args: readonly string[]): Promise<DockerResult> {
    this.calls.push([...args]);
    const name = args.at(-1)!;
    if (args[0] === "pull") {
      await new Promise<void>((resolve) => this.#release.push(resolve));
      if (this.failing.has(name)) return { exitCode: 1, stdout: "", stderr: "manifest unknown" };
      this.held.add(name);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "image" && args[1] === "inspect") return this.held.has(name) ? { exitCode: 0, stdout: "sha256:x\n", stderr: "" } : { exitCode: 1, stdout: "", stderr: "No such image" };
    return { exitCode: 1, stdout: "", stderr: "unexpected" };
  }
  pulls(): string[] { return this.calls.filter((call) => call[0] === "pull").map((call) => call.at(-1)!); }
  /** Lets every waiting pull finish, then waits for the module's bookkeeping. */
  async finish(): Promise<void> {
    for (const release of this.#release.splice(0)) release();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("which images a step needs", () => {

  it("ignores what is not an owner-list image: another digest, another repository, a plan without dependencies, and anything malformed", () => {
    expect(ownerImagesNeededBy(job([dependency("svc/postgres", "f".repeat(64))]), entries)).toEqual([]);
    expect(ownerImagesNeededBy(job([dependency("svc/mysql", digestOf(postgres16.reference))]), entries)).toEqual([]);
    expect(ownerImagesNeededBy(job(undefined), entries)).toEqual([]);
    for (const hostile of [null, "x", 1, { payload: null }, { payload: { testEnvironment: { dependencies: "postgres" } } }, job([null, 1, { repository: "svc/postgres; rm -rf /", digest: digestOf(postgres16.reference) }, { repository: "svc/postgres", digest: "ABC" }])]) {
      expect(ownerImagesNeededBy(hostile, entries), JSON.stringify(hostile)).toEqual([]);
    }
  });

  it("names each image once, and looks at no more than its cap for one step", () => {
    const same = dependency("svc/postgres", digestOf(postgres16.reference));
    expect(ownerImagesNeededBy(job([same, same, same]), entries)).toEqual([postgres16.reference]);
    const many = Array.from({ length: MAX_IMAGES_PER_STEP + 4 }, (_, index) => ({ reference: `docker.io/library/postgres@sha256:${String(index).padStart(64, "0")}`, family: "postgres" as const, version: String(index + 1) }));
    const plan = job(many.map((entry, index) => dependency("svc/postgres", String(index).padStart(64, "0"))));
    expect(ownerImagesNeededBy(plan, many).length).toBeLessThanOrEqual(MAX_IMAGES_PER_STEP);
  });
});

describe("pulling on first use", () => {
  const needsPostgres = job([dependency("svc/postgres", digestOf(postgres16.reference))]);

  it("an image not here: one pull by its pinned digest, `pulling` until it is done (a second try starts no second pull), then ready", async () => {
    const docker = new GatedDocker();
    const logged: Array<Record<string, unknown>> = [];
    const lazy = createLazyServiceImages({ docker, ownerImages: entries, log: (entry) => logged.push(entry) });
    expect(await lazy.prepare(needsPostgres)).toBe("pulling");
    expect(await lazy.prepare(needsPostgres)).toBe("pulling");
    expect(docker.pulls()).toEqual([postgres16.reference]);
    expect(docker.pulls().every((reference) => /@sha256:[a-f0-9]{64}$/u.test(reference))).toBe(true);
    await docker.finish();
    expect(await lazy.prepare(needsPostgres)).toBe("ready");
    expect(docker.pulls()).toEqual([postgres16.reference]);
    // The logs name the family only: never a reference, a digest or Docker's words.
    expect(logged.map((entry) => entry["event"])).toEqual(["test_services.image_pull_started", "test_services.image_pulled"]);
    expect(JSON.stringify(logged)).not.toMatch(/sha256|docker\.io|manifest/u);
  });

  it("two steps asking at the same moment start one pull, not two", async () => {
    const docker = new GatedDocker();
    const lazy = createLazyServiceImages({ docker, ownerImages: entries });
    expect(await Promise.all([lazy.prepare(needsPostgres), lazy.prepare(needsPostgres)])).toEqual(["pulling", "pulling"]);
    expect(docker.pulls()).toEqual([postgres16.reference]);
    await docker.finish();
    expect(await lazy.prepare(needsPostgres)).toBe("ready");
  });

  it("a pull that fails does not hold the step, is not tried again for five minutes, and is tried again after", async () => {
    const docker = new GatedDocker();
    docker.failing.add(postgres16.reference);
    let now = 1_000_000;
    const lazy = createLazyServiceImages({ docker, ownerImages: entries, now: () => now });
    expect(await lazy.prepare(needsPostgres)).toBe("pulling");
    await docker.finish();
    expect(await lazy.prepare(needsPostgres)).toBe("ready");
    now += 4 * 60_000;
    expect(await lazy.prepare(needsPostgres)).toBe("ready");
    expect(docker.pulls()).toHaveLength(1);
    now += 2 * 60_000;
    docker.failing.clear();
    expect(await lazy.prepare(needsPostgres)).toBe("pulling");
    expect(docker.pulls()).toHaveLength(2);
    await docker.finish();
    expect(await lazy.prepare(needsPostgres)).toBe("ready");
  });
});

// ---- the worker machine's delivery

const roots: string[] = [];
afterEach(async () => { while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true }); });

/** FakeDocker for the machine, with pulls of service images gated like GatedDocker's. */
class MachineDocker extends FakeDocker {
  readonly gate = new GatedDocker();
  override async run(args: readonly string[]): Promise<DockerResult> {
    const name = args.at(-1) ?? "";
    if (args[0] === "pull" || (args[0] === "image" && args[1] === "inspect" && name.includes("@sha256:"))) return this.gate.run(args);
    return super.run(args);
  }
}

function invocation(workspaceId: string, dependencies: unknown[] | undefined): WorkerInvocation {
  const operationId = randomUUID();
  return WorkerInvocationSchema.parse({
    protocolVersion: AGENTX_PROTOCOL_VERSION, operationId, workspaceId, fence: 1, projectRevision: 1, callbackCapability: "c".repeat(48), kind: "task",
    payload: { conversationId: operationId, prompt: "make the change", ...(dependencies === undefined ? {} : { workflowMode: "IMPLEMENT", testEnvironment: { revision: 1, digest: "a".repeat(64), roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, checks: [{ id: "unit", kind: "test" }], dependencies } }) },
  });
}

describe("a worker machine with lazy test services", () => {
  async function build(lazyPulls: boolean) {
    const stateDirectory = await mkdtemp(join(tmpdir(), "rovara-lazy-"));
    roots.push(stateDirectory);
    const docker = new MachineDocker();
    const services = { registry: OWNER_LIST_REGISTRY, catalogEnv: OWNER_LIST_CATALOG_ENV, images: ownerListReferences(entries), ownerImages: entries, ...(lazyPulls ? { lazyPulls: true as const } : {}) };
    const machines = new DockerWorkerMachines({ image: "worker:test", stateDirectory, callback: () => ({ tcpPort: 1234 }), signer: createEphemeralInvokeSigner(), docker, fetch: docker.fetch, testServices: services });
    return { docker, machines };
  }
  const postgresPlan = (): unknown[] => [{
    id: "postgres", name: "Postgres", kind: "database", family: "postgres", backing: "local", catalogId: "postgres@16", repository: "svc/postgres", digest: digestOf(postgres16.reference),
    config: {}, aliases: ["postgres"], connect: [], seeds: [], reset: "fresh_per_round",
  }];

  it("holds a job whose plan needs an image that is not here (not_ready, so the dispatcher comes back), and hands it over once the image is pulled", async () => {
    const { docker, machines } = await build(true);
    const { machineId } = await machines.start({ machineKey: "ws-lazy", companyId: COMPANY });
    const workspaceId = workspaceIdFor(COMPANY, "ws-lazy");
    const first = invocation(workspaceId, postgresPlan());
    await expect(machines.deliver(machineId, first)).rejects.toMatchObject({ code: "not_ready" });
    expect(docker.gate.pulls()).toEqual([postgres16.reference]);
    await docker.gate.finish();
    expect(await machines.deliver(machineId, first)).toEqual({ duplicate: false });
    expect(docker.gate.pulls()).toEqual([postgres16.reference]);
  });

});

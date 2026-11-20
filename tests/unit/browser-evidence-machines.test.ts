// TE-H1 slice 2 (DEC 241a), the laptop's machines: a machine for a project with a browser evidence recipe is created with the executor image's id as EXECUTOR_IMAGE and a guard that lets it start capture containers; every other machine is
// exactly what it always was (same environment, same guard policy, same digest). An image this machine does not hold, a profile that does not verify, or a reader that throws is no browser evidence.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { DockerWorkerMachines } from "../../packages/broker/src/local/docker-worker-machines.js";
import { createEphemeralInvokeSigner } from "../../packages/broker/src/local/invoke-signer.js";
import { FakeDocker } from "../support/local/fake-docker.js";

const scratch: string[] = [];
afterAll(async () => { while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true }); });
const EXECUTOR = "rovara-e2e-executor:test";
const PROFILE = '{"defaultAction":"SCMP_ACT_ERRNO"}';

const SIGNER = createEphemeralInvokeSigner();
async function start(options: { stateDirectory?: string | undefined; browser?: { image: string; enabled: (project: string | undefined) => boolean | Promise<boolean>; seccomp: () => string } | undefined; project?: string | undefined; key?: string | undefined; docker?: FakeDocker | undefined }) {
  const stateDirectory = options.stateDirectory ?? await mkdtemp(join(tmpdir(), "rovara-be-machines-"));
  if (options.stateDirectory === undefined) scratch.push(stateDirectory);
  const docker = options.docker ?? new FakeDocker();
  const machines = new DockerWorkerMachines({ image: "worker:test", stateDirectory, callback: () => ({ tcpPort: 1234 }), signer: SIGNER, docker, fetch: docker.fetch, ...(options.browser === undefined ? {} : { browserEvidence: options.browser }) });
  const handle = await machines.start({ machineKey: options.key ?? "ws-be", companyId: IMPLICIT_COMPANY_ID, ...(options.project === undefined ? {} : { projectName: options.project }) });
  const hash = handle.machineId.slice("rovara-worker-".length);
  const worker = docker.containers.get(handle.machineId)!;
  const guard = docker.containers.get(`rovara-sock-${hash}`)!;
  const policy = JSON.parse(guard.environment.ROVARA_SOCK_POLICY!) as Record<string, unknown>;
  expect(Object.keys(worker.labels).some((key) => /config/.test(key))).toBe(true);
  return { worker, guard, policy, digest: Object.entries(worker.labels).filter(([key]) => /config/.test(key)).map(([, value]) => value).join("|"), docker };
}
const enabled = { image: EXECUTOR, enabled: (project: string | undefined) => project === "my-app", seccomp: () => PROFILE };

describe("machines with browser evidence", () => {

  it("for anything else the machine is what it always was: no variable, no policy, the same digest as a machine made with no such option", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "rovara-be-same-"));
    scratch.push(stateDirectory);
    const plain = await start({ stateDirectory, project: "my-app", key: "ws-same" });
    for (const other of [{ browser: enabled, project: "other-app" }, { browser: enabled, project: undefined }, { browser: undefined, project: "my-app" }]) {
      const w = await start({ ...other, stateDirectory, key: "ws-same" });
      expect(w.worker.environment.EXECUTOR_IMAGE, JSON.stringify(other.project)).toBeUndefined();
      expect(w.policy).not.toHaveProperty("browserEvidence");
      expect(w.digest).toBe(plain.digest);
    }
    const with_ = await start({ stateDirectory, browser: enabled, project: "my-app", key: "ws-same" });
    expect(with_.digest).not.toBe(plain.digest);
  });

  it("is no browser evidence when the machine does not hold the image, the profile does not verify, or the owner's reader throws", async () => {
    const missing = new FakeDocker();
    missing.images.delete(EXECUTOR);
    expect((await start({ browser: enabled, project: "my-app", docker: missing })).worker.environment.EXECUTOR_IMAGE).toBeUndefined();
    const bad = { ...enabled, seccomp: () => { throw new Error("executor-seccomp-profile-digest-mismatch"); } };
    const unverified = await start({ browser: bad, project: "my-app" });
    expect(unverified.worker.environment.EXECUTOR_IMAGE).toBeUndefined();
    expect(unverified.policy).not.toHaveProperty("browserEvidence");
    expect((await start({ browser: { ...enabled, enabled: () => { throw new Error("config unreadable"); } }, project: "my-app" })).worker.environment.EXECUTOR_IMAGE).toBeUndefined();
    expect((await start({ browser: { ...enabled, seccomp: () => "" }, project: "my-app" })).worker.environment.EXECUTOR_IMAGE).toBeUndefined();
    // Only an exact `true` turns it on.
    expect((await start({ browser: { ...enabled, enabled: () => "yes" as never }, project: "my-app" })).worker.environment.EXECUTOR_IMAGE).toBeUndefined();
  });
});

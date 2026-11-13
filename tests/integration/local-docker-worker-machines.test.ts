// Port lane L4: the local Docker adapter against a real Docker daemon and a real worker image. It runs only when
// ROVARA_LOCAL_DOCKER_IMAGE names a worker image that is already on this machine and Docker answers; it is skipped otherwise.
// (Build one with: docker build -f environments/base/Dockerfile -t rovara-worker:local .) Colima and Docker Desktop share the
// home folder with the VM only, so the state folder is made under the home folder.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENTX_PROTOCOL_VERSION, WorkerInvocationSchema, type WorkerInvocation } from "@rovara-code/contracts";
import { describe, expect, it, vi } from "vitest";
import { createDockerRunner } from "../../packages/core/src/local/docker-runner.js";
import { DockerWorkerMachines, MACHINE_LABEL, workspaceIdFor } from "../../packages/core/src/local/docker-worker-machines.js";
import { createEphemeralInvokeSigner } from "../../packages/core/src/local/invoke-signer.js";
import { runWorkerMachinesConformance } from "../support/ports/worker-machines-conformance.js";

const IMAGE = process.env.ROVARA_LOCAL_DOCKER_IMAGE;
function dockerAnswers(): boolean {
  try {
    execFileSync("docker", ["image", "inspect", IMAGE ?? ""], { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}
const enabled = IMAGE !== undefined && IMAGE !== "" && dockerAnswers();
const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

function invocationFor(workspaceId: string, operationId: string): WorkerInvocation {
  return WorkerInvocationSchema.parse({
    protocolVersion: AGENTX_PROTOCOL_VERSION,
    operationId,
    workspaceId,
    fence: 1,
    projectRevision: 1,
    callbackCapability: "c".repeat(48),
    kind: "close",
    payload: {},
  });
}

async function leftovers(): Promise<string[]> {
  const result = await createDockerRunner().run(["ps", "--all", "--quiet", "--filter", `label=${MACHINE_LABEL}=1`]);
  return result.stdout.split("\n").filter((line) => line.trim() !== "");
}

describe.skipIf(!enabled)("local docker worker machines (real Docker)", () => {
  runWorkerMachinesConformance("local docker", {
    async create() {
      const stateDirectory = await mkdtemp(join(homedir(), ".rovara-it-"));
      const docker = createDockerRunner();
      const machines = new DockerWorkerMachines({
        image: IMAGE!,
        stateDirectory,
        callback: () => ({ tcpPort: 9 }),
        signer: createEphemeralInvokeSigner(),
        docker,
        startupGraceMs: 120_000,
      });
      let lastKey = "ws-1";
      const keys = new Set<string>();
      return {
        machines,
        invocation: (operationId) => invocationFor(workspaceIdFor(COMPANY, lastKey), operationId),
        spec: (machineKey) => {
          lastKey = machineKey;
          keys.add(machineKey);
          return { machineKey, companyId: COMPANY };
        },
        // A real worker answers the test's job at once and is idle again before `health` is asked.
        jobsMayFinishAtOnce: true,
        settle: () => new Promise((resolve) => setTimeout(resolve, 300)),
        dispose: async () => {
          // Whatever the test left running goes: every machine this harness could have made.
          for (const key of keys) {
            const handle = await machines.start({ machineKey: key, companyId: COMPANY }).catch(() => undefined);
            if (handle !== undefined) await machines.terminate(handle.machineId);
          }
          await rm(stateDirectory, { recursive: true, force: true });
        },
      };
    },
  });

  it("leaves no container behind", async () => {
    expect(await leftovers()).toEqual([]);
  });
});

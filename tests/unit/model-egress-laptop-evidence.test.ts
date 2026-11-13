// TE-F1c: the laptop's evidence about the model-host block reads what the machine REALLY has (the label `DockerWorkerMachines.sandboxModelHostsOf` reads, set by FIX-0518's gateway deny), never a constant. The deny list and the
// gateway are #552's (tests/unit/local-sandbox-model-deny.test.ts); only the evidence words are this lane's.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NOT_SEALED_BLOCKED_BY_NAME_SENTENCE } from "@agentx/contracts";
import { DockerWorkerMachines } from "../../packages/broker/src/local/docker-worker-machines.js";
import { createEphemeralInvokeSigner } from "../../packages/broker/src/local/invoke-signer.js";
import { laptopSandboxDenyList } from "../../packages/broker/src/local/isolation/sandbox-model-deny.js";
import { laptopBlockEvidenceFor, laptopBlockEvidenceInput } from "../../packages/broker/src/local/model-egress/name-block.js";
import { modelBridgeEvidenceLines, NOT_SEALED_NO_BLOCK_SENTENCE } from "../../packages/worker/src/model-bridge-ledger.js";
import { FakeDocker } from "../support/local/fake-docker.js";

const scratch: string[] = [];
afterAll(async () => { while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true }); });

const lines = (input: ReturnType<typeof laptopBlockEvidenceInput>) => modelBridgeEvidenceLines({ roundKind: "check_unsealed", classes: [], ...input });

describe("the evidence follows the machine's real state", () => {
  it("denied: blocked by name, with the deny list's own hosts (and no wildcard in the host list)", () => {
    const input = laptopBlockEvidenceInput("denied");
    expect(input).toMatchObject({ blockMode: "by_name", azureOpenAiNotBlocked: false });
    expect(input.machineBlock).toBeUndefined();
    expect(input.blockList).toContain("api.openai.com");
    expect(input.blockList.some((entry) => entry.startsWith("*."))).toBe(false);
    expect(lines(input)[0]).toBe(NOT_SEALED_BLOCKED_BY_NAME_SENTENCE);
  });
  it("allowed, or a machine that cannot say: not blocked, and never the by-name claim", () => {
    for (const state of ["allowed", undefined] as const) {
      const input = laptopBlockEvidenceInput(state);
      expect(input).toMatchObject({ blockMode: "none", machineBlock: "not_blocked", blockList: [] });
      expect(lines(input).join("\n")).not.toMatch(/blocked by name only/u);
      expect(lines(input)[0]).toMatch(/^not sealed; model hosts not blocked on this machine/u);
    }
    void NOT_SEALED_NO_BLOCK_SENTENCE;
  });
  it("the block list never holds Google's token hosts (DECISIONS 174)", () => {
    const list = laptopBlockEvidenceInput("denied").blockList;
    for (const host of ["oauth2.googleapis.com", "sts.googleapis.com", "iamcredentials.googleapis.com"]) expect(list).not.toContain(host);
    expect(laptopSandboxDenyList()).not.toContain("oauth2.googleapis.com");
  });
});

describe("laptopBlockEvidenceFor reads the machines adapter", () => {
  const start = async (config?: { denied: boolean }) => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "rovara-ev-"));
    scratch.push(stateDirectory);
    const docker = new FakeDocker();
    const machines = new DockerWorkerMachines({
      image: "worker:test", stateDirectory, callback: () => ({ tcpPort: 1234 }), signer: createEphemeralInvokeSigner(), docker, fetch: docker.fetch,
      modelHostsDeniedInSandbox: laptopSandboxDenyList(),
      ...(config === undefined ? {} : { sandboxModelHostsAllowed: () => !config.denied }),
    });
    const handle = await machines.start({ machineKey: "ws-ev", companyId: "org_aaaaaaaaaaaaaaaaaaaa" });
    return { machines, machineId: handle.machineId };
  };
  it("a real machine: its label decides", async () => {
    const denied = await start();
    expect((await laptopBlockEvidenceFor(denied.machines, denied.machineId)).blockMode).toBe("by_name");
    const allowed = await start({ denied: false });
    expect(await allowed.machines.sandboxModelHostsOf(allowed.machineId)).toBe("allowed");
    expect((await laptopBlockEvidenceFor(allowed.machines, allowed.machineId)).blockMode).toBe("none");
  });
  it("an unknown machine, a malformed id, and an adapter that throws all read as not blocked", async () => {
    const { machines } = await start();
    expect((await laptopBlockEvidenceFor(machines, "rovara-worker-" + "0".repeat(24))).machineBlock).toBe("not_blocked");
    expect((await laptopBlockEvidenceFor(machines, "not-a-machine")).machineBlock).toBe("not_blocked");
    expect((await laptopBlockEvidenceFor({ sandboxModelHostsOf: () => Promise.reject(new Error("docker down")) }, "x")).machineBlock).toBe("not_blocked");
  });
});

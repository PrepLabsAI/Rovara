
import { rm } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { installedExecutorSeccompProfilePath } from "../../packages/verifier/src/host/executor-seccomp.js";
import { executorContainerArgs } from "../../packages/verifier/src/host/executor-container.js";
import { browserEvidenceExecutorArgs } from "../../packages/worker/src/browser-evidence-run.js";

const scratch: string[] = [];
afterAll(async () => { while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true }); });
const EXECUTOR = `sha256:${"e".repeat(64)}`;
const SANDBOX = "agentx-task-op1-abcd1234";
const CAPTURE = "rovara-be-0123456789ab";
const PLAN = "eyJwb3J0Ijo0MzIxfQ";
const ENTRY = "/opt/agentx/packages/verifier/dist/executor/browser-evidence-entry.js";
const TMPFS = "rw,exec,nosuid,nodev,size=512m";

describe("the arguments the worker passes are the shape the guard accepts", () => {
  it("is exactly what the guard compares: the executor's own flags (limits, seccomp, tmpfs), and the command", () => {
    const args = browserEvidenceExecutorArgs({ image: EXECUTOR, sandbox: SANDBOX, name: CAPTURE, seccompProfile: installedExecutorSeccompProfilePath(), plan: PLAN });
    expect(args).toEqual(expect.arrayContaining(executorContainerArgs(installedExecutorSeccompProfilePath())));
    expect(args.slice(-3)).toEqual(["node", ENTRY, PLAN]);
    expect(args).toEqual(expect.arrayContaining(["--shm-size", "1g", "--memory", "2g", "--memory-swap", "2g", "--pids-limit", "1024", "--cpus", "2", "--tmpfs", `/tmp:${TMPFS}`]));
  });
});

import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WEB_API_BUILD_IMAGE } from "../../packages/verifier/src/host/docker-application-host.js";
import { createWorkflowE2EApplicationRuntime, workflowE2EApplicationRuntimeConfig } from "../../packages/worker/src/workflow-e2e-application-runtime.js";
import { createOrdersExecutorPlan } from "../support/e2e-orders-executor-fixture.js";
import { FakeDockerCli } from "../support/fake-docker-cli.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("worker application runtime configuration", () => {
  const image = "123456789012.dkr.ecr.us-east-1.amazonaws.com/rovara-executor@sha256:" + "a".repeat(64);

  it("takes the executor image from EXECUTOR_IMAGE, the build image from the pin and a shared run root from the host profile", () => {
    expect(workflowE2EApplicationRuntimeConfig({ EXECUTOR_IMAGE: image }, "linux", "arm64"))
      .toEqual({ executorImage: image, buildImage: WEB_API_BUILD_IMAGE, runRoot: "/mnt/agentx-runtime/candidates/web-api-runs" });
  });

  it.each([{}, { EXECUTOR_IMAGE: "" }, { EXECUTOR_IMAGE: "  " }, { EXECUTOR_IMAGE: "--privileged" }, { EXECUTOR_IMAGE: "two words" }])("refuses to run without a usable executor image (%j)", (environment) => {
    expect(() => workflowE2EApplicationRuntimeConfig(environment, "linux", "arm64")).toThrow(/EXECUTOR_IMAGE/);
  });

  it("refuses a host with no shared runtime directory", () => {
    expect(() => workflowE2EApplicationRuntimeConfig({ EXECUTOR_IMAGE: image }, "darwin", "arm64")).toThrow(/shared runtime directory/);
  });

  it("builds one Docker application host per call over the supplied admission, group and staged source, touching docker only when it runs", async () => {
    const source = await realpath(await mkdtemp(join(tmpdir(), "runtime-source-")));
    roots.push(source);
    await writeFile(join(source, "package.json"), "{}");
    const fixture = createOrdersExecutorPlan({ probe: "web-csv-positive-v1" });
    const docker = new FakeDockerCli();
    const runtime = createWorkflowE2EApplicationRuntime({ EXECUTOR_IMAGE: image }, { platform: "linux", arch: "arm64", docker });
    expect(runtime.runRoot).toBe("/mnt/agentx-runtime/candidates/web-api-runs");
    const first = runtime.createHost({ admission: fixture.plan.admission, groupId: fixture.plan.groupId, candidateSourceDir: source });
    const second = runtime.createHost({ admission: fixture.plan.admission, groupId: fixture.plan.groupId, candidateSourceDir: source });
    expect(first).not.toBe(second);
    expect(docker.calls).toEqual([]);
    expect(() => runtime.createHost({ admission: fixture.plan.admission, groupId: "not-a-group", candidateSourceDir: source })).toThrow(/not a runnable application group/);
  });
});

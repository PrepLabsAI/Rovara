import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SETUP_AGENT_LIMITS_DEFAULT } from "../../packages/contracts/src/index.js";
import { runSetupAgentInvocation } from "../../packages/worker/src/setup-agent-invocation.js";
import { SETUP_ISOLATION_ENVIRONMENT, SETUP_ISOLATION_UNAVAILABLE_MESSAGE, setupIsolationUnavailable } from "../../packages/worker/src/setup-isolation.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

// The launcher (boot-stage2.sh) tells the worker whether the setup run's firewall rules are in place. Without them a setup run (the only mode on a `rvbs<slot>` bridge) is refused with one fixed sentence; nothing else changes.
const EC2_NAMED = { AGENTX_RUNTIME: "ec2", AGENTX_ENVIRONMENT_KIND: "named", AGENTX_SANDBOX_IMAGE: `i@sha256:${"b".repeat(64)}` } as const;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function attempt(environment: NodeJS.ProcessEnv) {
  const root = await mkdtemp(join(tmpdir(), "rovara-isolation-"));
  roots.push(root);
  const calls: string[][] = [];
  const docker: DockerCli = { run: (args) => { calls.push([...args]); return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }); } };
  const invocation = { operationId: "11111111-1111-4111-8111-111111111111", projectRevision: 1, payload: { conversationId: "c", setupAgent: { limits: SETUP_AGENT_LIMITS_DEFAULT, commits: [{ repository: "web", commit: "a".repeat(40) }] } } } as never;
  const dependencies = { rootPath: root, model: { provider: "amazon-bedrock", modelId: "global.anthropic.claude-fable-5" }, eventSink: async () => undefined, setupAgent: async () => ({}), docker, environment };
  const error: unknown = await runSetupAgentInvocation(invocation, dependencies, { repositories: [] }, root).then(() => undefined, (caught: unknown) => caught);
  return { error: error as (Error & { code?: string }) | undefined, calls };
}

describe("a setup run on a worker whose launcher withdrew the setup firewall rules", () => {
  it.each([
    ["unavailable", { [SETUP_ISOLATION_ENVIRONMENT]: "unavailable" }],
    ["no value at all (the fact could not be read: fail closed)", {}],
    ["an empty value", { [SETUP_ISOLATION_ENVIRONMENT]: "" }],
    ["an odd value", { [SETUP_ISOLATION_ENVIRONMENT]: "Ready" }],
  ])("is refused with the specific reason, and nothing is started: %s", async (_name, extra) => {
    const { error, calls } = await attempt({ ...EC2_NAMED, ...extra, AGENTX_MODEL_PROXY_URL: "https://proxy.test" });
    expect(error?.message).toContain(SETUP_ISOLATION_UNAVAILABLE_MESSAGE);
    expect(error?.message).toContain("setup isolation unavailable on this worker");
    // The same failure shape as the worker's other "cannot run it" refusals, which the broker records as a failed task with this text.
    expect(error?.code).toBe("RUNTIME_UNAVAILABLE");
    expect(calls).toEqual([]);
  });

  it("is not refused when the launcher says ready (it goes on to the next check, here the missing model proxy)", async () => {
    const { error } = await attempt({ ...EC2_NAMED, [SETUP_ISOLATION_ENVIRONMENT]: "ready" });
    expect(error?.message).toContain("model proxy");
  });

  it("does not gate a runtime that has no launcher (a developer's machine, tests)", () => {
    expect(setupIsolationUnavailable({})).toBe(false);
    expect(setupIsolationUnavailable({ AGENTX_RUNTIME: "ec2" })).toBe(false);
    expect(setupIsolationUnavailable({ AGENTX_RUNTIME: "ec2", AGENTX_ENVIRONMENT_KIND: "named" })).toBe(true);
  });

  it("gates the setup run only: no other mode reads the fact, so ordinary tasks are unaffected", () => {
    const sources = ["run-task.ts", "server.ts", "task-sandbox.ts", "setup-draft.ts"].map((name) => readFileSync(new URL(`../../packages/worker/src/${name}`, import.meta.url), "utf8"));
    for (const source of sources) expect(source).not.toMatch(/setup-isolation|AGENTX_SETUP_ISOLATION/u);
    expect(readFileSync(new URL("../../packages/worker/src/setup-agent-invocation.ts", import.meta.url), "utf8")).toContain("assertSetupIsolation(environment);");
  });
});

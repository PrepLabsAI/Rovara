// Setup spend pricing: the invocation hands the run's usage to the broker. Every booking test of the run drives `runSetupAgent` with a hand-made port, so this test drives the REAL `runSetupAgentInvocation` (its real ports, a fake
// Docker and a fake Pi session) and checks that the worker's event sink receives a `usage` event: lose the `reportUsage` line and "Cost unavailable" comes back on the Work card.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { SETUP_AGENT_LIMITS_DEFAULT } from "../../packages/contracts/src/index.js";
import type { WorkerEvent } from "../../packages/worker/src/events.js";
import type { PiSessionAdapter, PiSessionHandle } from "../../packages/worker/src/pi-session.js";
import { runSetupAgentInvocation } from "../../packages/worker/src/setup-agent-invocation.js";
import type { DockerCli } from "../../packages/worker/src/docker-cli.js";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function repository() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "setup-spend-inv-")));
  roots.push(root);
  const directory = join(root, "repo/web");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), "{\n  \"scripts\": { \"test\": \"vitest\" }\n}\n");
  const git = (...args: string[]) => run("git", ["-C", directory, "-c", "user.email=a@b.c", "-c", "user.name=x", "-c", "commit.gpgsign=false", ...args]);
  await git("init", "-q", "-b", "main");
  await git("add", "-A");
  await git("commit", "-q", "-m", "one");
  return { root, commit: (await git("rev-parse", "HEAD")).stdout.trim() };
}

describe("the setup invocation books the run's usage", () => {
  it("sends one `usage` event to the worker's event sink, with the run's tokens and a cost, for a run that spent", async () => {
    const r = await repository();
    const sent: WorkerEvent[] = [];
    const listeners: Array<(event: unknown) => void> = [];
    const tokens = { input: 1_000, output: 500, cacheRead: 40_000, cacheWrite: 2_000, total: 43_500 };
    const session = {
      conversationId: "c", sessionFile: join(r.root, "agent-sessions/c.jsonl"),
      prompt: async () => { for (const l of listeners) l({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "no answer" }], usage: { input: 1_000, output: 500, cacheRead: 40_000, cacheWrite: 2_000 } } }); },
      abort: async () => undefined, getModel: () => ({ provider: "amazon-bedrock", modelId: "global.anthropic.claude-fable-5" }), getSessionStats: () => ({ cost: 0, tokens }) as never,
      subscribe: (l: (event: unknown) => void) => { listeners.push(l); return () => undefined; }, dispose: () => undefined,
    } as unknown as PiSessionHandle;
    const adapter: PiSessionAdapter = { create: async () => session };
    const docker: DockerCli = { run: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }) };
    const invocation = { operationId: "11111111-1111-4111-8111-111111111111", projectRevision: 1, payload: { conversationId: "c", setupAgent: { limits: { ...SETUP_AGENT_LIMITS_DEFAULT }, commits: [{ repository: "web", commit: r.commit }] } } } as never;
    const dependencies = {
      rootPath: r.root, model: { provider: "amazon-bedrock", modelId: "global.anthropic.claude-fable-5" }, piAdapter: adapter, docker, setupAgent: async () => ({}),
      eventSink: async (events: readonly WorkerEvent[]) => { sent.push(...events); },
      environment: { AGENTX_SANDBOX_IMAGE: `i@sha256:${"b".repeat(64)}`, AGENTX_SANDBOX_NETWORK: "agentx-sandbox", AGENTX_MODEL_PROXY_URL: "https://proxy.test" },
    };
    const manifest = { repositories: [{ name: "web", path: "repo/web", resolvedCommit: r.commit, defaultBranch: "main", resolvedAt: "", completedAt: "" }] };
    await runSetupAgentInvocation(invocation, dependencies, manifest, r.root);
    const usage = sent.filter((event) => event.type === "usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]!.payload).toMatchObject({ provider: "amazon-bedrock", modelId: "global.anthropic.claude-fable-5", tokens: { input: 1_000, output: 500, cacheRead: 40_000, cacheWrite: 2_000 } });
    expect((usage[0]!.payload as { costUsd: number }).costUsd).toBeGreaterThan(0);
  });
});

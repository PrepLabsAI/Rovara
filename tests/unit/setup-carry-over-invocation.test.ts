// DEC 254zzz431: the REAL setup invocation (real ports, a fake Docker and a fake Pi session) hands the payload's carry-over to the agent's first prompt as marked data; a payload without it prompts as it always did.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { SETUP_AGENT_LIMITS_DEFAULT } from "../../packages/contracts/src/index.js";
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


describe("the setup invocation and a re-run's carry-over (DEC 254zzz431)", () => {
  const carryOver = { version: 1 as const, fromRun: "t1", endedAs: "time_used" as const, proposal: "{\"notes\":\"x\"}", journal: { total: 1, lines: ["#1 worked: npm ci"], hosts: [] } };
  async function firstPrompt(withCarryOver: boolean): Promise<string> {
    const r = await repository();
    const prompts: string[] = [];
    const listeners: Array<(event: unknown) => void> = [];
    const session = {
      conversationId: "c", sessionFile: join(r.root, "agent-sessions/c.jsonl"),
      prompt: async (text?: string) => { prompts.push(String(text)); for (const l of listeners) l({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "no answer" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } } } }); },
      abort: async () => undefined, getModel: () => ({ provider: "amazon-bedrock", modelId: "global.anthropic.claude-fable-5" }), getSessionStats: () => ({ cost: 0, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } }) as never,
      subscribe: (l: (event: unknown) => void) => { listeners.push(l); return () => undefined; }, dispose: () => undefined,
    } as unknown as PiSessionHandle;
    const adapter: PiSessionAdapter = { create: async () => session };
    const docker: DockerCli = { run: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }) };
    const invocation = { operationId: "11111111-1111-4111-8111-111111111111", projectRevision: 1, payload: { conversationId: "c", setupAgent: { limits: { ...SETUP_AGENT_LIMITS_DEFAULT }, commits: [{ repository: "web", commit: r.commit }], ...(withCarryOver ? { carryOver } : {}) } } } as never;
    const dependencies = {
      rootPath: r.root, model: { provider: "amazon-bedrock", modelId: "global.anthropic.claude-fable-5" }, piAdapter: adapter, docker, setupAgent: async () => ({}),
      eventSink: async () => undefined,
      environment: { AGENTX_SANDBOX_IMAGE: `i@sha256:${"b".repeat(64)}`, AGENTX_SANDBOX_NETWORK: "agentx-sandbox", AGENTX_MODEL_PROXY_URL: "https://proxy.test" },
    };
    const manifest = { repositories: [{ name: "web", path: "repo/web", resolvedCommit: r.commit, defaultBranch: "main", resolvedAt: "", completedAt: "" }] };
    await runSetupAgentInvocation(invocation, dependencies, manifest, r.root);
    return prompts[0] ?? "";
  }
  it("puts the carry-over in the first prompt as marked data, and a payload without it prompts without any", async () => {
    const withIt = await firstPrompt(true);
    expect(withIt).toContain("<last-run-findings>");
    expect(withIt).toContain("#1 worked: npm ci");
    const without = await firstPrompt(false);
    expect(without).not.toContain("last-run-findings");
  });
});

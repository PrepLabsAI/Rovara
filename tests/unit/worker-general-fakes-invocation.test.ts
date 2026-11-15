// General fakes slice 1 (DEC 234), end to end in the worker: a real CHECKS invocation on the local shell whose payload carries `generalFakes` runs the customer's check command, the command's call to its
// base-URL variable gets the Rovara-made fake's answer, and the round says "Made by Rovara". The same invocation without the payload is unchanged (the command cannot reach the service).
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { GENERAL_FAKE_NOT_RUN_SENTENCES, GENERAL_FAKES_LOCAL_ONLY_SENTENCE, type GeneralFakesPayload, type ProjectCommand } from "@agentx/contracts";
import { isolatedGitEnvironment } from "../../packages/worker/src/git.js";
import { runTaskInvocation, type TaskInvocationDependencies } from "../../packages/worker/src/run-task.js";
import { FAUX_MODEL } from "../support/faux-model.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const git = (directory: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Rovara", "-c", "user.email=noreply@example.invalid", ...args], { cwd: directory, env: isolatedGitEnvironment(directory), encoding: "utf8" }).trim();
const put = async (root: string, path: string, text: string) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); };

const SPEC = JSON.stringify({ openapi: "3.0.3", info: { title: "pay", version: "1" }, paths: { "/charges/{id}": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", properties: { paid: { type: "boolean" } } } } } } } } } } });
// The customer's test: it calls its payments service through its own variable, and passes only on a paid charge.
const TEST = "const base = process.env.PAY_URL ?? 'https://pay.invalid'; fetch(base + process.argv[1]).then(async (r) => { const b = await r.json(); console.log('paid=' + b.paid); process.exit(b.paid === true ? 0 : 1); }, () => { console.log('unreachable'); process.exit(2); });";
const check = (path: string): ProjectCommand => ({ executable: process.execPath, args: ["-e", TEST, path], cwd: "app", timeoutSeconds: 20 });

async function invoke(payload: { generalFakes?: GeneralFakesPayload; readiness: ProjectCommand[] }, candidate: Record<string, string> = {}, base: Record<string, string> = {}) {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "rovara-gf-invoke-")));
  roots.push(root);
  await mkdir(join(root, "app"));
  git(join(root, "app"), "init", "-q", "-b", "main");
  await put(root, "app/openapi.json", SPEC);
  for (const [path, text] of Object.entries(base)) await put(root, `app/${path}`, text);
  git(join(root, "app"), "add", "-A"); git(join(root, "app"), "commit", "-qm", "base");
  const baseCommit = git(join(root, "app"), "rev-parse", "HEAD");
  // The candidate: the agent's uncommitted changes on top of the base.
  for (const [path, text] of Object.entries(candidate)) await put(root, `app/${path}`, text);
  await put(root, ".agentx/preparation-manifest.json", JSON.stringify({ schemaVersion: 2, projectName: "pay", projectRevision: 1, repositories: [{ name: "app", path: "app", defaultBranch: "main", resolvedCommit: baseCommit }],
    completedSetupSteps: [], readinessResults: [], readinessCommandKeys: [], complete: true, updatedAt: new Date().toISOString() }));
  const events: unknown[] = [];
  const artifacts = new Map<string, string>();
  const dependencies: TaskInvocationDependencies = { rootPath: root, model: FAUX_MODEL,
    taskShell: { kind: "local" },
    stopBeforeReading: { stopWorkspaceProcesses: async () => ({ stopped: 0 }), sweepWorkspaceContainers: async () => ({ removed: 0 }) },
    eventSink: async (batch: unknown) => { events.push(batch); }, artifactSink: async (artifact: { name: string; content: string | Uint8Array }) => { artifacts.set(artifact.name, String(artifact.content)); } };
  const invocation: Parameters<typeof runTaskInvocation>[0] = { protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
    payload: { workflowMode: "CHECKS", conversationId: randomUUID(), prompt: "check", ...payload } };
  const result = await runTaskInvocation(invocation, dependencies);
  return { result, events: JSON.stringify(events), artifacts };
}

describe("general fakes in a real CHECKS invocation", () => {
  it("the check's call gets the fake's answer and the round is labelled Made by Rovara", async () => {
    const { result, events } = await invoke({ generalFakes: { services: [{ variable: "PAY_URL" }] }, readiness: [check("/charges/ch_1")] });
    expect(result.checks?.checks[0]).toMatchObject({ after: "passed" });
    expect(result.checks?.checks[0]?.output).toContain("paid=true");
    expect(events).toContain("Made by Rovara: 1 outside call in this check round was answered by fakes Rovara made from your OpenAPI description. They never count as change proof.");
  });

  it("a failed check after a call the fake cannot answer is Not run with the reason", async () => {
    const { result } = await invoke({ generalFakes: { services: [{ variable: "PAY_URL" }] }, readiness: [check("/refunds/r_1")] });
    expect(result.checks?.checks[0]).toMatchObject({ after: "not_run", output: GENERAL_FAKE_NOT_RUN_SENTENCES.operation_unknown });
    expect(JSON.stringify(result.checks?.checks[0])).toContain(GENERAL_FAKE_NOT_RUN_SENTENCES.operation_unknown);
  });

  // Review M1/M2: the change removed an outside call. On the new code the test passes with no call; on the original code the call is answered by the fake and the new test fails there.
  // That "fails on the old code" rests on a Rovara-made answer, so the saved test proof must mark the check, and it can never read as proof.
  it("the saved test proof marks a check whose original-code run used a fake, even when the new code made no call", async () => {
    const callsService = "module.exports = async () => ((await (await fetch(process.env.PAY_URL + '/charges/ch_1')).json()).paid ? 'paid' : 'unpaid');\n";
    const testFile = "const test = require('node:test'); const assert = require('node:assert'); test('unpaid', async () => { assert.equal(await require('./lib.cjs')(), 'unpaid'); });\n";
    const proofCheck: ProjectCommand = { executable: "node", args: ["--test", "lib.test.cjs"], cwd: "app", timeoutSeconds: 30 };
    const { result, artifacts } = await invoke({ generalFakes: { services: [{ variable: "PAY_URL" }] }, readiness: [proofCheck] },
      { "lib.cjs": "module.exports = async () => 'unpaid';\n", "lib.test.cjs": testFile }, { "lib.cjs": callsService });
    expect(result.checks?.checks[0]).toMatchObject({ after: "passed" });
    const proof = JSON.parse(artifacts.get("test-proof.json") ?? "null") as { items: { checkId: string; verdict: string }[]; madeByRovara?: { checkId: string }[] } | null;
    expect(proof?.items).toEqual([expect.objectContaining({ checkId: "readiness:0", verdict: "proves_change" })]);
    expect(proof?.madeByRovara).toEqual([{ checkId: "readiness:0", served: expect.any(Number) as number }]);
  });

  it("without the payload the invocation is unchanged: no fake, no label, the call fails as before (golden)", async () => {
    const { result, events } = await invoke({ readiness: [check("/charges/ch_1")] });
    expect(result.checks?.checks[0]).toMatchObject({ after: "failed" });
    expect(result.checks?.checks[0]?.output).toContain("unreachable");
    expect(events).not.toContain("Made by Rovara");
    expect(events).not.toContain(GENERAL_FAKES_LOCAL_ONLY_SENTENCE);
  });
});

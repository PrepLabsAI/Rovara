import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { snapshotExecutorOutput } from "../../packages/verifier/src/host/executor-readback.js";
import { createCredentialRedactor } from "../../packages/verifier/src/executor/redact.js";

// Task 4.3b: the host reads an agent step's ledger and recordings back as operator evidence (executor-readback.ts), next to the captures and the log head. Neither file is a verdict input.
const PASSWORD = "pw-Zk39-very-secret-value";
const result = { schemaVersion: "e2e-executor-result/v1", exitCode: 0, reason: null, startedAt: "2026-10-20T00:00:00.000Z", finishedAt: "2026-10-20T00:01:00.000Z",
  node: { version: "v22.23.2", execPath: "/usr/local/bin/node", platform: "linux", arch: "arm64" }, runId: "r", groupId: "g", shards: [] } as never;
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function outDirWith(files: Record<string, Buffer | string>): Promise<string> {
  const out = await mkdtemp(join(tmpdir(), "agent-readback-")); dirs.push(out);
  await mkdir(join(out, "observations"), { recursive: true });
  for (const [name, data] of Object.entries(files)) { await mkdir(join(out, name, ".."), { recursive: true }); await writeFile(join(out, name), data); }
  return out;
}
const redactor = () => createCredentialRedactor([{ profileId: "orders-owner", email: "rovara-owner-a1b2c3@example.test", password: PASSWORD }]);
const options = { containsCredential: (bytes: Uint8Array) => redactor().contains(bytes) };
const CASE_DIR = "0123456789abcdef";

describe("reading an agent step's files back into the snapshot", () => {
  it("carries each case's ledger and the kept recordings, byte for byte, and counts nothing dropped", async () => {
    const out = await outDirWith({ [`agent/${CASE_DIR}/agent-actions.json`]: '{"ledger":1}\n', "agent/traces/trace-aaaaaaaaaaaaaaaa.json": '{"actions":[]}' });
    const agent = (await snapshotExecutorOutput(out, result, options)).executorEvidence.agent!;
    expect(agent.ledgers.map((item) => [item.caseDirectory, Buffer.from(item.bytes).toString()])).toEqual([[CASE_DIR, '{"ledger":1}\n']]);
    expect(agent.traces.map((item) => [item.name, Buffer.from(item.bytes).toString()])).toEqual([["trace-aaaaaaaaaaaaaaaa.json", '{"actions":[]}']]);
    expect(agent.dropped).toBe(0);
  });

  it("has no agent field at all for a run that left none, so such a run reads back exactly as before", async () => {
    const snapshot = await snapshotExecutorOutput(await outDirWith({ "executor.log": "x" }), result, options);
    expect("agent" in snapshot.executorEvidence).toBe(false);
  });

  it("holds back a file the host's credential predicate flags (an account password, and as base64 too) and counts it", async () => {
    const out = await outDirWith({ [`agent/${CASE_DIR}/agent-actions.json`]: `{"typed":"${PASSWORD}"}`, "agent/traces/trace-aaaaaaaaaaaaaaaa.json": `{"x":"${Buffer.from(PASSWORD).toString("base64")}"}`,
      "agent/traces/trace-bbbbbbbbbbbbbbbb.json": '{"actions":[]}' });
    const agent = (await snapshotExecutorOutput(out, result, options)).executorEvidence.agent!;
    expect(agent.ledgers).toEqual([]);
    expect(agent.traces.map((item) => item.name)).toEqual(["trace-bbbbbbbbbbbbbbbb.json"]);
    expect(agent.dropped).toBe(2);
    expect(JSON.stringify([...agent.ledgers, ...agent.traces].map((item) => Buffer.from(item.bytes).toString("latin1")))).not.toContain(PASSWORD);
  });

  it("does not follow a link in place of a file or a directory, ignores names outside the executor's own, and never fails the snapshot", async () => {
    const out = await outDirWith({ "outside.json": "secret outside", [`agent/${CASE_DIR}/placeholder`]: "x", "agent/notes.txt": "ignored", "agent/traces/trace-bad.json": "ignored", "agent/ZZZ/agent-actions.json": "ignored" });
    await symlink(join(out, "outside.json"), join(out, `agent/${CASE_DIR}/agent-actions.json`));
    const agent = (await snapshotExecutorOutput(out, result, options)).executorEvidence.agent!;
    expect(agent.ledgers).toEqual([]);
    expect(agent.traces).toEqual([]);
    expect(agent.dropped).toBe(1);
  });

  it("bounds a ledger at 256 KiB and a recording at 1 MiB, and holds sixteen recordings at most", async () => {
    const files: Record<string, string> = { [`agent/${CASE_DIR}/agent-actions.json`]: "x".repeat(256 * 1024 + 1), "agent/traces/trace-ffffffffffffffff.json": "y".repeat(1_048_577) };
    for (let index = 0; index < 17; index += 1) files[`agent/traces/trace-${index.toString(16).padStart(16, "0")}.json`] = "{}";
    const agent = (await snapshotExecutorOutput(await outDirWith(files), result, options)).executorEvidence.agent!;
    expect(agent.ledgers).toEqual([]);
    expect(agent.traces).toHaveLength(16);
    expect(agent.dropped).toBe(3);
  });
});

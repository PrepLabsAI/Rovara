import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { agentRunnable, executorLog, runAgentCase } from "../support/agent-executor-run.js";
import { assembleAgentRun, collectAssembled } from "../support/agent-collection.js";

it.runIf(agentRunnable)("an AI owner and a deterministic viewer run in separate shards without giving the viewer a model", async () => {
  const run = await runAgentCase({
    script: [{ kind: "tap", name: /Download orders/ }, { kind: "done" }],
    plan: { withDeterministicCase: true, deterministicAccountProfileId: "orders-viewer" },
  });
  try {
    expect(run.fixture.compiled.shards).toHaveLength(2);
    expect(run.result, executorLog(run.out)).toEqual({ exitCode: 0, reason: null });
    const assembled = await assembleAgentRun(run);
    const collected = collectAssembled(assembled);
    expect(collected.unavailableReason).toBeNull();
    expect(collected.qualification?.status).toBe("PASS");
    expect(collected.qualification?.result?.cases).toHaveLength(2);
    const owner = run.fixture.compiled.expectedCases.find(item => item.scenarioId === "agent-export")!;
    expect(run.receipts.length).toBeGreaterThan(0);
    expect(run.receipts.every(receipt => receipt.caseId === owner.caseId)).toBe(true);
    // Re-addressing a report must not let an AI shard claim a larger token limit.
    const ownerShard = assembled.actual.shards.find(shard => assembled.resolved.suite.shards
      .find(compiled => compiled.shardId === shard.shardId)?.targetId === owner.targetId)!;
    const report = JSON.parse(Buffer.from(ownerShard.rawReportBytes).toString("utf8")) as { run: { limits: Record<string, number> } };
    report.run.limits.maxModelTokensPerCall = 64_001;
    const bytes = Buffer.from(JSON.stringify(report));
    const forged = { ...ownerShard, rawReportBytes: bytes, runProcess: { ...ownerShard.runProcess,
      stdoutSha256: createHash("sha256").update(bytes).digest("hex"), stdoutBytes: bytes.byteLength } };
    const tampered = collectAssembled({ ...assembled, actual: { ...assembled.actual,
      shards: assembled.actual.shards.map(shard => shard.shardId === ownerShard.shardId ? forged : shard) } });
    expect(tampered.qualification?.status ?? "UNKNOWN").toBe("UNKNOWN");
    expect(tampered.unavailableReason).toContain("budget");

  } finally {
    await run.cleanup();
  }
}, 300_000);

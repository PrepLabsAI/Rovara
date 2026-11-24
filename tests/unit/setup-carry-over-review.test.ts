// Lead 4 Opus review of SETUP-CARRY-OVER (DEC 254zzz431): the scoping and scrubbing lines the builder's tests left unpinned, and the size cut the claim promises.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, SETUP_CARRY_OVER_MAX_BYTES, SETUP_CARRY_OVER_PROPOSAL_MAX_BYTES, type SetupJournalEntry, type SetupProposal } from "@agentx/contracts";
import type { SetupAgentPointer, SetupAgentView } from "../../packages/broker/src/core/setup-agent/agent.js";
import { buildCarryOver, journalLineOf, setupCarryOverFor } from "../../packages/broker/src/core/setup-agent/carry-over.js";
import { appendSetupJournal } from "../../packages/broker/src/core/setup-agent/journal.js";
import { hostAskKey, setupAgentKey } from "../../packages/broker/src/core/setup-agent/keys.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";

const ORG = IMPLICIT_COMPANY_ID;
const NOW = Date.parse("2026-11-23T12:00:00Z");
const ENDED_AT = new Date(NOW - 3_600_000).toISOString();
const LIMITS = { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 };
const entry = (n: number, over: Partial<SetupJournalEntry> = {}): SetupJournalEntry => ({
  n, source: "agent", command: `npm run step-${String(n)}`, exitCode: 0, durationMs: 1_000, timedOut: false, flagged: false, blockedHosts: [], tail: "ok\n", startedAt: "2026-11-23T10:00:00.000Z", ...over,
});
const proposal = (over: Record<string, unknown> = {}): SetupProposal => ({
  version: 2, basedOnRevision: 1, repositories: [],
  setup: [{ id: "setup-web", value: { repo: "web", commands: ["npm ci"] }, from: [{ kind: "inferred", repo: "web", note: "worked when run" }], confidence: "high", risk: "low" }],
  tests: [], checks: [], testEnvironment: [], knowledge: [], sources: [], intake: [], allowedDomains: [], secretsNeeded: [], flaggedCommands: [], foundNotUsed: [], notes: "", ...over,
} as unknown as SetupProposal);

async function seed(store: MemoryDocumentStore, taskId = randomUUID()) {
  const pointer = { orgId: ORG, project: "payments", taskId, requestId: randomUUID(), requestedBy: "owner", basedOnRevision: 1, startedAt: "2026-11-23T09:00:00.000Z", limits: LIMITS };
  await store.put({ item: { ...setupAgentKey(ORG, "payments"), entityType: "SETUP_AGENT", ...pointer } });
  await store.put({ item: { ...taskKey(taskId), entityType: "DEVELOPER_TASK", companyId: ORG, project: "payments", purpose: "setup_agent", taskId, setupAgentResult: { status: "failed", stop: "time_used", failure: "x" }, agentRunEnd: { state: "FAILED", at: ENDED_AT }, updatedAt: ENDED_AT } });
  await appendSetupJournal({ store, now: () => NOW }, { orgId: ORG, project: "payments", taskId }, [entry(1, { command: "npm ci" })]);
  return { pointer: pointer as unknown as SetupAgentPointer, taskId };
}
const viewOf = (taskId: string): SetupAgentView => ({ status: "failed", basedOnRevision: 1, limits: LIMITS, taskId, stop: "time_used", proposal: proposal() });
const deps = (store: MemoryDocumentStore) => ({ store, companyId: ORG as never, now: () => NOW });

describe("review: what the carry-over reads is the named run's own", () => {
  it("names only the websites of the run it carries, never another run's asks in the same project", async () => {
    const store = new MemoryDocumentStore();
    const { pointer, taskId } = await seed(store);
    const ask = (host: string, askTask: string) => ({ ...hostAskKey(ORG, "payments", host), entityType: "SETUP_HOST_ASK", orgId: ORG, project: "payments", host, state: "approved", requestedBy: "a".repeat(64), taskId: askTask, askedAt: "2026-11-23T10:00:00.000Z", joined: 0 });
    await store.put({ item: ask("mine.example.dev", taskId) });
    await store.put({ item: ask("older-run.example.dev", randomUUID()) });
    const carried = await setupCarryOverFor(deps(store), "payments", { view: viewOf(taskId), pointer });
    expect(carried?.journal.hosts).toEqual([{ host: "mine.example.dev", state: "approved" }]);
  });

  it("is not taken when the view read now is of another run than the pointer names", async () => {
    const store = new MemoryDocumentStore();
    const { pointer } = await seed(store);
    expect(await setupCarryOverFor(deps(store), "payments", { view: viewOf(randomUUID()), pointer })).toBeUndefined();
  });

  it("scrubs a secret-shaped value from a journal line even when the stored row still held it", () => {
    const key = `AKIA${"Q".repeat(16)}`;
    const line = journalLineOf(entry(2, { command: `aws configure set aws_access_key_id ${key}`, exitCode: 1, tail: `error near ${key}\n` }));
    expect(line).not.toContain(key);
    expect(line).toMatch(/^#2 failed \(exit 1\): aws configure set/u);
  });
});

describe("review: the cut order holds on the wire size, not only on the proposal's own text", () => {
  it("a proposal within its share whose JSON grows when it is carried as a string still leaves a carry-over (cut, not dropped)", () => {
    // ~8.4 KB of proposal JSON, inside its 10 KiB share; carried as a JSON string each quote becomes 2-4 bytes, so the whole exceeds 16 KiB.
    const quoted = proposal({ notes: "\"".repeat(4_000) });
    expect(Buffer.byteLength(JSON.stringify(quoted))).toBeLessThanOrEqual(SETUP_CARRY_OVER_PROPOSAL_MAX_BYTES);
    const carried = buildCarryOver({ fromRun: "t1", endedAs: "time_used", proposal: quoted, journal: [entry(1, { command: "npm ci" })], hosts: [] });
    expect(carried).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(carried))).toBeLessThanOrEqual(SETUP_CARRY_OVER_MAX_BYTES);
    expect(carried?.journal.lines).toEqual(["#1 worked: npm ci"]);
  });

  it("twenty long website names do not drop a full-share proposal and its journal", () => {
    const label = "a".repeat(60);
    const hosts = Array.from({ length: 20 }, (_, index) => ({ host: `${label}.${label}.${label}.h${String(index)}.example.dev`, state: "blocked" as const }));
    const setup = Array.from({ length: 58 }, (_, index) => ({ id: `setup-${String(index)}`, value: { repo: "web", commands: ["npm ci", "npm run build"] }, from: [{ kind: "inferred", repo: "web", note: "ok" }], confidence: "high", risk: "low" }));
    const carried = buildCarryOver({ fromRun: "t1", endedAs: "time_used", proposal: proposal({ setup }), journal: [entry(1, { command: "npm ci" })], hosts });
    expect(carried).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(carried))).toBeLessThanOrEqual(SETUP_CARRY_OVER_MAX_BYTES);
  });
});

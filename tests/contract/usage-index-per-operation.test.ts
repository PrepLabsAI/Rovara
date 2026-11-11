// A release check found the usage index (USAGE_INDEX rows, origin ai_tool) adding up to about 1.8 times the cost ledger. A conversation's reopened Pi session adds up every message of its saved
// transcript, so the worker's usage event for a later operation carried the conversation's running total, and a review run (whose own session is not used) sent that whole total again.
// This runs the real worker over several operations of one conversation (a retry, a crash before the event was sent and its retry, and a review among them), sends each usage event
// through the real activity index, settles the ledger after each operation, and asserts that the rows, and the autofix spend sum, add up to what was spent.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { marshall } from "@aws-sdk/util-dynamodb";
import { describe, expect, it } from "vitest";
import { WorkerInvocationSchema } from "../../packages/contracts/src/index.js";
import { indexActivity, type IndexStore } from "../../packages/broker/src/aws/activity-index.js";
import type { StreamRecord } from "../../packages/broker/src/developer/notifications.js";
import { statsSince } from "../../packages/worker/src/usage.js";
import type { PiSessionAdapter, PiSessionHandle } from "../../packages/worker/src/pi-session.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";

const git = (directory: string, ...args: string[]) => execFileSync("git", ["-C", directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args], { encoding: "utf8" }).trim();

async function workspace() {
  const rootPath = await realpath(await mkdtemp(join(tmpdir(), "agentx-usage-index-")));
  const directory = join(rootPath, "repo/payments");
  await mkdir(join(directory, "src"), { recursive: true });
  git(directory, "init", "--quiet", "--initial-branch=main");
  await writeFile(join(directory, "src/a.ts"), "export const a = 1;\n");
  git(directory, "add", ".");
  git(directory, "commit", "--quiet", "-m", "base");
  const base = git(directory, "rev-parse", "HEAD");
  const now = new Date().toISOString();
  await mkdir(join(rootPath, ".agentx"), { recursive: true });
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({
    schemaVersion: 2, projectName: "payments", projectRevision: 1,
    repositories: [{ name: "payments", path: "repo/payments", defaultBranch: "main", resolvedCommit: base, resolvedAt: now, completedAt: now }],
    completedSetupSteps: [], readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: now,
  }));
  await writeFile(join(directory, "src/a.ts"), "export const a = 2;\n");
  return { rootPath, base };
}

const SPEC = { kind: "feature", title: "Reset password", summary: "Let a user reset a password.", requirements: [{ title: "Request", criteria: [{ when: "a user submits a known email", shall: "send one reset link" }] }], design: "Use the mailer.", tasks: [{ title: "Add route", covers: ["1.1"] }] };
const SPEC_ANSWER = `Here you go.\n\`\`\`rovara-spec\n${JSON.stringify(SPEC)}\n\`\`\``;
const PLAN_DIGEST = "d".repeat(64);

/**
 * Pi's own behaviour for what matters here: a session's stats add up every message of the transcript it holds, a reopened conversation holds the earlier operations' messages, and what a
 * model call costs is spent for real (`incurred`, which the proxy's key spend and so the ledger counts).
 */
function fakePi(conversationId: string, costs: { next: Array<number | null> }) {
  const statsFail = { once: false };
  const transcripts = new Map<string, number[]>();
  const incurred = { usd: 0 };
  const session = (id: string, file: string, role: "main" | "reviewer"): PiSessionHandle => {
    const entries = transcripts.get(id) ?? [];
    transcripts.set(id, entries);
    let listener: (event: unknown) => void = () => undefined;
    return {
      conversationId: id, sessionFile: file,
      async prompt() {
        const cost = costs.next.length === 0 ? 0 : costs.next.shift()!;
        // `null`: the model call never happened (the run answered without one), so nothing is added to the transcript.
        if (cost !== null) {
          entries.push(cost);
          incurred.usd = Math.round((incurred.usd + cost) * 1e9) / 1e9;
        }
        listener({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: role === "main" ? SPEC_ANSWER : '{"findings":[]}' }] } });
      },
      async abort() {},
      getModel: () => ({ provider: "test", modelId: "first-v1" }),
      getSessionStats: () => {
        if (statsFail.once) { statsFail.once = false; throw new Error("stats unreadable"); }
        return { sessionFile: file, sessionId: id, userMessages: entries.length, assistantMessages: entries.length, toolCalls: 0, toolResults: 0, totalMessages: entries.length * 2, tokens: { input: 10 * entries.length, output: 5 * entries.length, cacheRead: 0, cacheWrite: 0, total: 15 * entries.length }, cost: Math.round(entries.reduce((sum, cost) => sum + cost, 0) * 1e9) / 1e9 };
      },
      subscribe(callback) { listener = callback; return () => { listener = () => undefined; }; },
      dispose() {},
    };
  };
  const adapter: PiSessionAdapter = {
    async create(input) {
      const file = join(input.sessionDirectory, `${input.conversationId ?? randomUUID()}.jsonl`);
      await writeFile(file, "{}");
      return session(input.conversationId ?? randomUUID(), file, input.conversationId === conversationId ? "main" : "reviewer");
    },
    async open(input) {
      return session(input.conversationId, input.sessionFile, "main");
    },
  };
  return { adapter, incurred, statsFail };
}

/** What a conversation started by 0.5.13 looks like: the manifest has no reported usage. */
async function withoutReportedUsage(rootPath: string): Promise<void> {
  const file = join(rootPath, ".agentx/conversations.json");
  const manifest = JSON.parse(await readFile(file, "utf8")) as { conversations: Record<string, Record<string, unknown>> };
  for (const record of Object.values(manifest.conversations)) delete record.reportedUsage;
  await writeFile(file, JSON.stringify(manifest));
}

const WORKSPACE_ID = randomUUID();
const TASK = randomUUID();
const taskRecords = [
  { pk: `WORKSPACE#${WORKSPACE_ID}`, sk: "META", projectName: "payments", ownerKey: "a".repeat(64) },
  { pk: `WORKSPACE#${WORKSPACE_ID}`, sk: "DEVELOPER_TASK", entityType: "DEVELOPER_TASK_POINTER", taskId: TASK, developerId: "d".repeat(64) },
  { pk: `DEVTASK#${TASK}`, sk: "META", taskId: TASK, developerName: "Maya Chen" },
];

/** The index as DynamoDB keeps it: a put of a key that exists replaces the row. */
function table() {
  const rows = new Map<string, Record<string, unknown>>();
  const store: IndexStore = {
    get: async (key) => taskRecords.find((item) => item.pk === key.pk && item.sk === key.sk),
    put: async (item) => { rows.set(`${String(item.pk)}|${String(item.sk)}`, item); },
  };
  return { store, rows, usdOf: () => Math.round([...rows.values()].reduce((sum, row) => sum + Number(row.costUsd), 0) * 1e6) / 1e6 };
}

const inserted = (item: Record<string, unknown>, eventID: string): StreamRecord => ({ eventID, eventName: "INSERT", dynamodb: { NewImage: marshall(item, { removeUndefinedValues: true }) } });

describe("the usage index holds each operation's own cost, written once", () => {
  it("adds up to the ledger over several operations of one conversation, a retry and a review among them, with a settle after each", async () => {
    const w = await workspace();
    const conversationId = randomUUID();
    const costs = { next: [] as Array<number | null> };
    const pi = fakePi(conversationId, costs);
    const index = table();
    // The broker's side: events get the next sequence number of their operation (a retry continues it) and arrive at distinct times (a row is keyed by its time and operation), the index reads them, and the ledger settles what the proxy says was spent.
    const sequences = new Map<string, number>();
    const stored: Array<Record<string, unknown>> = [];
    const ledger = { settledUsd: 0, settles: 0 };
    const operations: Array<{ id: string; mode: "SPEC_WRITE" | "REVIEW"; costs: Array<number | null>; runs: number; crashFirst?: true; legacyBefore?: true }> = [
      { id: randomUUID(), mode: "SPEC_WRITE", costs: [0.03815], runs: 1 },
      { id: randomUUID(), mode: "SPEC_WRITE", costs: [0.02035], runs: 1 },
      // Reopened, with a first attempt that is run again under the same operation id.
      { id: randomUUID(), mode: "SPEC_WRITE", costs: [0.04978, 0.0123], runs: 2 },
      // A review run: the conversation's session and the reviewers' sessions of their own each spend.
      { id: randomUUID(), mode: "REVIEW", costs: [0.03688, 0.02712], runs: 1 },
      // The conversation was started before the reported figure was kept (a 0.5.13 conversation): its earlier operations were reported as running totals, so this one starts from the stats at reopen.
      { id: randomUUID(), mode: "SPEC_WRITE", costs: [0.0517], runs: 1, legacyBefore: true },
      // A run on the reopened conversation that makes no model call: it spent nothing, so it reports nothing (and not the conversation's running total).
      { id: randomUUID(), mode: "SPEC_WRITE", costs: [null], runs: 1 },
      // A first attempt that makes its model calls and dies before its usage event reaches the control plane (the event sink refuses everything), then the retry: the retry reports both.
      { id: randomUUID(), mode: "SPEC_WRITE", costs: [0.0777, 0.0111], runs: 2, crashFirst: true },
      { id: randomUUID(), mode: "SPEC_WRITE", costs: [0.0299], runs: 1 },
    ];
    let first = true;
    for (const operation of operations) {
      for (let run = 0; run < operation.runs; run += 1) {
        costs.next = operation.mode === "SPEC_WRITE" ? [operation.costs[run]!] : [...operation.costs];
        const events: Array<{ type: string; timestamp: string; payload: unknown }> = [];
        const crashed = operation.crashFirst === true && run === 0;
        if (operation.legacyBefore === true && run === 0) await withoutReportedUsage(w.rootPath);
        const attempt = runTaskInvocation(WorkerInvocationSchema.parse({
          protocolVersion: 1, kind: "task", operationId: operation.id, workspaceId: WORKSPACE_ID, fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
          payload: operation.mode === "SPEC_WRITE"
            ? { conversationId, ...(first ? {} : { conversationStarted: true }), prompt: "THE APPROVED PLAN", workflowMode: "SPEC_WRITE", specWrite: { format: "kiro", kind: "feature", planDigest: PLAN_DIGEST }, workflowBase: [{ repositoryId: "payments", baseCommitSha: w.base }] }
            : { conversationId, conversationStarted: true, prompt: "Run the independent read-only reviews.", workflowMode: "REVIEW", workflowBase: [{ repositoryId: "payments", baseCommitSha: w.base }] },
        }), {
          rootPath: w.rootPath, model: { provider: "test", modelId: "first-v1" }, piAdapter: pi.adapter, log: () => undefined,
          eventSink: async (batch) => {
            if (crashed) throw new Error("the control plane did not take the events");
            for (const event of (Array.isArray(batch) ? batch : [batch]) as typeof events) events.push(event);
          },
          artifactSink: async () => undefined,
        });
        if (crashed) await attempt.catch(() => undefined);
        else await attempt;
        first = false;
        const records: StreamRecord[] = [];
        for (const event of events) {
          if (event.type !== "usage") continue;
          const sequence = (sequences.get(operation.id) ?? 0) + 1;
          sequences.set(operation.id, sequence);
          const item = { pk: `OPERATION#${operation.id}`, sk: `EVENT#${String(sequence).padStart(12, "0")}`, entityType: "EVENT", workspaceId: WORKSPACE_ID, operationId: operation.id, sequence, type: "usage", timestamp: new Date(Date.parse(event.timestamp) + sequence).toISOString(), payload: event.payload };
          stored.push(item);
          records.push(inserted(item, `${operation.id}-${sequence}`));
        }
        expect(await indexActivity(records, index.store, () => undefined)).toMatchObject({ failed: 0 });
        // The settle after the operation: the ledger counts what the proxy says the task's keys spent so far.
        ledger.settledUsd = pi.incurred.usd;
        ledger.settles += 1;
      }
    }
    expect(ledger.settles).toBe(10);
    expect(ledger.settledUsd).toBeCloseTo(0.03815 + 0.02035 + 0.04978 + 0.0123 + 0.03688 + 0.02712 + 0.0517 + 0.0777 + 0.0111 + 0.0299, 6);
    // The index adds up to the ledger (within rounding), and every row is origin ai_tool.
    expect([...index.rows.values()].every((row) => row.origin === "ai_tool")).toBe(true);
    expect(index.usdOf()).toBeCloseTo(ledger.settledUsd, 6);
    // No operation's rows add up to more than that operation spent: the retried operation holds both attempts' own cost.
    const byOperation = (id: string) => Math.round([...index.rows.values()].filter((row) => row.operationId === id).reduce((sum, row) => sum + Number(row.costUsd), 0) * 1e6) / 1e6;
    expect(byOperation(operations[0]!.id)).toBeCloseTo(0.03815, 6);
    expect(byOperation(operations[1]!.id)).toBeCloseTo(0.02035, 6);
    expect(byOperation(operations[2]!.id)).toBeCloseTo(0.04978 + 0.0123, 6);
    expect(byOperation(operations[3]!.id)).toBeCloseTo(0.03688 + 0.02712, 6);
    expect(byOperation(operations[4]!.id)).toBeCloseTo(0.0517, 6);
    expect(byOperation(operations[5]!.id)).toBe(0);
    expect(byOperation(operations[6]!.id)).toBeCloseTo(0.0777 + 0.0111, 6);
    expect(byOperation(operations[7]!.id)).toBeCloseTo(0.0299, 6);
    // One row per report that spent something: the review has one for its conversation session and one per reviewer session, the retried operation has one row per attempt, a run with no model call has none.
    const rowsOf = (id: string) => [...index.rows.values()].filter((row) => row.operationId === id).length;
    expect(operations.map((operation) => rowsOf(operation.id))).toEqual([1, 1, 2, 3, 1, 0, 1, 1]);
    // The AUTOFIX spend cap adds up the usage events themselves (not the index): over a reopen, a retry and a crash and its retry, each operation's sum is what that operation really spent.
    const eventsClient = { send: async (command: { input: { ExpressionAttributeValues?: Record<string, unknown> } }) => ({ Items: stored.filter((item) => item.pk === command.input.ExpressionAttributeValues![":pk"]).map((item) => ({ payload: item.payload })) }) };
    // The broker's entry module reads its settings when it loads.
    Object.assign(process.env, {
      AWS_REGION: "us-east-1", STATE_TABLE_NAME: "unused", ARTIFACT_BUCKET_NAME: "unused", OIDC_ISSUER: "https://identity.example.test", CALLBACK_SIGNING_KEY: "c".repeat(64),
      GITHUB_APP_PRIVATE_KEY_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:111122223333:secret:test",
      GITHUB_APP_CREDENTIAL_REF: "github-app", GITHUB_APP_ACCOUNT: "example", GITHUB_APP_ID: "123", GITHUB_APP_INSTALLATION_ID: "456",
    });
    const { autofixOperationUsage } = await import("../../packages/broker/src/aws/broker.js");
    const autofixed = async (id: string) => autofixOperationUsage({ documentClient: eventsClient, tableName: "table" } as never, id);
    const spentBy = [0.03815, 0.02035, 0.04978 + 0.0123, 0.03688 + 0.02712, 0.0517, 0, 0.0777 + 0.0111, 0.0299];
    for (const [position, operation] of operations.entries()) expect((await autofixed(operation.id))?.total, `operation ${String(position)}`).toBeCloseTo(spentBy[position]!, 6);
  });
});

describe("a run whose usage cannot be worked out reports none, and says so", () => {
  const invocation = (operationId: string, conversationId: string, base: string, started: boolean) => WorkerInvocationSchema.parse({
    protocolVersion: 1, kind: "task", operationId, workspaceId: WORKSPACE_ID, fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
    payload: { conversationId, ...(started ? { conversationStarted: true } : {}), prompt: "THE APPROVED PLAN", workflowMode: "SPEC_WRITE", specWrite: { format: "kiro", kind: "feature", planDigest: PLAN_DIGEST }, workflowBase: [{ repositoryId: "payments", baseCommitSha: base }] },
  });
  const run = async (rootPath: string, pi: ReturnType<typeof fakePi>, input: ReturnType<typeof invocation>, options: { refuse?: true } = {}) => {
    const events: Array<{ type: string; payload: unknown }> = [];
    const logged: string[] = [];
    await runTaskInvocation(input, {
      rootPath, model: { provider: "test", modelId: "first-v1" }, piAdapter: pi.adapter, log: (_level, line) => { logged.push(line); },
      eventSink: async (batch) => {
        if (options.refuse) throw new Error("the control plane did not take the events");
        for (const event of (Array.isArray(batch) ? batch : [batch]) as typeof events) events.push(event);
      },
      artifactSink: async () => undefined,
    });
    return { usage: events.filter((event) => event.type === "usage"), logged };
  };

  it("sends nothing, instead of the whole running total again, when a conversation without a reported figure cannot read its stats", async () => {
    const w = await workspace();
    const conversationId = randomUUID();
    const costs = { next: [0.05, 0.07] as Array<number | null> };
    const pi = fakePi(conversationId, costs);
    const first = await run(w.rootPath, pi, invocation(randomUUID(), conversationId, w.base, false));
    expect(first.usage).toHaveLength(1);
    await withoutReportedUsage(w.rootPath);
    pi.statsFail.once = true;
    const second = await run(w.rootPath, pi, invocation(randomUUID(), conversationId, w.base, true));
    expect(second.usage).toHaveLength(0);
    expect(second.logged.some((line) => line.includes("usage.baseline_unavailable"))).toBe(true);
  });

  it("keeps the stats at the end of such a run as the figure, so a retry of the next run, which died before its event was sent, reports that attempt's spend too", async () => {
    const w = await workspace();
    const conversationId = randomUUID();
    const costs = { next: [0.05] as Array<number | null> };
    const pi = fakePi(conversationId, costs);
    await run(w.rootPath, pi, invocation(randomUUID(), conversationId, w.base, false));
    await withoutReportedUsage(w.rootPath);
    // This run cannot work out its own spend (nothing is sent for its 0.07), but the conversation now has a figure.
    costs.next = [0.07];
    pi.statsFail.once = true;
    expect((await run(w.rootPath, pi, invocation(randomUUID(), conversationId, w.base, true))).usage).toHaveLength(0);
    const kept = JSON.parse(await readFile(join(w.rootPath, ".agentx/conversations.json"), "utf8")) as { conversations: Record<string, { reportedUsage?: { cost: number } }> };
    expect(kept.conversations[conversationId]?.reportedUsage?.cost).toBeCloseTo(0.12, 6);
    // The next operation makes its model calls and dies before its event is sent; the retry reports both attempts.
    const operationId = randomUUID();
    costs.next = [0.02];
    await run(w.rootPath, pi, invocation(operationId, conversationId, w.base, true), { refuse: true }).catch(() => undefined);
    costs.next = [0.03];
    const retry = await run(w.rootPath, pi, invocation(operationId, conversationId, w.base, true));
    expect(retry.usage).toHaveLength(1);
    expect((retry.usage[0]!.payload as { costUsd: number }).costUsd).toBeCloseTo(0.05, 6);
  });

  it("sends no event for a run with no model call on a fresh session either, as on a reopened one", async () => {
    const w = await workspace();
    const conversationId = randomUUID();
    const pi = fakePi(conversationId, { next: [null] });
    const fresh = await run(w.rootPath, pi, invocation(randomUUID(), conversationId, w.base, false));
    expect(fresh.usage).toHaveLength(0);
  });
});

describe("a reopened session's usage since it opened", () => {
  const stats = (cost: number, total: number) => ({ tokens: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total }, cost });
  it("is the stats less the stats it opened with, never below zero, and the stats as they are with no baseline", () => {
    expect(statsSince(stats(0.08793, 30), stats(0.03815, 10))).toEqual(stats(0.04978, 20));
    expect(statsSince(stats(0.01, 5), stats(0.02, 9))).toEqual(stats(0, 0));
    expect(statsSince(stats(0.08793, 30), undefined)).toEqual(stats(0.08793, 30));
  });
});

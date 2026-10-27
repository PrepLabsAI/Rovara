import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentError } from "e2e/agent";
import { E2EAgentActionLedgerSchema, E2EAgentCleanTraceSchema, E2E_AGENT_TRACES_PER_GROUP_MAX, E2E_AGENT_TRACE_FILE_MAX_BYTES, E2E_AGENT_TRACE_SUMMARY, e2eAgentValueDigest, e2eAgentValueKeyId, generateE2EAgentValueKey, parseVerifiedE2EAgentActionLedger, reviewCapturedE2EAgentTrace,
  type E2EModelChannelClient, type E2EModelChannelRequest, type E2EModelChannelResponse } from "@agentx/contracts";
import { createRovaraE2EAgentExecutor, appRelativePath, elideSupersededScreens, parseScreen, parseScreenLine, E2E_AGENT_MESSAGES_SOFT_BUDGET_BYTES } from "../../packages/verifier/src/executor/agent-executor.js";
import { createE2EAgentLedgerWriter, E2E_AGENT_EVIDENCE_DIR, E2E_AGENT_LEDGER_FILE, agentCaseDirectoryName } from "../../packages/verifier/src/executor/agent-ledger.js";
import { agentTraceFilePath, createE2EAgentCaptureStore, persistE2EAgentTrace } from "../../packages/verifier/src/executor/agent-capture-store.js";
import { createCredentialRedactor } from "../../packages/verifier/src/executor/redact.js";
import { createE2EAgentModelAdapter, E2EAgentModelError } from "../../packages/verifier/src/executor/agent-model-adapter.js";
import { createE2EModelChannelClient } from "../../packages/verifier/src/executor/model-channel.js";
import { noSessionValues } from "../support/e2e-session-sync.js";
import { createScriptedE2EInvoke } from "../../packages/worker/src/e2e-model-scripted.js";

const RUN_ID = "7f1c2a4e-5b6d-4c8e-9f01-23456789abcd";
const CASE_ID = "case-orders-export";
const ORIGIN = "http://127.0.0.1:4317";
const GOAL = "Export the orders as a CSV file";
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const SCREEN = [
  '#n1 heading "Orders"',
  '#n2 button "Download orders" testid="download-orders"',
  '#n3 button "Download invoices" testid="download-invoices"',
  '#n4 textbox "File name" placeholder="name"',
].join("\n");

/** A recording as e2e hands it to the store (Task 4.6a): the actions and the provenance a real trace carries. */
const rec = (actions: unknown[], extra: Record<string, unknown> = {}) => ({ actions, executor: { name: "rovara-e2e-agent", version: "1" }, summary: "Done.",
  recordedFor: { testId: ".agentx/e2e/generated-application.test.ts::case-orders-export", targetId: "account-target-1", instructionDigest: sha(GOAL), callIndex: 0 }, ...extra });
const TAP_ORDERS = { name: "tap", summary: 'tap button "Download orders"', target: { role: "button", name: "Download orders", testId: "download-orders" } };

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "agent-unit-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type Answer = { tool: string; input: Record<string, unknown> };
const ok = (receiptId: string, answer: Answer): E2EModelChannelResponse => ({ schemaVersion: "rovara-e2e-model-channel/v1", receiptId, result: { status: "ok",
  content: [{ type: "tool-call", toolCallId: `call_${receiptId}`, toolName: answer.tool as "tap", input: JSON.stringify(answer.input) }],
  finishReason: { unified: "tool-calls", raw: null }, usage: { inputTokens: 100, outputTokens: 10 } } });

/** A channel client that answers from a list and keeps every request it was given. */
function scriptedClient(answers: Array<Answer | "error">) {
  const requests: Array<{ caseId: string; stepIndex: number; callIndex: number; call: E2EModelChannelRequest["call"] }> = [];
  const client: E2EModelChannelClient = {
    async beginStep() { /* the markers are the host's */ }, async endStep() { /* idem */ },
    async generate(request) {
      requests.push(request);
      const answer = answers[requests.length - 1];
      if (answer === undefined) throw new Error("the script ran out");
      if (answer === "error") return { schemaVersion: "rovara-e2e-model-channel/v1", receiptId: `r${requests.length}`, result: { status: "error", code: "provider-error", message: "x" } };
      return ok(`r${requests.length}`, answer);
    },
  };
  return { client, requests };
}

/** The pieces of a step context the loop and the executor use, with the page stood in for. */
function stepContext(model: unknown, page: { text: () => string; goal?: string }, spies: { observed: unknown[]; actions: string[]; fail?: ((name: string) => Error | undefined) | undefined }) {
  const act = (name: string) => async (...args: unknown[]) => { spies.actions.push(`${name}:${JSON.stringify(args)}`); const error = spies.fail?.(name); if (error) throw error; };
  return {
    model, providerOptions: undefined, agentContext: undefined, signal: new AbortController().signal, ledger: "", pixelsTainted: false,
    step: { kind: "act", index: 0, instruction: page.goal ?? GOAL, params: undefined, secrets: [] },
    attempt: { testId: "t", attemptId: "a", index: 0, signal: new AbortController().signal, memory: new Map() },
    target: { name: "web", platform: "web", verbs: new Set(["tap", "type", "press", "select", "scroll", "navigate"]) },
    budgets: { maxActions: 8, maxModelCalls: 12, actionsUsed: () => 0, remainingMs: () => 60_000, recordModelCall: () => undefined, runTool: async (_call: unknown, body: () => Promise<unknown>) => body() },
    observe: async (options?: unknown) => { spies.observed.push(options ?? null); return { revision: "1", text: page.text(), truncated: false, viewport: { width: 1, height: 1 } }; },
    actions: { tap: act("tap"), type: act("type"), press: act("press"), select: act("select"), scroll: act("scroll"), navigate: act("navigate") },
    attachTranscript: () => undefined, attachTurns: () => undefined, attachScreenshot: async () => "x",
  };
}

function build(answers: Array<Answer | "error">, options: { origin?: string; screen?: () => string; goal?: string } = {}) {
  const outDir = temp();
  const valueKey = generateE2EAgentValueKey();
  const goal = options.goal ?? GOAL;
  const ledger = createE2EAgentLedgerWriter({ outDir, runId: RUN_ID, caseId: CASE_ID, valueKey });
  const { client, requests } = scriptedClient(answers);
  let position: { caseId: string; stepIndex: number } | null = { caseId: CASE_ID, stepIndex: 0 };
  const adapter = createE2EAgentModelAdapter({ client, routeId: "rovara-scripted/v1", position: () => position });
  const executor = createRovaraE2EAgentExecutor({ position: () => position, ledger: () => ledger, origin: () => options.origin ?? ORIGIN });
  const spies = { observed: [] as unknown[], actions: [] as string[], fail: undefined as ((name: string) => Error | undefined) | undefined };
  const ctx = stepContext(adapter, { text: options.screen ?? (() => SCREEN), goal }, spies);
  ledger.beginStep(0, goal);
  return { executor, ctx, ledger, spies, requests, outDir, valueKey, goal, end: () => { position = null; }, adapter,
    readLedger: () => E2EAgentActionLedgerSchema.parse(JSON.parse(readFileSync(join(outDir, E2E_AGENT_EVIDENCE_DIR, agentCaseDirectoryName(CASE_ID), E2E_AGENT_LEDGER_FILE), "utf8"))) };
}
const DONE: Answer = { tool: "complete_step", input: { status: "passed", summary: "done" } };

describe("the agent executor (Task 4.3b, test case 1)", () => {
  it("offers exactly the seven tools, never asks for pixels, and sends no file part in any request the channel serializes", async () => {
    const t = build([{ tool: "tap", input: { target: "n2" } }, DONE]);
    const verdict = await t.executor.runStep(t.ctx as never);
    expect(verdict).toMatchObject({ status: "passed" });
    expect(t.requests).toHaveLength(2);
    for (const request of t.requests) expect((request.call.tools ?? []).map((item) => item.name).sort()).toEqual(expect.arrayContaining(["complete_step"]));
    expect(t.requests[0]!.call.tools!.map((item) => item.name).sort()).toEqual(["complete_step", "navigate", "press", "scroll", "select", "tap", "type"]);
    // Tree-only: observe() is called without pixels, and without a tree either (the text is the observation).
    expect(t.spies.observed.length).toBeGreaterThan(0);
    for (const options of t.spies.observed) expect(JSON.stringify(options)).not.toContain("pixels");
    const wire = JSON.stringify(t.requests);
    expect(wire).not.toMatch(/"type":"(file|image)"/);
    expect(wire).not.toContain("mediaType");
    // The leading # of a node id is not part of the target the engine receives.
    expect(t.spies.actions).toEqual(['tap:[{"id":"n2"}]']);
  });

  it("puts the goal on a 'Goal:' line and the screen as node lines, in the first message and in the tool result that follows an action", async () => {
    const t = build([{ tool: "tap", input: { target: "n2" } }, DONE]);
    await t.executor.runStep(t.ctx as never);
    const first = t.requests[0]!.call.prompt.find((message) => message.role === "user")!;
    const firstText = (first.content as Array<{ text: string }>).map((part) => part.text).join("\n");
    expect(firstText).toContain(`Goal: ${GOAL}`);
    expect(firstText).toContain('#n2 button "Download orders" testid="download-orders"');
    const second = t.requests[1]!.call.prompt;
    const toolMessage = second.find((message) => message.role === "tool")!;
    const output = (toolMessage.content as Array<{ output: { type: string; value: string } }>)[0]!.output;
    expect(output.type).toBe("text");
    expect(output.value).toContain("Screen after the action:");
    expect(output.value).toContain('#n3 button "Download invoices"');
  });

  it("(k) round-trips the real prompt through the scripted double with no goalCandidates override: it taps the node whose name matches", async () => {
    const t = build([DONE]);
    await t.executor.runStep(t.ctx as never);
    const invoke = createScriptedE2EInvoke({ scripts: { [sha(GOAL)]: [{ kind: "tap", name: /Download orders/ }, { kind: "done" }] } });
    const target = { provider: "rovara-scripted", identifier: "rovara-scripted-v1", region: null } as never;
    const signal = new AbortController().signal;
    const first = await invoke({ target, call: t.requests[0]!.call, maxOutputTokens: 1024, sampling: "provider-default", thinking: "off", effort: null, signal });
    expect(first.content[0]).toMatchObject({ type: "tool-call", toolName: "tap", input: JSON.stringify({ target: "n2" }) });
    // And after the tap, the tool result carries the new screen: the double finds its node there too.
    const t2 = build([{ tool: "tap", input: { target: "n2" } }, DONE]);
    await t2.executor.runStep(t2.ctx as never);
    const next = await invoke({ target, call: t2.requests[1]!.call, maxOutputTokens: 1024, sampling: "provider-default", thinking: "off", effort: null, signal });
    expect(next.content[0]).toMatchObject({ toolName: "complete_step" });
  });

  it("refuses a tool call outside an agent step before it acts", async () => {
    const t = build([{ tool: "tap", input: { target: "n2" } }, DONE]);
    t.end();
    // The adapter itself refuses first: no position, so nothing is sent.
    await expect(t.executor.runStep(t.ctx as never)).rejects.toMatchObject({ code: "MODEL_PROVIDER_FAILED" });
    expect(t.requests).toHaveLength(0);
    expect(t.spies.actions).toEqual([]);
  });
});

describe("the action ledger (Task 4.3b, test case 2)", () => {
  it("records the role, name and test id of the line the model chose from, and null when the line has no test id", async () => {
    const t = build([{ tool: "tap", input: { target: "n2" } }, { tool: "tap", input: { target: "n1" } }, DONE]);
    await t.executor.runStep(t.ctx as never);
    t.ledger.endStep(0, { verdict: "concluded", stopCode: null, receiptIds: [] });
    const [step] = t.readLedger().steps;
    expect(step!.actions.map((action) => [action.tool, action.node, action.outcome])).toEqual([
      ["tap", { role: "button", name: "Download orders", testId: "download-orders" }, "ok"],
      ["tap", { role: "heading", name: "Orders", testId: null }, "ok"],
    ]);
    expect(step!.actions[0]!.snapshotSha256).toBe(sha(SCREEN));
  });

  it("cuts a name at 120 characters, never inside a surrogate pair", () => {
    const long = `#n1 button "${"a".repeat(119)}😀tail" testid="x"`;
    const outDir = temp();
    const ledger = createE2EAgentLedgerWriter({ outDir, runId: RUN_ID, caseId: CASE_ID, valueKey: generateE2EAgentValueKey() });
    ledger.beginStep(0, GOAL);
    const line = parseScreenLine(long)!;
    ledger.recordAction({ tool: "tap", node: { role: line.role, name: line.name, testId: line.testId }, value: null, url: null, snapshotSha256: sha(long), outcome: "ok" });
    const stored = E2EAgentActionLedgerSchema.parse(JSON.parse(readFileSync(join(ledger.directory, E2E_AGENT_LEDGER_FILE), "utf8")));
    expect(stored.steps[0]!.actions[0]!.node!.name).toBe("a".repeat(119));
  });

  it("keeps a typed value that is text of the goal as a literal with its keyed digest, and any other value as a digest alone", async () => {
    const goal = "Type orders.csv into the file name box";
    const t = build([{ tool: "type", input: { target: "n4", value: "orders.csv" } }, { tool: "type", input: { target: "n4", value: "hunter2-not-in-goal" } }, { tool: "press", input: { target: "n4", key: "Enter" } }, DONE], { goal });
    await t.executor.runStep(t.ctx as never);
    t.ledger.endStep(0, { verdict: "concluded", stopCode: null, receiptIds: [] });
    const actions = t.readLedger().steps[0]!.actions;
    expect(actions[0]).toMatchObject({ tool: "type", valueLiteral: "orders.csv", valueDigest: e2eAgentValueDigest(t.valueKey, "orders.csv") });
    expect(actions[1]).toMatchObject({ tool: "type", valueLiteral: null, valueDigest: e2eAgentValueDigest(t.valueKey, "hunter2-not-in-goal") });
    expect(actions[2]).toMatchObject({ tool: "press", valueLiteral: null, valueDigest: e2eAgentValueDigest(t.valueKey, "Enter") });
    // The literal the model typed outside the goal is in no byte of the file; the verified parse accepts the rest.
    const bytes = readFileSync(join(t.outDir, E2E_AGENT_EVIDENCE_DIR, agentCaseDirectoryName(CASE_ID), E2E_AGENT_LEDGER_FILE), "utf8");
    expect(bytes).not.toContain("hunter2");
    expect(parseVerifiedE2EAgentActionLedger(JSON.parse(bytes), { goals: new Map([[0, goal]]), valueKey: t.valueKey, runId: RUN_ID, caseId: CASE_ID }).ok).toBe(true);
    // The key itself is in no ledger byte; its id is.
    expect(bytes).not.toContain(t.valueKey);
    expect(bytes).toContain(e2eAgentValueKeyId(t.valueKey));
  });

  it("records navigate as an app-relative path with no query, and a page of another origin as policy-denied without visiting it", async () => {
    const t = build([{ tool: "navigate", input: { url: `${ORIGIN}/orders?token=abc&x=1#frag` } }, { tool: "navigate", input: { url: "https://evil.example.com/steal?t=1" } }, { tool: "navigate", input: { url: "/orders" } }, DONE]);
    await t.executor.runStep(t.ctx as never);
    t.ledger.endStep(0, { verdict: "concluded", stopCode: null, receiptIds: [] });
    const actions = t.readLedger().steps[0]!.actions;
    expect(actions.map((action) => [action.tool, action.url, action.outcome, action.node, action.valueDigest])).toEqual([
      ["navigate", "/orders", "ok", null, null], ["navigate", "/", "policy-denied", null, null], ["navigate", "/orders", "ok", null, null]]);
    // The engine was asked for the first and third only, and the token is in no ledger byte.
    expect(t.spies.actions).toEqual([`navigate:["${ORIGIN}/orders?token=abc&x=1#frag"]`, `navigate:["${ORIGIN}/orders"]`]);
    expect(JSON.stringify(t.readLedger())).not.toContain("token");
    expect(JSON.stringify(t.readLedger())).not.toContain("evil");
  });

  it("records a failed action as action-failed and POLICY_DENIED as policy-denied, and the model is told", async () => {
    const t = build([{ tool: "tap", input: { target: "n2" } }, { tool: "tap", input: { target: "n3" } }, DONE]);
    let calls = 0;
    t.spies.fail = () => { calls += 1; return calls === 1 ? new AgentError("LOCATOR_NOT_FOUND", "no such node") : new AgentError("POLICY_DENIED", "denied"); };
    await t.executor.runStep(t.ctx as never);
    t.ledger.endStep(0, { verdict: "concluded", stopCode: null, receiptIds: [] });
    expect(t.readLedger().steps[0]!.actions.map((action) => action.outcome)).toEqual(["action-failed", "policy-denied"]);
  });

  it("leaves the actions taken so far under the verdict cut-short when the step never ends, and a bad ordering throws", async () => {
    const t = build([{ tool: "tap", input: { target: "n2" } }, DONE]);
    await t.executor.runStep(t.ctx as never);
    // No endStep: the process was killed here.
    const step = t.readLedger().steps[0]!;
    expect(step).toMatchObject({ verdict: "cut-short", stopCode: null });
    expect(step.actions).toHaveLength(1);
    expect(() => t.ledger.beginStep(1, GOAL)).toThrow(/one step at a time/);
    t.ledger.endStep(0, { verdict: "failed", stopCode: "MODEL_PROVIDER_FAILED", receiptIds: ["r1", "r1", "r2"] });
    expect(t.readLedger().steps[0]).toMatchObject({ verdict: "failed", stopCode: "MODEL_PROVIDER_FAILED", receiptIds: ["r1", "r2"] });
    expect(() => t.ledger.endStep(0, { verdict: "concluded", stopCode: null, receiptIds: [] })).toThrow(/ends the step it began/);
  });

  it("refuses a failed verdict without a stop code (the ledger schema binds them)", () => {
    const t = build([DONE]);
    expect(() => t.ledger.endStep(0, { verdict: "failed", stopCode: null, receiptIds: [] })).toThrow();
  });
});

describe("screen lines", () => {
  it("reads role, name and test id, and does not take a test id inside a quoted name or text for the node's own", () => {
    expect(parseScreenLine('#n9 button "Say testid=\\"fake\\"" text="more testid=\\"also\\"" testid="real" [focused]')).toEqual({ id: "n9", role: "button", name: 'Say testid="fake"', testId: "real" });
    expect(parseScreenLine('  #n3 "Plain text"')).toEqual({ id: "n3", role: "generic", name: "Plain text", testId: null });
    expect(parseScreenLine("not a node line")).toBeNull();
    expect([...parseScreen(SCREEN).keys()]).toEqual(["n1", "n2", "n3", "n4"]);
  });
  it("turns an absolute or relative target into an app path, and anything off the origin into null", () => {
    expect(appRelativePath(`${ORIGIN}/a/b?x=1`, ORIGIN)).toBe("/a/b");
    expect(appRelativePath("/a", ORIGIN)).toBe("/a");
    expect(appRelativePath("a/b", ORIGIN)).toBe("/a/b");
    expect(appRelativePath("//evil.example.com/x", ORIGIN)).toBeNull();
    expect(appRelativePath("https://127.0.0.1:4317/a", ORIGIN)).toBeNull();
    expect(appRelativePath("javascript:alert(1)", ORIGIN)).toBeNull();
  });
});

describe("superseded screens", () => {
  const screenOf = (name: string, padding: number) => `#n1 button "${name}"\n${"#n2 text \"filler row\"\n".repeat(padding)}`;
  const history = (screens: string[]) => [
    { role: "user", content: [{ type: "text", text: `Goal: ${GOAL}\n\nScreen:\n${screens[0]}` }] },
    ...screens.slice(1).flatMap((screen, index) => [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: `c${index}`, toolName: "tap", input: { target: "n1" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: `c${index}`, toolName: "tap", output: { type: "text", value: `Done.\n\nScreen after the action:\n${screen}` } }] },
    ]),
  ] as never[];

  it("leaves a small history alone, and keeps the goal and the newest screen when a large one is shortened", () => {
    const small = history([screenOf("one", 2), screenOf("two", 2)]);
    expect(elideSupersededScreens(small)).toBe(small);
    const rows = Math.ceil(E2E_AGENT_MESSAGES_SOFT_BUDGET_BYTES / 20 / 2);
    const large = history([screenOf("first", rows), screenOf("second", rows), screenOf("newest", rows)]);
    const shortened = elideSupersededScreens(large);
    const text = JSON.stringify(shortened);
    expect(text).toContain(`Goal: ${GOAL}`);
    expect(text).toContain("newest");
    expect(text).not.toContain('button \\"first\\"');
    expect(text).toContain("an earlier screen is left out");
    expect(Buffer.byteLength(text)).toBeLessThan(Buffer.byteLength(JSON.stringify(large)));
  });
});

describe("the capture-only cache store (Task 4.3b, test case 3)", () => {
  it("always misses on read, keeps what the runner writes, takes each trace once, and delete removes nothing", async () => {
    const store = createE2EAgentCaptureStore();
    expect(store.writable).toBe(true);
    expect(await store.read("a".repeat(64))).toEqual({ status: "miss" });
    const written = await store.write("a".repeat(64), rec([TAP_ORDERS]));
    expect(written!.bytes).toBeGreaterThan(10);
    // A read after the write still misses: a candidate round never replays.
    expect(await store.read("a".repeat(64))).toEqual({ status: "miss" });
    await store.delete("a".repeat(64));
    const taken = store.taken();
    expect(taken).toHaveLength(1);
    expect(taken[0]).toMatchObject({ keyHash: "a".repeat(64), trace: { actions: [{ name: "tap", target: { role: "button", name: "Download orders", testId: "download-orders" } }] } });
    expect(store.taken()).toEqual([]);
  });
  it("refuses a file past the 128 KiB ceiling and more than three held (a group's agent step cap), and replaces a trace written again for the same key", async () => {
    const store = createE2EAgentCaptureStore({ maxFileBytes: 700 });
    expect(await store.write("b".repeat(64), rec([{ ...TAP_ORDERS, target: { role: "button", name: "x".repeat(300), testId: "y".repeat(300) } }, { ...TAP_ORDERS, target: { role: "button", name: "z".repeat(300) } }]))).toBeUndefined();
    const big = createE2EAgentCaptureStore();
    for (let index = 0; index < 3; index += 1) expect(await big.write(String(index).padStart(64, "0"), rec([]))).toBeDefined();
    expect(await big.write("c".repeat(64), rec([]))).toBeUndefined();
    expect(await big.write("0".repeat(64), rec([], { summary: "again" }))).toBeDefined();
    expect(big.taken()).toHaveLength(3);
    expect(big.taken()).toEqual([]);
    expect(await big.write("0".repeat(64), rec([TAP_ORDERS]))).toBeDefined();
    expect(big.taken()).toMatchObject([{ keyHash: "0".repeat(64), trace: { actions: [{ name: "tap" }] } }]);
    expect(E2E_AGENT_TRACE_FILE_MAX_BYTES).toBe(131_072);
    expect(E2E_AGENT_TRACES_PER_GROUP_MAX).toBe(3);
  });
  it("hands a trace that matches the verified ledger to the review, which keeps it, and discards one the credential scan flagged without touching the ledger", async () => {
    const t = build([{ tool: "tap", input: { target: "n2" } }, DONE]);
    await t.executor.runStep(t.ctx as never);
    t.ledger.endStep(0, { verdict: "concluded", stopCode: null, receiptIds: [] });
    const parsed = parseVerifiedE2EAgentActionLedger(t.readLedger(), { goals: new Map([[0, GOAL]]), valueKey: t.valueKey, runId: RUN_ID, caseId: CASE_ID });
    if (!parsed.ok) throw new Error(parsed.reason);
    const trace = { actions: [{ name: "tap", target: { role: "button", name: "Download orders", testId: "download-orders" } }] };
    expect(reviewCapturedE2EAgentTrace({ stepIndex: 0, trace, ledger: parsed.ledger, valueKey: t.valueKey, credentialScanHit: false })).toMatchObject({ keep: true });
    expect(reviewCapturedE2EAgentTrace({ stepIndex: 0, trace, ledger: parsed.ledger, valueKey: t.valueKey, credentialScanHit: true })).toEqual({ keep: false, reason: "credential-scan-hit" });
    // Reviewing never changed the ledger on disk.
    expect(t.readLedger().steps[0]!.actions).toHaveLength(1);
  });
});

describe("the capture-only store with the host's credential scan and file hook (Task 4.3b, test case 3)", () => {
  const PASSWORD = "pw-Zk39-very-secret-value";
  const account = { profileId: "orders-owner", email: "rovara-owner-a1b2c3@example.test", password: PASSWORD };

  it("writes a clean trace to agent/traces under a name that comes from a digest of its key, and nothing else is written", async () => {
    const outDir = temp();
    const redactor = createCredentialRedactor([account]);
    const store = createE2EAgentCaptureStore({ scan: (bytes) => redactor.contains(bytes), persist: (keyHash, bytes) => persistE2EAgentTrace(outDir, keyHash, bytes) });
    const keyHash = "1".repeat(64);
    expect(await store.write(keyHash, rec([TAP_ORDERS]))).toBeDefined();
    const path = agentTraceFilePath(outDir, keyHash);
    expect(path).toMatch(/\/agent\/traces\/trace-[a-f0-9]{16}\.json$/);
    expect(path).not.toContain("1111");
    // The file is the wrapper (Task 4.6a): its key, and the trace cleaned to what the ledger's rules allow.
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ schemaVersion: "rovara-agent-trace-file/v1", keyHash,
      trace: { actions: [{ name: "tap", summary: "The tap action.", target: { role: "button", name: "Download orders", testId: "download-orders" } }], summary: E2E_AGENT_TRACE_SUMMARY, executor: { name: "rovara-e2e-agent", version: "1" },
        recordedFor: { testId: ".agentx/e2e/generated-application.test.ts::case-orders-export", targetId: "account-target-1", instructionDigest: sha(GOAL), callIndex: 0 } } });
  });

  it("drops a trace that carries an account password (also as base64) or a session value learned later: no file, no held trace, the verdict inputs untouched", async () => {
    const outDir = temp();
    const redactor = createCredentialRedactor([account]);
    const store = createE2EAgentCaptureStore({ scan: (bytes) => redactor.contains(bytes), persist: (keyHash, bytes) => persistE2EAgentTrace(outDir, keyHash, bytes) });
    const typing = (value: string) => rec([{ name: "type", value, summary: "typed", target: { role: "textbox", name: "Password" } }]);
    expect(await store.write("a".repeat(64), typing(PASSWORD))).toBeUndefined();
    expect(await store.write("b".repeat(64), typing(Buffer.from(PASSWORD).toString("base64")))).toBeUndefined();
    redactor.addSessionSecret("session-cookie-value-123456");
    expect(await store.write("c".repeat(64), typing("session-cookie-value-123456"))).toBeUndefined();
    expect(store.taken()).toEqual([]);
    expect(existsSync(agentTraceFilePath(outDir, "a".repeat(64)))).toBe(false);
    expect(existsSync(agentTraceFilePath(outDir, "c".repeat(64)))).toBe(false);
    // A clean trace is still taken afterwards (the scan is per trace), and a failing hook loses the file and nothing more.
    const failing = createE2EAgentCaptureStore({ persist: () => { throw new Error("disk full"); } });
    expect(await failing.write("d".repeat(64), rec([]))).toBeDefined();
    expect(failing.taken()).toHaveLength(1);
    expect(await store.write("e".repeat(64), rec([]))).toBeDefined();
  });
});

type Kept = Record<string, unknown> & { actions: Array<Record<string, unknown> & { target: Record<string, unknown> }> };
describe("trace hygiene: what the capture store keeps (Task 4.6a, test case 4)", () => {
  const PASSWORD = "pw-Zk39-very-secret-value";
  const account = { profileId: "orders-owner", email: "rovara-owner-a1b2c3@example.test", password: PASSWORD };
  const redactor = createCredentialRedactor([account]);
  const make = (extra: Parameters<typeof createE2EAgentCaptureStore>[0] = {}) => createE2EAgentCaptureStore({ scan: (bytes) => redactor.contains(bytes), origin: ORIGIN, goals: () => [GOAL], valueKey: generateE2EAgentValueKey(), ...extra });
  const keptOf = async (store: ReturnType<typeof make>, trace: unknown) => { const written = await store.write("a".repeat(64), trace); return written === undefined ? undefined : store.taken()[0]!.trace as Kept; };
  const dirtyTarget = { role: "button", name: "Download orders", testId: "download-orders", text: "Download the orders", placeholder: "ph", selector: "main > button:nth-child(2)", inputPurpose: "email",
    within: "row-7", position: { index: 1, of: 2 } };

  it("replaces every summary by a fixed sentence and keeps an action target to role, name and testId only", async () => {
    const trace = await keptOf(make(), rec([{ name: "tap", summary: "tapped the button because the page said the admin password is hunter2", target: dirtyTarget },
      { name: "scroll", summary: "scrolled", direction: "down", times: 2, spans: 0.9, target: dirtyTarget }], { summary: "The model said: all went well for ada@example.com" }));
    expect(trace).toBeDefined();
    expect(trace!["summary"]).toBe(E2E_AGENT_TRACE_SUMMARY);
    expect(JSON.stringify(trace)).not.toMatch(/hunter2|ada@example|because the page/);
    expect(trace!["actions"]).toEqual([
      { name: "tap", summary: "The tap action.", target: { role: "button", name: "Download orders", testId: "download-orders" } },
      { name: "scroll", summary: "The scroll action.", direction: "down", times: 2, target: { role: "button", name: "Download orders", testId: "download-orders" } }]);
  });

  it("stores a navigation as its app path alone (a same-origin absolute URL is rewritten to its path, Ruling DQ) and drops the trace for a query, a fragment, another origin, credentials in the URL or a bad location", async () => {
    const store = make();
    const paths = await keptOf(store, rec([{ name: "navigate", summary: "went", url: `${ORIGIN}/orders` }, { name: "navigate", summary: "went", url: "/orders/2" }], { startPath: "/", endPath: "/orders/2" }));
    expect(paths!["actions"].map((action) => action["url"])).toEqual(["/orders", "/orders/2"]);
    expect(JSON.stringify(paths)).not.toContain("127.0.0.1");
    for (const url of [`${ORIGIN}/orders?token=abc`, "/orders?token=abc", "/orders#frag", "https://evil.example/orders", "//evil.example/orders", `${ORIGIN}@evil.example/x`,
      `http://user:pw@127.0.0.1:4317/orders`, "javascript:alert(1)", "orders", `${ORIGIN}/orders/../x?a`, ""]) {
      expect(await store.write("b".repeat(64), rec([{ name: "navigate", summary: "went", url }])), url).toBeUndefined();
    }
    for (const bad of [{ startPath: "/x?token=abc" }, { endPath: "/x#frag" }, { endPath: "https://evil.example/" }, { startPath: "http://127.0.0.1:4317/x" }]) {
      expect(await store.write("c".repeat(64), rec([TAP_ORDERS], bad)), JSON.stringify(bad)).toBeUndefined();
    }
    // A relative path is the only form a store with no known origin keeps.
    const noOrigin = make({ origin: undefined as never });
    expect(await noOrigin.write("d".repeat(64), rec([{ name: "navigate", summary: "w", url: `${ORIGIN}/orders` }]))).toBeUndefined();
    expect(await noOrigin.write("d".repeat(64), rec([{ name: "navigate", summary: "w", url: "/orders" }]))).toBeDefined();
  });

  it("drops a trace with an action the ledger has no verb for, a truncated one, one with more than eight actions, a key or direction out of vocabulary, or a target with nothing in it", async () => {
    const store = make();
    for (const action of [{ name: "upload", summary: "u", target: dirtyTarget, paths: ["/etc/passwd"] }, { name: "typeSecret", summary: "s", target: dirtyTarget, secret: "login" }, { name: "tapAt", summary: "t", point: { x: 1, y: 2 }, viewport: { width: 1, height: 1 } },
      { name: "typeText", summary: "t", value: "x", replace: false }, { name: "press", summary: "p", key: "k".repeat(65), target: dirtyTarget }, { name: "scroll", summary: "s", direction: "sideways" },
      { name: "tap", summary: "t", target: { selector: "button" } }, { name: "tap", summary: "t" }]) {
      expect(await store.write("e".repeat(64), rec([action])), JSON.stringify(action)).toBeUndefined();
    }
    expect(await store.write("e".repeat(64), rec([TAP_ORDERS], { truncated: true }))).toBeUndefined();
    expect(await store.write("e".repeat(64), rec(Array.from({ length: 9 }, () => TAP_ORDERS)))).toBeUndefined();
    expect(await store.write("e".repeat(64), rec(Array.from({ length: 8 }, () => TAP_ORDERS)))).toBeDefined();
    expect(await store.write("1".repeat(64), rec([{ name: "press", summary: "p", key: "Enter", target: dirtyTarget }]))).toBeDefined();
  });

  it("keeps end anchors as postconditions within the owner's bound (16 in all, 300 characters each), without selector, container or position, and drops the trace past it", async () => {
    const store = make();
    const anchor = { role: "status", name: "Export", text: "Orders exported", testId: "orders-export-status", selector: "#s", within: "r", position: { index: 0, of: 1 }, inputPurpose: "x", states: ["checked"] };
    const trace = await keptOf(store, rec([TAP_ORDERS], { endAnchors: [anchor], goneAnchors: [{ text: "Exporting" }] }));
    expect(trace!["endAnchors"]).toEqual([{ role: "status", name: "Export", text: "Orders exported", testId: "orders-export-status", states: ["checked"] }]);
    expect(trace!["goneAnchors"]).toEqual([{ text: "Exporting" }]);
    const many = (count: number) => Array.from({ length: count }, (_, index) => ({ text: `row ${index}` }));
    expect(await store.write("2".repeat(64), rec([TAP_ORDERS], { endAnchors: many(8), goneAnchors: many(8) }))).toBeDefined();
    expect(await store.write("3".repeat(64), rec([TAP_ORDERS], { endAnchors: many(9) }))).toBeUndefined();
    expect(await store.write("3".repeat(64), rec([TAP_ORDERS], { endAnchors: many(8), goneAnchors: many(9) }))).toBeUndefined();
    expect(await store.write("4".repeat(64), rec([TAP_ORDERS], { endAnchors: [{ text: "x".repeat(300) }] }))).toBeDefined();
    expect(await store.write("5".repeat(64), rec([TAP_ORDERS], { endAnchors: [{ text: "x".repeat(301) }] }))).toBeUndefined();
    expect(await store.write("5".repeat(64), rec([TAP_ORDERS], { endAnchors: [{ selector: "#only-a-selector" }] }))).toBeUndefined();
  });

  it("holds an anchor's input value to the ledger's rule: text of a goal stays, any other becomes its keyed digest, and the trace is dropped when there is no key to make one", async () => {
    const valueKey = generateE2EAgentValueKey();
    const typed = "a value the model made up 4711";
    const trace = await keptOf(make({ valueKey }), rec([TAP_ORDERS], { endAnchors: [{ role: "textbox", name: "File name", value: "orders" }, { role: "textbox", name: "Other", value: typed }] }));
    expect(trace!["endAnchors"]).toEqual([{ role: "textbox", name: "File name", value: "orders" }, { role: "textbox", name: "Other", value: `hmac-sha256:${e2eAgentValueDigest(valueKey, typed)}` }]);
    expect(JSON.stringify(trace)).not.toContain(typed);
    expect(await make({ valueKey: undefined as never }).write("6".repeat(64), rec([TAP_ORDERS], { endAnchors: [{ role: "textbox", value: typed }] }))).toBeUndefined();
  });

  it("never lets an account password (raw, base64, in an anchor, a target or a URL) or a session value learned later reach the held trace or the file", async () => {
    const outDir = temp();
    const store = make({ persist: (keyHash, bytes) => persistE2EAgentTrace(outDir, keyHash, bytes) });
    const spots: Array<[string, unknown]> = [
      ["anchor text", rec([TAP_ORDERS], { endAnchors: [{ text: `Your password is ${PASSWORD}` }] })],
      ["anchor text base64", rec([TAP_ORDERS], { endAnchors: [{ text: Buffer.from(PASSWORD).toString("base64") }] })],
      ["target name", rec([{ ...TAP_ORDERS, target: { role: "button", name: PASSWORD } }])],
      ["email local part in a target", rec([{ ...TAP_ORDERS, target: { role: "button", name: account.email } }])],
    ];
    redactor.addSessionSecret("session-cookie-value-123456");
    spots.push(["session value", rec([TAP_ORDERS], { endAnchors: [{ text: "token session-cookie-value-123456" }] })]);
    for (const [index, [where, trace]] of spots.entries()) expect(await store.write(String(index + 1).repeat(64), trace), where).toBeUndefined();
    expect(store.taken()).toEqual([]);
    for (let index = 1; index <= spots.length; index += 1) expect(existsSync(agentTraceFilePath(outDir, String(index).repeat(64)))).toBe(false);
    // Positive control: the same store keeps a clean trace, so the drops above are the scan's.
    expect(await store.write("a".repeat(64), rec([TAP_ORDERS], { endAnchors: [{ text: "Orders exported" }] }))).toBeDefined();
  });

  it("Q4: a typed value, option or key that is text of ANOTHER goal (not the step's own) is a digest, like any value the model chose; the step is found by the recording's instruction digest", async () => {
    const valueKey = generateE2EAgentValueKey();
    const other = "Open the archive and rename the quarterly report";
    const store = make({ valueKey, goals: () => [GOAL, other] });
    const field = { role: "textbox", name: "File name" };
    const trace = await keptOf(store, rec([{ name: "type", value: "orders", summary: "t", target: field }, { name: "type", value: "quarterly report", summary: "t", target: field },
      { name: "press", key: "quarterly", summary: "p", target: field }]));
    expect(trace!["actions"].map((action: Record<string, unknown>) => action["value"] ?? action["key"])).toEqual(["orders", `hmac-sha256:${e2eAgentValueDigest(valueKey, "quarterly report")}`,
      `hmac-sha256:${e2eAgentValueDigest(valueKey, "quarterly")}`]);
    expect(JSON.stringify(trace)).not.toContain("quarterly report");
    // A recording that names no step of this process has no goal at all: every value is a digest, and without a key it is dropped.
    const unnamed = await keptOf(make({ valueKey, goals: () => [GOAL] }), rec([{ name: "type", value: "orders", summary: "t", target: field }], { recordedFor: undefined }));
    expect(unnamed!["actions"][0]!["value"]).toBe(`hmac-sha256:${e2eAgentValueDigest(valueKey, "orders")}`);
    expect(await make({ valueKey: undefined as never, goals: () => [GOAL] }).write("b".repeat(64), rec([{ name: "type", value: "orders", summary: "t", target: field }], { recordedFor: { testId: "t::c", targetId: "x", instructionDigest: "0".repeat(64) } }))).toBeUndefined();
  });

  it("keeps a key only when it is a named key or text of the goal; any other key is a keyed digest, and a key past the closed set is not spelled out", async () => {
    const valueKey = generateE2EAgentValueKey();
    const store = make({ valueKey });
    const field = { role: "textbox", name: "File name" };
    const keys = ["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Space"];
    const trace = await keptOf(store, rec(keys.slice(0, 8).map((key) => ({ name: "press", key, summary: "p", target: field }))));
    expect(trace!["actions"].map((action: Record<string, unknown>) => action["key"])).toEqual(keys.slice(0, 8));
    const spelled = await keptOf(make({ valueKey }), rec(["q", "x", "Control+a", "z", "1", "7", "k", "m"].map((key) => ({ name: "press", key, summary: "p", target: field }))));
    expect(spelled!["actions"].map((action: Record<string, unknown>) => action["key"])).toEqual(["q", "x", "Control+a", "z", "1", "7", "k", "m"].map((key) => (GOAL.includes(key) ? key : `hmac-sha256:${e2eAgentValueDigest(valueKey, key)}`)));
    expect(JSON.stringify(spelled)).not.toContain("Control+a");
    expect(await make({ valueKey: undefined as never }).write("c".repeat(64), rec([{ name: "press", key: "Control+a", summary: "p", target: field }]))).toBeUndefined();
  });

  it("holds a target to the ledger's node: a lower-case role of letters, a name and a test id of at most 120 characters", async () => {
    const trace = await keptOf(make(), rec([{ name: "tap", summary: "t", target: { role: "Menu-Item", name: "n".repeat(300), testId: "t".repeat(200) } }, { name: "tap", summary: "t", target: { name: "No role" } }]));
    expect(trace!["actions"].map((action) => action.target)).toEqual([{ role: "menuitem", name: "n".repeat(120), testId: "t".repeat(120) }, { role: "generic", name: "No role" }]);
  });

  it("the file schema is strict on the cleaned shape: a hand-made trace with a selector, a prose summary, a query, a ninth action, a long name or an extra field is refused, and every trace the store keeps passes it", async () => {
    const ok = (await keptOf(make(), rec([TAP_ORDERS], { endAnchors: [{ text: "Orders exported" }], startPath: "/", endPath: "/" })))!;
    expect(E2EAgentCleanTraceSchema.safeParse(ok).success).toBe(true);
    const bad: Array<[string, Record<string, unknown>]> = [
      ["a selector on a target", { ...ok, actions: [{ ...(ok["actions"] as Record<string, unknown>[])[0], target: { role: "button", selector: "#b" } }] }],
      ["prose in the summary", { ...ok, summary: "the model liked it" }],
      ["prose in an action summary", { ...ok, actions: [{ ...(ok["actions"] as Record<string, unknown>[])[0], summary: "tapped the secret" }] }],
      ["a query in the end path", { ...ok, endPath: "/x?token=1" }],
      ["a long name", { ...ok, actions: [{ ...(ok["actions"] as Record<string, unknown>[])[0], target: { role: "button", name: "n".repeat(121) } }] }],
      ["a same-origin absolute navigate URL", { ...ok, actions: [{ name: "navigate", summary: "The navigate action.", url: `${ORIGIN}/orders` }] }],
      ["an off-origin navigate URL", { ...ok, actions: [{ name: "navigate", summary: "The navigate action.", url: "https://other.example/orders" }] }],
      ["an absolute end path", { ...ok, endPath: "https://other.example/" }],
      ["a ninth action", { ...ok, actions: Array.from({ length: 9 }, () => (ok["actions"] as unknown[])[0]) }],
      ["an extra field", { ...ok, model: "x" }],
      ["a selector on an anchor", { ...ok, endAnchors: [{ text: "x", selector: "#s" }] }],
      ["nine anchors a side", { ...ok, endAnchors: Array.from({ length: 9 }, () => ({ text: "x" })) }],
      ["an anchor text past 300", { ...ok, endAnchors: [{ text: "x".repeat(301) }] }],
      ["sixteen and one anchors", { ...ok, endAnchors: Array.from({ length: 8 }, () => ({ text: "x" })), goneAnchors: Array.from({ length: 9 }, () => ({ text: "x" })) }],
      ["an upload action", { ...ok, actions: [{ name: "upload", summary: "The upload action.", target: { role: "button" }, paths: ["/etc/passwd"] }] }],
    ];
    for (const [label, trace] of bad) expect(E2EAgentCleanTraceSchema.safeParse(trace).success, label).toBe(false);
  });

  it("keeps provenance only as identifiers and digests, and drops what e2e adds that this module does not know", async () => {
    const provenance = { testId: ".agentx/e2e/generated-application.test.ts::case-1", targetId: "account-target-1", instructionDigest: "a".repeat(64), paramsDigest: "b".repeat(64), callIndex: 0, agent: "default" };
    const keyedBy = { cacheSchema: "trace-1", policyVersion: "conservative/6", project: "c".repeat(64), platform: "web", engineName: "web", engineSpiVersion: 1, appIdentity: "d".repeat(64), agentContextDigest: "e".repeat(64) };
    const trace = await keptOf(make(), rec([TAP_ORDERS], { recordedFor: provenance, keyedBy, endWaitMs: 10_214, startPath: "/", endPath: "/", futureField: "free text the model wrote", model: { reasoning: "x" } }));
    expect(trace).toEqual({ actions: [expect.objectContaining({ name: "tap" })], summary: E2E_AGENT_TRACE_SUMMARY, executor: { name: "rovara-e2e-agent", version: "1" }, recordedFor: provenance, keyedBy, endWaitMs: 10_214, startPath: "/", endPath: "/" });
  });
});

describe("the model adapter (Task 4.3b, test case 4)", () => {
  it("maps a channel error answer to a plain Error that is not retryable, naming only the code, and keeps its receipt id", async () => {
    const { client } = scriptedClient(["error"]);
    const adapter = createE2EAgentModelAdapter({ client, routeId: "rovara-scripted/v1", position: () => ({ caseId: CASE_ID, stepIndex: 0 }) });
    const error = await adapter.doGenerate({ prompt: [{ role: "system", content: "s" }, { role: "user", content: [{ type: "text", text: "Goal: x" }] }] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(E2EAgentModelError);
    expect(error).toBeInstanceOf(Error);
    expect((error as { isRetryable?: unknown }).isRetryable).not.toBe(true);
    expect((error as Error).message).toBe("the model call did not complete (provider-error)");
    expect(adapter.takeReceiptIds({ caseId: CASE_ID, stepIndex: 0 })).toEqual(["r1"]);
    expect(adapter.takeReceiptIds({ caseId: CASE_ID, stepIndex: 0 })).toEqual([]);
  });

  it("refuses a prompt part that is not text, a tool call outside the channel's names, and a call with no step running, before anything is sent", async () => {
    const { client, requests } = scriptedClient([]);
    let position: { caseId: string; stepIndex: number } | null = { caseId: CASE_ID, stepIndex: 0 };
    const adapter = createE2EAgentModelAdapter({ client, routeId: "r", position: () => position });
    await expect(adapter.doGenerate({ prompt: [{ role: "user", content: [{ type: "file", mediaType: "image/png", data: "AAAA" }] }] })).rejects.toMatchObject({ code: "unsupported-prompt" });
    await expect(adapter.doGenerate({ prompt: [{ role: "assistant", content: [{ type: "reasoning", text: "hmm" }] }] })).rejects.toMatchObject({ code: "unsupported-prompt" });
    position = null;
    await expect(adapter.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }] })).rejects.toMatchObject({ code: "no-position" });
    expect(requests).toHaveLength(0);
  });

  it("numbers the calls of a step from 0, per step", async () => {
    const { client, requests } = scriptedClient([DONE, DONE, DONE]);
    let step = 0;
    const adapter = createE2EAgentModelAdapter({ client, routeId: "r", position: () => ({ caseId: CASE_ID, stepIndex: step }) });
    const prompt = [{ role: "user", content: [{ type: "text", text: "x" }] }];
    await adapter.doGenerate({ prompt }); await adapter.doGenerate({ prompt }); step = 1; await adapter.doGenerate({ prompt });
    expect(requests.map((request) => [request.stepIndex, request.callIndex])).toEqual([[0, 0], [0, 1], [1, 0]]);
    expect(adapter.callsFor({ caseId: CASE_ID, stepIndex: 0 })).toBe(2);
  });

  describe("over a real unix socket", () => {
    let server: Server | undefined; let socketDir = "";
    afterEach(async () => { await new Promise<void>((resolve) => { if (server === undefined) resolve(); else server.close(() => resolve()); }); server = undefined; });

    it("sends exactly one HTTP request for one generate, and a socket that answers nothing useful becomes a plain error with no retry", async () => {
      socketDir = mkdtempSync(join("/tmp", "rva-")); dirs.push(socketDir);
      const socketPath = join(socketDir, "m.sock");
      let hits = 0;
      server = createServer((request, response) => {
        // The client syncs before the call (MIDSTEPCOOKIE); this socket accepts the sync and answers nothing useful to the call.
        if (request.url === "/v1/sync") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ schemaVersion: "rovara-e2e-model-channel/v1", status: "ok", syncSeq: 1 })); return; }
        hits += 1; response.writeHead(502, { "content-type": "application/json" }); response.end("{}");
      });
      await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
      const adapter = createE2EAgentModelAdapter({ client: createE2EModelChannelClient({ socketPath, runId: RUN_ID, sessionSync: noSessionValues }), routeId: "r", position: () => ({ caseId: CASE_ID, stepIndex: 0 }) });
      const error = await adapter.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Goal: x" }] }] }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "channel-error", channelCode: "refused" });
      expect((error as { isRetryable?: unknown }).isRetryable).not.toBe(true);
      expect(hits).toBe(1);
      expect(adapter.takeReceiptIds({ caseId: CASE_ID, stepIndex: 0 })).toEqual([]);
    });
  });

  it("still refuses a string model id through the refusing default provider (a child process against the real ai)", () => {
    const script = `
      import { installRefusingE2EDefaultProvider } from ${JSON.stringify(new URL("../../packages/verifier/src/executor/ai-default-provider.ts", import.meta.url).href)};
      installRefusingE2EDefaultProvider();
      const { generateText } = await import("ai");
      try { await generateText({ model: "openai/gpt-x", prompt: "hi" }); console.log("NOT_REFUSED"); }
      catch (error) { console.log("REFUSED " + (error instanceof Error ? error.message : String(error))); }
    `;
    const out = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: join(import.meta.dirname, "../.."), encoding: "utf8", timeout: 60_000 });
    expect(out).toContain("REFUSED");
    expect(out).toContain("the AI SDK default provider is not available in the executor");
  }, 90_000);
});


describe("fix round 1 (Task 4.3b review)", () => {
  it("ends the step blocked with ENVIRONMENT_UNAVAILABLE when the ledger cannot be written, and the model is told a fixed sentence with no fs text or path", async () => {
    const t = build([{ tool: "tap", input: { target: "n2" } }, { tool: "tap", input: { target: "n3" } }, DONE]);
    const failing = { directory: t.ledger.directory, beginStep: (index: number, goal: string) => t.ledger.beginStep(index, goal), endStep: (index: number, end: Parameters<typeof t.ledger.endStep>[1]) => t.ledger.endStep(index, end),
      recordAction: () => { throw new Error("EACCES: permission denied, open '/srv/secret-path/actions.json'"); } };
    const executor = createRovaraE2EAgentExecutor({ position: () => ({ caseId: CASE_ID, stepIndex: 0 }), ledger: () => failing, origin: () => ORIGIN });
    const verdict = await executor.runStep(t.ctx as never);
    expect(verdict).toMatchObject({ status: "blocked", errorCode: "ENVIRONMENT_UNAVAILABLE" });
    expect(JSON.stringify(t.requests)).not.toMatch(/EACCES|secret-path|actions\.json/);
    // No action runs after the one that could not be recorded.
    expect(t.spies.actions).toEqual(['tap:[{"id":"n2"}]']);
  });

  it("describes the first action's node from the screen the model was shown in the prompt, not from a fresh observation", async () => {
    const screens = [SCREEN, SCREEN.replace('#n2 button "Download orders" testid="download-orders"', '#n2 button "Something else" testid="other"')];
    let reads = 0;
    const t = build([{ tool: "tap", input: { target: "n2" } }, DONE], { screen: () => screens[Math.min(reads++, 1)]! });
    await t.executor.runStep(t.ctx as never);
    t.ledger.endStep(0, { verdict: "concluded", stopCode: null, receiptIds: [] });
    const action = t.readLedger().steps[0]!.actions[0]!;
    expect(action.node).toEqual({ role: "button", name: "Download orders", testId: "download-orders" });
    expect(action.snapshotSha256).toBe(sha(SCREEN));
  });

  it("keeps a trace's typed value that is text of a goal, turns any other into its keyed digest, and drops a trace whose value shows anywhere else", async () => {
    const valueKey = generateE2EAgentValueKey();
    const outDir = temp();
    const store = createE2EAgentCaptureStore({ valueKey, goals: () => [GOAL], persist: (keyHash, bytes) => persistE2EAgentTrace(outDir, keyHash, bytes) });
    const typed = "a value the model made up 4711";
    const field = { role: "textbox", name: "File name", testId: "file-name" };
    expect(await store.write("a".repeat(64), rec([{ name: "type", value: "orders", target: field, summary: "typed" },
      { name: "select", value: typed, target: { role: "combobox", name: "Kind" }, summary: "chose" }, { name: "type", value: typed, target: field, summary: "typed" }]))).toBeDefined();
    const kept = readFileSync(agentTraceFilePath(outDir, "a".repeat(64)), "utf8");
    expect(kept).not.toContain(typed);
    const parsed = JSON.parse(kept) as { trace: { actions: Array<{ value: string }> } };
    expect(parsed.trace.actions.map((action) => action.value)).toEqual(["orders", `hmac-sha256:${e2eAgentValueDigest(valueKey, typed)}`, `hmac-sha256:${e2eAgentValueDigest(valueKey, typed)}`]);
    expect(JSON.stringify(store.taken())).not.toContain(typed);
    // The typed action's own summary and an anchor's input value that is the typed value are rewritten with it; the trace is kept with no copy of the value.
    expect(await store.write("f".repeat(64), rec([{ name: "type", value: typed, summary: `typed "${typed}"`, target: field }], { endAnchors: [{ role: "textbox", name: "File name", value: typed }] }))).toBeDefined();
    expect(readFileSync(agentTraceFilePath(outDir, "f".repeat(64)), "utf8")).not.toContain(typed);
    // The value shows somewhere else (an anchor's screen text, a URL): the trace is dropped whole.
    expect(await store.write("9".repeat(64), rec([{ name: "type", value: typed, summary: "typed", target: field }], { endAnchors: [{ role: "text", name: `Hello ${typed}` }] }))).toBeUndefined();
    // Percent-encoded in a later URL: dropped too.
    expect(await store.write("c".repeat(64), rec([{ name: "type", value: typed, summary: "typed", target: field }, { name: "navigate", url: `/search/${encodeURIComponent(typed)}`, summary: "went" }]))).toBeUndefined();
    // With no value key, any value that is not text of a goal drops the trace.
    const keyless = createE2EAgentCaptureStore({ goals: () => [GOAL] });
    expect(await keyless.write("d".repeat(64), rec([{ name: "type", value: typed, summary: "typed", target: field }]))).toBeUndefined();
    expect(await keyless.write("e".repeat(64), rec([{ name: "type", value: "orders", summary: "typed", target: field }]))).toBeDefined();
  });

  it("a trace whose typed value the store kept as its keyed digest still matches the verified ledger in the review", async () => {
    const typed = "a value the model made up 4711";
    const t = build([{ tool: "type", input: { target: "n4", value: typed } }, DONE]);
    await t.executor.runStep(t.ctx as never);
    t.ledger.endStep(0, { verdict: "concluded", stopCode: null, receiptIds: [] });
    const parsed = parseVerifiedE2EAgentActionLedger(t.readLedger(), { goals: new Map([[0, GOAL]]), valueKey: t.valueKey, runId: RUN_ID, caseId: CASE_ID });
    if (!parsed.ok) throw new Error(parsed.reason);
    const store = createE2EAgentCaptureStore({ valueKey: t.valueKey, goals: () => [GOAL] });
    expect(await store.write("a".repeat(64), rec([{ name: "type", value: typed, summary: "typed", target: { role: "textbox", name: "File name" } }]))).toBeDefined();
    const [held] = store.taken();
    expect(JSON.stringify(held)).not.toContain(typed);
    expect(reviewCapturedE2EAgentTrace({ stepIndex: 0, trace: held!.trace, ledger: parsed.ledger, valueKey: t.valueKey, credentialScanHit: false })).toMatchObject({ keep: true });
    // A digest that is not the ledger's does not match.
    const forged = { actions: [{ name: "type", value: `hmac-sha256:${"0".repeat(64)}`, summary: "typed", target: { role: "textbox", name: "File name" } }] };
    expect(reviewCapturedE2EAgentTrace({ stepIndex: 0, trace: forged, ledger: parsed.ledger, valueKey: t.valueKey, credentialScanHit: false })).toMatchObject({ keep: false });
  });

  it("refuses a model call whose request carries a session value this process learned after the step began, before anything is sent", async () => {
    const { client, requests } = scriptedClient([DONE, DONE]);
    const redactor = createCredentialRedactor([]);
    const adapter = createE2EAgentModelAdapter({ client, routeId: "r", position: () => ({ caseId: CASE_ID, stepIndex: 0 }), scan: (bytes) => redactor.contains(bytes) });
    const prompt = (text: string) => ({ prompt: [{ role: "user", content: [{ type: "text", text }] }] });
    await adapter.doGenerate(prompt("Screen: sid=session-cookie-value-7f3a9c"));
    expect(requests).toHaveLength(1);
    redactor.addSessionSecret("session-cookie-value-7f3a9c");
    await expect(adapter.doGenerate(prompt("Screen: sid=session-cookie-value-7f3a9c"))).rejects.toMatchObject({ code: "credential-in-prompt", isRetryable: false });
    expect(requests).toHaveLength(1);
  });
});

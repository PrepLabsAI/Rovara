import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentError } from "e2e/agent";
import { E2EAgentActionLedgerSchema, generateE2EAgentValueKey, type E2EModelChannelClient } from "@agentx/contracts";
import { E2E_AGENT_EVIDENCE_DIR, E2E_AGENT_LEDGER_FILE, agentCaseDirectoryName } from "../../packages/verifier/src/executor/agent-ledger.js";
import type { createE2EAgentLedgerWriter } from "../../packages/verifier/src/executor/agent-ledger.js";
import { createE2EAgentStepDriver } from "../../packages/verifier/src/executor/agent-step-driver.js";

// Task 4.3b: the lifecycle around one agent.act call (executor/agent-step-driver.ts): the markers the worker is told, the ledger, the current step, and what a failure does.
const RUN_ID = "7f1c2a4e-5b6d-4c8e-9f01-23456789abcd";
const CASE_ID = "case-orders-export";
const GOAL = "Export the orders as a CSV file";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(options: { begin?: () => Promise<void>; end?: () => Promise<void>; secrets?: string[] } = {}) {
  const outDir = mkdtempSync(join(tmpdir(), "agent-driver-")); dirs.push(outDir);
  const valueKey = generateE2EAgentValueKey();
  const events: string[] = [];
  const markers: Array<{ kind: string; position: { caseId: string; stepIndex: number }; cookieValues?: readonly string[] }> = [];
  const client: E2EModelChannelClient = {
    async beginStep(position) { events.push("begin-marker"); markers.push({ kind: "begin", position: { caseId: position.caseId, stepIndex: position.stepIndex }, ...(position.cookieValues === undefined ? {} : { cookieValues: position.cookieValues }) }); await options.begin?.(); },
    async endStep(position) { events.push("end-marker"); markers.push({ kind: "end", position }); await options.end?.(); },
    async generate() { throw new Error("the driver makes no model call itself"); },
  };
  const current: { position: { caseId: string; stepIndex: number } | null; ledger: ReturnType<typeof createE2EAgentLedgerWriter> | null } = { position: null, ledger: null };
  const adapter = { takeReceiptIds: (position: { caseId: string; stepIndex: number }) => { events.push(`receipts:${String(position.stepIndex)}`); return ["r1", "r2"]; } };
  const driver = createE2EAgentStepDriver({ client, adapter, current, runId: RUN_ID, valueKey, outDir, sessionSecrets: () => options.secrets ?? [] });
  const ledger = () => E2EAgentActionLedgerSchema.parse(JSON.parse(readFileSync(join(outDir, E2E_AGENT_EVIDENCE_DIR, agentCaseDirectoryName(CASE_ID), E2E_AGENT_LEDGER_FILE), "utf8")));
  const request = (act: (goal: string, options: { maxSteps: number; maxModelCalls: number; timeout: number }) => Promise<unknown>) => ({ caseId: CASE_ID, stepIndex: 1, goal: GOAL, maxActions: 4, timeoutMs: 80_000, signal: new AbortController().signal, act });
  return { driver, current, events, markers, ledger, request, outDir };
}

describe("the agent step driver", () => {
  it("tells the worker the step began, runs act with the step's budgets and with the step current, then records it and tells the worker it ended", async () => {
    const t = setup();
    let seenCurrent: unknown; let seenOptions: unknown;
    const outcome = await t.driver(t.request(async (_goal, options) => { seenOptions = options; seenCurrent = { ...t.current.position, ledger: t.current.ledger !== null }; t.events.push("act"); }));
    expect(outcome).toEqual({ verdict: "concluded", stopCode: null, receiptIds: ["r1", "r2"] });
    expect(t.events).toEqual(["begin-marker", "act", "receipts:1", "end-marker"]);
    expect(seenOptions).toEqual({ maxSteps: 4, maxModelCalls: 8, timeout: 80_000 });
    expect(seenCurrent).toEqual({ caseId: CASE_ID, stepIndex: 1, ledger: true });
    expect(t.current).toEqual({ position: null, ledger: null });
    expect(t.ledger().steps[0]).toMatchObject({ stepIndex: 1, verdict: "concluded", stopCode: null, receiptIds: ["r1", "r2"] });
  });

  it("sends at most the newest 32 session values with the begin marker, and none at all when it holds none", async () => {
    const many = Array.from({ length: 40 }, (_, index) => `session-value-${String(index).padStart(3, "0")}`);
    const t = setup({ secrets: many });
    await t.driver(t.request(async () => undefined));
    expect(t.markers[0]!.cookieValues).toEqual(many.slice(-32));
    const none = setup();
    await none.driver(none.request(async () => undefined));
    expect(none.markers[0]!.cookieValues).toBeUndefined();
  });

  it("makes an AgentError an outcome: failed, with its stop code, a ledger that says so, and the end marker still sent", async () => {
    const t = setup();
    const outcome = await t.driver(t.request(async () => { throw new AgentError("MODEL_PROVIDER_FAILED", "the model provider failed"); }));
    expect(outcome).toEqual({ verdict: "failed", stopCode: "MODEL_PROVIDER_FAILED", receiptIds: ["r1", "r2"] });
    expect(t.events.at(-1)).toBe("end-marker");
    expect(t.ledger().steps[0]).toMatchObject({ verdict: "failed", stopCode: "MODEL_PROVIDER_FAILED" });
    expect(t.current).toEqual({ position: null, ledger: null });
  });

  it("records a failure that is not an AgentError as a failed step (ACTION_FAILED) and throws it again", async () => {
    const t = setup();
    await expect(t.driver(t.request(async () => { throw new TypeError("the executor broke"); }))).rejects.toThrow("the executor broke");
    expect(t.ledger().steps[0]).toMatchObject({ verdict: "failed", stopCode: "ACTION_FAILED" });
    expect(t.events.at(-1)).toBe("end-marker");
    expect(t.current).toEqual({ position: null, ledger: null });
  });

  it("does nothing for a step the worker refused to begin: no act, no ledger step, no end marker", async () => {
    const t = setup({ begin: async () => { throw new Error("refused"); } });
    let acted = false;
    await expect(t.driver(t.request(async () => { acted = true; }))).rejects.toThrow("refused");
    expect(acted).toBe(false);
    expect(t.events).toEqual(["begin-marker"]);
    expect(t.current).toEqual({ position: null, ledger: null });
  });

  it("fails the step when the worker cannot be told it ended, after the ledger has been written", async () => {
    const t = setup({ end: async () => { throw new Error("socket gone"); } });
    await expect(t.driver(t.request(async () => undefined))).rejects.toThrow("socket gone");
    expect(t.ledger().steps[0]).toMatchObject({ verdict: "concluded" });
  });

  it("runs two steps of one case one after the other in the same ledger, and refuses the same step twice", async () => {
    const t = setup();
    await t.driver(t.request(async () => undefined));
    await t.driver({ ...t.request(async () => undefined), stepIndex: 3 });
    expect(t.ledger().steps.map((step) => step.stepIndex)).toEqual([1, 3]);
    await expect(t.driver(t.request(async () => undefined))).rejects.toThrow(/begins each step once/);
    expect(t.current).toEqual({ position: null, ledger: null });
  });
});

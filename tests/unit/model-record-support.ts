// TE-F8 test support: a world on F1-a's fake egress adapter, a report from F4's detector, and a recording engine over either store. No real call: the fake provider answers, and the suite runs under the network tripwire.
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryRecordingStore, createRecordReplay, detectPromptChanges, planRecording, type ModelEgressEvent, type RecordReplay, type RecordReplayOptions, type RecordReplayServe, type RecordingMode, type RecordingPlan, type RecordingScope,
  type RecordingStore,
} from "@agentx/contracts";
import { createTaskRecordingStore } from "../../packages/worker/src/model-record-store-task.js";
import { COMPANY_A, COMPANY_B, type IsolationCompany } from "../../packages/testing/src/isolation/two-company.js";
import { validFrame, type ModelEgressWorld } from "../../packages/testing/src/ports/model-egress-conformance.js";
import { fakeModelEgressWorld } from "../../packages/testing/src/ports/model-egress-world.js";
import type { ModelEgressMutation } from "../../packages/testing/src/ports/model-egress-fake.js";

export { COMPANY_A, COMPANY_B };
export const DAY_MS = 24 * 60 * 60 * 1000;
/** 2026-11-13T10:00:00Z */
export const T0 = Date.UTC(2026, 10, 13, 10, 0, 0);

/** The text of the changed system prompt, and of an unchanged user message, as the request carries them. */
export const SYSTEM_TEXT = "Answer in one short sentence about trains.";
export const OLD_SYSTEM_TEXT = "Old system text that nobody ships any more.";
export const USER_TEXT = "Hello there";

/** F4's report for a change of the system prompt (and the model name) in a Python file. */
export function changedReport(opts: { system?: string; oldSystem?: string; model?: string; oldModel?: string } = {}) {
  const system = opts.system ?? SYSTEM_TEXT;
  const oldSystem = opts.oldSystem ?? OLD_SYSTEM_TEXT;
  const model = opts.model ?? "fixture-small";
  const oldModel = opts.oldModel ?? model;
  const source = (m: string, s: string): string => `client.messages.create(model='${m}', system='${s}', messages=[{'role':'user','content':'${USER_TEXT}'}])`;
  return detectPromptChanges({ files: [{ path: "ai/app.py", before: source(oldModel, oldSystem), after: source(model, system), wholeFile: true }] }).report;
}
export const planOf = (report: unknown): RecordingPlan => planRecording(report);

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
/** An OpenAI-shaped chat request whose system message carries `system` and whose user message carries `user`. */
export function chatFrame(world: ModelEgressWorld, opts: { system?: string; user?: string; extra?: Record<string, unknown>; headers?: Array<[string, string]>; stream?: boolean; model?: string } = {}): Record<string, unknown> {
  const row = world.rows.openai!;
  const base = validFrame(row, world.connection, "x");
  const body: Record<string, unknown> = {
    model: opts.model ?? "fixture-small",
    messages: [...(opts.system === undefined ? [] : [{ role: "system", content: opts.system }]), { role: "user", content: opts.user ?? USER_TEXT }],
    ...(opts.stream === true ? { stream: true } : {}),
    ...(opts.extra ?? {}),
  };
  return { ...base, headers: opts.headers ?? base.headers, body: enc(JSON.stringify(body)) };
}
/** An Anthropic-shaped request: the `system` field and one user message. */
export function messagesFrame(world: ModelEgressWorld, opts: { system?: string; user?: string; extra?: Record<string, unknown>; model?: string } = {}): Record<string, unknown> {
  const row = world.rows.anthropic!;
  const base = validFrame(row, world.connection, "x");
  return { ...base, body: enc(JSON.stringify({ model: opts.model ?? "fixture-small", max_tokens: 64, ...(opts.system === undefined ? {} : { system: opts.system }), messages: [{ role: "user", content: opts.user ?? USER_TEXT }], ...(opts.extra ?? {}) })) };
}
/** A Gemini-shaped request: `systemInstruction` and one user content. */
export function geminiFrame(world: ModelEgressWorld, opts: { system?: string; user?: string } = {}): Record<string, unknown> {
  const row = world.rows.gemini!;
  const base = validFrame(row, world.connection, "x");
  return { ...base, body: enc(JSON.stringify({ ...(opts.system === undefined ? {} : { systemInstruction: { parts: [{ text: opts.system }] } }), contents: [{ role: "user", parts: [{ text: opts.user ?? USER_TEXT }] }] })) };
}

export async function drain(serve: RecordReplayServe): Promise<{ events: ModelEgressEvent[]; body: string; text: string }> {
  const events: ModelEgressEvent[] = [];
  if (serve.kind === "stream") for await (const event of serve.events) events.push(event);
  const chunks = events.flatMap((event) => (event.kind === "chunk" ? [event.bytes] : []));
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  const body = new TextDecoder().decode(bytes);
  return { events, body, text: body };
}

export interface Rig {
  readonly world: ModelEgressWorld;
  readonly store: RecordingStore;
  readonly clock: { now: number };
  readonly scope: RecordingScope;
  /** The directory a file store writes under (a memory store never writes there). */
  readonly rootDir: string;
  engine(over?: Partial<RecordReplayOptions> & { company?: IsolationCompany; mode?: RecordingMode; rowKey?: "openai" | "anthropic" | "gemini"; taskId?: string }): RecordReplay;
  cleanup(): void;
}

export type StoreKind = "memory" | "file";

/** A rig for company A, task T1, over `kind` of store, on the fake egress world (optionally with one defect switched on). */
export function makeRig(kind: StoreKind, opts: { mutation?: ModelEgressMutation; report?: unknown; store?: (now: () => number) => RecordingStore } = {}): Rig {
  const world = fakeModelEgressWorld(opts.mutation);
  const clock = { now: T0 };
  const dirs: string[] = [];
  const root = mkdtempSync(join(tmpdir(), "f8-rec-"));
  dirs.push(root);
  const store = opts.store !== undefined ? opts.store(() => clock.now) : kind === "memory" ? createMemoryRecordingStore({ now: () => clock.now }) : createTaskRecordingStore({ root: join(root, "recordings"), now: () => clock.now });
  const scope: RecordingScope = { companyId: COMPANY_A.orgId, taskId: "task-1" };
  const plan = planOf(opts.report ?? changedReport());
  return {
    world,
    store,
    clock,
    scope,
    rootDir: join(root, "recordings"),
    engine(over = {}) {
      const company = over.company ?? COMPANY_A;
      const { company: _company, mode, rowKey, taskId, ...rest } = over;
      void _company;
      return createRecordReplay({
        egress: world.adapter,
        egressScope: world.scope(company, world.rows[rowKey ?? "openai"]!.id),
        egressCompanyOf: (scope) => (scope as unknown as { company?: string }).company,
        store,
        scope: () => ({ companyId: company.orgId, taskId: taskId ?? "task-1" }),
        plan,
        mode: mode ?? "record",
        clock: () => clock.now,
        ...rest,
      });
    },
    cleanup() {
      for (const dir of dirs) {
        try {
          chmodSync(dir, 0o700);
        } catch {
          // already gone
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

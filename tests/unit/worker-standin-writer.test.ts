// L4-E7: the stand-in writer, worker side. A separate, tool-less agent step at the end of a setup run, on the company's own AI, inside the run's cap, with the cost on the run's record. Every outside thing is a fake: no real model call.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentXError, SETUP_AGENT_LIMITS_DEFAULT, STANDIN_LIMITS, STANDIN_WRITER_WORDS, StandInWriterInputSchema, StandInWriterSetSchema, standInSetDigest, standInWriterCeilingCents, type StandInWriterInput,
} from "../../packages/contracts/src/index.js";
import { modelNotAllowedMarker, budgetExhaustedMarker } from "../../packages/model-runtime/src/budget.js";
import { runSetupAgent, type SetupRunInput, type SetupRunPorts } from "../../packages/worker/src/setup-agent-run.js";
import { STANDIN_WRITER_MAX_OUTPUT_TOKENS, STANDIN_WRITER_SYSTEM_PROMPT, STANDIN_WRITER_TIMEOUT_MS, runStandInWriter, standInSessionInputOf, standInWriterPrompt } from "../../packages/worker/src/standin-writer.js";
import { standInRequestOf } from "../../packages/worker/src/standin-shapes.js";
import type { PiSessionHandle } from "../../packages/worker/src/pi-session.js";
import type { RunNetwork } from "../../packages/worker/src/setup-network.js";
import { agentStepTools } from "../../packages/worker/src/agent-step.js";
import { createWorkspacePiSession, type PiSessionAdapter, type PiSessionInput } from "../../packages/worker/src/pi-session.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const COMMIT = "a".repeat(40);
const OPERATION = "11111111-1111-4111-8111-111111111111";
const PRICE = { inputPerMTok: 3, outputPerMTok: 15 };
const ANSWER = { setup: [{ repo: "web", commands: ["npm ci"], confidence: "high", from: [{ kind: "file", repo: "web", path: "package.json", line: 2, quote: "\"scripts\"" }] }], tests: [{ repo: "web", commands: ["npm test"], from: [{ kind: "ci", repo: "web", path: ".github/workflows/ci.yml", line: 5, quote: "run: npm test" }] }] };
const block = (answer: unknown) => `done\n\`\`\`agentx-setup-proposal\n${JSON.stringify(answer)}\n\`\`\``;

const REQUEST: StandInWriterInput = StandInWriterInputSchema.parse({
  tables: [{ name: "creators", rows: 2, columns: [{ name: "id", kind: "integer", key: true, writable: false }, { name: "bio", kind: "text", key: false, writable: true, maxChars: 120 }, { name: "followers", kind: "integer", key: false, writable: true }] }],
  operations: [{ id: "tiktok-user", host: "open.tiktokapis.com", method: "GET", path: "/v2/user/info", answers: 1, fields: [{ path: "data.user.display_name", kind: "string", required: true }] }],
});
const REPLY = { tables: { creators: [{ bio: "Weekend baker sharing quick recipes.", followers: 12044 }, { bio: "Slow travel around West Africa.", followers: 880 }] }, answers: { "tiktok-user": [{ data: { user: { display_name: "Mara Okafor" } } }] } };

interface WriterScript { text?: string; usage?: { input?: number; output?: number; cacheWrite?: number }; cost?: number; stopReason?: string; errorMessage?: string; throws?: Error; hang?: boolean; twoReplies?: boolean }
function writerSession(script: WriterScript = {}) {
  const prompts: string[] = []; const listeners: Array<(event: unknown) => void> = []; let aborted = 0; let disposed = 0; let release: (() => void) | undefined;
  const reply = (text: string) => { for (const listener of listeners) listener({ type: "message_end", message: { role: "assistant", stopReason: script.stopReason ?? "stop", ...(script.errorMessage === undefined ? {} : { errorMessage: script.errorMessage }), content: [{ type: "text", text }], usage: script.usage ?? { input: 2_000, output: 600 } } }); };
  const session: PiSessionHandle = {
    conversationId: "w", sessionFile: "w",
    prompt: async (text) => {
      prompts.push(String(text));
      if (script.throws !== undefined) throw script.throws;
      if (script.hang === true) { await new Promise<void>((resolve) => { release = resolve; }); return; }
      reply(script.text ?? JSON.stringify(REPLY));
      if (script.twoReplies === true) reply("{}");
    },
    abort: async () => { aborted += 1; release?.(); }, getModel: () => ({ provider: "p", modelId: "m" }), getSessionStats: () => ({ cost: script.cost ?? 0.02 }) as never,
    subscribe: (listener) => { listeners.push(listener); return () => undefined; }, dispose: () => { disposed += 1; },
  };
  return { session, prompts, aborted: () => aborted, disposed: () => disposed };
}

// ---- the writer on its own

describe("the writer's prompt holds the shapes and nothing else", () => {
  it("is built from the validated request alone: the same request, the same prompt; names, kinds and shapes are all there is", () => {
    const prompt = standInWriterPrompt(REQUEST);
    expect(prompt).toBe(standInWriterPrompt(REQUEST));
    expect(prompt).toContain(JSON.stringify(REQUEST));
    expect(prompt.replace(JSON.stringify(REQUEST), "")).not.toMatch(/diff|patch|commit|pull request|branch|task|--- a\//iu);
  });
  it("refuses a request that carries a change, a row or anything else a request has no field for: the model is never asked", async () => {
    const dirty = { ...REQUEST, diff: "--- a/src/pay.ts\n+++ b/src/pay.ts\n+const key = 1;" };
    expect(() => standInWriterPrompt(dirty as never)).toThrow();
    let opened = 0;
    const outcome = await runStandInWriter({ input: dirty, price: PRICE, remainingCents: 400, openSession: async () => { opened += 1; return writerSession().session; } });
    expect(outcome).toMatchObject({ status: "skipped", reason: "failed", spendCents: 0 });
    expect(opened).toBe(0);
  });
  it("tells the model it has no tools, no real people, and to write only what is asked (fixed words, the same for every project)", () => {
    expect(STANDIN_WRITER_SYSTEM_PROMPT).toContain("You have no tools");
    expect(STANDIN_WRITER_SYSTEM_PROMPT).toContain("Never use a real person's name");
    expect(STANDIN_WRITER_SYSTEM_PROMPT).toContain("never a key");
    expect(STANDIN_WRITER_SYSTEM_PROMPT).not.toMatch(/\$\{|undefined|\[object/u);
  });
  it("an agent step with an empty tool list has no tool at all (the mode's own tools narrowed to nothing)", () => {
    expect(agentStepTools("PLAN", [])).toEqual({ tools: [], shell: false });
  });
});

describe("the writer runs on the company's AI or not at all", () => {
  it("with no model session to open, or a model with no price: says so in clear words, opens nothing, spends nothing", async () => {
    for (const run of [{ price: PRICE, openSession: undefined }, { price: undefined, openSession: async () => writerSession().session }, { price: { inputPerMTok: Number.NaN, outputPerMTok: 1 }, openSession: async () => writerSession().session }]) {
      const outcome = await runStandInWriter({ input: REQUEST, remainingCents: 400, ...run });
      expect(outcome).toEqual({ status: "skipped", reason: "no_ai", spendCents: 0, words: STANDIN_WRITER_WORDS.noAi });
    }
    expect(STANDIN_WRITER_WORDS.noAi).toBe("Rovara writes sample data for your tests with your own AI, and none is connected for this project. Connect your AI first; Rovara never pays for it. Nothing was written and nothing was spent.");
  });
  it("a model the company has not allowed (at open, or in the reply) is the same words; a spent AI budget is `no_room`", async () => {
    const atOpen = await runStandInWriter({ input: REQUEST, price: PRICE, remainingCents: 400, openSession: async () => { throw agentXError("MODEL_NOT_ALLOWED", "no AI source serves this model"); } });
    expect(atOpen).toMatchObject({ status: "skipped", reason: "no_ai", spendCents: 0 });
    const inReply = await runStandInWriter({ input: REQUEST, price: PRICE, remainingCents: 400, openSession: async () => writerSession({ stopReason: "error", errorMessage: modelNotAllowedMarker("connect a key"), text: "" , usage: {} }).session });
    expect(inReply).toMatchObject({ status: "skipped", reason: "no_ai" });
    const spent = await runStandInWriter({ input: REQUEST, price: PRICE, remainingCents: 400, openSession: async () => writerSession({ stopReason: "error", errorMessage: budgetExhaustedMarker("org"), text: "", usage: {} }).session });
    expect(spent).toMatchObject({ status: "skipped", reason: "no_room" });
  });
  it("a session that cannot be opened for any other reason is `failed`, nothing spent", async () => {
    expect(await runStandInWriter({ input: REQUEST, price: PRICE, remainingCents: 400, openSession: async () => { throw new Error("boom: /secret/path"); } })).toMatchObject({ status: "skipped", reason: "failed", spendCents: 0, words: STANDIN_WRITER_WORDS.failed });
  });
});

describe("the writer is paid inside the run's cap", () => {
  it("does not start when its ceiling does not fit in what is left (the cap holds however the model answers)", async () => {
    const ceiling = standInWriterCeilingCents(PRICE);
    let opened = 0;
    const open = async () => { opened += 1; return writerSession().session; };
    expect(await runStandInWriter({ input: REQUEST, price: PRICE, remainingCents: ceiling - 1, openSession: open })).toMatchObject({ status: "skipped", reason: "no_room", spendCents: 0 });
    expect(await runStandInWriter({ input: REQUEST, price: PRICE, remainingCents: Number.NaN, openSession: open })).toMatchObject({ reason: "no_room" });
    expect(await runStandInWriter({ input: REQUEST, price: PRICE, remainingCents: -5, openSession: open })).toMatchObject({ reason: "no_room" });
    expect(opened).toBe(0);
    expect(await runStandInWriter({ input: REQUEST, price: PRICE, remainingCents: ceiling, openSession: open })).toMatchObject({ status: "written" });
    expect(opened).toBe(1);
  });
  it("counts the spend: the larger of the session's figure and its own count from the tokens at the price; an unreadable figure is the whole ceiling", async () => {
    // 2,000 in and 600 out at $3 / $15 per million is $0.015 = 2 cents (rounded up); the session says $0.02 = 2 cents.
    const small = await runStandInWriter({ input: REQUEST, price: PRICE, remainingCents: 400, openSession: async () => writerSession({ usage: { input: 2_000, output: 600 }, cost: 0 }).session });
    expect(small).toMatchObject({ status: "written", spendCents: 2 });
    const reportedMore = await runStandInWriter({ input: REQUEST, price: PRICE, remainingCents: 400, openSession: async () => writerSession({ usage: { input: 10, output: 10 }, cost: 0.37 }).session });
    expect(reportedMore).toMatchObject({ spendCents: 37 });
    const unreadable = await runStandInWriter({ input: REQUEST, price: PRICE, remainingCents: 400, openSession: async () => writerSession({ cost: Number.NaN }).session });
    expect(unreadable).toMatchObject({ status: "written", spendCents: standInWriterCeilingCents(PRICE) });
  });
  it("a reply that does not fit is not stored, and what it cost is still counted", async () => {
    const wrong = await runStandInWriter({ input: REQUEST, price: PRICE, remainingCents: 400, openSession: async () => writerSession({ text: JSON.stringify({ tables: { creators: [{ id: 1, bio: "x" }] } }) }).session });
    expect(wrong).toEqual({ status: "skipped", reason: "unusable", spendCents: 2, words: STANDIN_WRITER_WORDS.unusable });
    const prose = await runStandInWriter({ input: REQUEST, price: PRICE, remainingCents: 400, openSession: async () => writerSession({ text: "Sure! Here is some data." }).session });
    expect(prose).toMatchObject({ status: "skipped", reason: "unusable" });
  });
  it("makes ONE model call: a second reply ends it, and the session is always disposed", async () => {
    const two = writerSession({ twoReplies: true });
    expect(await runStandInWriter({ input: REQUEST, price: PRICE, remainingCents: 400, openSession: async () => two.session })).toMatchObject({ status: "skipped", reason: "failed" });
    expect(two.prompts).toHaveLength(1);
    expect(two.aborted()).toBe(1);
    expect(two.disposed()).toBe(1);
    const one = writerSession();
    await runStandInWriter({ input: REQUEST, price: PRICE, remainingCents: 400, openSession: async () => one.session });
    expect(one.disposed()).toBe(1);
  });
  it("a call that hangs is aborted at its time limit, and a person's Stop reaches it", async () => {
    const hung = writerSession({ hang: true });
    const outcome = await runStandInWriter({ input: REQUEST, price: PRICE, remainingCents: 400, openSession: async () => hung.session, timeoutMs: 20 });
    expect(outcome).toMatchObject({ status: "skipped", reason: "failed" });
    expect(hung.aborted()).toBe(1);
    expect(STANDIN_WRITER_TIMEOUT_MS).toBeGreaterThan(60_000);
    const stopped = writerSession({ hang: true });
    let abort: (() => Promise<void>) | undefined;
    const running = runStandInWriter({ input: REQUEST, price: PRICE, remainingCents: 400, openSession: async () => stopped.session, timeoutMs: 5_000, register: (a) => { abort = a; return () => { abort = undefined; }; } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(abort).toBeDefined();
    await abort!();
    expect(stopped.aborted()).toBeGreaterThanOrEqual(1);
    await running.catch(() => undefined);
  });
  it("is deterministic per version: the same reply, in any key order, is the same set and digest", async () => {
    const a = await runStandInWriter({ input: REQUEST, price: PRICE, remainingCents: 400, openSession: async () => writerSession().session });
    const reversed = { answers: REPLY.answers, tables: { creators: REPLY.tables.creators.map((row) => ({ followers: row.followers, bio: row.bio })) } };
    const b = await runStandInWriter({ input: REQUEST, price: PRICE, remainingCents: 400, openSession: async () => writerSession({ text: JSON.stringify(reversed, null, 2) }).session });
    expect(a.status === "written" && b.status === "written" && standInSetDigest(a.set) === standInSetDigest(b.set)).toBe(true);
    if (a.status === "written") expect(StandInWriterSetSchema.safeParse(a.set).success).toBe(true);
  });
});

describe("the request comes from the two readers, shapes only", () => {
  it("is built from the tables and the outside answers the readers found, and is undefined when they found nothing or threw", async () => {
    const readers = {
      tables: async () => [{ name: "creators", rows: 5, columns: [{ name: "id", kind: "integer" as const, key: true }, { name: "bio", kind: "text" as const, key: false, maxChars: 100 }] }],
      operations: async () => [],
    };
    expect((await standInRequestOf([], new Map(), readers))?.tables.map((table) => table.name)).toEqual(["creators"]);
    expect(await standInRequestOf([], new Map(), { tables: async () => [], operations: async () => [] })).toBeUndefined();
    expect(await standInRequestOf([], new Map(), { tables: async () => { throw new Error("unreadable"); }, operations: async () => [] })).toBeUndefined();
    // Until lanes E3 and E6 are merged the real readers find nothing, so a setup run's writer step does nothing and says nothing.
    expect(await standInRequestOf([], new Map())).toBeUndefined();
  });
});

// ---- inside a setup run

async function world(options: { writer?: WriterScript | undefined; request?: unknown; price?: SetupRunInput["price"]; limits?: Partial<typeof SETUP_AGENT_LIMITS_DEFAULT>; final?: string; mainCost?: number; withWriter?: boolean; script?: (control: { abort(): Promise<void> }) => Promise<void> } = {}) {
  const rootPath = await mkdtemp(join(tmpdir(), "standin-run-"));
  roots.push(rootPath);
  await mkdir(join(rootPath, "repo/web"), { recursive: true });
  const w = { callbacks: [] as unknown[], progress: [] as string[], mainPrompts: [] as string[], writerPrompts: [] as string[], opened: 0, writerOpened: 0, control: undefined as { abort(): Promise<void> } | undefined, order: [] as string[] };
  const listeners: Array<(event: unknown) => void> = [];
  const main: PiSessionHandle = {
    conversationId: "c", sessionFile: "f",
    prompt: async (text) => { w.mainPrompts.push(String(text)); w.order.push("main"); await options.script?.(w.control!); for (const l of listeners) l({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: options.final ?? block(ANSWER) }], usage: { input: 1000 } } }); },
    steer: async () => undefined, isStreaming: () => true, abort: async () => undefined, getModel: () => ({ provider: "p", modelId: "m" }),
    getSessionStats: () => ({ cost: options.mainCost ?? 0.05 }) as never, subscribe: (l) => { listeners.push(l); return () => undefined; }, dispose: () => undefined,
  };
  const network: RunNetwork = { name: "agentx-setup-0123456789ab", subnet: "172.29.9.0/24", gateway: "172.29.9.1", helperName: "h", helperIp: "172.29.9.2", sandboxIp: "172.29.9.3", readBlocked: async () => [], stop: async () => undefined };
  const ports: SetupRunPorts = {
    startNetwork: async () => network,
    createSandbox: () => ({ bashOperations: () => ({ exec: async () => ({ exitCode: 0 }) }), dispose: async () => undefined, fileOpsTarget: () => ({}) }) as never,
    openSession: async () => { w.opened += 1; return main; },
    callback: async (body) => { w.callbacks.push(body); const kind = (body as { kind: string }).kind; return kind === "poll" ? { hosts: [] } : kind === "stand_in_data" ? { stored: true, digest: "d", version: 1 } : { ok: true }; },
    progress: async (message) => { w.progress.push(message); },
    register: (control) => { w.control = control; return () => undefined; },
    checkFiles: async () => ({ ok: true }),
    tickMs: 5, parkTickMs: 5,
    ...(options.withWriter === false ? {} : {
      standIn: {
        input: async () => (options.request === undefined ? REQUEST : options.request),
        openSession: async () => { w.writerOpened += 1; const writer = writerSession(options.writer); const inner = writer.session; return { ...inner, prompt: async (text: string) => { w.writerPrompts.push(text); w.order.push("writer"); await inner.prompt(text); } }; },
      },
    }),
  };
  ports.beforeStart = async () => ({ scan: { repositories: [], setup: [], tests: [], checks: [], knowledge: [], sources: [], foundNotUsed: [], notes: [] }, tracked: new Map([["web", new Set(["package.json", ".github/workflows/ci.yml"])]]) });
  const input: SetupRunInput = { rootPath, operationId: OPERATION, basedOnRevision: 4, limits: { ...SETUP_AGENT_LIMITS_DEFAULT, ...options.limits }, price: "price" in options ? options.price : PRICE, repositories: [{ name: "web", path: "repo/web", resolvedCommit: COMMIT }], commits: [{ repository: "web", commit: COMMIT }], ports };
  return { w, input };
}
const stood = (t: { w: { callbacks: unknown[] } }) => t.w.callbacks.filter((body) => (body as { kind: string }).kind === "stand_in_data") as Array<{ set: unknown }>;

describe("the writer inside a setup run", () => {
  it("runs ONCE, after the run proposed, in its own session; its set goes over the one callback; its words are on the live view", async () => {
    const t = await world();
    const result = await runSetupAgent(t.input);
    expect(result.setupRunSummary.stop).toBe("proposed");
    expect(t.w.opened).toBe(1);
    expect(t.w.writerOpened).toBe(1);
    expect(t.w.writerPrompts).toHaveLength(1);
    expect(t.w.order).toEqual(["main", "writer"]);
    expect(stood(t)).toHaveLength(1);
    expect(StandInWriterSetSchema.safeParse(stood(t)[0]!.set).success).toBe(true);
    expect(t.w.progress).toContain(STANDIN_WRITER_WORDS.written);
  });
  it("its spend is on the setup run's record, inside the run's cap", async () => {
    const t = await world({ mainCost: 0.05, writer: { usage: { input: 2_000, output: 600 }, cost: 0.02 } });
    const result = await runSetupAgent(t.input);
    // 5 cents for the run, 2 for the writer.
    expect(result.setupRunSummary.spendCents).toBe(7);
    expect(result.setupRunSummary.spendCents).toBeLessThanOrEqual(t.input.limits.budgetCents);
    const without = await world({ mainCost: 0.05, withWriter: false });
    expect((await runSetupAgent(without.input)).setupRunSummary.spendCents).toBe(5);
  });
  it("is not started when the run has no room for its ceiling: the run's own result is unchanged and the words say why", async () => {
    const ceiling = standInWriterCeilingCents(PRICE);
    const t = await world({ mainCost: (400 - ceiling + 1) / 100 });
    const result = await runSetupAgent(t.input);
    expect(t.w.writerOpened).toBe(0);
    expect(stood(t)).toHaveLength(0);
    expect(t.w.progress).toContain(STANDIN_WRITER_WORDS.noRoom);
    expect(result.setupRunSummary.spendCents).toBe(400 - ceiling + 1);
    expect(result.setupProposal).toBeDefined();
  });
  it("never runs for a run that did not propose (a stopped run, a limit stop, a run that needs a code change)", async () => {
    const needs = await world({ final: `NEEDS CODE CHANGE: the lock file is broken\n${block(ANSWER)}` });
    const needsResult = await runSetupAgent(needs.input);
    expect(needsResult.setupRunSummary.stop).toBe("needs_code_change");
    expect(needs.w.writerOpened).toBe(0);
    expect(stood(needs)).toHaveLength(0);
    const stoppedRun = await world({ script: async (control) => { await control.abort(); } });
    const stoppedResult = await runSetupAgent(stoppedRun.input);
    expect(stoppedResult.setupRunSummary.stop).not.toBe("proposed");
    expect(stoppedRun.w.writerOpened).toBe(0);
    expect(stood(stoppedRun)).toHaveLength(0);
  });
  it("with no writer port the run is exactly as it was: no extra session, no extra callback, no extra words", async () => {
    const t = await world({ withWriter: false });
    const result = await runSetupAgent(t.input);
    expect(t.w.writerOpened).toBe(0);
    expect(stood(t)).toHaveLength(0);
    expect(t.w.progress.filter((line) => line.startsWith("Rovara wrote") || line.startsWith("Rovara did not write"))).toEqual([]);
    expect(result.setupRunSummary.stop).toBe("proposed");
  });
  it("finding nothing to write for says nothing and spends nothing", async () => {
    const t = await world({ request: undefined });
    t.input.ports.standIn!.input = async () => undefined;
    const result = await runSetupAgent(t.input);
    expect(t.w.writerOpened).toBe(0);
    expect(t.w.progress.filter((line) => line.includes("sample data"))).toEqual([]);
    expect(result.setupRunSummary.spendCents).toBe(5);
  });
  it("a writer that fails or writes something unusable never fails the run: the run still reports its proposal, with the writer's words and spend", async () => {
    const bad = await world({ writer: { text: "not json", cost: 0.03, usage: { input: 100, output: 10 } } });
    const result = await runSetupAgent(bad.input);
    expect(result.setupRunSummary.stop).toBe("proposed");
    expect(result.setupProposal).toBeDefined();
    expect(stood(bad)).toHaveLength(0);
    expect(bad.w.progress).toContain(STANDIN_WRITER_WORDS.unusable);
    expect(result.setupRunSummary.spendCents).toBe(8);
    const threw = await world();
    threw.input.ports.standIn!.input = async () => { throw new Error("reader broke at /secret"); };
    expect((await runSetupAgent(threw.input)).setupRunSummary.stop).toBe("proposed");
    const callbackDown = await world();
    const original = (body: unknown) => callbackDown.input.ports.callback(body);
    callbackDown.input.ports.callback = async (body) => { if ((body as { kind: string }).kind === "stand_in_data") throw new Error("broker down"); return original(body); };
    const down = await runSetupAgent(callbackDown.input);
    expect(down.setupRunSummary.stop).toBe("proposed");
    expect(callbackDown.w.progress).toContain(STANDIN_WRITER_WORDS.failed);
  });
  it("the words are fixed: nothing of the request, the reply, a path or a cause is echoed on the live view", async () => {
    const t = await world({ writer: { text: "Mara Okafor lives at 12 Real Street /secret/path" } });
    await runSetupAgent(t.input);
    const joined = t.w.progress.join("\n");
    expect(joined).not.toContain("Mara");
    expect(joined).not.toContain("Real Street");
    expect(joined).not.toContain("/secret");
  });
  it("the writer's prompt holds the shapes, never the run's proposal, repository text or commands", async () => {
    const t = await world();
    await runSetupAgent(t.input);
    const prompt = t.w.writerPrompts[0]!;
    expect(prompt).toBe(standInWriterPrompt(REQUEST));
    expect(prompt).not.toContain("npm ci");
    expect(prompt).not.toContain("package.json");
    expect(prompt).not.toContain("repo/web");
    expect(prompt).not.toContain(COMMIT);
  });
  it("a Stop while the writer goes ends its call and stores nothing", async () => {
    const t = await world({ writer: { hang: true } });
    t.input.ports.standIn!.openSession = async () => { const writer = writerSession({ hang: true }); return writer.session; };
    const running = runSetupAgent(t.input);
    for (let i = 0; i < 100 && t.w.writerOpened === 0 && stood(t).length === 0; i += 1) { await new Promise((resolve) => setTimeout(resolve, 10)); if (t.w.order.includes("main")) break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
    await t.w.control!.abort();
    const result = await running;
    expect(stood(t)).toHaveLength(0);
    expect(result.setupRunSummary).toBeDefined();
  }, 15_000);
  it("the ceiling is below the whole default cap, so a default run has room for it", () => {
    expect(standInWriterCeilingCents(PRICE)).toBeLessThan(SETUP_AGENT_LIMITS_DEFAULT.budgetCents / 4);
    expect(STANDIN_LIMITS.outputTokens).toBeLessThanOrEqual(10_000);
  });
});

describe("the writer's model session has no tool, no shell, no sandbox and no repository context", () => {
  it("is opened as an agent run with the writer's own system prompt, an empty tool list, the output cap and nothing else that could carry data in or out", async () => {
    const root = await mkdtemp(join(tmpdir(), "standin-session-"));
    roots.push(root);
    let seen: PiSessionInput | undefined;
    const adapter: PiSessionAdapter = {
      create: async (input) => { seen = input; return { ...writerSession().session, sessionFile: join(input.sessionDirectory, "w.jsonl") }; },
    };
    await createWorkspacePiSession(standInSessionInputOf({ rootPath: root, model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } }), adapter);
    expect(seen).toBeDefined();
    const input = seen!;
    expect(input.agentTools).toEqual([]);
    expect(input.agentRun).toEqual({ systemPrompt: STANDIN_WRITER_SYSTEM_PROMPT, tools: [] });
    expect(input.maxOutputTokens).toBe(STANDIN_WRITER_MAX_OUTPUT_TOKENS);
    expect(input.contextFiles).toEqual([]);
    for (const absent of ["bashOperations", "fileTools", "devcontainerPaths", "skills", "contextTools", "contextMcp", "answerTools", "knowledgeStep", "knowledgeSession", "proposeTool", "standingInstructions", "conversationId"] as const) {
      expect(input[absent as keyof PiSessionInput]).toBeUndefined();
    }
    // Whatever mode the session runs in, an empty step list leaves it no tool.
    for (const mode of ["PLAN", "SETUP", "IMPLEMENT", "REVIEW"] as const) expect(agentStepTools(mode, input.agentTools).tools).toEqual([]);
  });
});

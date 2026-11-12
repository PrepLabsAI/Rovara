// Decision 147: in a Slack thread where AgentX answered someone, that same person's later plain replies count as
// addressed to AgentX for 24 hours after its last answer there; anyone else still needs an @mention. A continued reply
// gets the mention's handling: small talk the fixed reply, a clear small request an automatic Quick start with Stop.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { THREAD_CONTINUATION_SECONDS, WORKFLOW_PATH_QUICK_ACTION, WORKFLOW_STOP_ACTION, isThreadContinuation, threadContinuationItems, type RequestRouteKind, type RequestRouteOutcome } from "../../packages/contracts/src/index.js";
import { createWorkflowE2E } from "../support/workflow-e2e.js";
import { MAYA } from "../support/developer-task-broker.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

const PLAN = planAnswer(planDocument({ title: "Fix the README typo", why: [{ text: "The README has a typo.", author: "Maya" }], claims: [{ id: "1", text: "Fix the typo in README.md." }], decisions: [] }));
const ROUTES: Readonly<Record<string, { kind: RequestRouteKind; outcome: RequestRouteOutcome }>> = {
  "fix the typo in README": { kind: "small_change", outcome: "ok" },
  "what does the payments service do?": { kind: "question", outcome: "ok" },
};
const THREAD = "1697000000.000001";

describe("decision 147: replies without a mention from the person AgentX answered", () => {
  let log: MockInstance<typeof console.log>;
  beforeEach(() => { log = vi.spyOn(console, "log").mockImplementation(() => undefined); });
  afterEach(() => { log.mockRestore(); });

  const start = async () => {
    // Messages posted by apps reach the ingress too (its appPosted switch on), so only the continuation rule keeps them out.
    const e2e = await createWorkflowE2E({ route: (text) => ROUTES[text] ?? { kind: "unclear", outcome: "ok" }, autoStartQuick: true, model: { plan: PLAN, edits: [] },
      appPosted: { accept: true, checkMember: async () => ({ outcome: "person" }) } });
    // AgentX answers Maya's top-level greeting in its thread.
    expect(await e2e.mention("hello", { ts: THREAD, threadTs: THREAD })).toBe(200);
    expect(e2e.slack.posts.at(-1)!.text).toMatch(/^Hi!/);
    return e2e;
  };
  const reply = (e2e: Awaited<ReturnType<typeof createWorkflowE2E>>, text: string, options: { user?: string; subtype?: string; botId?: string } = {}) =>
    e2e.mention(text, { type: "message", threadTs: THREAD, ...options });
  const inThread = (e2e: Awaited<ReturnType<typeof createWorkflowE2E>>) => e2e.slack.posts.filter((post) => post.threadTs === THREAD);

  it("answers the same person's \"thanks\" with the fixed reply and no model call, and starts their clear request on Quick with Stop", async () => {
    const e2e = await start();
    const asked = e2e.routeCalls.length;
    expect(await reply(e2e, "thanks!")).toBe(200);
    expect(inThread(e2e).at(-1)!.text).toMatch(/^You're welcome!/);
    expect(e2e.routeCalls).toHaveLength(asked);
    expect(await reply(e2e, "fix the typo in README")).toBe(200);
    const started = e2e.slack.lastPostWithAction(WORKFLOW_STOP_ACTION);
    expect(started.threadTs).toBe(THREAD);
    expect(started.text).toContain("so I started it as a quick change");
    expect(e2e.db.find((item) => String(item.pk).startsWith("DEVTASK#") && item.sk === "META")).toHaveLength(1);
  }, 120_000);

  it("ignores another person's reply without a mention, and a bot's or an edited message", async () => {
    const e2e = await start();
    const posts = inThread(e2e).length;
    const asked = e2e.routeCalls.length;
    expect(await reply(e2e, "thanks!", { user: "U0TEAMMATE1" })).toBe(200);
    expect(await reply(e2e, "fix the typo in README", { user: "U0TEAMMATE1" })).toBe(200);
    expect(await reply(e2e, "fix the typo in README", { botId: "B0OTHERAPP1" })).toBe(200);
    expect(await reply(e2e, "fix the typo in README", { subtype: "message_changed" })).toBe(200);
    expect(inThread(e2e)).toHaveLength(posts);
    expect(e2e.routeCalls).toHaveLength(asked);
    expect(e2e.chatQueue).toEqual([]);
    expect(e2e.db.find((item) => String(item.pk).startsWith("DEVTASK#") && item.sk === "META")).toEqual([]);
    // The other person is still heard when they mention AgentX.
    expect(await e2e.mention("thanks!", { threadTs: THREAD, user: "U0TEAMMATE1" })).toBe(200);
    expect(inThread(e2e).length).toBeGreaterThan(posts);
  }, 120_000);

  it("ignores the same person's reply once 24 hours passed since AgentX's last answer in the thread", async () => {
    const e2e = await start();
    e2e.clock.advance((THREAD_CONTINUATION_SECONDS - 60) * 1_000);
    expect(await reply(e2e, "thanks!")).toBe(200);
    expect(inThread(e2e).at(-1)!.text).toMatch(/^You're welcome!/);
    // That answer started a new 24 hours; past them, a plain reply is ignored again.
    const posts = inThread(e2e).length;
    e2e.clock.advance((THREAD_CONTINUATION_SECONDS + 60) * 1_000);
    expect(await reply(e2e, "thanks!")).toBe(200);
    expect(inThread(e2e)).toHaveLength(posts);
    expect(e2e.slack.posts.some((post) => JSON.stringify(post.blocks ?? []).includes(WORKFLOW_PATH_QUICK_ACTION))).toBe(false);
  }, 120_000);
});

describe("the continuation record", () => {
  const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: THREAD };
  const now = 1_700_000_000;
  const store = new Map<string, Record<string, unknown>>();
  for (const item of threadContinuationItems(thread, String(MAYA.slackUserId), now * 1_000)) store.set(`${String(item.pk)}|${String(item.sk)}`, item);
  const read = async (key: { pk: string; sk: string }) => store.get(`${key.pk}|${key.sk}`);

  it("is per thread and per Slack workspace: another company's thread with the same channel and timestamp never matches", async () => {
    expect(await isThreadContinuation(read, thread, String(MAYA.slackUserId), now + 60)).toBe(true);
    expect(await isThreadContinuation(read, { ...thread, teamId: "T0OTHERCO01" }, String(MAYA.slackUserId), now + 60)).toBe(false);
    expect(await isThreadContinuation(read, { ...thread, threadTs: "1697000000.000099" }, String(MAYA.slackUserId), now + 60)).toBe(false);
  });

  it("is per person and lasts 24 hours after the last answer", async () => {
    expect(await isThreadContinuation(read, thread, "U0TEAMMATE1", now + 60)).toBe(false);
    expect(await isThreadContinuation(read, thread, String(MAYA.slackUserId), now + THREAD_CONTINUATION_SECONDS)).toBe(true);
    expect(await isThreadContinuation(read, thread, String(MAYA.slackUserId), now + THREAD_CONTINUATION_SECONDS + 1)).toBe(false);
  });

  it("keeps every item bounded by a TTL", () => {
    for (const item of threadContinuationItems(thread, "U0TEAMMATE1", now * 1_000)) expect(item.expiresAt).toBeGreaterThan(now);
  });
});

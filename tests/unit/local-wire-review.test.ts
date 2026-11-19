// Lane L9-wire, review round 1: the lower-level cases (plan feedback, keys, the state folder lock, the message limit, the start transaction).
import { afterEach, describe, expect, it } from "vitest";
import { createLocalPagesServer, type LocalPagesServer } from "../../packages/broker/src/core/local-pages/index.js";
import { fakeWorld, raw } from "../support/local-pages-fakes.js";
import { when } from "@agentx/contracts";
import { MESSAGES_PER_HOUR, MESSAGE_RATE_LIMITED, createSessionControlHost } from "../../packages/broker/src/local/app/host.js";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { PLAN_FEEDBACK_MAX, planFeedbackKey, planFeedbackOf } from "../../packages/broker/src/core/task-flow/stage-machine.js";

const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";

describe("M1: the planner is told the newest changes the owner asked for", () => {
  it("keeps the latest words after more than the cap of send-backs, oldest of the kept first", async () => {
    const store = new MemoryDocumentStore();
    for (let round = 1; round <= PLAN_FEEDBACK_MAX + 5; round += 1) await store.put({ item: { ...planFeedbackKey(TASK, round), entityType: "PLAN_FEEDBACK", text: `change ${round}`, createdAt: "2026-11-09T10:00:00.000Z" } });
    const feedback = await planFeedbackOf({ store }, TASK);
    expect(feedback).toHaveLength(PLAN_FEEDBACK_MAX);
    expect(feedback.at(-1)).toBe(`change ${PLAN_FEEDBACK_MAX + 5}`);
    expect(feedback[0]).toBe("change 6");
    expect(feedback).not.toContain("change 1");
  });
});

const DEVELOPER = "ab".repeat(32);
const messageId = (id: number): string => `msg_${String(id).padStart(20, "0")}`;

/** A workflow task on the harness, and the host's plan for a message to it, written the way the session control writes it (the plan's items in one transaction). */
async function messaging() {
  const h = createHarness({ understandFirst: true });
  await h.registerProject();
  const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x", workflow: true });
  const taskId = started.task.taskId;
  const host = createSessionControlHost(h.deps);
  const tell = async (id: number, text = "note") => {
    const plan = await host.planMessage!(taskId, { messageId: messageId(id), text, sessionId: "ses_aaaaaaaaaaaaaaaaaaaa", author: { developerId: DEVELOPER, name: "Owner" }, owner: true });
    if ((plan.items ?? []).length > 0) expect((await h.store.transact([...plan.items!])).applied).toBe(true);
    return plan;
  };
  return { h, host, taskId, tell };
}

describe("L4 and L5: the message limit is a token bucket, and a repeat is not counted", () => {
  it("allows the limit in a burst, refills evenly, and does not allow twice the limit across an hour boundary", async () => {
    const { h, tell } = await messaging();
    const send = async (id: number) => (await tell(id)).reason;
    for (let id = 1; id <= MESSAGES_PER_HOUR; id += 1) expect(await send(id)).not.toBe(MESSAGE_RATE_LIMITED);
    expect(await send(100)).toBe(MESSAGE_RATE_LIMITED);
    // A fixed hourly window would reopen at the next hour; a bucket refills a little at a time.
    h.clock.advance(180);
    expect(await send(101)).not.toBe(MESSAGE_RATE_LIMITED);
    expect(await send(102)).toBe(MESSAGE_RATE_LIMITED);
    h.clock.advance(1_800);
    for (let id = 200; id < 200 + MESSAGES_PER_HOUR / 2; id += 1) expect(await send(id)).not.toBe(MESSAGE_RATE_LIMITED);
    expect(await send(300)).toBe(MESSAGE_RATE_LIMITED);
    // A repeat of a message already saved is answered again and takes no token.
    h.clock.advance(3_600);
    expect(await send(1)).not.toBe(MESSAGE_RATE_LIMITED);
    expect((await tell(1)).state).toBe("queued");
  });

  it("keeps each saved message as a note with an expiry, and a message planned twice at once is one note and one token (the loser's transaction is refused and planned again)", async () => {
    const { h, host, taskId } = await messaging();
    const plan = () => host.planMessage!(taskId, { messageId: messageId(7), text: "a", sessionId: "ses_aaaaaaaaaaaaaaaaaaaa", author: { developerId: DEVELOPER, name: "Owner" }, owner: true });
    const [first, second] = await Promise.all([plan(), plan()]);
    const applied = await Promise.all([h.store.transact([...first.items!]), h.store.transact([...second.items!])]);
    expect(applied.filter((result) => result.applied)).toHaveLength(1);
    const rows = (await h.store.query({ pk: `DEVTASK#${taskId}`, sk: { op: "beginsWith", prefix: "NOTE#" } })).items;
    expect(rows).toHaveLength(1);
    expect(typeof rows[0]!["indexExpiresAt"]).toBe("number");
    expect((await h.store.get({ pk: `DEVTASK#${taskId}`, sk: "META" }))?.["threadNoteCount"]).toBe(1);
    expect((await h.store.get({ pk: `DEVTASK#${taskId}`, sk: "MESSAGE_BUCKET" }))?.["tokens"]).toBe(MESSAGES_PER_HOUR - 1);
  });
});

describe("the start transaction", () => {
  it("leaves neither a task nor a session when one of the session's items cannot be written", async () => {
    const h = createHarness({ understandFirst: true });
    await h.registerProject();
    // A record already sits where the session's first item would go.
    await h.store.put({ item: { pk: "SESSION#taken", sk: "META", entityType: "AGENT_SESSION" } });
    h.deps.startExtras = () => ({ items: [{ kind: "put", item: { pk: "SESSION#taken", sk: "META", entityType: "AGENT_SESSION" }, condition: when.absent() }], sessionId: "ses_taken" });
    await expect(h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x", workflow: true })).rejects.toThrow();
    expect((await h.flow.list(h.owner)).tasks).toHaveLength(0);
  });
});

describe("N3: an address in the process list holds no session and is good once", () => {
  let server: LocalPagesServer | undefined;
  afterEach(async () => { await server?.close(); server = undefined; });

  it("redirects the first GET to the owner's page, then answers like a path that does not exist; a code expires; HEAD and a wrong code spend nothing", async () => {
    let clock = 1_000_000;
    const world = fakeWorld();
    server = await createLocalPagesServer({ data: world.data, actions: world.actions, now: () => clock });
    const host = new URL(server.origin).host;
    const get = (path: string, method = "GET") => raw(server!.origin, { method, path, headers: { host } });
    const address = new URL(server.onceLink(`/plan/${TASK}`));
    expect(address.pathname).not.toMatch(/\/s\/[A-Za-z0-9_-]{43}(\/|$)/);
    expect((await get(address.pathname, "HEAD")).status).toBe(404);
    expect((await get("/s/once/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).status).toBe(404);
    const hop = await get(address.pathname);
    expect(hop.status).toBe(303);
    expect(hop.headers["location"]).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/s/[A-Za-z0-9_-]{43}/plan/${TASK}$|^/s/[A-Za-z0-9_-]{43}/plan/${TASK}$`));
    expect((await get(address.pathname)).status).toBe(404);
    // A code left unused for longer than its time is dead.
    const late = new URL(server.onceLink("/", { ttlMs: 30_000 }));
    clock += 30_001;
    expect((await get(late.pathname)).status).toBe(404);
  });
});
